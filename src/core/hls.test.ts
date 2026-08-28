/**
 * On-demand HLS, tested in the two halves it naturally has.
 *
 * The **verdict** and the **command** are pure functions over what `ffprobe`
 * already said, so they are tested directly: no media file, no subprocess, and
 * every codec combination that matters covered in milliseconds. That is the
 * half where the interesting decisions live — "is this already playable" and
 * "can this be copied at all" — and it is the half that would otherwise only be
 * exercised by having the right corrupt MKV lying around.
 *
 * The **manager** is tested against a *fake ffmpeg*: a shell script that writes
 * a playlist and some segments on the same schedule the real one does, and
 * records that it ran. That is deliberate rather than lazy. The properties
 * worth proving here — one process per file, an orphan gets killed, the
 * directory is wiped — are properties of the bookkeeping, and the real ffmpeg
 * would only make them slower to check and dependent on a binary being
 * installed. The real one is exercised end to end by hand, against the real
 * 67 MB MKV; that is written up in the worklog.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import {
  buildFfmpegArgs,
  createHlsManager,
  decidePlayback,
  HLS_DIR,
  playlistSegments,
  readMp4Layout,
  rewritePlaylist,
  sessionId,
  sessionKey,
  type HlsManager,
} from "./hls";
import type { MediaProbe, ProbeStream } from "./library";

// --- Fixtures ---------------------------------------------------------------

function stream(kind: ProbeStream["kind"], codec: string, extra: Partial<ProbeStream> = {}): ProbeStream {
  return { index: 0, kind, codec, isDefault: true, ...extra };
}

function probeOf(...streams: ProbeStream[]): MediaProbe {
  return {
    path: "x",
    durationSeconds: 213,
    bitrate: 2_000_000,
    formatName: "matroska,webm",
    width: 1920,
    height: 1080,
    streams,
  };
}

// --- The verdict ------------------------------------------------------------

describe("decidePlayback", () => {
  test("an MP4 of H.264 and AAC is served as it is — no ffmpeg, no disk", () => {
    const verdict = decidePlayback("mp4", probeOf(stream("video", "h264"), stream("audio", "aac")));
    expect(verdict.mode).toBe("direct");
    expect(verdict.transcodesAudio).toBe(false);
  });

  test("the leading dot and the case of the extension make no difference", () => {
    const probe = probeOf(stream("video", "h264"), stream("audio", "aac"));
    expect(decidePlayback(".MP4", probe).mode).toBe("direct");
    expect(decidePlayback("M4V", probe).mode).toBe("direct");
  });

  test("an MKV is remuxed however ordinary its contents — the container alone decides", () => {
    const verdict = decidePlayback("mkv", probeOf(stream("video", "h264"), stream("audio", "aac")));
    expect(verdict.mode).toBe("hls");
    // AAC rides into MPEG-TS untouched, so this one costs nothing at all.
    expect(verdict.transcodesAudio).toBe(false);
  });

  test("the MKV yt-dlp actually produces — H.264 and Opus — is remuxed, audio converted", () => {
    const verdict = decidePlayback("mkv", probeOf(stream("video", "h264"), stream("audio", "opus")));
    expect(verdict.mode).toBe("hls");
    expect(verdict.transcodesAudio).toBe(true);
    expect(verdict.videoCodec).toBe("h264");
    expect(verdict.audioCodec).toBe("opus");
  });

  /**
   * 🔴 The case an extension-only check gets wrong, and the reason this reads
   * the streams at all. The container is one a browser opens; the file still
   * does not play on the only device it is watched from.
   */
  test("Opus inside MP4 is not direct — Safari does not decode it", () => {
    const verdict = decidePlayback("mp4", probeOf(stream("video", "h264"), stream("audio", "opus")));
    expect(verdict.mode).toBe("hls");
    expect(verdict.transcodesAudio).toBe(true);
    expect(verdict.reason).toContain("Safari");
  });

  test("Opus inside WebM is fine, because that is where it belongs", () => {
    expect(decidePlayback("webm", probeOf(stream("video", "vp9"), stream("audio", "opus"))).mode).toBe("direct");
  });

  /**
   * 🔴 The line between "we can fix this for free" and "we cannot fix it".
   * VP9 has no MPEG-TS mapping, so `-c:v copy` is impossible — and re-encoding
   * is the thing this module exists to avoid.
   */
  test("VP9 in a container browsers refuse is unsupported, not silently re-encoded", () => {
    const verdict = decidePlayback("mkv", probeOf(stream("video", "vp9"), stream("audio", "opus")));
    expect(verdict.mode).toBe("unsupported");
    expect(verdict.reason).toContain("re-encoding");
  });

  test("AV1 in an MKV, likewise", () => {
    expect(decidePlayback("mkv", probeOf(stream("video", "av1"), stream("audio", "opus"))).mode).toBe("unsupported");
  });

  test("HEVC in an MKV is copyable — MPEG-TS carries it", () => {
    expect(decidePlayback("mkv", probeOf(stream("video", "hevc"), stream("audio", "aac"))).mode).toBe("hls");
  });

  test("an MP3 is direct, and an audio-only MKA is remuxed", () => {
    expect(decidePlayback("mp3", probeOf(stream("audio", "mp3"))).mode).toBe("direct");
    expect(decidePlayback("mka", probeOf(stream("audio", "flac"))).mode).toBe("hls");
  });

  /**
   * ⚠️ Embedded cover art arrives as a *video* stream of `mjpeg`. Reading it as
   * the video track turns a plain music file into "unsupported", which is how a
   * download that worked yesterday stops playing today.
   */
  test("cover art is not mistaken for the video stream", () => {
    const verdict = decidePlayback(
      "m4a",
      probeOf(stream("video", "mjpeg", { index: 1 }), stream("audio", "aac")),
    );
    expect(verdict.mode).toBe("direct");
    expect(verdict.videoCodec).toBeUndefined();
  });
});

