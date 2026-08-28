/**
 * On-demand HLS: making a file the browser refuses into one it will play,
 * **without re-encoding the video**.
 *
 * The problem this exists for is narrow and concrete. A finished download is
 * very often an MKV — the container yt-dlp produces when it merges separate
 * video and audio streams — and no browser opens Matroska. Chrome, Safari and
 * Firefox all refuse it on the container alone, whatever is inside. Opus, which
 * YouTube hands out for most audio, is a second wall: legal in MP4 by spec and
 * not decoded by Safari, which is the only browser on the iPad this is watched
 * from.
 *
 * 🔴 **The video is copied, never re-encoded.** `-c:v copy` moves the existing
 * H.264 bitstream into a new container: no decode, no encode, a few percent of
 * one core. Only the audio is converted, and only when it has to be. The host
 * also runs Home Assistant and Frigate; a `libx264` pass would take four cores
 * for the length of a film to produce a *worse* picture than the one already on
 * disk. Anything that cannot be copied is reported as such rather than
 * transcoded quietly — see {@link decidePlayback}.
 *
 * 🔴 **Segment boundaries are ffmpeg's business.** Seeking is the whole point
 * of this module — a sequential stream would be no better than the direct route
 * — and a player can only start at a segment boundary, so every segment must
 * begin on a keyframe. ffmpeg splits at keyframes because it can see them; a
 * splitter working on byte offsets cannot, and produces segments that decode to
 * grey mush until the next IDR frame. ⚠️ A real consequence of copying: cuts
 * land **where the keyframes are**, so segment durations vary around
 * `-hls_time` rather than matching it. That is correct and expected; forcing it
 * would mean re-encoding, which is the thing we are avoiding.
 *
 * ⚠️ **This writes real bytes to real disk.** A two-hour film leaves several
 * hundred megabytes of `.ts` under `TEMP_DIR`. Hence: one session per file, a
 * ceiling on how many run at once, a sweep on a timer, a wipe on startup, and
 * {@link HlsManager.stats} so the number is visible rather than discovered when
 * the disk fills.
 *
 * 📌 **Not every file needs any of this.** An MP4 of H.264 and AAC is served
 * straight from `GET /api/library/file`, which answers range requests and costs
 * nothing. {@link decidePlayback} is what decides, and its verdict is cached
 * per file so the `ffprobe` behind it happens once, not once per request.
 */
import { Result } from "better-result";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  LocalProbeFailed,
  NotFound,
  PathOutsideRoot,
  TranscodeBusy,
  TranscodeUnavailable,
} from "./errors";
import { withDeadline, type MediaProbe } from "./library";
import type { MountUnavailable, Timeout } from "./errors";

// --- Constants --------------------------------------------------------------

/** Six seconds is Apple's own recommendation, and short enough that the first one arrives fast. */
export const DEFAULT_SEGMENT_SECONDS = 6;

/**
 * How long a session survives with nobody reading from it. PLAN-level default:
 * an hour, which outlasts a pause, a phone call and a nap.
 */
export const DEFAULT_IDLE_MS = 60 * 60 * 1000;

/**
 * The tighter deadline, and the one that matters for CPU: a session whose
 * ffmpeg is **still running** and which nobody has read from in five minutes is
 * a closed tab. An orphaned remux is worse than no playback at all, because it
 * is invisible.
 */
export const DEFAULT_TRANSCODE_IDLE_MS = 5 * 60 * 1000;

/** Concurrent remuxes. Copying is cheap; the disk they share is not. */
export const DEFAULT_MAX_SESSIONS = 3;

/** How often the sweep runs. */
export const DEFAULT_SWEEP_MS = 60 * 1000;

/** How long to wait for ffmpeg to produce a playlist with something in it. */
export const DEFAULT_PLAYLIST_TIMEOUT_MS = 30 * 1000;

/**
 * How long to wait for a segment that is not on disk **yet**.
 *
 * A player reading a live-ish playlist routinely asks for the segment ffmpeg is
 * writing at that instant. A short wait turns a spurious 404 into a slightly
 * slow 200; without it the player drops the segment and stalls.
 */
export const DEFAULT_SEGMENT_WAIT_MS = 3_000;

/** After a failure, how long before the same file is worth another ffmpeg. */
export const DEFAULT_FAILED_RETRY_MS = 30 * 1000;

/** Per filesystem call, same reasoning as `core/library`. */
const STAT_TIMEOUT_MS = 5_000;

/** The subfolder of `TEMP_DIR` this module owns outright — it is wiped on start. */
export const HLS_DIR = "hls";

/** `%05d.ts`, and nothing else, is what `-hls_segment_filename` produces. */
export const SEGMENT_NAME = /^[0-9]{5}\.ts$/;

export const PLAYLIST_NAME = "index.m3u8";

// --- The verdict ------------------------------------------------------------

/**
 * Containers a browser opens, as extensions without the dot.
 *
 * ⚠️ Conservative on purpose, and it disagrees with `src/web/data/library.ts`
 * in one direction only: `mov` is here because the *server* can tell what is
 * inside it, and an H.264/AAC QuickTime file plays in Safari and Chrome. The
 * browser-side list cannot look inside, so it excludes `mov` — a stricter guess
 * made with less information, which is the right way round.
 */
const PLAYABLE_CONTAINERS: ReadonlySet<string> = new Set([
  "mp4",
  "m4v",
  "mov",
  "webm",
  "ogv",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "oga",
  "opus",
  "flac",
  "wav",
]);

/** Video codecs a browser decodes, given a container it will open. */
const PLAYABLE_VIDEO: ReadonlySet<string> = new Set(["h264", "avc1", "vp8", "vp9", "av1"]);

