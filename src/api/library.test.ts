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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config";
import type { AppContext } from "./context";
import { libraryRoutes } from "./library";
import { TRASH_DIR } from "../core/library";

let root: string;

function appFor(libraryDir: string = root) {
  const ctx = { config: { ...loadConfig({}), libraryDir } } as AppContext;
  return new Elysia({ prefix: "/api" }).use(libraryRoutes(ctx));
}

function get(path: string, libraryDir?: string): Promise<Response> {
  return appFor(libraryDir).handle(new Request(`http://local/api${path}`));
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
