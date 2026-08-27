/**
 * `/api/library`, against a **real directory tree**.
 *
 * The route is a thin layer over `core/library`, which is tested on its own, so
 * what is worth proving here is what only exists at the HTTP boundary: that the
 * query and body shapes are the ones documented, that a tagged error becomes
 * the right status code, and above all that **a path trying to leave the
 * library is refused before it reaches the filesystem**.
 *
 * The context is a cast rather than a whole application: these routes read
 * `config` and touch nothing else, and opening two SQLite files to list a
 * directory would make the test slower and less specific, not more honest.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config";
import type { AppContext } from "./context";
import { INLINE_RANGE_CAP_BYTES, libraryRoutes } from "./library";
import { TRASH_DIR } from "../core/library";

let root: string;

function appFor(libraryDir: string = root, env: Record<string, string> = {}) {
  const ctx = { config: { ...loadConfig(env), libraryDir } } as AppContext;
  return new Elysia({ prefix: "/api" }).use(libraryRoutes(ctx));
}

function get(path: string, libraryDir?: string): Promise<Response> {
  return appFor(libraryDir).handle(new Request(`http://local/api${path}`));
}

/**
 * A server whose ffmpeg and ffprobe are shell scripts.
 *
 * The point of every thumbnail test below is what happens *around* ffmpeg —
 * which source answers, whether a second request costs a process, whether
 * listing starts any. Stand-ins make those assertions instead of hopes, and
 * make the whole file runnable on a machine with no ffmpeg on it.
 */
function appWithFakeMedia(options: { ffmpeg?: "ok" | "fail"; video?: boolean } = {}) {
  const dataDir = join(root, "..", `data-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dataDir, { recursive: true });
  const calls = join(dataDir, "calls.log");

  const ffprobe = join(dataDir, "ffprobe.sh");
  const streams = options.video === false ? "" : '{"index":0,"codec_type":"video","codec_name":"h264"}';
  writeFileSync(
    ffprobe,
    `#!/bin/sh
printf '%s' '{"format":{"duration":"100"},"streams":[${streams}]}'
exit 0
`,
  );
  chmodSync(ffprobe, 0o755);

  const ffmpeg = join(dataDir, "ffmpeg.sh");
  const body =
    options.ffmpeg === "fail"
      ? `echo "Invalid data found when processing input" >&2
exit 1
`
      : `for last; do :; done
printf '\\377\\330fake-jpeg' > "$last"
exit 0
`;
  writeFileSync(ffmpeg, `#!/bin/sh
echo run >> ${JSON.stringify(calls)}
${body}`);
  chmodSync(ffmpeg, 0o755);

  const app = appFor(root, { DATA_DIR: dataDir, FFMPEG_BIN: ffmpeg, FFPROBE_BIN: ffprobe });
  return {
    dataDir,
    ffmpegRuns: () =>
      existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line !== "").length : 0,
    get: (path: string, init?: RequestInit) => app.handle(new Request(`http://local/api${path}`, init)),
  };
}