/** Audio codecs a browser decodes. ⚠️ `opus` only outside MP4 — see below. */
const PLAYABLE_AUDIO: ReadonlySet<string> = new Set([
  "aac",
  "mp3",
  "mp4a",
  "opus",
  "vorbis",
  "flac",
  "pcm_s16le",
  "pcm_s24le",
]);

// --- What the front of the file says about its own shape ---------------------

/**
 * How many bytes of the head are enough to answer "is this fragmented?".
 *
 * The `moov` of a fragmented MP4 carries **no sample tables** — that is the
 * point of fragmenting — so it is tiny: the real file measured here has a
 * 1370-byte `moov` describing 73 minutes. A non-fragmented `moov` is large, but
 * we do not have to read it: `mvex` is a direct child of `moov`, so either it
 * appears within the first boxes or the file is not fragmented. 256 KB is far
 * more than any fragmented `moov` and cheap to read once per (size, mtime).
 */
export const MP4_HEAD_BYTES = 256 * 1024;

/** Extensions whose head is worth parsing as ISO base media. */
const ISO_BMFF_CONTAINERS: ReadonlySet<string> = new Set(["mp4", "m4v", "m4a", "mov"]);

export interface ContainerLayout {
  /**
   * The `moov` declares `mvex`, so the samples are in `moof` fragments and the
   * movie header describes **nothing about where anything is**.
   */
  fragmented: boolean;
}

/**
 * Read the shape of an MP4 out of the first bytes of the file.
 *
 * 🔴 This is the question `ffprobe` does not answer. `ffprobe` reports codecs,
 * durations and bitrates — every one of which was *correct and reassuring* on
 * the file that would not play. What it never says is that the file has no
 * sample table at the front, which is the only thing that mattered.
 *
 * A **fragmented** MP4 (`moov` → `mvex`) stores its samples in a chain of
 * `moof`/`mdat` pairs and keeps no index of them anywhere. A browser handed one
 * over HTTP therefore learns the duration, and where any given second lives, by
 * **reading every `moof` in the file** — measured on the real 438 MB file as
 * 468 range requests and 3.74 GB on the wire before the first frame. The same
 * content remuxed to a plain `moov`+`mdat` MP4, at the same 439 MB, took **one
 * request and 11.8 MB**. See `docs/DISCOVERIES.md`.
 *
 * ⚠️ Returns `undefined` when the head is not ISO base media at all — a WebM, a
 * truncated file, an MP3. "I cannot tell" and "it is not fragmented" are
 * different answers and the caller must not confuse them.
 */
export function readMp4Layout(head: Uint8Array): ContainerLayout | undefined {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

  /** The type of the box starting at `at`, or undefined when it does not fit. */
  function boxAt(at: number): { type: string; body: number; next: number } | undefined {
    if (at + 8 > head.byteLength) return undefined;
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > head.byteLength) return undefined;
      // 64-bit sizes beyond 2^53 cannot happen in a real file and would break
      // the arithmetic below; treat one as "cannot tell" rather than guessing.
      const large = view.getBigUint64(at + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      // "To the end of the file" — legal for the last box, and it means this
      // box has no sibling after it.
      size = head.byteLength - at;
    }
    if (size < header) return undefined;
    let type = "";
    for (let i = at + 4; i < at + 8; i += 1) type += String.fromCharCode(head[i] ?? 0);
    return { type, body: at + header, next: at + size };
  }

  const first = boxAt(0);
  // Every ISO base media file starts with `ftyp`. Anything else is a container
  // this parser has no business guessing about.
  if (first === undefined || first.type !== "ftyp") return undefined;

  for (let at = 0; at < head.byteLength; ) {
    const box = boxAt(at);
    if (box === undefined || box.next <= at) break;
    if (box.type === "moov") {
      // `mvex` is a direct child of `moov`, so one level of walking is enough.
      const end = Math.min(box.next, head.byteLength);
      for (let child = box.body; child < end; ) {
        const inner = boxAt(child);
        if (inner === undefined || inner.next <= child) break;
        if (inner.type === "mvex") return { fragmented: true };
        child = inner.next;
      }
      // A `moov` we read to the end with no `mvex` in it is a plain MP4. A
      // `moov` that ran off the end of the head is one we could not finish —
      // but it is also, by construction, far bigger than any fragmented `moov`,
      // which is itself the answer.
      return { fragmented: false };
    }
    at = box.next;
  }
  return undefined;
}

/** Whether this container is one `readMp4Layout` can say anything about. */
export function isIsoBmff(container: string): boolean {
  return ISO_BMFF_CONTAINERS.has(container);
}

/**
 * Video codecs MPEG-TS can carry, which is the real limit on `-c:v copy`.
 *
 * 🔴 This is the line between "we can fix it for free" and "we cannot fix it at
 * all". VP9 and AV1 have no MPEG-TS mapping, so copying one into a `.ts`
 * segment fails outright — and re-encoding it is exactly what this module
 * refuses to do. A VP9 MKV is therefore honestly reported as undeliverable
 * rather than silently turned into an hour of CPU.
 */
const TS_COPYABLE_VIDEO: ReadonlySet<string> = new Set(["h264", "avc1", "hevc", "h265", "hev1", "hvc1"]);

/** Audio codecs MPEG-TS carries as-is, so the audio pass can be skipped too. */
const TS_COPYABLE_AUDIO: ReadonlySet<string> = new Set(["aac", "mp3", "ac3", "eac3"]);