// --- The shape of the container ---------------------------------------------

/**
 * A minimal ISO base media file, built box by box.
 *
 * Real fixtures were considered and rejected: a fragmented MP4 that is worth
 * testing against is hundreds of megabytes, and a small one checked into the
 * repository would be a binary nobody can read a diff of. What is being tested
 * is a box walk, and boxes are eleven bytes of structure — so the fixture says
 * out loud what it contains.
 */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = payload.reduce((total, part) => total + part.byteLength, 0);
  const out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const part of payload) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function join8(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const filler = (n: number) => new Uint8Array(n);

describe("readMp4Layout", () => {
  test("🔴 an MP4 whose moov declares mvex is fragmented", () => {
    const head = join8(
      box("ftyp", filler(16)),
      box("moov", box("mvhd", filler(100)), box("trak", filler(64)), box("mvex", filler(24))),
      box("styp", filler(16)),
      box("moof", filler(64)),
    );
    expect(readMp4Layout(head)).toEqual({ fragmented: true });
  });

  test("an ordinary moov + mdat MP4 is not", () => {
    const head = join8(
      box("ftyp", filler(16)),
      box("moov", box("mvhd", filler(100)), box("trak", filler(512))),
      box("free", filler(8)),
      box("mdat", filler(1024)),
    );
    expect(readMp4Layout(head)).toEqual({ fragmented: false });
  });

  /**
   * ⚠️ The distinction the caller depends on: "not fragmented" and "I cannot
   * tell" are different answers. A `undefined` leaves the verdict exactly where
   * it was before this check existed; a `{ fragmented: false }` asserts
   * something about the file.
   */
  test("anything that is not ISO base media answers undefined, not false", () => {
    expect(readMp4Layout(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
    expect(readMp4Layout(new Uint8Array(4))).toBeUndefined();
    expect(readMp4Layout(new Uint8Array(0))).toBeUndefined();
  });

  test("a head that stops before the moov answers undefined", () => {
    const head = box("ftyp", filler(16));
    expect(readMp4Layout(head)).toBeUndefined();
  });

  test("a 64-bit box size is read rather than mistaken for a one-byte box", () => {
    // size=1 means the real size follows the type as a 64-bit integer.
    const ftyp = new Uint8Array(24);
    const view = new DataView(ftyp.buffer);
    view.setUint32(0, 1);
    for (let i = 0; i < 4; i += 1) ftyp[4 + i] = "ftyp".charCodeAt(i);
    view.setBigUint64(8, 24n);
    const head = join8(ftyp, box("moov", box("mvex", filler(24))));
    expect(readMp4Layout(head)).toEqual({ fragmented: true });
  });

  /** A malformed size of 0 inside a box must not spin. */
  test("a zero-length box terminates the walk instead of looping", () => {
    const head = new Uint8Array(40);
    const view = new DataView(head.buffer);
    view.setUint32(0, 24);
    for (let i = 0; i < 4; i += 1) head[4 + i] = "ftyp".charCodeAt(i);
    // A second box claiming size 0 — "to the end of the file".
    view.setUint32(24, 0);
    for (let i = 0; i < 4; i += 1) head[28 + i] = "mdat".charCodeAt(i);
    expect(readMp4Layout(head)).toBeUndefined();
  });
});

/**
 * The verdict, once it can see the shape.
 *
 * 🔴 This is the case that cost a day: every field `ffprobe` reports said the
 * file was fine, and it was. See `docs/DISCOVERIES.md` for the 3.74 GB.
 */
describe("decidePlayback on a fragmented MP4", () => {
  const fragmented = { fragmented: true };

  test("🔴 H.264 + AAC in a fragmented MP4 goes to HLS, not direct", () => {
    const verdict = decidePlayback("mp4", probeOf(stream("video", "h264"), stream("audio", "aac")), fragmented);
    expect(verdict.mode).toBe("hls");
    expect(verdict.fragmented).toBe(true);
    // Still a remux: the point of choosing HLS here is the segmenting, not the
    // encoding, and paying for an encode would defeat it.
    expect(verdict.transcodesAudio).toBe(false);
    expect(verdict.reason).toContain("fragmented");
  });

  test("the same file, not fragmented, is still served directly", () => {
    const verdict = decidePlayback("mp4", probeOf(stream("video", "h264"), stream("audio", "aac")), {
      fragmented: false,
    });
    expect(verdict.mode).toBe("direct");
    expect(verdict.fragmented).toBeUndefined();
  });

  /** No layout means no new opinion — exactly the behaviour before this existed. */
  test("with no layout at all the answer is unchanged", () => {
    expect(decidePlayback("mp4", probeOf(stream("video", "h264"), stream("audio", "aac"))).mode).toBe("direct");
  });

  test("a fragmented MP4 of VP9 is honest that nothing here can play it", () => {
    const verdict = decidePlayback("mp4", probeOf(stream("video", "vp9"), stream("audio", "opus")), fragmented);
    expect(verdict.mode).toBe("unsupported");
    expect(verdict.reason).toContain("fragmented");
  });

  test("a fragmented MP4 whose audio cannot ride in MPEG-TS says the audio is converted", () => {
    const verdict = decidePlayback("mp4", probeOf(stream("video", "h264"), stream("audio", "opus")), fragmented);
    expect(verdict.mode).toBe("hls");
    expect(verdict.transcodesAudio).toBe(true);
  });

  /**
   * ⚠️ `fragmented` is meaningless outside ISO base media. An MKV cannot have
   * an `mvex`, so a layout claiming otherwise must not change the MKV path.
   */
  test("the fragmented flag does not leak into containers it cannot describe", () => {
    const verdict = decidePlayback("mkv", probeOf(stream("video", "h264"), stream("audio", "aac")), fragmented);
    expect(verdict.mode).toBe("hls");
    expect(verdict.fragmented).toBeUndefined();
  });
});

// --- The command ------------------------------------------------------------

describe("buildFfmpegArgs", () => {
  const args = buildFfmpegArgs("/library/Film.mkv", "/tmp/hls/abc", { audioCodec: "opus" });

  test("🔴 the video is copied, never encoded", () => {
    expect(args).toContain("copy");
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
    expect(args).not.toContain("libx264");
  });

  test("🔴 every segment stays in the index, which is what allows seeking backwards", () => {
    expect(args[args.indexOf("-hls_list_size") + 1]).toBe("0");
    expect(args[args.indexOf("-hls_playlist_type") + 1]).toBe("event");
  });

  test("subtitle and data streams are dropped — MPEG-TS cannot carry embedded SRT", () => {
    expect(args).toContain("-sn");
    expect(args).toContain("-dn");
  });

  test("Opus is converted; AAC is copied, because it did not need converting", () => {
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    const aac = buildFfmpegArgs("/library/Film.mkv", "/tmp/hls/abc", { audioCodec: "aac" });
    expect(aac[aac.indexOf("-c:a") + 1]).toBe("copy");
    expect(aac).not.toContain("-ac");
  });

  test("the segment pattern and the playlist both land in the session directory", () => {
    expect(args).toContain("/tmp/hls/abc/%05d.ts");
    expect(args[args.length - 1]).toBe("/tmp/hls/abc/index.m3u8");
  });

  test("the segment length is configurable and defaults to six seconds", () => {
    expect(args[args.indexOf("-hls_time") + 1]).toBe("6");
    const short = buildFfmpegArgs("in", "dir", { segmentSeconds: 2 });
    expect(short[short.indexOf("-hls_time") + 1]).toBe("2");
  });
});

// --- The playlist rewrite ---------------------------------------------------

describe("rewritePlaylist", () => {
  const raw = ["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXTINF:6.000000,", "00000.ts", "#EXT-X-ENDLIST", ""].join("\n");

  test("🔴 every segment line carries the path the query string would have lost", () => {
    const out = rewritePlaylist(raw, "Music/Dua Lipa - Love Again.mkv");
    expect(out).toContain("00000.ts?path=Music%2FDua%20Lipa%20-%20Love%20Again.mkv");
  });

  test("directives and blank lines are left exactly alone", () => {
    const out = rewritePlaylist(raw, "a.mkv").split("\n");
    expect(out[0]).toBe("#EXTM3U");
    expect(out).toContain("#EXT-X-TARGETDURATION:6");
    expect(out).toContain("#EXTINF:6.000000,");
    expect(out[out.length - 2]).toBe("#EXT-X-ENDLIST");
  });

  /**
   * 🔴 Found by watching it go wrong, not by reading the spec. While ffmpeg is
   * still working the playlist has no `#EXT-X-ENDLIST`, and Chrome treats that
   * as live — so opening the file began playback at 3:28 of 4:22, the point the
   * remux had reached. Nothing errored; it played the wrong part of the video.
   */
  test("🔴 the playlist pins the start to zero, right after the header", () => {
    const out = rewritePlaylist(raw, "a.mkv").split("\n");
    expect(out[1]).toBe("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES");
  });

  test("a playlist that already carries EXT-X-START is not given a second one", () => {
    const already = "#EXTM3U\n#EXT-X-START:TIME-OFFSET=12\n#EXTINF:6,\n00000.ts\n";
    const out = rewritePlaylist(already, "a.mkv");
    expect(out.match(/#EXT-X-START/g)).toHaveLength(1);
  });

  test("playlistSegments reads back only the segment URIs", () => {
    expect(playlistSegments(raw)).toEqual(["00000.ts"]);
  });
});

// --- The manager ------------------------------------------------------------

let root: string;
let temp: string;
let runs: string;
let managers: HlsManager[];

/**
 * A fake ffmpeg: writes an `event` playlist and three segments on a delay, and
 * records every invocation. `runs` is what proves one process per file.
 */
function fakeFfmpeg(name: string, options: { delay?: number; failWith?: number; segments?: number } = {}): string {
  const path = join(temp, name);
  const delay = options.delay ?? 0.02;
  const count = options.segments ?? 3;
  writeFileSync(
    path,
    options.failWith !== undefined
      ? `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(runs)}\necho "fake failure" >&2\nexit ${options.failWith}\n`
      : [
          "#!/usr/bin/env bash",
          `echo "$*" >> ${JSON.stringify(runs)}`,
          'out="${@: -1}"',
          'dir="$(dirname "$out")"',
          "printf '#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:6\\n#EXT-X-MEDIA-SEQUENCE:0\\n#EXT-X-PLAYLIST-TYPE:EVENT\\n' > \"$out\"",
          `for i in $(seq 0 ${count - 1}); do`,
          `  sleep ${delay}`,
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

function runCount(): number {
  return existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).length : 0;
}

/** Always answers "H.264 + Opus in an MKV", i.e. the file this feature exists for. */
function mkvProbe(calls?: { n: number }) {
  return async (path: string) => {
    if (calls) calls.n += 1;
    return Result.ok({ ...probeOf(stream("video", "h264"), stream("audio", "opus")), path });
  };
}

function manage(options: Parameters<typeof createHlsManager>[0]): HlsManager {
  // Silenced: the manager narrates every start, finish and eviction, which is
  // right in a server log and noise on top of a passing test run.
  const created = createHlsManager({ log: () => {}, ...options });
  managers.push(created);
  return created;
}

function put(relative: string, contents = "not really a video"): void {
  const absolute = join(root, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-hls-lib-"));
  temp = mkdtempSync(join(tmpdir(), "casatube-hls-tmp-"));
  runs = join(temp, "runs.log");
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.stop()));
  rmSync(root, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

describe("createHlsManager", () => {
  test("🔴 the temp directory is wiped on startup — a crash leaves segments nothing would ever reap", () => {
    const stale = join(temp, HLS_DIR, "deadbeefdeadbeef");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "00000.ts"), "left by a crash");

    manage({ libraryRoot: root, tempDir: temp, probe: mkvProbe() });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(temp, HLS_DIR))).toBe(true);
  });

  test("the verdict is cached: ffprobe runs once per file, not once per request", async () => {
    put("Film.mkv");
    const calls = { n: 0 };
    const manager = manage({ libraryRoot: root, tempDir: temp, probe: mkvProbe(calls) });

    await manager.verdict("Film.mkv");
    await manager.verdict("Film.mkv");
    await manager.verdict("Film.mkv");

    expect(calls.n).toBe(1);
  });

  /**
   * ⚠️ Keyed on size and mtime, not on the name. A re-download over the same
   * filename is a different file, and a verdict cached on the name alone would
   * go on describing the one that is gone.
   */
  test("a file replaced in place is probed again", async () => {
    put("Film.mkv", "first");
    const calls = { n: 0 };
    const manager = manage({ libraryRoot: root, tempDir: temp, probe: mkvProbe(calls) });

    await manager.verdict("Film.mkv");
    await Bun.sleep(10);
    put("Film.mkv", "a different file entirely");
    await manager.verdict("Film.mkv");

    expect(calls.n).toBe(2);
  });

  test("a file that is not there is NotFound, not a session", async () => {
    const manager = manage({ libraryRoot: root, tempDir: temp, probe: mkvProbe() });
    const answered = await manager.verdict("nope.mkv");
    expect(Result.isError(answered) && answered.error._tag).toBe("NotFound");
    expect(runCount()).toBe(0);
  });

  test("🔴 a path climbing out of the library is refused before ffmpeg sees it", async () => {
    const manager = manage({ libraryRoot: root, tempDir: temp, probe: mkvProbe() });
    for (const path of ["../../etc/passwd", "/etc/passwd", "a/../../b.mkv"]) {
      const answered = await manager.verdict(path);
      expect(Result.isError(answered) && answered.error._tag).toBe("PathOutsideRoot");
    }
    expect(runCount()).toBe(0);
  });

  test("a directly playable file gets no session — the point of asking first", async () => {
    put("Clip.mp4");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg"),
      probe: async (path: string) => Result.ok({ ...probeOf(stream("video", "h264"), stream("audio", "aac")), path }),
    });

    const verdict = await manager.verdict("Clip.mp4");
    expect(Result.isOk(verdict) && verdict.value.mode).toBe("direct");

    const answered = await manager.playlist("Clip.mp4");
    expect(Result.isError(answered) && answered.error._tag).toBe("TranscodeUnavailable");
    expect(runCount()).toBe(0);
    expect((await manager.stats()).sessions).toHaveLength(0);
  });

  test("the playlist comes back rewritten, with the segments ffmpeg wrote", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg"),
      probe: mkvProbe(),
    });

    const answered = await manager.playlist("Film.mkv");
    expect(Result.isOk(answered)).toBe(true);
    if (Result.isError(answered)) return;

    expect(answered.value.body).toContain("#EXTM3U");
    expect(answered.value.body).toContain("00000.ts?path=Film.mkv");
    expect(answered.value.info.segments).toBeGreaterThan(0);

    const segment = await manager.segment("Film.mkv", "00000.ts");
    expect(Result.isOk(segment) && segment.value.size).toBeGreaterThan(0);
  });

  /**
   * 🔴 The property the whole `ensure` path is shaped around. Two players — or
   * one player and a reload — arriving in the same tick must not put two ffmpeg
   * processes into the same directory: that is double the CPU *and* a playlist
   * two writers are appending to.
   */
  test("🔴 two simultaneous requests start exactly one ffmpeg", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { delay: 0.05 }),
      probe: mkvProbe(),
    });

    const answers = await Promise.all([
      manager.playlist("Film.mkv"),
      manager.playlist("Film.mkv"),
      manager.playlist("Film.mkv"),
    ]);

    for (const answer of answers) expect(Result.isOk(answer)).toBe(true);
    expect(runCount()).toBe(1);
    expect((await manager.stats()).sessions).toHaveLength(1);
  });

  test("and so does a second request once the first session is finished", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg"),
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    await Bun.sleep(150);
    await manager.playlist("Film.mkv");

    expect(runCount()).toBe(1);
  });

  test("an unknown segment name is refused without touching the disk", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg"),
      probe: mkvProbe(),
    });
    await manager.playlist("Film.mkv");

    for (const name of ["../../../etc/passwd", "index.m3u8", "1.ts", "00000.ts.bak"]) {
      const answered = await manager.segment("Film.mkv", name);
      expect(Result.isError(answered) && answered.error._tag).toBe("NotFound");
    }
  });

  /**
   * 🔴 Found by watching Chrome die fifteen seconds into the real MKV with
   * `DEMUXER_ERROR_COULD_NOT_PARSE`. A file that exists is not a segment that
   * is written: the playlist is the only thing that says so, because ffmpeg
   * lists a segment after it closes it.
   */
  test("🔴 a segment that exists but is not yet listed is not served half-written", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg"),
      segmentWaitMs: 300,
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    const dir = join(temp, HLS_DIR, sessionId("Film.mkv"));
    await Bun.sleep(200);
    // Exactly what ffmpeg's next segment looks like a moment before it is
    // finished: on disk, non-empty, and absent from the index.
    writeFileSync(join(dir, "00042.ts"), "the first bytes of a segment still being written");

    const answered = await manager.segment("Film.mkv", "00042.ts");
    expect(Result.isError(answered) && answered.error._tag).toBe("NotFound");
  });

  test("a segment asked for before it exists is waited for, briefly", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      // Slow enough that the last segment is definitely not there when asked for.
      ffmpegPath: fakeFfmpeg("ffmpeg", { delay: 0.12 }),
      segmentWaitMs: 3_000,
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    const answered = await manager.segment("Film.mkv", "00002.ts");
    expect(Result.isOk(answered) && answered.value.size).toBeGreaterThan(0);
  });

  test("...but not for ever: once ffmpeg is done, what is missing stays missing", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { segments: 2 }),
      segmentWaitMs: 5_000,
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    await Bun.sleep(200);
    const started = Date.now();
    const answered = await manager.segment("Film.mkv", "00009.ts");
    expect(Result.isError(answered)).toBe(true);
    // It gave up because the process ended, not because it waited out the clock.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("ffmpeg failing is reported as TranscodeUnavailable, with what it said", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { failWith: 1 }),
      playlistTimeoutMs: 3_000,
      probe: mkvProbe(),
    });

    const answered = await manager.playlist("Film.mkv");
    expect(Result.isError(answered) && answered.error._tag).toBe("TranscodeUnavailable");
  });

  test("a failed session is not retried on every request — no spawn storm", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { failWith: 1 }),
      playlistTimeoutMs: 2_000,
      failedRetryMs: 60_000,
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    await manager.playlist("Film.mkv");
    expect(runCount()).toBe(1);
  });

  test("🔴 the session cap holds, and says so in a way worth retrying", async () => {
    put("A.mkv");
    put("B.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      // Long enough that the first session is still running when the second asks.
      ffmpegPath: fakeFfmpeg("ffmpeg", { delay: 0.5 }),
      maxSessions: 1,
      probe: mkvProbe(),
    });

    await manager.playlist("A.mkv");
    const answered = await manager.playlist("B.mkv");
    expect(Result.isError(answered) && answered.error._tag).toBe("TranscodeBusy");
    expect(runCount()).toBe(1);
  });

  test("a finished session is evicted to make room rather than refusing the new one", async () => {
    put("A.mkv");
    put("B.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { segments: 1 }),
      maxSessions: 1,
      probe: mkvProbe(),
    });

    await manager.playlist("A.mkv");
    await Bun.sleep(200);
    const answered = await manager.playlist("B.mkv");
    expect(Result.isOk(answered)).toBe(true);

    const stats = await manager.stats();
    expect(stats.sessions.map((session) => session.path)).toEqual(["B.mkv"]);
    expect(existsSync(join(temp, HLS_DIR, sessionId("A.mkv")))).toBe(false);
  });

  // --- Cleanup ------------------------------------------------------------

  test("🔴 a finished session that nobody has touched for an hour is removed, disk and all", async () => {
    put("Film.mkv");
    let clock = 1_000_000;
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { segments: 2 }),
      idleMs: 60 * 60 * 1000,
      now: () => clock,
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    await Bun.sleep(200);

    const dir = join(temp, HLS_DIR, sessionId("Film.mkv"));
    const before = await manager.stats();
    expect(before.sessions).toHaveLength(1);
    expect(before.bytes).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(true);

    // Fifty-nine minutes: still someone's paused video.
    expect(await manager.sweep(clock + 59 * 60 * 1000)).toBe(0);

    clock += 61 * 60 * 1000;
    expect(await manager.sweep(clock)).toBe(1);

    await Bun.sleep(50);
    expect(existsSync(dir)).toBe(false);
    const after = await manager.stats();
    expect(after.sessions).toHaveLength(0);
    expect(after.bytes).toBe(0);
  });

  /**
   * 🔴 The failure this module is most likely to cause and the one nobody would
   * notice: a closed tab leaves an ffmpeg copying a two-hour film to a disk no
   * one will ever read. Five minutes of silence is enough to call it.
   */
  test("🔴 an ffmpeg nobody is reading from is killed, well before the idle hour", async () => {
    put("Film.mkv");
    let clock = 1_000_000;
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      // Still running when the sweep comes round.
      ffmpegPath: fakeFfmpeg("ffmpeg", { delay: 2, segments: 20 }),
      idleMs: 60 * 60 * 1000,
      transcodeIdleMs: 5 * 60 * 1000,
      now: () => clock,
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    const dir = join(temp, HLS_DIR, sessionId("Film.mkv"));
    expect(existsSync(dir)).toBe(true);

    // Four minutes: a long pause, not an abandonment.
    expect(await manager.sweep(clock + 4 * 60 * 1000)).toBe(0);

    clock += 6 * 60 * 1000;
    expect(await manager.sweep(clock)).toBe(1);

    await Bun.sleep(50);
    expect(existsSync(dir)).toBe(false);
    expect((await manager.stats()).sessions).toHaveLength(0);
  });

  test("reading a segment keeps the session alive", async () => {
    put("Film.mkv");
    let clock = 1_000_000;
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { segments: 2 }),
      idleMs: 60 * 60 * 1000,
      now: () => clock,
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    await Bun.sleep(200);

    clock += 50 * 60 * 1000;
    await manager.segment("Film.mkv", "00000.ts");
    // Fifty-five minutes since the playlist, five since the segment.
    expect(await manager.sweep(clock + 5 * 60 * 1000)).toBe(0);
  });

  test("stats report the disk in use, per session and in total", async () => {
    put("Film.mkv");
    const manager = manage({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { segments: 3 }),
      probe: mkvProbe(),
    });

    await manager.playlist("Film.mkv");
    await Bun.sleep(250);

    const stats = await manager.stats();
    expect(stats.root).toContain(HLS_DIR);
    expect(stats.sessions).toHaveLength(1);
    expect(stats.sessions[0]?.segments).toBe(3);
    expect(stats.sessions[0]?.bytes).toBeGreaterThan(0);
    expect(stats.bytes).toBe(stats.sessions[0]?.bytes ?? 0);
  });

  test("stop() kills everything and leaves nothing behind", async () => {
    put("Film.mkv");
    const manager = createHlsManager({
      libraryRoot: root,
      tempDir: temp,
      ffmpegPath: fakeFfmpeg("ffmpeg", { delay: 2, segments: 20 }),
      probe: mkvProbe(),
      log: () => {},
    });

    await manager.playlist("Film.mkv");
    await manager.stop();
    await Bun.sleep(50);

    expect(existsSync(join(temp, HLS_DIR, sessionId("Film.mkv")))).toBe(false);
    expect((await manager.stats()).sessions).toHaveLength(0);
  });
});