function send(method: "DELETE" | "POST", path: string, body?: unknown): Promise<Response> {
  return appFor().handle(
    new Request(`http://local/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

function put(relative: string, contents = "x"): void {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

function touch(relative: string, epochSeconds: number): void {
  utimesSync(join(root, relative), epochSeconds, epochSeconds);
}

type Listing = {
  root: string;
  folder: string;
  items: { path: string; name: string; folder: string; size: number; ext: string; subtitles: { name: string; language?: string }[] }[];
  matched: number;
  nextCursor: string | null;
  truncated: boolean;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-api-library-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/library", () => {
  test("lists what has been downloaded, with its subtitles attached", async () => {
    put("youtube/Talk.mkv", "0123456789");
    put("youtube/Talk.en.srt", "subs");
    touch("youtube/Talk.mkv", 1_700_000_000);

    const response = await get("/library");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Listing;

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      path: "youtube/Talk.mkv",
      name: "Talk.mkv",
      folder: "youtube",
      ext: "mkv",
      size: 10,
    });
    expect(body.items[0]?.subtitles.map((sub) => sub.name)).toEqual(["Talk.en.srt"]);
    expect(body.items[0]?.subtitles[0]?.language).toBe("en");
    expect(body.truncated).toBe(false);
  });

  test("filters by subfolder and searches by name", async () => {
    put("youtube/Interstellar.mkv");
    put("youtube/Cooking.mkv");
    put("films/Interstellar.mkv");

    const scoped = (await (await get("/library?folder=youtube")).json()) as Listing;
    expect(scoped.items.map((item) => item.path).sort()).toEqual(["youtube/Cooking.mkv", "youtube/Interstellar.mkv"]);
    expect(scoped.folder).toBe("youtube");

    const searched = (await (await get("/library?q=inters")).json()) as Listing;
    expect(searched.items.map((item) => item.path).sort()).toEqual(["films/Interstellar.mkv", "youtube/Interstellar.mkv"]);

    const both = (await (await get("/library?folder=films&q=inters")).json()) as Listing;
    expect(both.items.map((item) => item.path)).toEqual(["films/Interstellar.mkv"]);

    const shallow = (await (await get("/library?recursive=false")).json()) as Listing;
    expect(shallow.items).toEqual([]);
  });

  test("orders and pages by cursor", async () => {
    for (const name of ["a", "b", "c"]) put(`${name}.mkv`);

    const first = (await (await get("/library?sort=name&limit=2")).json()) as Listing;
    expect(first.items.map((item) => item.name)).toEqual(["a.mkv", "b.mkv"]);
    expect(first.matched).toBe(3);
    expect(first.nextCursor).not.toBeNull();

    const second = (await (
      await get(`/library?sort=name&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)
    ).json()) as Listing;
    expect(second.items.map((item) => item.name)).toEqual(["c.mkv"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a library that is not mounted is 503 MountUnavailable, not an empty page", async () => {
    const response = await get("/library", join(root, "not-mounted"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ tag: "MountUnavailable", retryable: true });
  });

  test("a subfolder that is not there is 404", async () => {
    expect((await get("/library?folder=films")).status).toBe(404);
  });
});