export type PlaybackMode =
  /** Serve the file itself through `GET /api/library/file`. No ffmpeg, no disk. */
  | "direct"
  /** Remux to HLS on demand. */
  | "hls"
  /** Neither works. The honest answer is the download button. */
  | "unsupported";

export interface PlaybackVerdict {
  mode: PlaybackMode;
  /** One sentence, written for someone looking at a player that will not start. */
  reason: string;
  /** Lower-case, without the dot. */
  container: string;
  videoCodec?: string;
  audioCodec?: string;
  /** Whether the HLS pass would also have to re-encode the audio. */
  transcodesAudio: boolean;
  /**
   * Set when the file is a **fragmented** MP4 — the one shape a browser opens
   * and still cannot stream. Reported rather than merely acted on, because the
   * panel has to be able to say why a file the browser "supports" is being
   * remuxed anyway.
   */
  fragmented?: boolean;
}

function firstOfKind(probe: MediaProbe, kind: "video" | "audio"): string | undefined {
  // ⚠️ Cover art rides in an MKV as a video stream of `mjpeg` or `png`. Treating
  // it as *the* video stream turns a plain music file into "unsupported".
  const stream = probe.streams.find(
    (candidate) =>
      candidate.kind === kind && !(kind === "video" && ["mjpeg", "png", "bmp", "gif"].includes(candidate.codec ?? "")),
  );
  return stream?.codec?.toLowerCase();
}

/**
 * How this file should reach a browser.
 *
 * Pure: it takes the extension and what `ffprobe` already said, and returns a
 * decision. That is what makes it testable without a media file, and what lets
 * the answer be cached — nothing here reads the disk.
 */
export function decidePlayback(ext: string, probe: MediaProbe, layout?: ContainerLayout): PlaybackVerdict {
  const container = ext.toLowerCase().replace(/^\./, "");
  const videoCodec = firstOfKind(probe, "video");
  const audioCodec = firstOfKind(probe, "audio");

  const base = { container, ...(videoCodec ? { videoCodec } : {}), ...(audioCodec ? { audioCodec } : {}) };

  /**
   * 🔴 **A fragmented MP4 is not a direct download, whatever its codecs say.**
   *
   * This is the case the container-and-codec check got wrong, and it got it
   * wrong in the most convincing way: MP4, H.264 High, AAC-LC, `moov` first,
   * range requests all correct, first byte in 1 ms — every measurement said
   * "serve it directly", and the browser sat on a spinner. The samples are in
   * 1475 `moof` fragments and nothing indexes them, so Chrome read the *whole
   * file* to find the duration: 468 range requests, **3.74 GB on the wire for a
   * 437 MB file**, before a single frame.
   *
   * ⚠️ **It is not about size.** The same 73 minutes remuxed to a plain
   * `moov`+`mdat` MP4 — same codecs, same 439 MB — took one request and 11.8 MB.
   * A size threshold would have punished every large file and still missed a
   * fragmented small one.
   *
   * HLS is the right answer because ffmpeg reads the fragments once,
   * sequentially, and the player then asks for six seconds at a time. The video
   * is still copied, never re-encoded.
   */
  if (layout?.fragmented === true && isIsoBmff(container)) {
    const transcodes = audioCodec !== undefined && !TS_COPYABLE_AUDIO.has(audioCodec);
    if (videoCodec === undefined || TS_COPYABLE_VIDEO.has(videoCodec)) {
      return {
        ...base,
        mode: "hls",
        fragmented: true,
        transcodesAudio: transcodes,
        reason:
          "This MP4 is fragmented: the samples live in `moof` fragments with no index, so a browser has to read the whole file before it can play a second of it. Served as HLS segments instead — the video is still copied, not re-encoded.",
      };
    }
    return {
      ...base,
      mode: "unsupported",
      fragmented: true,
      transcodesAudio: false,
      reason: `This MP4 is fragmented, so it cannot be streamed directly, and ${videoCodec.toUpperCase()} cannot be carried by HLS segments without re-encoding the video, which CasaTube does not do. Download the file instead.`,
    };
  }

  if (PLAYABLE_CONTAINERS.has(container)) {
    const videoOk = videoCodec === undefined || PLAYABLE_VIDEO.has(videoCodec);
    // 🔴 Opus is legal in MP4 and Safari does not decode it. This is the exact
    // case the brief names, and the one an extension-only check gets wrong: the
    // container is fine, the file still will not play on the only device that
    // matters here.
    const opusInMp4 = audioCodec === "opus" && ["mp4", "m4v", "mov"].includes(container);
    const audioOk = audioCodec === undefined || (PLAYABLE_AUDIO.has(audioCodec) && !opusInMp4);

    if (videoOk && audioOk) {
      return {
        ...base,
        mode: "direct",
        transcodesAudio: false,
        reason: `${container.toUpperCase()} with ${videoCodec ?? "no video"}/${audioCodec ?? "no audio"} plays as it is.`,
      };
    }
    if (opusInMp4 && videoOk) {
      return {
        ...base,
        mode: "hls",
        transcodesAudio: true,
        reason: "Opus inside MP4 is not decoded by Safari — the audio is converted to AAC.",
      };
    }
  }

  if (videoCodec !== undefined && !TS_COPYABLE_VIDEO.has(videoCodec)) {
    return {
      ...base,
      mode: "unsupported",
      transcodesAudio: false,
      reason: `${videoCodec.toUpperCase()} cannot be carried by HLS segments without re-encoding the video, which CasaTube does not do. Download the file instead.`,
    };
  }

  const transcodesAudio = audioCodec !== undefined && !TS_COPYABLE_AUDIO.has(audioCodec);
  return {
    ...base,
    mode: "hls",
    transcodesAudio,
    reason: `${container.toUpperCase() || "This container"} is not opened by browsers; the ${videoCodec ?? "video"} stream is copied into HLS segments${transcodesAudio ? ` and the ${audioCodec ?? "audio"} audio converted to AAC` : ""}.`,
  };
}

