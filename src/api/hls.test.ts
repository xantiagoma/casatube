/**
 * `/api/library/hls` at the HTTP boundary.
 *
 * `core/hls` is tested on its own, so what is worth proving here is what only
 * exists in the routes: the **content types** (a player checks them), the
 * **rewritten segment URLs** (a bare `00000.ts` would arrive without a `?path=`
 * and could not be served), the **empty error bodies** on the segment route,
 * and that a path trying to leave the library is refused before ffmpeg is
 * handed it — this module passes a path to `ffmpeg -i`, which reads whatever it
 * is given.
 *
 * The manager is built here with a fake ffmpeg and a fake probe, so the suite
 * needs neither binary installed and does not depend on what codecs the local
 * build happens to have.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { createHlsManager, type HlsManager } from "../core/hls";
import type { MediaProbe } from "../core/library";
import { loadConfig } from "./config";
import type { AppContext } from "./context";
import { hlsRoutes, playbackUrl } from "./hls";

let root: string;
let temp: string;
let manager: HlsManager;
/**
 * Typed by what the test uses rather than as `Elysia`: the concrete instance
 * carries its prefix and its whole route table in its type, and annotating it
 * with the bare class is a type error rather than a widening.
 */
let app: { handle(request: Request): Promise<Response> };

