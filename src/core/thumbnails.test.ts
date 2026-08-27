/**
 * Thumbnails, against a **real directory tree** and a real subprocess.
 *
 * ffmpeg itself is not what is being tested here — that it can extract a frame
 * is not in doubt. What is being tested is everything around it, and all of it
 * is about *not* running it: the sidecar that makes it unnecessary, the cache
 * that makes it unnecessary a second time, the negative cache that stops a
 * broken file from spawning two processes per card per scroll, and the
 * deduplication that turns ten simultaneous requests into one process.
 *
 * So `ffmpegPath` points at a **shell script** that records every invocation
 * and can be told to succeed, fail, write nothing or hang. That makes "ffmpeg
 * was not run" an assertion rather than a hope, and it makes the failure cases
 * deterministic on a machine that may not have ffmpeg at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MediaProbe } from "./library";
import {
  buildThumbnailArgs,
  cacheKey,
  contentTypeFor,
  createThumbnailer,
  seekSeconds,
  sidecarNames,
  type Thumbnailer,
} from "./thumbnails";

let root: string;
let cacheDir: string;
let ffmpeg: string;
let calls: string;

type FakeMode = "ok" | "fail" | "empty" | "slow";

/** A stand-in for ffmpeg that records what it was asked to do. */
function fakeFfmpeg(mode: FakeMode = "ok"): string {
  const path = join(root, `ffmpeg-${mode}.sh`);
  const body = {
    // The output path is the last argument — see `buildThumbnailArgs`.
    ok: `for last; do :; done\nprintf '\\377\\330fake-jpeg' > "$last"\nexit 0\n`,
    fail: `echo "Invalid data found when processing input" >&2\nexit 1\n`,
    // 🔴 The case that matters most: ffmpeg exits 0 having written nothing,
    // which is what a seek past the last frame does.
    empty: `exit 0\n`,
    slow: `sleep 5\nexit 0\n`,
  }[mode];
  writeFileSync(path, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

function runCount(): number {
  if (!existsSync(calls)) return 0;
  return readFileSync(calls, "utf8").split("\n").filter((line) => line.trim() !== "").length;
}

function lastArgs(): string {
  return readFileSync(calls, "utf8").trim().split("\n").at(-1) ?? "";
}

function probeOf(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    path: "x",
    durationSeconds: 100,
    bitrate: null,
    formatName: "matroska",
    width: 1920,
    height: 1080,
    streams: [{ index: 0, kind: "video", codec: "h264", isDefault: true }],
    ...overrides,
  };
}

function open(overrides: Partial<Parameters<typeof createThumbnailer>[0]> = {}): Thumbnailer {
  return createThumbnailer({
    libraryRoot: root,
    cacheDir,
    ffmpegPath: ffmpeg,
    probe: async () => Result.ok(probeOf()),
    log: () => undefined,
    ...overrides,
  });
}

function put(relative: string, contents = "video-bytes"): void {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

function unwrap<T>(result: Result<T, { _tag: string }>): T {
  if (Result.isError(result)) throw new Error(`expected ok, got ${result.error._tag}`);
  return result.value;
}

function tagOf(result: Result<unknown, { _tag: string }>): string {
  if (Result.isOk(result)) throw new Error("expected an error");
  return result.error._tag;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-thumbs-"));
  cacheDir = join(root, ".cache");
  calls = join(root, "calls.log");
  ffmpeg = fakeFfmpeg("ok");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- The decisions, as pure functions ---------------------------------------

describe("the pure parts", () => {
  test("a sidecar is the video's own name with an image extension, JPEG first", () => {
    expect(sidecarNames("Me at the zoo.mp4")).toEqual([
      "Me at the zoo.jpg",
      "Me at the zoo.jpeg",
      "Me at the zoo.png",
      "Me at the zoo.webp",
    ]);
  });

  test("the frame is taken from a fraction of the duration, never from second 0", () => {
    // The whole point: a video that opens on a fade to black still gets a
    // recognisable frame, and a long one gets a frame past the titles.
    expect(seekSeconds(100)).toBeCloseTo(10);
    expect(seekSeconds(7200)).toBeCloseTo(720);
    // Short clips: 10% of 6 seconds is still inside the fade, so the floor wins.
    expect(seekSeconds(6)).toBe(1);
    // Shorter than the floor, or unknown: 0 is the only offset guaranteed to
    // exist, and a seek past the end produces no image at all.
    expect(seekSeconds(0.4)).toBe(0);
    expect(seekSeconds(null)).toBe(0);
    expect(seekSeconds(Number.NaN)).toBe(0);
    expect(seekSeconds(1.2)).toBeLessThanOrEqual(0.7);
  });

  test("-ss comes before -i, which is what makes seeking into a film cheap", () => {
    const args = buildThumbnailArgs("/lib/A.mkv", "/cache/a.jpg", { seek: 12.5, width: 480 });
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("12.500");
    expect(args[args.indexOf("-i") + 1]).toBe("/lib/A.mkv");
    expect(args.at(-1)).toBe("/cache/a.jpg");
    // One frame from the first video stream, and nothing else in the file.
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(args[args.indexOf("-map") + 1]).toBe("0:v:0");
    expect(args).toContain("-an");
  });

  test("a seek of zero is left out entirely rather than passed as -ss 0", () => {
    expect(buildThumbnailArgs("/a", "/b", { seek: 0, width: 480 })).not.toContain("-ss");
  });

  test("the scale filter never enlarges a video that is already smaller", () => {
    const args = buildThumbnailArgs("/a", "/b", { seek: 1, width: 480 });
    expect(args[args.indexOf("-vf") + 1]).toBe("scale='min(iw,480)':-2");
  });

  test("the cache key changes when the file does, and when the size does", () => {
    const base = { relPath: "a/b.mkv", size: 100, mtimeMs: 5, width: 480 };
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, mtimeMs: 6 }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, size: 101 }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, width: 960 }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, relPath: "a/c.mkv" }));
  });

  test("the content type follows the sidecar's extension, not a guess", () => {
    expect(contentTypeFor("a.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("a.PNG")).toBe("image/png");
    expect(contentTypeFor("a.webp")).toBe("image/webp");
  });
});