// --- The ffmpeg command -----------------------------------------------------

export interface FfmpegArgsOptions {
  segmentSeconds?: number;
  /** From the verdict. `aac`/`mp3`/`ac3` are copied; anything else is re-encoded. */
  audioCodec?: string;
  /**
   * Which audio track, counted among the **audio** streams — `0` is the first.
   *
   * Absent means ffmpeg's own choice, which is what every session did before
   * this existed and what a file with one audio track still wants.
   */
  audioIndex?: number;
}

/**
 * The whole command, as a pure function, so the flags can be asserted without
 * running anything.
 *
 * Every flag is load-bearing:
 *
 * - `-c:v copy` — the point. See the module header.
 * - `-hls_list_size 0` — **keep every segment in the index**. The default drops
 *   old entries, which leaves a playlist you can only go forwards in; seeking
 *   *backwards* is half of what a person means by seeking.
 * - `-hls_playlist_type event` — the playlist is appended to as segments appear
 *   and gets its `#EXT-X-ENDLIST` when ffmpeg finishes, so playback can start
 *   on the first segment instead of waiting for the last.
 * - `-sn -dn` — drop subtitle and data streams. An MKV routinely carries
 *   embedded SRT or ASS, and MPEG-TS cannot hold either: without this the whole
 *   remux fails on a file whose *video* was perfectly copyable.
 * - `-ac 2` (only when re-encoding) — a 5.1 track downmixed for a tablet.
 * - `-nostdin` — ffmpeg reads stdin by default and a spawned one with an
 *   inherited terminal will happily eat keystrokes.
 */
export function buildFfmpegArgs(input: string, dir: string, options: FfmpegArgsOptions = {}): string[] {
  const seconds = options.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS;
  const audio = options.audioCodec?.toLowerCase();
  const copyAudio = audio !== undefined && TS_COPYABLE_AUDIO.has(audio);

  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-i", input,
    /**
     * 🔴 **Which audio, when one was asked for.** Without any `-map`, ffmpeg
     * picks a single "best" audio stream by its own rules — so a file with
     * English and Spanish tracks played one of them and the other never left
     * the server. There was no way to ask for the second.
     *
     * ⚠️ `0:v:0?` with the question mark. It makes the video map *optional*, so
     * the same argument list is still correct for a container that turns out to
     * have no video stream at all — without it ffmpeg exits with "Stream map
     * '0:v:0' matches no streams", which would turn choosing an audio track
     * into a failed playback.
     */
    ...(options.audioIndex === undefined
      ? []
      : ["-map", "0:v:0?", "-map", `0:a:${options.audioIndex}`]),
    "-c:v", "copy",
    ...(copyAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]),
    "-sn",
    "-dn",
    "-f", "hls",
    "-hls_time", String(seconds),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", join(dir, "%05d.ts"),
    join(dir, PLAYLIST_NAME),
  ];
}

/**
 * Tells the player to begin at the beginning.
 *
 * 🔴 Not cosmetic, and found by watching it fail. An `EVENT` playlist with no
 * `#EXT-X-ENDLIST` yet — which is every playlist for the first few seconds,
 * while ffmpeg is still working — is treated by Chrome's HLS as **live**, and a
 * live stream starts at the live edge. Opening the Dua Lipa MKV therefore began
 * playback at 3:28 of 4:22: the point ffmpeg had reached, not the start of the
 * video. Nothing errored; it simply played the wrong part of the film.
 *
 * `EXT-X-START` is the tag for exactly this, and it costs one line. Safari
 * follows the EVENT convention and starts at zero anyway, so this is Chrome and
 * Firefox catching up rather than a workaround for a bug.
 */
const START_AT_ZERO = "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES";

/**
 * Point every segment line in the playlist back at our own route, and pin the
 * start to zero.
 *
 * 🔴 The rewrite is necessary, not cosmetic. ffmpeg writes bare filenames
 * (`00000.ts`), which a player resolves against the playlist's URL — and our
 * playlist URL is `/api/library/hls/index.m3u8?path=…`, whose query string is
 * **not** part of that resolution. The player would ask for
 * `/api/library/hls/00000.ts` with no idea which file it belongs to. Rewriting
 * on the way out keeps ffmpeg's own output on disk untouched and correct.
 */
export function rewritePlaylist(playlist: string, relPath: string, audioIndex?: number): string {
  // ⚠️ The audio choice travels with every segment URL. The query string is not
  // part of how a player resolves a relative URI, so a segment line that
  // carried only the path would be fetched from the default session.
  const suffix =
    `?path=${encodeURIComponent(relPath)}` +
    (audioIndex === undefined ? "" : `&audio=${audioIndex}`);
  const lines = playlist.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return line;
    return `${trimmed}${suffix}`;
  });

  // After `#EXTM3U`, which the spec requires to be the first line.
  const header = lines.findIndex((line) => line.trim() === "#EXTM3U");
  if (header !== -1 && !playlist.includes("#EXT-X-START")) lines.splice(header + 1, 0, START_AT_ZERO);
  return lines.join("\n");
}