// --- Choosing an audio track (2026-08-28) -----------------------------------

describe("audio tracks", () => {
  test("🔴 no index leaves ffmpeg's own choice, exactly as before", () => {
    // Every session behaved this way before the option existed, and a file with
    // one audio track still wants it. `-map` appearing unconditionally would
    // change what every existing playback does.
    const args = buildFfmpegArgs("/in.mkv", "/out");
    expect(args).not.toContain("-map");
  });

  test("🔴 an index maps that audio stream, and keeps the video optional", () => {
    const args = buildFfmpegArgs("/in.mkv", "/out", { audioIndex: 1 });
    expect(args.join(" ")).toContain("-map 0:v:0? -map 0:a:1");
  });

  test("🔴 the video map carries a question mark, or a file with no video fails", () => {
    // Without it ffmpeg exits with "Stream map '0:v:0' matches no streams",
    // which would turn choosing an audio track into a failed playback.
    const args = buildFfmpegArgs("/in.mkv", "/out", { audioIndex: 0 });
    expect(args).toContain("0:v:0?");
    expect(args).not.toContain("0:v:0");
  });

  test("index 0 is a real choice, not the same as absent", () => {
    expect(buildFfmpegArgs("/in.mkv", "/out", { audioIndex: 0 }).join(" ")).toContain("-map 0:a:0");
  });
});