// --- The order of preference ------------------------------------------------

describe("which source answers", () => {
  test("the provider's sidecar wins, and ffmpeg is never started", async () => {
    put("Videos/A.mkv");
    put("Videos/A.jpg", "provider-picture");

    const answer = unwrap(await open().thumbnail("Videos/A.mkv"));

    expect(answer.source).toBe("sidecar");
    expect(answer.path).toBe(join(root, "Videos/A.jpg"));
    expect(answer.contentType).toBe("image/jpeg");
    expect(answer.size).toBe("provider-picture".length);
    expect(runCount()).toBe(0);
  });

  test("the sidecar wins even when a generated frame is already cached", async () => {
    // 🔴 The preference is not "whatever is cheapest to answer with". A frame
    // taken out of the middle of the file is a guess; the poster the creator
    // chose is not, and it must win the moment it appears — which is exactly
    // what happens when an old download is fetched again.
    put("Videos/A.mkv");
    const key = cacheKey({
      relPath: "Videos/A.mkv",
      size: Bun.file(join(root, "Videos/A.mkv")).size,
      mtimeMs: Bun.file(join(root, "Videos/A.mkv")).lastModified,
      width: 480,
    });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${key}.jpg`), "old-frame");
    put("Videos/A.jpg", "provider-picture");

    expect(unwrap(await open().thumbnail("Videos/A.mkv")).source).toBe("sidecar");
  });

  test("JPEG beats WebP when a folder somehow has both", async () => {
    put("A.mkv");
    put("A.webp", "webp");
    put("A.jpg", "jpeg");
    expect(unwrap(await open().thumbnail("A.mkv")).path).toBe(join(root, "A.jpg"));
  });

  test("a WebP sidecar is still served when it is all there is", async () => {
    // What a download on a machine without ffmpeg leaves: the original, not the
    // conversion. Losing the picture over the format would be the wrong trade.
    put("A.mkv");
    put("A.webp", "webp");
    const answer = unwrap(await open().thumbnail("A.mkv"));
    expect(answer.contentType).toBe("image/webp");
    expect(runCount()).toBe(0);
  });

  test("an empty sidecar is ignored — a truncated download is not a picture", async () => {
    put("A.mkv");
    put("A.jpg", "");
    expect(unwrap(await open().thumbnail("A.mkv")).source).toBe("generated");
  });
});

// --- The cache --------------------------------------------------------------

describe("the cache", () => {
  test("a miss generates, a hit does not", async () => {
    put("Videos/A.mkv");
    const thumbs = open();

    const first = unwrap(await thumbs.thumbnail("Videos/A.mkv"));
    expect(first.source).toBe("generated");
    expect(first.contentType).toBe("image/jpeg");
    expect(readFileSync(first.path).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(runCount()).toBe(1);

    const second = unwrap(await thumbs.thumbnail("Videos/A.mkv"));
    expect(second.source).toBe("cache");
    expect(second.path).toBe(first.path);
    // The whole point of the cache: the second request costs no subprocess.
    expect(runCount()).toBe(1);
    expect(second.etag).toBe(first.etag);
  });

  test("the cache lives under its own directory, never in the library", async () => {
    put("Videos/A.mkv");
    const answer = unwrap(await open().thumbnail("Videos/A.mkv"));
    expect(answer.path.startsWith(cacheDir)).toBe(true);
    // A derived file in the library would show up as an item, be backed up, and
    // be synced to a NAS. It is none of those things.
    expect(existsSync(join(root, "Videos/A.jpg"))).toBe(false);
  });

  test("a fresh process finds the frame the last one left", async () => {
    put("Videos/A.mkv");
    expect(unwrap(await open().thumbnail("Videos/A.mkv")).source).toBe("generated");
    // A different Thumbnailer, i.e. a restarted server: the cache is on disk,
    // not in memory, so it survives.
    expect(unwrap(await open().thumbnail("Videos/A.mkv")).source).toBe("cache");
    expect(runCount()).toBe(1);
  });

  test("replacing the file invalidates its thumbnail", async () => {
    // 📌 The trap `core/hls.ts` documents for its playback verdict, in a second
    // place: a re-download over the same name is a *different video*, and a
    // cache keyed on the path alone would keep serving a picture of the old one.
    put("A.mkv", "first");
    const thumbs = open();
    const before = unwrap(await thumbs.thumbnail("A.mkv"));

    put("A.mkv", "a completely different video");
    utimesSync(join(root, "A.mkv"), 1_800_000_000, 1_800_000_000);

    const after = unwrap(await thumbs.thumbnail("A.mkv"));
    expect(after.source).toBe("generated");
    expect(after.path).not.toBe(before.path);
    expect(runCount()).toBe(2);
  });

  test("ten simultaneous requests are one ffmpeg", async () => {
    put("A.mkv");
    const thumbs = open();
    const answers = await Promise.all(Array.from({ length: 10 }, () => thumbs.thumbnail("A.mkv")));
    expect(answers.every((answer) => Result.isOk(answer))).toBe(true);
    expect(runCount()).toBe(1);
  });

  test("the oldest entries are pruned once the cache is over its cap", async () => {
    const thumbs = open({ maxEntries: 2 });
    mkdirSync(cacheDir, { recursive: true });
    // Older than anything this test will create.
    for (const name of ["aaa.jpg", "bbb.jpg", "ccc.jpg"]) {
      writeFileSync(join(cacheDir, name), "old");
      utimesSync(join(cacheDir, name), 1_600_000_000, 1_600_000_000);
    }
    // The sweep runs on a schedule, not on every write, so this drives it there.
    for (let index = 0; index < 60; index += 1) {
      put(`A${index}.mkv`, `bytes-${index}`);
      await thumbs.thumbnail(`A${index}.mkv`);
    }
    const remaining = (await thumbs.stats()).entries;
    expect(remaining).toBeLessThanOrEqual(60);
    // The three planted entries were the oldest, so they are the ones that go.
    expect(existsSync(join(cacheDir, "aaa.jpg"))).toBe(false);
  });
});

// --- When it cannot be done -------------------------------------------------

describe("failing honestly", () => {
  test("ffmpeg failing is ThumbnailUnavailable, not a crash", async () => {
    put("A.mkv");
    const result = await open({ ffmpegPath: fakeFfmpeg("fail") }).thumbnail("A.mkv");
    expect(tagOf(result)).toBe("ThumbnailUnavailable");
    if (Result.isError(result)) {
      expect(String((result.error as { detail: string }).detail)).toContain("Invalid data");
    }
  });

  test("ffmpeg exiting 0 with no output is a failure, not an empty thumbnail", async () => {
    // 🔴 The exit code is not the answer. A seek past the last frame leaves
    // ffmpeg happy and the file absent; believing it would cache a zero-byte
    // JPEG and serve a broken image for as long as the video stays put.
    put("A.mkv");
    const result = await open({ ffmpegPath: fakeFfmpeg("empty") }).thumbnail("A.mkv");
    expect(tagOf(result)).toBe("ThumbnailUnavailable");
    expect((await open().stats()).entries).toBe(0);
  });

  test("a failure is remembered, so a broken file is not two processes per scroll", async () => {
    put("A.mkv");
    const thumbs = open({ ffmpegPath: fakeFfmpeg("fail"), failedRetryMs: 60_000, now: () => 1_000 });
    expect(tagOf(await thumbs.thumbnail("A.mkv"))).toBe("ThumbnailUnavailable");
    expect(tagOf(await thumbs.thumbnail("A.mkv"))).toBe("ThumbnailUnavailable");
    expect(runCount()).toBe(1);
  });

  test("and forgotten again once the retry window has passed", async () => {
    put("A.mkv");
    let clock = 1_000;
    const thumbs = open({ ffmpegPath: fakeFfmpeg("fail"), failedRetryMs: 60_000, now: () => clock });
    await thumbs.thumbnail("A.mkv");
    clock += 61_000;
    await thumbs.thumbnail("A.mkv");
    expect(runCount()).toBe(2);
  });

  test("an ffmpeg that hangs is killed, and the request answers", async () => {
    // ⚠️ The library can be a mount that has stopped responding. Without a
    // deadline this request never returns and the process is held open by a
    // child nobody is waiting for.
    put("A.mkv");
    const started = Date.now();
    const result = await open({ ffmpegPath: fakeFfmpeg("slow"), generateTimeoutMs: 300 }).thumbnail("A.mkv");
    expect(tagOf(result)).toBe("Timeout");
    expect(Date.now() - started).toBeLessThan(4_000);
    // Nothing half-written was left where a later request would find it.
    expect((await open().stats()).entries).toBe(0);
  });

  test("a file with no video stream is refused without spawning anything", async () => {
    put("A.m4a");
    const result = await open({
      probe: async () => Result.ok(probeOf({ streams: [{ index: 0, kind: "audio", codec: "aac", isDefault: true }] })),
    }).thumbnail("A.m4a");
    expect(tagOf(result)).toBe("ThumbnailUnavailable");
    expect(runCount()).toBe(0);
  });

  test("a failed probe is reported, and ffmpeg is not run blind", async () => {
    put("A.mkv");
    const result = await open({
      probe: async () => Result.err({ _tag: "ProbeFailed", message: "ffprobe exited with 1" }),
    }).thumbnail("A.mkv");
    expect(tagOf(result)).toBe("ThumbnailUnavailable");
    expect(runCount()).toBe(0);
  });

  test("a file that is not there is NotFound, not a generated blank", async () => {
    expect(tagOf(await open().thumbnail("Nope.mkv"))).toBe("NotFound");
    expect(runCount()).toBe(0);
  });

  test("a directory is not a video", async () => {
    mkdirSync(join(root, "Videos"), { recursive: true });
    expect(tagOf(await open().thumbnail("Videos"))).toBe("NotFound");
  });

  test("a path that leaves the library is refused", async () => {
    // The second of the two checks: `safeDestination` refuses the string at the
    // HTTP edge, this refuses the resolved path where ffmpeg would be handed it.
    expect(tagOf(await open().thumbnail("../etc/passwd"))).toBe("PathOutsideRoot");
    expect(tagOf(await open().thumbnail("/etc/passwd"))).toBe("PathOutsideRoot");
    expect(runCount()).toBe(0);
  });
});