describe("GET /api/library/item", () => {
  test("answers with the item, and does not probe unless asked", async () => {
    put("youtube/Talk.mkv", "video");
    put("youtube/Talk.es.vtt", "subs");

    const response = await get("/library/item?path=youtube%2FTalk.mkv");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { item: { path: string; subtitles: { language?: string }[] }; probe: unknown };
    expect(body.item.path).toBe("youtube/Talk.mkv");
    expect(body.item.subtitles[0]?.language).toBe("es");
    expect(body.probe).toBeNull();
  });

  test("a probe that fails still answers with the item", async () => {
    put("notes.txt", "not media");
    const response = await get("/library/item?path=notes.txt&probe=1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { item: { name: string }; probe: unknown; probeError?: string };
    expect(body.item.name).toBe("notes.txt");
    expect(body.probe).toBeNull();
    // Whether ffprobe is installed or not, the failure is reported and the
    // item survives. (`ffprobe` lives in the image, not on a dev machine.)
    expect(typeof body.probeError).toBe("string");
  });

  test("an item that is not there is 404", async () => {
    expect((await get("/library/item?path=missing.mkv")).status).toBe(404);
  });

  test("a path is required", async () => {
    expect((await get("/library/item")).status).toBe(422);
  });
});

describe("GET /api/library/file", () => {
  test("serves the whole file, marked inline so a player can use it", async () => {
    put("Videos/clip.mp4", "0123456789");

    const response = await get("/library/file?path=Videos%2Fclip.mp4");
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(await response.text()).toBe("0123456789");
  });

  test("a range is a 206 whose content-length is the slice, not the file", async () => {
    // The whole point of the route: without this a player cannot seek, and a
    // 206 that claims the full length makes it give up trying.
    put("Videos/clip.mp4", "0123456789");

    const response = await appFor().handle(
      new Request("http://local/api/library/file?path=Videos%2Fclip.mp4", { headers: { range: "bytes=2-5" } }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("2345");
  });

  test("`?download=1` is the same bytes told to save", async () => {
    put("Videos/clip.mp4", "0123456789");

    const response = await get("/library/file?path=Videos%2Fclip.mp4&download=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
    expect(await response.text()).toBe("0123456789");
  });

  test("the download name survives accents and quotes", async () => {
    // Both forms, because a client that reads only the quoted one must still
    // get something usable — and an unescaped quote there would truncate it.
    // (A backslash cannot be tested here: `safeDestination` refuses one in the
    // path before this route ever sees it.)
    const name = 'Adiós "x" ñ.mp4';
    put(`Videos/${name}`, "z");

    const response = await get(`/library/file?path=${encodeURIComponent(`Videos/${name}`)}&download=1`);
    const header = response.headers.get("content-disposition") ?? "";

    expect(header.startsWith(`attachment; filename="Adi_s _x_ _.mp4"`)).toBe(true);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
  });

  test("`?download` also rides on a resumed (ranged) request", async () => {
    put("Videos/clip.mp4", "0123456789");

    const response = await appFor().handle(
      new Request("http://local/api/library/file?path=Videos%2Fclip.mp4&download=1", {
        headers: { range: "bytes=0-1" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  /**
   * 🔴 The bound that stopped a 437 MB file costing 3.74 GB.
   *
   * A media element walking a file makes hundreds of `bytes=N-` requests and
   * abandons each after a few kilobytes — and in the deployed container an
   * abandoned one had already pushed 6 to 9 MB into the socket. Answering the
   * literal request ("everything to the end") is what made each probe cost
   * megabytes.
   */
  describe("an open-ended range", () => {
    /** A file comfortably larger than the cap, so the cap is what shows. */
    const size = INLINE_RANGE_CAP_BYTES + 5_000;
    const ranged = async (query: string, range: string) =>
      appFor().handle(new Request(`http://local/api/library/file?${query}`, { headers: { range } }));

    test("🔴 is answered with at most the cap, and says so in content-range", async () => {
      put("Videos/big.mp4", "x".repeat(size));

      const response = await ranged("path=Videos%2Fbig.mp4", "bytes=1000-");

      expect(response.status).toBe(206);
      expect(response.headers.get("content-length")).toBe(String(INLINE_RANGE_CAP_BYTES));
      expect(response.headers.get("content-range")).toBe(
        `bytes 1000-${1000 + INLINE_RANGE_CAP_BYTES - 1}/${size}`,
      );
    });

    /**
     * ⚠️ The half that must not be capped. A download manager resuming with
     * `bytes=N-` writes what it is given and calls the file finished — a cap
     * there is a silently truncated download, which is the failure this project
     * refuses on principle.
     */
    test("is NOT capped for `?download=1` — a resumed save gets the rest of the file", async () => {
      put("Videos/big.mp4", "x".repeat(size));

      const response = await ranged("path=Videos%2Fbig.mp4&download=1", "bytes=1000-");

      expect(response.status).toBe(206);
      expect(response.headers.get("content-length")).toBe(String(size - 1000));
      expect(response.headers.get("content-range")).toBe(`bytes 1000-${size - 1}/${size}`);
    });

    test("a range that names its end is honoured exactly, cap or no cap", async () => {
      put("Videos/big.mp4", "x".repeat(size));

      const response = await ranged("path=Videos%2Fbig.mp4", `bytes=0-${size - 1}`);

      expect(response.headers.get("content-length")).toBe(String(size));
    });

    test("a file smaller than the cap is still served to its end", async () => {
      put("Videos/clip.mp4", "0123456789");

      const response = await ranged("path=Videos%2Fclip.mp4", "bytes=2-");

      expect(response.headers.get("content-range")).toBe("bytes 2-9/10");
      expect(await response.text()).toBe("23456789");
    });

    test("a start past the end is still a 416, not an empty 206", async () => {
      put("Videos/clip.mp4", "0123456789");

      expect((await ranged("path=Videos%2Fclip.mp4", "bytes=99-")).status).toBe(416);
    });
  });

  test("a file outside the root is refused before it is opened", async () => {
    expect((await get("/library/file?path=..%2Foutside.mkv")).status).toBe(400);
  });

  test("a file that is not there is 404", async () => {
    expect((await get("/library/file?path=missing.mp4")).status).toBe(404);
  });
});

describe("nothing outside the root", () => {
  const escapes = ["../outside.mkv", "youtube/../../outside.mkv", "/etc/passwd", "..\\outside.mkv"];

  test("every escape is refused with 400 PathOutsideRoot, on every route", async () => {
    for (const attempt of escapes) {
      const encoded = encodeURIComponent(attempt);

      const listed = await get(`/library?folder=${encoded}`);
      expect(listed.status).toBe(400);
      expect(await listed.json()).toMatchObject({ tag: "PathOutsideRoot" });

      expect((await get(`/library/item?path=${encoded}`)).status).toBe(400);
      expect((await send("DELETE", `/library?path=${encoded}`)).status).toBe(400);
      expect((await send("POST", "/library/restore", { path: attempt })).status).toBe(400);
    }
  });

  test("a percent-encoded `..` is decoded before it is judged", async () => {
    // `%2F` reaches the handler as `/`, so this is `../../etc/passwd` by the
    // time anything looks at it — and it is refused as one.
    const response = await get("/library?folder=..%2F..%2Fetc%2Fpasswd");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ tag: "PathOutsideRoot" });
  });

  test("a double-encoded one is a filename, not an escape", async () => {
    // `%252F` decodes once, to the literal `%2F` — a legal (if silly) filename
    // inside the root. 404 is the honest answer; 400 would mean the guard is
    // matching on spelling rather than on where the path resolves.
    const response = await get("/library/item?path=..%252F..%252Fetc%252Fpasswd");
    expect(response.status).toBe(404);
  });

  test("the file next to the library is still there afterwards", async () => {
    // The instrument could lie by reporting a refusal it never enforced.
    const outside = join(root, "..", `casatube-api-outside-${process.pid}.mkv`);
    writeFileSync(outside, "not yours");
    try {
      const name = outside.split("/").pop() ?? "";
      const response = await send("DELETE", `/library?path=${encodeURIComponent(`../${name}`)}`);
      expect(response.status).toBe(400);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(join(root, TRASH_DIR))).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("DELETE /api/library → restore → empty", () => {
  test("the whole cycle over HTTP", async () => {
    put("youtube/Talk.mkv", "the video itself");
    put("youtube/Talk.en.srt", "the subtitles");

    // --- delete: a move into `.trash/`, not an unlink ---------------------
    const deleted = await send("DELETE", "/library?path=youtube%2FTalk.mkv&reason=curl");
    expect(deleted.status).toBe(200);
    const { trashed } = (await deleted.json()) as {
      trashed: { id: string; path: string; size: number; files: { original: string; trashed: string }[]; reason?: string };
    };
    expect(trashed.path).toBe("youtube/Talk.mkv");
    expect(trashed.files).toHaveLength(2);
    expect(trashed.reason).toBe("curl");
    expect(existsSync(join(root, "youtube/Talk.mkv"))).toBe(false);
    expect(readFileSync(join(root, TRASH_DIR, trashed.id, "Talk.mkv"), "utf8")).toBe("the video itself");

    expect(((await (await get("/library")).json()) as Listing).items).toEqual([]);

    const listedTrash = (await (await get("/library/trash")).json()) as {
      entries: { id: string }[];
      retentionDays: number;
      bytes: number;
    };
    expect(listedTrash.entries.map((entry) => entry.id)).toEqual([trashed.id]);
    expect(listedTrash.retentionDays).toBe(30);
    expect(listedTrash.bytes).toBe(trashed.size);

    // --- restore ----------------------------------------------------------
    const restored = await send("POST", "/library/restore", { path: "youtube/Talk.mkv" });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ path: "youtube/Talk.mkv", renamed: false });
    expect(readFileSync(join(root, "youtube/Talk.mkv"), "utf8")).toBe("the video itself");
    expect(readFileSync(join(root, "youtube/Talk.en.srt"), "utf8")).toBe("the subtitles");

    // --- delete again, then empty ----------------------------------------
    const again = (await (await send("DELETE", "/library?path=youtube%2FTalk.mkv")).json()) as { trashed: { id: string } };

    const retained = await send("POST", "/library/trash/empty", {});
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ removed: 0, remaining: 1, olderThanDays: 30 });
    expect(existsSync(join(root, TRASH_DIR, again.trashed.id))).toBe(true);

    const forced = await send("POST", "/library/trash/empty", { olderThanDays: 0 });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({ removed: 1, remaining: 0, olderThanDays: 0 });
    expect(existsSync(join(root, TRASH_DIR, again.trashed.id))).toBe(false);
  });

  test("emptying with no body at all uses the configured retention", async () => {
    put("a.mkv");
    await send("DELETE", "/library?path=a.mkv");
    const response = await send("POST", "/library/trash/empty");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ removed: 0, remaining: 1, olderThanDays: 30 });
  });

  test("deleting something that is not there is 404, and restoring it too", async () => {
    expect((await send("DELETE", "/library?path=missing.mkv")).status).toBe(404);
    expect((await send("POST", "/library/restore", { path: "missing.mkv" })).status).toBe(404);
  });
});

describe("GET /api/library/thumbnail", () => {
  test("serves the provider's sidecar, and never starts ffmpeg for it", async () => {
    put("youtube/Talk.mkv", "video");
    put("youtube/Talk.jpg", "provider-picture");
    const server = appWithFakeMedia();

    const response = await server.get(`/library/thumbnail?path=${encodeURIComponent("youtube/Talk.mkv")}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-thumbnail-source")).toBe("sidecar");
    expect(response.headers.get("cache-control")).toContain("max-age");
    expect(await response.text()).toBe("provider-picture");
    expect(server.ffmpegRuns()).toBe(0);
  });

  test("a browser that already has the picture gets a 304 and no bytes", async () => {
    put("Talk.mkv", "video");
    put("Talk.jpg", "provider-picture");
    const server = appWithFakeMedia();

    const first = await server.get("/library/thumbnail?path=Talk.mkv");
    const etag = first.headers.get("etag") ?? "";
    expect(etag).not.toBe("");

    const second = await server.get("/library/thumbnail?path=Talk.mkv", {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  test("with no sidecar it generates once, then answers from the cache", async () => {
    put("Talk.mkv", "video");
    const server = appWithFakeMedia();

    const first = await server.get("/library/thumbnail?path=Talk.mkv");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-thumbnail-source")).toBe("generated");
    // The magic bytes, not just the status: a 200 that is not an image is the
    // failure this endpoint exists to avoid.
    expect(new Uint8Array(await first.arrayBuffer()).subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(server.ffmpegRuns()).toBe(1);

    const second = await server.get("/library/thumbnail?path=Talk.mkv");
    expect(second.headers.get("x-thumbnail-source")).toBe("cache");
    expect(server.ffmpegRuns()).toBe(1);
  });

  test("🔴 listing the library generates nothing", async () => {
    // The rule the whole design rests on. Two hundred cards on a screen must
    // not be two hundred ffmpegs — the generation happens when a *thumbnail* is
    // asked for, one request at a time.
    for (const name of ["a", "b", "c", "d"]) put(`${name}.mkv`, "video");
    const server = appWithFakeMedia();

    const listing = (await (await server.get("/library")).json()) as Listing;
    expect(listing.items).toHaveLength(4);
    await server.get(`/library/item?path=a.mkv`);

    expect(server.ffmpegRuns()).toBe(0);
  });

  test("a file that is not there is a clean 404 with no body", async () => {
    const server = appWithFakeMedia();
    const response = await server.get("/library/thumbnail?path=nope.mkv");
    expect(response.status).toBe(404);
    // ⚠️ Empty, not JSON: this URL goes in an `<img src>`, and a browser handed
    // a paragraph where it expected an image reports nothing useful.
    expect(await response.text()).toBe("");
  });

  test("ffmpeg failing is a 404 as well — the grid draws its grey rectangle", async () => {
    put("broken.mkv", "not really a video");
    const server = appWithFakeMedia({ ffmpeg: "fail" });

    const response = await server.get("/library/thumbnail?path=broken.mkv");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("a file with no video stream is refused without running ffmpeg", async () => {
    put("Song.m4a", "audio");
    const server = appWithFakeMedia({ video: false });

    expect((await server.get("/library/thumbnail?path=Song.m4a")).status).toBe(404);
    expect(server.ffmpegRuns()).toBe(0);
  });

  test("a path that leaves the library is refused before anything runs", async () => {
    const server = appWithFakeMedia();
    const response = await server.get(`/library/thumbnail?path=${encodeURIComponent("../etc/passwd")}`);
    expect(response.status).toBe(400);
    expect(server.ffmpegRuns()).toBe(0);
  });

  test("a library that is not mounted answers 404, and that is all a stat can say", async () => {
    // ⚠️ Worth writing down rather than assuming: an unmounted mount and a file
    // that is not there produce the **same** ENOENT, so per file the honest
    // answer is 404. `MountUnavailable` (503) is reserved for the case a stat
    // can actually tell apart — a mount that *hangs*, which is what the deadline
    // in `core/thumbnails.ts` catches and what `core/thumbnails.test.ts` covers.
    const ctx = { config: { ...loadConfig({}), libraryDir: join(root, "not-mounted") } } as AppContext;
    const app = new Elysia({ prefix: "/api" }).use(libraryRoutes(ctx));
    const response = await app.handle(new Request("http://local/api/library/thumbnail?path=Talk.mkv"));
    expect(response.status).toBe(404);
  });
});

/**
 * `/bundle` — the route that shipped broken because nothing tested it.
 *
 * The bug was arithmetic on a filename: `item.ext` carries no dot, so
 * subtracting its length left one behind and the sidecar filter matched
 * nothing. `all` produced a zip with only the video, and `extras` returned 404
 * for a file that plainly had both. Neither failed loudly — which is exactly
 * why these assert on the **contents** of the archive rather than the status.
 */
describe("bundle", () => {
  function seedWithSidecars(): void {
    mkdirSync(join(root, "Videos"), { recursive: true });
    writeFileSync(join(root, "Videos", "Zoo Clip.mp4"), "video-bytes");
    writeFileSync(join(root, "Videos", "Zoo Clip.en.srt"), "1\nsubtitle\n");
    writeFileSync(join(root, "Videos", "Zoo Clip.jpg"), "jpeg-bytes");
    writeFileSync(join(root, "Videos", "Lonely.mp4"), "alone");
  }

  /** `zip` lives in the image, not necessarily on a developer machine. */
  const hasZip = Bun.spawnSync(["sh", "-c", "command -v zip"]).exitCode === 0;

  /**
   * Entry names, read from the archive itself.
   *
   * Parsing the local file headers rather than shelling out to `unzip`: the
   * image ships `zip` but not `unzip`, and a helper that quietly returns
   * "unavailable" turns a content assertion into a test that always passes —
   * which is how the bug these tests exist for got through in the first place.
   */
  async function namesIn(res: Response): Promise<string[]> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const names: string[] = [];
    for (let i = 0; i + 30 <= bytes.length; i++) {
      if (view.getUint32(i, true) !== 0x04034b50) continue; // "PK\x03\x04"
      const nameLength = view.getUint16(i + 26, true);
      names.push(new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLength)));
    }
    return names.sort();
  }


  test("all: the video AND everything sharing its base name", async () => {
    seedWithSidecars();
    if (!hasZip) return;
    const res = await get("/library/bundle?path=Videos%2FZoo%20Clip.mp4&what=all");
    expect(res.status).toBe(200);
    const names = await namesIn(res);
    expect(names).toEqual(["Zoo Clip.en.srt", "Zoo Clip.jpg", "Zoo Clip.mp4"]);
  });

  test("extras: the sidecars WITHOUT the video — the whole point of the option", async () => {
    seedWithSidecars();
    if (!hasZip) return;
    const res = await get("/library/bundle?path=Videos%2FZoo%20Clip.mp4&what=extras");
    expect(res.status).toBe(200);
    const names = await namesIn(res);
    expect(names).toEqual(["Zoo Clip.en.srt", "Zoo Clip.jpg"]);
    expect(names).not.toContain("Zoo Clip.mp4");
  });

  test("extras on a file with none is 404, not an empty archive", async () => {
    seedWithSidecars();
    const res = await get("/library/bundle?path=Videos%2FLonely.mp4&what=extras");
    expect(res.status).toBe(404);
  });

  test("the filename carries no double dot", async () => {
    seedWithSidecars();
    if (!hasZip) return;
    const res = await get("/library/bundle?path=Videos%2FZoo%20Clip.mp4&what=all");
    expect(res.headers.get("content-disposition")).toContain('"Zoo Clip.zip"');
  });

  test("a path leaving the library is refused before any of this", async () => {
    seedWithSidecars();
    const res = await get("/library/bundle?path=..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
  });
});