describe("sessionKey and sessionId", () => {
  test("🔴 two audio tracks of one file are two sessions", () => {
    // Keying both on the path would hand the second viewer the first one's
    // remux: the menu moves and the sound does not.
    expect(sessionKey("a/b.mkv")).toBe("a/b.mkv");
    expect(sessionKey("a/b.mkv", 1)).not.toBe(sessionKey("a/b.mkv"));
    expect(sessionKey("a/b.mkv", 0)).not.toBe(sessionKey("a/b.mkv", 1));
    // And they must not share a directory, or one ffmpeg overwrites the other's
    // segments while a player is reading them.
    expect(sessionId("a/b.mkv", 0)).not.toBe(sessionId("a/b.mkv", 1));
    expect(sessionId("a/b.mkv")).not.toBe(sessionId("a/b.mkv", 0));
  });
});

describe("rewritePlaylist with an audio choice", () => {
  test("🔴 every segment URL carries it, or the segments come from the wrong session", () => {
    // A query string is not part of how a player resolves a relative URI, so a
    // segment line naming only the path is fetched from the default remux —
    // the language would change back without the menu noticing.
    const playlist = "#EXTM3U\n#EXTINF:6.0,\n00000.ts\n#EXTINF:6.0,\n00001.ts\n";
    const rewritten = rewritePlaylist(playlist, "a/b.mkv", 1);
    expect(rewritten).toContain("00000.ts?path=a%2Fb.mkv&audio=1");
    expect(rewritten).toContain("00001.ts?path=a%2Fb.mkv&audio=1");
    // And without a choice it is exactly what it was.
    expect(rewritePlaylist(playlist, "a/b.mkv")).toContain("00000.ts?path=a%2Fb.mkv\n");
  });
});