/** Writes an `event` playlist and two segments, like the real one but instantly. */
function fakeFfmpeg(): string {
  const path = join(temp, "ffmpeg");
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      'out="${@: -1}"',
      'dir="$(dirname "$out")"',
      "printf '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:6\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n' > \"$out\"",
      "for i in 0 1; do",
      '  name="$(printf "%05d" "$i").ts"',
      '  printf "segment-%s" "$i" > "$dir/$name"',
      '  printf "#EXTINF:6.000000,\\n%s\\n" "$name" >> "$out"',
      "done",
      "printf '#EXT-X-ENDLIST\\n' >> \"$out\"",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/** MKV → H.264 + Opus (the yt-dlp output); anything else → H.264 + AAC. */
async function probe(path: string): Promise<Result<MediaProbe, { _tag: string }>> {
  const opus = path.endsWith(".mkv");
  return Result.ok({
    path,
    durationSeconds: 213,
    bitrate: 2_600_000,
    formatName: opus ? "matroska,webm" : "mov,mp4,m4a",
    width: 1920,
    height: 1080,
    streams: [
      { index: 0, kind: "video" as const, codec: "h264", isDefault: true },
      { index: 1, kind: "audio" as const, codec: opus ? "opus" : "aac", isDefault: true },
    ],
  });
}

function put(relative: string, contents = "not really a video"): void {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

function get(path: string): Promise<Response> {
  return app.handle(new Request(`http://local/api${path}`));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-api-hls-lib-"));
  temp = mkdtempSync(join(tmpdir(), "casatube-api-hls-tmp-"));
  put("Music/Dua Lipa - Love Again (Official Music Video).mkv");
  put("Videos/Me at the zoo.mp4");

  manager = createHlsManager({
    libraryRoot: root,
    tempDir: temp,
    ffmpegPath: fakeFfmpeg(),
    probe,
    log: () => {},
  });
  const ctx = { config: { ...loadConfig({}), libraryDir: root, tempDir: temp }, hls: manager } as AppContext;
  app = new Elysia({ prefix: "/api" }).use(hlsRoutes(ctx));
});

afterEach(async () => {
  await manager.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

const MKV = "Music/Dua Lipa - Love Again (Official Music Video).mkv";
const MP4 = "Videos/Me at the zoo.mp4";
const q = (path: string): string => `path=${encodeURIComponent(path)}`;

describe("GET /api/library/hls/playback", () => {
  test("an MKV is answered with the HLS index, and says why", async () => {
    const response = await get(`/library/hls/playback?${q(MKV)}`);
    const body = (await response.json()) as { mode: string; url: string; reason: string; transcodesAudio: boolean };

    expect(response.status).toBe(200);
    expect(body.mode).toBe("hls");
    expect(body.url).toBe(`/api/library/hls/index.m3u8?${q(MKV)}`);
    expect(body.transcodesAudio).toBe(true);
    expect(body.reason.length).toBeGreaterThan(0);
  });

  /** 🔴 The whole first half of the brief: an MP4 costs no ffmpeg and no disk. */
  test("🔴 an MP4 of H.264 and AAC is sent to the plain file route, and starts nothing", async () => {
    const response = await get(`/library/hls/playback?${q(MP4)}`);
    const body = (await response.json()) as { mode: string; url: string };

    expect(body.mode).toBe("direct");
    expect(body.url).toBe(`/api/library/file?${q(MP4)}`);
    expect((await manager.stats()).sessions).toHaveLength(0);
  });

  test("asking is free of side effects, however many times a grid asks", async () => {
    await Promise.all([get(`/library/hls/playback?${q(MKV)}`), get(`/library/hls/playback?${q(MKV)}`)]);
    expect((await manager.stats()).sessions).toHaveLength(0);
  });

  test("a missing file is a 404 with a tag, not a 500", async () => {
    const response = await get(`/library/hls/playback?${q("Music/nope.mkv")}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { tag: string }).tag).toBe("NotFound");
  });
});

describe("GET /api/library/hls/index.m3u8", () => {
  test("the index arrives as a playlist, uncacheable, with our own segment URLs", async () => {
    const response = await get(`/library/hls/index.m3u8?${q(MKV)}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/vnd.apple.mpegurl");
    // ⚠️ An `event` playlist grows. A cached one is a video that stops early.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("#EXTM3U");
    // 🔴 Without this, a playlist still being written reads as live and the
    // player starts at the live edge — see the note in `core/hls.ts`.
    expect(body).toContain("#EXT-X-START:TIME-OFFSET=0");
    // 🔴 Without this the player would ask for /api/library/hls/00000.ts with
    // no idea which file it belongs to — query strings are not part of relative
    // URL resolution.
    expect(body).toContain(`00000.ts?${q(MKV)}`);
    expect(body).not.toMatch(/^00000\.ts$/m);
  });

  test("a file that plays as it is refuses, and names the route that does work", async () => {
    const response = await get(`/library/hls/index.m3u8?${q(MP4)}`);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { tag: string; message: string };
    expect(body.tag).toBe("TranscodeUnavailable");
    expect(body.message).toContain("/api/library/file");
  });

  test("🔴 a path climbing out of the library is refused before ffmpeg is handed it", async () => {
    for (const path of ["../../../etc/passwd", "/etc/passwd", "a\\..\\..\\b.mkv", "..", "sub/../../x.mkv"]) {
      const response = await get(`/library/hls/index.m3u8?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { tag: string }).tag).toBe("PathOutsideRoot");
    }
    expect((await manager.stats()).sessions).toHaveLength(0);
  });

  /**
   * 📌 A *percent-encoded* separator is not a traversal: after one decode it is
   * a filename containing the characters `%2F`, which is legal and simply is not
   * there. Refusing it as a traversal would be a check that does not understand
   * what it is looking at — the honest answer is 404.
   */
  test("a double-encoded separator is a strange filename, not an escape", async () => {
    const response = await get(`/library/hls/index.m3u8?path=${encodeURIComponent("..%2F..%2Fetc%2Fpasswd")}`);
    expect(response.status).toBe(404);
    expect((await manager.stats()).sessions).toHaveLength(0);
  });
});

describe("GET /api/library/hls/:segment", () => {
  test("a segment is served as MPEG-TS, and may be cached — it never changes", async () => {
    await get(`/library/hls/index.m3u8?${q(MKV)}`);
    const response = await get(`/library/hls/00000.ts?${q(MKV)}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp2t");
    expect(response.headers.get("cache-control")).toContain("max-age");
    expect(await response.text()).toBe("segment-0");
  });

  /**
   * ⚠️ The rule the whole route is written around: a player that receives prose
   * where it expected MPEG-TS does not report a clean error, it misbehaves —
   * and the symptom then shows up far from the cause.
   */
  test("🔴 every failure has an empty body, never JSON or prose", async () => {
    await get(`/library/hls/index.m3u8?${q(MKV)}`);

    const cases = [
      `/library/hls/00099.ts?${q(MKV)}`, // never written
      `/library/hls/00000.ts?${q("Videos/never-started.mkv")}`, // no session
      `/library/hls/notasegment?${q(MKV)}`, // not a segment name
      `/library/hls/00000.ts?path=${encodeURIComponent("../../../etc/passwd")}`,
    ];

    for (const path of cases) {
      const response = await get(path);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).toBe("");
    }
  });
});

describe("GET /api/library/hls/sessions", () => {
  test("what is running and what it costs, so the disk is visible before it is full", async () => {
    const before = (await (await get("/library/hls/sessions")).json()) as { sessions: unknown[]; bytes: number };
    expect(before.sessions).toHaveLength(0);
    expect(before.bytes).toBe(0);

    await get(`/library/hls/index.m3u8?${q(MKV)}`);

    const after = (await (await get("/library/hls/sessions")).json()) as {
      sessions: { path: string; segments: number; bytes: number }[];
      bytes: number;
      maxSessions: number;
    };
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]?.path).toBe(MKV);
    expect(after.sessions[0]?.segments).toBe(2);
    expect(after.bytes).toBeGreaterThan(0);
    expect(after.maxSessions).toBeGreaterThan(0);
  });
});

describe("playbackUrl", () => {
  test("names a route per mode, and nothing at all when there is none", () => {
    expect(playbackUrl("direct", "a b.mp4")).toBe("/api/library/file?path=a%20b.mp4");
    expect(playbackUrl("hls", "a b.mkv")).toBe("/api/library/hls/index.m3u8?path=a%20b.mkv");
    expect(playbackUrl("unsupported", "a.mkv")).toBeNull();
  });
});