/** Segment URIs listed in a playlist, in order. */
export function playlistSegments(playlist: string): string[] {
  return playlist
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// --- Sessions ---------------------------------------------------------------

export type SessionState = "starting" | "running" | "complete" | "failed";

export interface HlsSessionInfo {
  /** Library-relative path of the file being remuxed. */
  path: string;
  /** The directory name under `TEMP_DIR/hls`, derived from the path. */
  id: string;
  state: SessionState;
  /** Epoch milliseconds. */
  startedAt: number;
  lastAccessAt: number;
  /** Segments listed in the playlist so far. */
  segments: number;
  /** What this session is occupying on disk, right now. */
  bytes: number;
  error?: string;
}

interface Session {
  id: string;
  relPath: string;
  /** Which audio track this remux carries; absent means ffmpeg's own choice. */
  audioIndex?: number;
  dir: string;
  state: SessionState;
  startedAt: number;
  lastAccessAt: number;
  endedAt?: number;
  error?: string;
  proc?: { kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> };
}

export interface HlsOptions {
  /** The library root. Paths handed to this module are relative to it. */
  libraryRoot: string;
  /** `TEMP_DIR`. Sessions live in `<tempDir>/hls`. */
  tempDir: string;
  /**
   * What `ffprobe` says about a file, given a library-relative path.
   *
   * Injected rather than re-implemented: `core/library` already spawns
   * `ffprobe` under a deadline and parses it, and a second copy of that would be
   * a second thing to keep right. It is also the seam that lets the verdict be
   * tested without a media file.
   */
  probe(relPath: string): Promise<Result<MediaProbe, { _tag: string; message?: string }>>;
  ffmpegPath?: string;
  segmentSeconds?: number;
  idleMs?: number;
  transcodeIdleMs?: number;
  maxSessions?: number;
  sweepMs?: number;
  playlistTimeoutMs?: number;
  segmentWaitMs?: number;
  failedRetryMs?: number;
  /** Injectable so the sweep can be tested without waiting an hour. */
  now?(): number;
  log?(line: string): void;
}

export interface HlsStats {
  root: string;
  sessions: HlsSessionInfo[];
  /** Everything the sessions hold, in bytes. */
  bytes: number;
  maxSessions: number;
  idleMs: number;
  transcodeIdleMs: number;
}

export type HlsError =
  | TranscodeUnavailable
  | TranscodeBusy
  | LocalProbeFailed
  | NotFound
  | PathOutsideRoot
  | MountUnavailable
  | Timeout;

export interface HlsManager {
  readonly root: string;
  /** Cached per file. The `ffprobe` behind it runs once per (size, mtime). */
  verdict(relPath: string): Promise<Result<PlaybackVerdict, HlsError>>;
  /** Start the session if there is none, and answer with the index. */
  playlist(
    relPath: string,
    /** Which audio track, among the audio streams. Absent leaves ffmpeg's choice. */
    audioIndex?: number,
  ): Promise<Result<{ body: string; info: HlsSessionInfo }, HlsError>>;
  /** One segment, waiting briefly if ffmpeg is writing it right now. */
  segment(
    relPath: string,
    name: string,
    /** ⚠️ Must match the playlist the segment was listed in. */
    audioIndex?: number,
  ): Promise<Result<{ path: string; size: number }, HlsError>>;
  stats(): Promise<HlsStats>;
  /** Remove what has gone idle. Returns how many sessions went. */
  sweep(at?: number): Promise<number>;
  /** Stop the timer and kill everything. */
  stop(): Promise<void>;
  /**
   * Stop one session and reclaim its segments. Returns the bytes freed.
   *
   * Exists because the screen that lists sessions had no way to end one, and a
   * Close button with nothing behind it would have been the fourth control in
   * this project that moves without changing anything.
   */
  close(relPath: string): Promise<number>;
}

function describeCause(cause: unknown): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code: unknown }).code)
      : undefined;
  const message = cause instanceof Error ? cause.message : String(cause);
  return code === undefined ? message : `${code}: ${message}`;
}

/**
 * What identifies one remux: the file, **and which audio track was asked for**.
 *
 * 🔴 Not just the path. A file with English and Spanish audio produces two
 * different remuxes, and keying them both on the path would hand the second
 * viewer the first one's session — the menu would move and the sound would not.
 */
export function sessionKey(relPath: string, audioIndex?: number): string {
  return audioIndex === undefined ? relPath : `${relPath}#a${audioIndex}`;
}

/** A short, stable directory name per session — and one that cannot contain a separator. */
export function sessionId(relPath: string, audioIndex?: number): string {
  return createHash("sha256").update(sessionKey(relPath, audioIndex)).digest("hex").slice(0, 16);
}

/**
 * Resolve a library-relative path, refusing anything that leaves the root.
 *
 * 🔴 The second of the two independent checks the library routes already run.
 * `safeDestination` refuses the *string* at the HTTP edge; this refuses the
 * *resolved* path here, because a rule enforced only at the edge is a rule the
 * next entry point walks past.
 */
function resolveInRoot(root: string, relPath: string): Result<string, PathOutsideRoot> {
  if (relPath.trim() === "" || isAbsolute(relPath) || relPath.includes("\0")) {
    return Result.err(new PathOutsideRoot({ path: relPath, root }));
  }
  const absolute = resolve(root, relPath);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    return Result.err(new PathOutsideRoot({ path: relPath, root }));
  }
  return Result.ok(absolute);
}

export function createHlsManager(options: HlsOptions): HlsManager {
  const libraryRoot = resolve(options.libraryRoot);
  const root = join(resolve(options.tempDir), HLS_DIR);
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const segmentSeconds = options.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const transcodeIdleMs = options.transcodeIdleMs ?? DEFAULT_TRANSCODE_IDLE_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
  const playlistTimeoutMs = options.playlistTimeoutMs ?? DEFAULT_PLAYLIST_TIMEOUT_MS;
  const segmentWaitMs = options.segmentWaitMs ?? DEFAULT_SEGMENT_WAIT_MS;
  const failedRetryMs = options.failedRetryMs ?? DEFAULT_FAILED_RETRY_MS;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.log(line));

  const sessions = new Map<string, Session>();
  const verdicts = new Map<string, { key: string; verdict: PlaybackVerdict }>();

  /**
   * 🔴 Wipe on startup, before anything can be served.
   *
   * A crash mid-remux leaves a directory of `.ts` files that nothing will ever
   * read again and nothing will ever delete — the sweep only knows about
   * sessions in memory, and a restart forgets them all. Without this the temp
   * disk grows by one film per crash, for ever.
   */
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  // --- verdict cache ------------------------------------------------------

  /**
   * The head of an MP4, so the verdict can see the one thing `ffprobe` never
   * reports: whether the file is fragmented.
   *
   * ⚠️ **A failure here is not a failure of the verdict.** The read is a
   * 256 KB optimisation on a mount that may be slow or gone; if it cannot be
   * done, the answer is `undefined` — "I could not tell" — and `decidePlayback`
   * falls back to deciding on container and codec alone, exactly as before.
   * Turning an unreadable head into a playback error would take a file that
   * plays fine and make it unplayable.
   *
   * 📌 Called once per (size, mtime), behind the same cache as the probe.
   */
  async function readLayout(absolute: string, ext: string): Promise<ContainerLayout | undefined> {
    if (!isIsoBmff(ext.replace(/^\./, ""))) return undefined;
    const raced = await withDeadline(
      Bun.file(absolute)
        .slice(0, MP4_HEAD_BYTES)
        .bytes()
        .then((bytes) => readMp4Layout(bytes))
        .catch(() => undefined),
      STAT_TIMEOUT_MS,
      absolute,
      "reading a file",
    );
    return Result.isError(raced) ? undefined : raced.value;
  }

  async function verdict(relPath: string): Promise<Result<PlaybackVerdict, HlsError>> {
    const absolute = resolveInRoot(libraryRoot, relPath);
    if (Result.isError(absolute)) return absolute;

    const raced = await withDeadline(
      stat(absolute.value).then(
        (value) => ({ ok: true as const, value }),
        (cause: unknown) => ({ ok: false as const, cause }),
      ),
      STAT_TIMEOUT_MS,
      absolute.value,
      "reading a file",
    );
    if (Result.isError(raced)) return raced;
    if (!raced.value.ok) {
      return Result.err(new NotFound({ what: "library file", id: relPath }));
    }
    const stats = raced.value.value;
    if (!stats.isFile()) return Result.err(new NotFound({ what: "library file", id: relPath }));

    // 📌 Keyed on size and mtime, not on the path alone: a file replaced in
    // place — a re-download over the same name — is a different file, and a
    // verdict cached on the name would keep describing the old one.
    const key = `${stats.size}:${stats.mtimeMs}`;
    const cached = verdicts.get(relPath);
    if (cached !== undefined && cached.key === key) return Result.ok(cached.verdict);

    const probed = await options.probe(relPath);
    if (Result.isError(probed)) {
      return Result.err(
        new LocalProbeFailed({ path: relPath, detail: probed.error.message ?? probed.error._tag }),
      );
    }

    const ext = relPath.includes(".") ? relPath.slice(relPath.lastIndexOf(".") + 1) : "";
    const layout = await readLayout(absolute.value, ext.toLowerCase());
    const decided = layout === undefined ? decidePlayback(ext, probed.value) : decidePlayback(ext, probed.value, layout);
    verdicts.set(relPath, { key, verdict: decided });
    return Result.ok(decided);
  }

  // --- session lifecycle --------------------------------------------------

  function info(session: Session, segments = 0, bytes = 0): HlsSessionInfo {
    return {
      path: session.relPath,
      id: session.id,
      state: session.state,
      startedAt: session.startedAt,
      lastAccessAt: session.lastAccessAt,
      segments,
      bytes,
      ...(session.error === undefined ? {} : { error: session.error }),
    };
  }

  /**
   * Drop a session from the map **now**, and remove its bytes as soon as the
   * filesystem can. The returned promise is what a caller awaits when it needs
   * the disk actually free — `stop()` does; `ensure` deliberately does not,
   * because it must not yield (see the note there).
   */
  function discard(session: Session, why: string): Promise<void> {
    sessions.delete(session.relPath);
    try {
      session.proc?.kill();
    } catch {
      // Already gone.
    }
    log(`[casatube] hls: dropped ${session.relPath} (${why})`);
    return rm(session.dir, { recursive: true, force: true }).catch(() => {});
  }

  function spawn(
    relPath: string,
    absolute: string,
    audioCodec: string | undefined,
    audioIndex: number | undefined,
  ): Session {
    const id = sessionId(relPath, audioIndex);
    const dir = join(root, id);
    // Synchronous on purpose — see `ensure`. Also removes whatever a previous,
    // discarded session left behind under the same (path-derived) name.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const at = now();
    const session: Session = {
      id,
      relPath,
      dir,
      state: "starting",
      startedAt: at,
      lastAccessAt: at,
      ...(audioIndex === undefined ? {} : { audioIndex }),
    };

    const args = buildFfmpegArgs(absolute, dir, {
      segmentSeconds,
      ...(audioCodec === undefined ? {} : { audioCodec }),
      ...(audioIndex === undefined ? {} : { audioIndex }),
    });

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      // `Bun.spawn`, never `Bun.$`: library filenames are full of quotes and
      // brackets, and a shell in the middle would reinterpret them.
      proc = Bun.spawn([ffmpegPath, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    } catch (cause) {
      session.state = "failed";
      session.error = `ffmpeg could not start: ${describeCause(cause)}`;
      session.endedAt = at;
      return session;
    }

    session.proc = proc;
    session.state = "running";

    const stderr = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    void (async () => {
      const code = await proc.exited;
      const message = (await stderr.catch(() => "")).trim();
      session.endedAt = now();
      if (code === 0) {
        session.state = "complete";
        log(`[casatube] hls: finished ${relPath}`);
      } else {
        session.state = "failed";
        session.error = message || `ffmpeg exited with ${code}`;
        log(`[casatube] hls: ffmpeg failed on ${relPath}: ${session.error}`);
      }
    })();

    log(`[casatube] hls: started ${relPath} → ${dir}`);
    return session;
  }

  /**
   * The one session for this file, started if there is none.
   *
   * 🔴 **Synchronous up to and including `sessions.set`, and that is the whole
   * mutual exclusion.** Two requests arriving in the same tick both reach here;
   * the first creates and registers the session before yielding, so the second
   * finds it. An `await` anywhere above the `set` — a stat, a probe, a promise
   * cache — reopens the window and produces two ffmpeg processes writing into
   * the same directory, which corrupts the playlist as well as burning the CPU
   * twice. The async work (the verdict) happens *before* this is called.
   */
  function ensure(
    relPath: string,
    absolute: string,
    audioCodec: string | undefined,
    audioIndex: number | undefined,
  ): Result<Session, TranscodeBusy> {
    const at = now();
    const key = sessionKey(relPath, audioIndex);
    const existing = sessions.get(key);
    if (existing !== undefined) {
      const stale = existing.state === "failed" && at - (existing.endedAt ?? existing.startedAt) >= failedRetryMs;
      if (!stale) {
        existing.lastAccessAt = at;
        return Result.ok(existing);
      }
      void discard(existing, "retrying after a failure");
    }

    if (sessions.size >= maxSessions) {
      // Evict the least recently used session that is not mid-remux: throwing
      // away finished segments costs a re-remux, killing a running ffmpeg
      // throws away work someone is probably watching right now.
      const idle = [...sessions.values()]
        .filter((candidate) => candidate.state === "complete" || candidate.state === "failed")
        .sort((a, b) => a.lastAccessAt - b.lastAccessAt)[0];
      if (idle === undefined) {
        return Result.err(new TranscodeBusy({ path: relPath, active: sessions.size, limit: maxSessions }));
      }
      void discard(idle, "making room");
    }

    const session = spawn(relPath, absolute, audioCodec, audioIndex);
    sessions.set(key, session);
    return Result.ok(session);
  }

  // --- reading what ffmpeg has written ------------------------------------

  async function readPlaylist(session: Session): Promise<string | null> {
    const file = Bun.file(join(session.dir, PLAYLIST_NAME));
    if (!(await file.exists())) return null;
    return file.text();
  }

  /**
   * Wait until the playlist names at least one segment.
   *
   * ⚠️ The existence of `index.m3u8` is not enough: ffmpeg creates it with a
   * header and no entries, and a player handed an empty playlist gives up
   * rather than retrying.
   */
  async function waitForPlaylist(session: Session): Promise<Result<string, HlsError>> {
    const deadline = Date.now() + playlistTimeoutMs;
    for (;;) {
      const playlist = await readPlaylist(session);
      if (playlist !== null && playlistSegments(playlist).length > 0) return Result.ok(playlist);
      if (session.state === "failed") {
        return Result.err(
          new TranscodeUnavailable({ path: session.relPath, detail: session.error ?? "ffmpeg failed" }),
        );
      }
      if (session.state === "complete" && playlist !== null) {
        // Finished without producing a single segment: an empty or unreadable
        // input. Reporting "still waiting" would be the wrong answer for ever.
        return Result.err(
          new TranscodeUnavailable({ path: session.relPath, detail: "ffmpeg produced no segments" }),
        );
      }
      if (Date.now() >= deadline) {
        return Result.err(
          new TranscodeUnavailable({
            path: session.relPath,
            detail: `no segment appeared within ${playlistTimeoutMs} ms`,
          }),
        );
      }
      await Bun.sleep(100);
    }
  }

  async function playlist(
    relPath: string,
    audioIndex?: number,
  ): Promise<Result<{ body: string; info: HlsSessionInfo }, HlsError>> {
    const decided = await verdict(relPath);
    if (Result.isError(decided)) return decided;
    if (decided.value.mode === "direct") {
      return Result.err(
        new TranscodeUnavailable({
          path: relPath,
          detail: `${decided.value.reason} Use GET /api/library/file instead.`,
        }),
      );
    }
    if (decided.value.mode === "unsupported") {
      return Result.err(new TranscodeUnavailable({ path: relPath, detail: decided.value.reason }));
    }

    const absolute = resolveInRoot(libraryRoot, relPath);
    if (Result.isError(absolute)) return absolute;

    const session = ensure(relPath, absolute.value, decided.value.audioCodec, audioIndex);
    if (Result.isError(session)) return session;

    const ready = await waitForPlaylist(session.value);
    if (Result.isError(ready)) return ready;

    session.value.lastAccessAt = now();
    const segments = playlistSegments(ready.value);
    return Result.ok({
      body: rewritePlaylist(ready.value, relPath, audioIndex),
      info: info(session.value, segments.length, await bytesOf(session.value.dir)),
    });
  }

  /**
   * One segment, and **only once it is finished**.
   *
   * 🔴 The subtle part, and it was found by watching Chrome die 15 seconds into
   * the real MKV with `DEMUXER_ERROR_COULD_NOT_PARSE`. "The file exists" is not
   * "the segment is written": ffmpeg creates `00002.ts` and fills it over the
   * next fraction of a second, and a player handed those first bytes gets a
   * truncated MPEG-TS. It does not retry — it fails the whole stream. Worse,
   * with a cacheable response the browser then keeps the broken copy.
   *
   * The playlist is the authority. ffmpeg appends a segment's `#EXTINF` line
   * **after** closing the file, so a name that appears in `index.m3u8` names a
   * complete segment, always. That single rule also gives the brief's "wait a
   * moment if it is being written right now" for free: the wait is for the
   * playlist to catch up, not for a file to stop growing, which is not
   * something a reader can observe.
   */
  async function segment(
    relPath: string,
    name: string,
    audioIndex?: number,
  ): Promise<Result<{ path: string; size: number }, HlsError>> {
    if (!SEGMENT_NAME.test(name)) {
      return Result.err(new NotFound({ what: "hls segment", id: name }));
    }
    // ⚠️ The same key the playlist was served from. A segment asked for
    // without it would be answered from the *default* session — a player
    // switching language would keep hearing the old track while its menu said
    // otherwise, which is the failure this key exists to prevent.
    const session = sessions.get(sessionKey(relPath, audioIndex));
    if (session === undefined) {
      // The session went while the player was watching — swept, evicted, or the
      // server restarted. Nothing to do but say so; the player reloads the
      // playlist, which starts a new session.
      return Result.err(new NotFound({ what: "hls session", id: relPath }));
    }
    session.lastAccessAt = now();

    const absolute = join(session.dir, name);
    const deadline = Date.now() + segmentWaitMs;
    for (;;) {
      const playlist = await readPlaylist(session);
      if (playlist !== null && playlistSegments(playlist).includes(name)) {
        const file = Bun.file(absolute);
        if (await file.exists()) return Result.ok({ path: absolute, size: file.size });
      }
      // Once ffmpeg has stopped, whatever is not listed never will be.
      if (session.state !== "running" && session.state !== "starting") break;
      if (Date.now() >= deadline) break;
      await Bun.sleep(50);
    }
    return Result.err(new NotFound({ what: "hls segment", id: name }));
  }

  // --- accounting and cleanup ---------------------------------------------

  async function bytesOf(dir: string): Promise<number> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const sizes = await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map((entry) =>
            stat(join(dir, entry.name)).then(
              (stats) => stats.size,
              () => 0,
            ),
          ),
      );
      return sizes.reduce((total, size) => total + size, 0);
    } catch {
      return 0;
    }
  }

  async function stats(): Promise<HlsStats> {
    const listed = await Promise.all(
      [...sessions.values()].map(async (session) => {
        const playlistText = await readPlaylist(session);
        return info(
          session,
          playlistText === null ? 0 : playlistSegments(playlistText).length,
          await bytesOf(session.dir),
        );
      }),
    );
    return {
      root,
      sessions: listed,
      bytes: listed.reduce((total, entry) => total + entry.bytes, 0),
      maxSessions,
      idleMs,
      transcodeIdleMs,
    };
  }

  /**
   * Remove what nobody is reading.
   *
   * Two deadlines, because the two cases cost different things. A **finished**
   * session is disk, and an hour of grace is cheap. A session whose ffmpeg is
   * **still running** is CPU, and five minutes of nobody asking for a segment
   * means the tab is closed — an orphaned remux is the failure this module is
   * most likely to cause and the one nobody would notice.
   */
  async function sweep(at: number = now()): Promise<number> {
    const doomed = [...sessions.values()].filter((session) => {
      const idle = at - session.lastAccessAt;
      const running = session.state === "running" || session.state === "starting";
      return running ? idle >= transcodeIdleMs : idle >= idleMs;
    });
    const removals = doomed.map((session) => {
      const running = session.state === "running" || session.state === "starting";
      return discard(session, running ? "nobody is reading it and ffmpeg is still running" : "idle");
    });
    // Wait for the processes *and* the bytes: a caller that awaits a sweep is
    // asking whether the disk is free, not whether we have decided it should be.
    await Promise.all([
      ...removals,
      ...doomed.map((session) => session.proc?.exited ?? Promise.resolve(0)),
    ]);
    return doomed.length;
  }

  const timer = setInterval(() => {
    void sweep().catch((cause: unknown) => log(`[casatube] hls sweep failed: ${describeCause(cause)}`));
  }, sweepMs);
  // Nothing here should hold a process open — least of all a test runner.
  timer.unref?.();

  /**
   * ⚠️ Awaits the **removals**, not just the kills. A shutdown that returns
   * before the directories are gone leaves a film's worth of `.ts` behind — the
   * startup wipe would eventually collect it, but only on the next start, and
   * a machine that restarts rarely is exactly where that hurts.
   */
  async function stop(): Promise<void> {
    clearInterval(timer);
    const all = [...sessions.values()];
    const removals = all.map((session) => discard(session, "shutting down"));
    await Promise.all([...removals, ...all.map((session) => session.proc?.exited ?? Promise.resolve(0))]);
  }

  /**
   * Stop one session and reclaim its segments.
   *
   * Safe while ffmpeg is still writing: `discard` kills the process before
   * removing the directory, so a session someone is watching stops cleanly
   * rather than having the floor pulled out from under it.
   */
  async function close(relPath: string): Promise<number> {
    const session = sessions.get(relPath);
    if (!session) return 0;
    const freed = await bytesOf(session.dir).catch(() => 0);
    await discard(session, "closed from the interface");
    return freed;
  }

  return { root, verdict, playlist, segment, stats, sweep, stop, close };
}
