/**
 * The built-in yt-dlp provider.
 *
 * This file is the **only** place in CasaTube that is allowed to know what a
 * yt-dlp flag or a `format_id` looks like. Everything above it speaks the
 * provider-neutral vocabulary in `core/types.ts` (PLAN §5). If a yt-dlp string
 * escapes this module, the seam has leaked.
 *
 * ---------------------------------------------------------------------------
 * Verified against the real binary (yt-dlp 2026.08.19, 2026-08-26). Do not
 * "simplify" any of the following away — each one was paid for once:
 *
 * 1. `--color no` DOES NOT EXIST. It is `--color never`. With `no`, yt-dlp
 *    exits 2 with `"no" is not a valid color policy` — which never says the
 *    word "option", so it does not read like a flag mistake.
 *
 * 2. Download progress and post-processing progress come out of DIFFERENT
 *    PIPES, and the reason is `--quiet`:
 *
 *      YoutubeDL.py:664  screen = sys.stderr if quiet else stdout
 *      downloader/common.py:331   download progress -> _out_files.out  (stdout, always)
 *      postprocessor/common.py:188 postprocess progress -> to_screen -> screen
 *
 *    We pass `-q --progress` (quiet, but keep progress) so stdout carries
 *    nothing but our own structured lines. The price is that `postprocess:`
 *    lines land on **stderr**. Reading only stdout makes post-processing look
 *    like a hang. We read both.
 *
 * 3. One 1080p download is SEVERAL FILES IN SEQUENCE (video, then one file per
 *    audio language). yt-dlp restarts its byte counter at 0 for every one of
 *    them. `ProgressAccumulator` sums across files so the bar never resets.
 *
 * 4. Progress is read from `--progress-template`, never from the human bar and
 *    never through a PTY. `%(...)s` conversion is deliberate: with `%(x)d` a
 *    missing value raises, with `%(x)s` it renders `NA`, which we parse away.
 *
 * 5. `FFmpegMergerPP` (postprocessor/ffmpeg.py:822) merges with `-c copy` and
 *    `-map` ONLY. It writes NO language metadata. That is the root of the
 *    HomeTube bug (PLAN §4.1): the tag in the output is whatever the DASH
 *    fragment happened to carry. We pass `-metadata:s:a:N language=...`
 *    explicitly, from `plan.languageTags`.
 *
 * 6. With formats to merge and no ffmpeg installed, yt-dlp EXITS 0, prints only
 *    a warning, and `--print after_move:%(filepath)s` reports a path that was
 *    never created. So `fetch` stats the file before returning Ok, and does not
 *    pass `--no-warnings` (warnings are routed to `ctx.log`).
 *
 * ---------------------------------------------------------------------------
 * ## Credentials
 *
 * Every invocation that touches the network — `probe`, `list` and `fetch` —
 * asks the {@link CredentialResolver} for the URL first and releases what it
 * got in a `finally`. Two shapes reach the command line, and no more:
 *
 * - `cookies` → `--cookies <file>`, where the file is written 0600 into a 0700
 *   temp directory for the life of the process and **deleted afterwards**. Not
 *   `--cookies-from-browser`: there is no browser in the container.
 * - `password` → `--username` / `--password`.
 *
 * ⚠️ `--password` puts the password in **argv**, where anything that can read
 * `/proc` on the host can see it. yt-dlp offers no file-based alternative that
 * does not involve `.netrc`, whose keying by "machine" does not survive the
 * scope model. Stated rather than hidden, and surfaced by the credential test
 * endpoint — a single-tenant home server is the context in which it is
 * acceptable.
 *
 * ⚠️ Nothing here logs a secret, and `redactLine` scrubs the password out of
 * every stderr line on the way to `ctx.log` anyway. That is defence against a
 * future yt-dlp echoing an argument, not against today's.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import { Result } from "better-result";
import {
  AuthRequired,
  Blocked,
  FormatUnavailable,
  ProbeFailed,
  RateLimited,
  UnsupportedUrl,
  type ProviderError,
} from "../core/errors";
/**
 * ⚠️ Type-only, and it has to stay that way. `core/credentials.ts` imports the
 * schema, which imports `core/types.ts`; a *value* import here would close a
 * cycle that `tsc` is perfectly happy with and that blows up at module
 * initialisation (see the import-cycle entry in docs/DISCOVERIES.md). The
 * resolver arrives through `YtdlpOptions`, never through an import.
 */
import type { CredentialLease, CredentialResolver } from "../core/credentials";
import type {
  AudioTrack,
  DiscoveredItem,
  DownloadPlan,
  FetchResult,
  MediaInfo,
  ProgressUpdate,
  Provider,
  ProviderContext,
  SubtitleTrack,
  VideoFormat,
} from "../core/types";

// --- The process seam -------------------------------------------------------
// Injected so the tests never touch the network. The provider hands over an
// argv and two line sinks; whoever runs it is not this module's business.

export interface SpawnRequest {
  args: string[];
  cwd?: string;
  signal?: AbortSignal;
  onStdout(line: string): void;
  onStderr(line: string): void;
}

export interface SpawnOutcome {
  exitCode: number;
}

export type Spawner = (req: SpawnRequest) => Promise<SpawnOutcome>;

/** Splits a byte stream into lines on `\n` **and** `\r`. */
async function pump(
  stream: ReadableStream<Uint8Array>,
  sink: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.search(/[\r\n]/);
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length > 0) sink(line);
      index = buffer.search(/[\r\n]/);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) sink(buffer);
}

/**
 * The real spawner. `Bun.spawn`, never `Bun.$` — a shell in the middle would
 * reinterpret quoting in titles, format selectors and ffmpeg arguments.
 */
export const bunSpawner: Spawner = async (req) => {
  const proc = Bun.spawn(req.args, {
    cwd: req.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const kill = () => {
    try {
      proc.kill();
    } catch {
      // Already gone. Nothing to do.
    }
  };

  if (req.signal) {
    if (req.signal.aborted) kill();
    else req.signal.addEventListener("abort", kill, { once: true });
  }

  try {
    await Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array>, req.onStdout),
      pump(proc.stderr as ReadableStream<Uint8Array>, req.onStderr),
    ]);
    return { exitCode: await proc.exited };
  } finally {
    req.signal?.removeEventListener("abort", kill);
  }
};

// --- Structured progress ----------------------------------------------------

/** Subtitle sidecars, which travel with the video and are collected after the run. */
const SUBTITLE_SIDECAR_EXTENSIONS = new Set([
  ".vtt", ".srt", ".ass", ".ssa", ".ttml", ".srv1", ".srv2", ".srv3", ".json3", ".lrc", ".sbv",
]);

/**
 * The thumbnail, in every form it can arrive in.
 *
 * `--convert-thumbnails jpg` makes it a JPEG, which is what media servers read
 * — but the conversion is an ffmpeg post-processor, so on a machine without
 * ffmpeg the original survives instead. YouTube serves WebP; other sites serve
 * PNG. All three are accepted rather than losing the picture over the format.
 */
const THUMBNAIL_SIDECAR_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

/** Everything yt-dlp writes *beside* the media file. */
const SIDECAR_EXTENSIONS = new Set([
  ...SUBTITLE_SIDECAR_EXTENSIONS,
  ...THUMBNAIL_SIDECAR_EXTENSIONS,
]);

const DL_TAG = "CT-DL";
const PP_TAG = "CT-PP";
const FILE_TAG = "CT-FILE";

/**
 * `filename` is last on purpose: it is the only field that can contain the
 * separator, so the parser can rejoin the tail without ambiguity.
 */
const DOWNLOAD_TEMPLATE =
  `download:${DL_TAG}|%(progress.status)s|%(progress.downloaded_bytes)s` +
  `|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s` +
  `|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s|%(progress.filename)s`;

const POSTPROCESS_TEMPLATE = `postprocess:${PP_TAG}|%(progress.status)s|%(progress.postprocessor)s`;

const FILEPATH_TEMPLATE = `after_move:${FILE_TAG}|%(filepath)s`;

export interface DownloadProgressLine {
  status: string;
  /**
   * Key for per-file bookkeeping.
   *
   * The filename, not the format id: subtitle sidecars come through this same
   * template with `format_id` set to `NA`, so keying on the id would collide
   * two different files into one counter.
   */
  key: string;
  doneBytes: number;
  totalBytes?: number;
  speed?: number;
  eta?: number;
  filename?: string;
}

/** yt-dlp renders a missing value as the literal `NA`. */
function num(field: string | undefined): number | undefined {
  if (field === undefined || field === "" || field === "NA") return undefined;
  const value = Number(field);
  return Number.isFinite(value) ? value : undefined;
}

function text(field: string | undefined): string | undefined {
  if (field === undefined || field === "" || field === "NA") return undefined;
  return field;
}

export function parseDownloadLine(line: string): DownloadProgressLine | null {
  if (!line.startsWith(`${DL_TAG}|`)) return null;
  const parts = line.split("|");
  const status = parts[1] ?? "";
  const done = num(parts[2]) ?? 0;
  const total = num(parts[3]) ?? num(parts[4]);
  const filename = text(parts.slice(8).join("|"));
  const key = filename ?? text(parts[7]) ?? "single";
  return {
    status,
    key,
    doneBytes: done,
    totalBytes: total,
    speed: num(parts[5]),
    eta: num(parts[6]),
    filename,
  };
}

export interface PostProcessLine {
  status: string;
  postprocessor?: string;
}

export function parsePostProcessLine(line: string): PostProcessLine | null {
  if (!line.startsWith(`${PP_TAG}|`)) return null;
  const parts = line.split("|");
  return { status: parts[1] ?? "", postprocessor: text(parts[2]) };
}

export function parseFilePathLine(line: string): string | null {
  if (!line.startsWith(`${FILE_TAG}|`)) return null;
  const path = line.slice(FILE_TAG.length + 1);
  return path.length > 0 ? path : null;
}

/**
 * Is this file part of what the progress bar is measuring?
 *
 * ⚠️ Verified against the real binary: with `--write-subs`, yt-dlp downloads
 * the **subtitle file first**, and reports it through the same
 * `--progress-template`. A 440-byte `.vtt` completes instantly, so a naive
 * accumulator shows 100% before the video has started a single byte — the same
 * lie as the per-file reset, from the other direction.
 *
 * Sidecars are excluded from the byte budget instead of being special-cased in
 * the bar. Their `format_id` is `NA`, so the extension is what identifies them.
 */
export function isMediaFile(filename: string | undefined): boolean {
  if (!filename) return true;
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return true;
  return !SIDECAR_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/**
 * Sums progress across the several files one download produces.
 *
 * yt-dlp counts bytes per file and starts again at zero for the next one. Per
 * file, a 1080p job would show 0-100% for the video and then 0-100% again for
 * every audio language. Here the totals accumulate, so the percentage only ever
 * describes the whole job.
 *
 * The total is the sum of the files **seen so far**: yt-dlp does not announce
 * the next file's size until it starts it. So adding an audio track can nudge
 * the percentage down a little (audio is a few percent of a video). That is a
 * truthful dip, not a reset — and it is the reason `doneBytes`/`totalBytes` are
 * reported alongside, so a UI can show real numbers rather than a lying bar.
 */
export class ProgressAccumulator {
  private readonly files = new Map<string, { done: number; total: number }>();

  /**
   * Folds one line into the running totals.
   *
   * Returns `null` for a file that is not part of the media byte budget — see
   * `isMediaFile`. Those lines are real progress, they are just progress on
   * something else.
   */
  update(line: DownloadProgressLine): ProgressUpdate | null {
    if (!isMediaFile(line.filename)) return null;
    const finished = line.status === "finished";
    // On `finished` the byte count is authoritative; before that a missing
    // total is better approximated by what has already arrived than by zero.
    const total = finished
      ? line.doneBytes
      : Math.max(line.totalBytes ?? 0, line.doneBytes);
    this.files.set(line.key, { done: line.doneBytes, total });

    const snapshot = this.snapshot();
    const speed = line.speed;
    const remaining = snapshot.totalBytes - snapshot.doneBytes;
    return {
      ...snapshot,
      percent: snapshot.totalBytes > 0
        ? Math.min(100, (snapshot.doneBytes / snapshot.totalBytes) * 100)
        : undefined,
      speed,
      // The per-file eta yt-dlp reports ignores the files still to come, so it
      // is recomputed against the accumulated remainder.
      eta: speed !== undefined && speed > 0
        ? Math.round(remaining / speed)
        : line.eta,
    };
  }

  /** Totals only — used to keep the UI alive during post-processing. */
  snapshot(): { doneBytes: number; totalBytes: number } {
    let doneBytes = 0;
    let totalBytes = 0;
    for (const file of this.files.values()) {
      doneBytes += file.done;
      totalBytes += file.total;
    }
    return { doneBytes, totalBytes };
  }

  fileCount(): number {
    return this.files.size;
  }
}

// --- Error mapping ----------------------------------------------------------
//
// Every pattern below was matched against a message the real binary produced,
// or against the source line that formats it. The comment on each says which.

/** Pulls the informative part out of yt-dlp's stderr. */
export function extractDetail(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => l.startsWith("ERROR:"));
  const chosen = errors.length > 0 ? errors : lines.slice(-3);
  const detail = chosen
    .join(" ")
    .replace(/^ERROR:\s*/, "")
    // The cookie how-to is three URLs of boilerplate on every auth failure.
    .replace(/\s*(Use --cookies-from-browser|See\s+https:\/\/github\.com\/yt-dlp).*$/i, "")
    .trim();
  return detail.length > 0 ? detail.slice(0, 500) : "yt-dlp failed without a message";
}

export interface ClassifyInput {
  stderr: string;
  url: string;
  /** The format selector that was asked for, when there was one. */
  wanted?: string;
}

export function classifyError({ stderr, url, wanted }: ClassifyInput): ProviderError {
  const t = stderr.toLowerCase();
  const detail = extractDetail(stderr);

  // 1. Bot check. Must come before the generic sign-in test: yt-dlp appends the
  //    same "Use --cookies..." login hint to this message as to a real auth
  //    failure (youtube/_video.py:4066), so the two look alike. A bot check is
  //    the IP being distrusted, not a missing account — PLAN §4.3 — so it is
  //    Blocked, and `demandsBackoff` slows the whole system down.
  if (
    /confirm you'?re not a bot/.test(t) ||
    /confirm that you'?re not a bot/.test(t) ||
    /captcha challenge/.test(t)
  ) {
    return new Blocked({ url, detail });
  }

  // 2. Throttling.
  //    "HTTP Error 429: Too Many Requests" — networking/exceptions.py:63 builds
  //    `HTTP Error {status}: {reason}`.
  //    "has been rate-limited by YouTube for up to an hour" — _video.py:4070.
  if (/http error 429/.test(t) || /too many requests/.test(t) || /rate-limited/.test(t)) {
    const anHour = /for up to an hour/.test(t);
    return new RateLimited(anHour ? { url, retryAfterMs: 3_600_000 } : { url });
  }

  // 3. Gone, geo-blocked, or DRM. Real messages, reproduced 2026-08-26:
  //      6SJNVb0GnPI -> "This video has been removed for violating YouTube's
  //                      policy on hate speech."
  //      aaaaaaaaaaa -> "Video unavailable" AND, minutes later on the same
  //                      binary, "This video is unavailable". The wording
  //                      depends on which player client answered, so the
  //                      pattern has to tolerate both.
  //      sJL6WA-aGkQ -> "The uploader has not made this video available in your
  //                      country"
  if (
    /video (?:is )?unavailable/.test(t) ||
    /has been removed/.test(t) ||
    /no longer available/.test(t) ||
    /this video has been terminated/.test(t) ||
    /account associated with this video has been/.test(t) ||
    /available in your country/.test(t) ||
    /not available from your location/.test(t) ||
    /geo restriction/.test(t) ||
    /blocked it in your country/.test(t) ||
    /drm protected/.test(t)
  ) {
    return new Blocked({ url, detail });
  }

  // 4. Needs a session. Real messages, reproduced 2026-08-26:
  //      Tq92D6wQ1mg -> "Sign in to confirm your age. Use --cookies-from-browser…"
  //      yZIXLfi8CZQ -> "Please sign in. Use --cookies-from-browser…"
  //    Members-only comes from YouTube's own `reason`/`subreason` text, which
  //    yt-dlp forwards verbatim (_video.py:4053-4066).
  if (
    /confirm your age/.test(t) ||
    /age-restricted/.test(t) ||
    /age_verification_required/.test(t) ||
    /inappropriate for some users/.test(t) ||
    /members[- ]only/.test(t) ||
    /members on level/.test(t) ||
    /join this channel/.test(t) ||
    /sign in/.test(t) ||
    /login details are needed/.test(t) ||
    /only available for registered users/.test(t)
  ) {
    return new AuthRequired({ url });
  }

  // 5. The format asked for is not there.
  //    "Requested format is not available" — YoutubeDL.py:3089.
  //    "No video formats found!" is the same problem seen from the other side:
  //    nothing downloadable was offered at all.
  if (/requested format is not available/.test(t) || /no video formats found/.test(t)) {
    return new FormatUnavailable({ url, wanted: wanted ?? "any" });
  }

  // 6. yt-dlp itself does not claim the URL. Cannot happen while this provider
  //    answers `supports` for everything, but the message exists.
  if (/unsupported url/.test(t)) {
    return new UnsupportedUrl({ url });
  }

  return new ProbeFailed({ url, detail });
}

// --- Translating yt-dlp's JSON into the neutral vocabulary ------------------

/** The shape of `yt-dlp -J`, as far as we rely on it. */
interface YtdlpFormat {
  format_id?: string;
  format_note?: string;
  ext?: string;
  protocol?: string;
  vcodec?: string;
  acodec?: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  vbr?: number | null;
  abr?: number | null;
  tbr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  language?: string | null;
  language_preference?: number | null;
}

interface YtdlpSubtitle {
  ext?: string;
  url?: string;
  name?: string;
}

interface YtdlpInfo {
  id?: string;
  title?: string;
  fulltitle?: string;
  duration?: number | null;
  thumbnail?: string | null;
  thumbnails?: Array<{ url?: string }>;
  uploader?: string | null;
  channel?: string | null;
  extractor?: string;
  extractor_key?: string;
  formats?: YtdlpFormat[];
  subtitles?: Record<string, YtdlpSubtitle[]>;
  automatic_captions?: Record<string, YtdlpSubtitle[]>;
  webpage_url?: string;
  url?: string;
  timestamp?: number | null;
  release_timestamp?: number | null;
  upload_date?: string | null;
  _type?: string;
  entries?: YtdlpInfo[];
}

/** Storyboards are neither video nor audio; they are a grid of JPEG thumbnails. */
function isStoryboard(f: YtdlpFormat): boolean {
  return f.ext === "mhtml" || f.protocol === "mhtml" || f.format_note === "storyboard";
}

function hasVideo(f: YtdlpFormat): boolean {
  return f.vcodec !== undefined && f.vcodec !== null && f.vcodec !== "none";
}

/** yt-dlp's own rule: `vcodec == 'none' and acodec != 'none'`. */
function isAudioOnly(f: YtdlpFormat): boolean {
  return !hasVideo(f) && f.acodec !== "none" && f.acodec !== undefined && f.acodec !== null;
}

/**
 * The track the source itself marks as original.
 *
 * yt-dlp puts the word in `format_note` — real example from a MrBeast video
 * with 22 dubs: `"English original (default), low"` on `139-21`, plain
 * `"Spanish, low"` on `139-16`. `language_preference` is 10 on that same track
 * and -1 on every other, so it is kept as a second, weaker signal.
 *
 * ⚠️ Never infer it from the language code. Guessing "en means original" is how
 * a video ends up tagged Portuguese (PLAN §4.1).
 */
function marksOriginal(f: YtdlpFormat): boolean {
  if (/\boriginal\b/i.test(f.format_note ?? "")) return true;
  return (f.language_preference ?? -1) >= 10;
}

function toVideoFormat(f: YtdlpFormat): VideoFormat {
  return {
    id: f.format_id ?? "",
    ...(f.width != null ? { width: f.width } : {}),
    ...(f.height != null ? { height: f.height } : {}),
    ...(f.fps != null ? { fps: f.fps } : {}),
    ...(f.vcodec && f.vcodec !== "none" ? { codec: f.vcodec } : {}),
    ...(f.vbr != null || f.tbr != null ? { bitrate: f.vbr ?? f.tbr ?? 0 } : {}),
    ...(f.filesize != null || f.filesize_approx != null
      ? { approxBytes: f.filesize ?? f.filesize_approx ?? 0 }
      : {}),
  };
}

function toAudioTracks(formats: YtdlpFormat[]): AudioTrack[] {
  const audio = formats.filter((f) => !isStoryboard(f) && isAudioOnly(f));
  const anyMarked = audio.some(marksOriginal);
  const languages = new Set(audio.map((f) => f.language ?? null));

  // When nothing is marked and there is only one audio language, that language
  // IS the original — a video with a single soundtrack has no other candidate.
  // This is inference, and it is deliberately narrow: with two or more
  // languages and no marker we mark nothing, because the fallback that must
  // never happen is "then take them all" (PLAN §4.1).
  const singleLanguageIsOriginal = !anyMarked && languages.size <= 1;

  return audio.map((f) => ({
    id: f.format_id ?? "",
    // Passed through exactly as yt-dlp gives it — `en-US`, `es-419`, `zh-Hans`.
    // Narrowing to a three-letter tag is `selection.ts`'s job (`toLanguageTag`);
    // doing it here would destroy the region before anyone could use it.
    language: f.language ?? "und",
    isOriginal: singleLanguageIsOriginal || marksOriginal(f),
    ...(f.abr != null || f.tbr != null ? { bitrate: f.abr ?? f.tbr ?? 0 } : {}),
    ...(f.acodec && f.acodec !== "none" ? { codec: f.acodec } : {}),
  }));
}

/** Subtitle formats worth asking for, best first. */
const SUBTITLE_EXT_PREFERENCE = ["vtt", "srt", "ass", "ttml", "srv3", "srv2", "srv1", "json3"];

export const MANUAL_SUBTITLE_PREFIX = "subs:";
export const AUTOMATIC_SUBTITLE_PREFIX = "auto:";

function toSubtitleTracks(info: YtdlpInfo): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  const collect = (
    table: Record<string, YtdlpSubtitle[]> | undefined,
    prefix: string,
    automatic: boolean,
  ) => {
    for (const [language, variants] of Object.entries(table ?? {})) {
      const exts = (variants ?? []).map((v) => v.ext).filter((e): e is string => !!e);
      const best = SUBTITLE_EXT_PREFERENCE.find((e) => exts.includes(e)) ?? exts[0];
      out.push({
        // Manual and automatic captions collide on the language key ("en" is in
        // both tables), so the id carries which table it came from. `fetch`
        // reads the prefix back to decide between --write-subs and
        // --write-auto-subs.
        id: `${prefix}${language}`,
        language,
        automatic,
        ...(best ? { format: best } : {}),
      });
    }
  };
  collect(info.subtitles, MANUAL_SUBTITLE_PREFIX, false);
  collect(info.automatic_captions, AUTOMATIC_SUBTITLE_PREFIX, true);
  return out;
}

export function translateInfo(info: YtdlpInfo, url: string): Result<MediaInfo, ProviderError> {
  const externalId = info.id;
  if (!externalId) {
    return Result.err(new ProbeFailed({ url, detail: "yt-dlp returned JSON with no id" }));
  }

  const formats = info.formats ?? [];
  const media: MediaInfo = {
    externalId,
    title: info.title ?? info.fulltitle ?? externalId,
    ...(info.duration != null ? { duration: info.duration } : {}),
    ...(info.thumbnail ?? info.thumbnails?.at(-1)?.url
      ? { thumbnail: info.thumbnail ?? info.thumbnails?.at(-1)?.url ?? "" }
      : {}),
    ...(info.uploader ?? info.channel ? { uploader: info.uploader ?? info.channel ?? "" } : {}),
    source: info.extractor ?? info.extractor_key?.toLowerCase() ?? "unknown",
    videoFormats: formats
      .filter((f) => !isStoryboard(f) && hasVideo(f))
      .map(toVideoFormat),
    audioTracks: toAudioTracks(formats),
    subtitles: toSubtitleTracks(info),
  };
  return Result.ok(media);
}

function toIsoDate(entry: YtdlpInfo): string | undefined {
  const stamp = entry.timestamp ?? entry.release_timestamp;
  if (stamp != null) return new Date(stamp * 1000).toISOString();
  const day = entry.upload_date;
  if (day && /^\d{8}$/.test(day)) {
    return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`;
  }
  return undefined;
}

export function translateListing(info: YtdlpInfo): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  const walk = (node: YtdlpInfo) => {
    // A channel URL comes back as a playlist of playlists (the channel tabs).
    if (node.entries) {
      for (const entry of node.entries) walk(entry);
      return;
    }
    const externalId = node.id;
    const url = node.url ?? node.webpage_url;
    if (!externalId || !url) return;
    const publishedAt = toIsoDate(node);
    items.push({
      externalId,
      url,
      title: node.title ?? externalId,
      ...(publishedAt ? { publishedAt } : {}),
    });
  };
  walk(info);
  return items;
}

// --- Building the command lines ---------------------------------------------

export interface YtdlpOptions {
  /** Binary to run. `YTDLP_BIN` lets the container point at a volume copy (PLAN §15). */
  binary?: string;
  spawn?: Spawner;
  /**
   * Netscape cookie jar, as a path.
   *
   * ⚠️ Credentials — never logged (PLAN §12). Two things set this: the
   * `COOKIES_FILE` environment variable, which is the global fallback PLAN §12
   * describes, and a {@link CredentialLease}, which overrides it per URL.
   */
  cookiesFile?: string;
  /** yt-dlp `--username`. Comes from a `password` credential, never from the environment. */
  username?: string;
  /** yt-dlp `--password`. ⚠️ Ends up in argv — see the header. */
  password?: string;
  /**
   * Where per-URL credentials come from.
   *
   * Absent means the provider authenticates with `cookiesFile` alone, which is
   * exactly how it behaved before credentials existed — so a registry built
   * without a store keeps working, and every test that does not care about
   * authentication needs no changes.
   */
  credentials?: CredentialResolver;
  /** Removed outright when a plan asks for sponsorblock. */
  sponsorblockRemove?: string;
  /** Kept as chapters, so nothing is silently lost. */
  sponsorblockMark?: string;
  /** `--playlist-end` for `list`. Unset means "everything the source offers". */
  maxListItems?: number;
  /**
   * What `--ffmpeg-location` receives, already resolved to a path that exists.
   *
   * ⚠️ **Never pass an unresolved name here.** yt-dlp answers a location that
   * does not exist with `ffmpeg-location X does not exist! Continuing without
   * ffmpeg` — a *warning*, after which the merge fails and the thumbnail stays
   * WebP. Forwarding `FFMPEG_BIN` verbatim would therefore be worse than
   * forwarding nothing, because `ffmpeg` (the bare name, resolvable on `PATH`)
   * is not a path. {@link resolveFfmpegLocation} is what turns one into the
   * other; the caller is expected to have used it.
   */
  ffmpegLocation?: string;
}

const DEFAULT_SPONSORBLOCK_REMOVE = "sponsor,selfpromo,interaction";
const DEFAULT_SPONSORBLOCK_MARK = "all";

/**
 * Flags every invocation gets.
 *
 * `--ignore-config` matters: without it yt-dlp reads the host's config files
 * and the argv we built stops being the whole truth.
 */
function baseArgs(binary: string, opts: Pick<YtdlpOptions, "cookiesFile" | "username" | "password"> = {}): string[] {
  return [
    binary,
    "--ignore-config",
    // NOT `--color no`. That exits 2 with a message that never mentions flags.
    "--color",
    "never",
    ...(opts.cookiesFile ? ["--cookies", opts.cookiesFile] : []),
    // ⚠️ Both or neither. yt-dlp prompts interactively for a password when
    // `--username` is given without one, and a prompt inside a container is a
    // process that hangs for ever with no output explaining why.
    ...(opts.username && opts.password ? ["--username", opts.username, "--password", opts.password] : []),
  ];
}

/**
 * Every credential flag, for one invocation of yt-dlp, released afterwards.
 *
 * The lease is what owns the temp cookie file, so the `finally` is not a
 * courtesy: without it, one jar per download accumulates under the temp
 * directory with the live session inside it, readable for as long as the
 * container runs.
 */
async function withCredentials<T>(
  url: string,
  opts: YtdlpOptions,
  run: (opts: YtdlpOptions, lease: CredentialLease | null) => Promise<T>,
): Promise<T> {
  const lease = (await opts.credentials?.acquire(url)) ?? null;
  if (lease === null) return run(opts, null);
  try {
    return await run(
      {
        ...opts,
        // A per-URL credential beats the global `COOKIES_FILE`: the whole point
        // of a scope is that the specific answer wins over the catch-all.
        ...(lease.cookiesFile === undefined ? {} : { cookiesFile: lease.cookiesFile }),
        ...(lease.username === undefined ? {} : { username: lease.username }),
        ...(lease.password === undefined ? {} : { password: lease.password }),
      },
      lease,
    );
  } finally {
    await lease.release();
  }
}

/**
 * Scrub a lease's secrets out of a line before it is logged.
 *
 * yt-dlp does not echo `--password` today. This exists because the job log is
 * shown in a browser and kept in the database, so the cost of being wrong about
 * that later is permanent, and the cost of the guard is one `replaceAll` per
 * stderr line.
 */
export function redactLine(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    // A one-character "secret" would turn every line into asterisks; anything
    // that short is not a credential worth protecting in a log.
    if (secret.length < 4) continue;
    out = out.replaceAll(secret, "***");
  }
  return out;
}

export function buildProbeArgs(url: string, opts: YtdlpOptions = {}): string[] {
  return [
    ...baseArgs(opts.binary ?? defaultBinary(), opts),
    "-J",
    "--no-warnings",
    // A watch URL that also carries `&list=` would otherwise drag the whole
    // playlist through the extractor. Probing is about one item.
    "--no-playlist",
    url,
  ];
}

export function buildListArgs(url: string, opts: YtdlpOptions = {}): string[] {
  return [
    ...baseArgs(opts.binary ?? defaultBinary(), opts),
    "-J",
    "--no-warnings",
    "--flat-playlist",
    ...(opts.maxListItems ? ["--playlist-end", String(opts.maxListItems)] : []),
    url,
  ];
}

/** `%` starts a template field, so a literal one has to be doubled. */
function escapeOutputTemplate(name: string): string {
  return name.replace(/%/g, "%%");
}

export function buildFormatSelector(plan: DownloadPlan): string {
  const parts: string[] = [];
  if (plan.video) parts.push(plan.video.id);
  for (const track of plan.audio) parts.push(track.id);
  // No video and no audio is a defect in selection, not a runtime failure mode.
  return parts.length > 0 ? parts.join("+") : "best";
}

/**
 * The fix for the wrong-language bug.
 *
 * `FFmpegMergerPP` maps streams with `-c copy` and writes no language metadata
 * at all, so we write it. Stream order follows the format selector: the video
 * first, then each audio in the order it appears, which makes audio output
 * index `N` the same as `plan.audio[N]`.
 *
 * ⚠️ That mapping assumes the selected video format is video-only. It is, for
 * every case where multiple audio tracks exist — a progressive format carries
 * its own audio and cannot be combined with others.
 */
export function buildLanguageMetadataArgs(plan: DownloadPlan): string[] {
  if (plan.audio.length === 0 || !plan.video) return [];
  const pieces = plan.audio.flatMap((track, index) => {
    const tag = plan.languageTags[track.id] ?? track.language;
    if (!tag) return [];
    return [`-metadata:s:a:${index}`, `language=${tag}`];
  });
  if (pieces.length === 0) return [];
  return ["--postprocessor-args", `Merger+ffmpeg_o:${pieces.join(" ")}`];
}

export function buildFetchArgs(
  plan: DownloadPlan,
  workDir: string,
  opts: YtdlpOptions = {},
): string[] {
  const manual = plan.subtitles.filter((s) => s.id.startsWith(MANUAL_SUBTITLE_PREFIX));
  const automatic = plan.subtitles.filter((s) => s.id.startsWith(AUTOMATIC_SUBTITLE_PREFIX));
  const subLanguages = [...new Set(plan.subtitles.map((s) => s.language))];

  return [
    ...baseArgs(opts.binary ?? defaultBinary(), opts),
    // ⚠️ Here and not in `baseArgs`: fetch is the only invocation that runs a
    // post-processor. Probing and listing never touch ffmpeg, so giving them
    // the flag would only widen the surface on which a wrong path can matter.
    ...(opts.ffmpegLocation ? ["--ffmpeg-location", opts.ffmpegLocation] : []),
    // Quiet, but keep progress. This is what pushes `postprocess:` onto stderr
    // (YoutubeDL.py:664) and leaves stdout carrying only our own lines.
    "-q",
    "--progress",
    // `--print` implies --simulate unless this is here. Without it, nothing
    // downloads and the failure looks like an empty working directory.
    "--no-simulate",
    "--newline",
    "--no-playlist",
    // Deliberately NOT --no-warnings: "ffmpeg is not installed, the formats
    // won't be merged" is a warning, and it is the difference between a merged
    // file and two orphans. Warnings go to ctx.log.
    "--progress-template",
    DOWNLOAD_TEMPLATE,
    "--progress-template",
    POSTPROCESS_TEMPLATE,
    "--print",
    FILEPATH_TEMPLATE,
    "-P",
    workDir,
    // YouTube needs a JavaScript runtime to decipher signatures. yt-dlp only
    // enables deno by default, and without any runtime it warns and falls back
    // to paths that cost extra requests — which is how a rate-limit starts.
    // Bun is a supported runtime and is already in the image, so this costs
    // nothing rather than the ~100 MB deno would add.
    ...jsRuntimeArgs(),
    "-o",
    `${escapeOutputTemplate(plan.outputName)}.%(ext)s`,
    "-f",
    buildFormatSelector(plan),
    // Off by default in yt-dlp. Without it only the first audio survives, and a
    // multi-language file quietly becomes single-language.
    ...(plan.audio.length > 1 ? ["--audio-multistreams"] : []),
    // 🔴 Subtitles are optional and must never take the video down with them.
    //
    // Observed in real use: yt-dlp fetches subtitles FIRST, so a 429 on a
    // 440-byte .vtt aborted the whole job at 0% before the video began. The
    // video was never even attempted.
    //
    // `--no-abort-on-error` keeps a failed subtitle as a warning. The sidecars
    // that did arrive are collected afterwards by reading the directory, so a
    // partial result is still a result.
    // 🔴 The thumbnail, as a **sidecar next to the video** — not embedded.
    //
    // It is the picture the creator chose, or the frame the site picked, and it
    // is always a better answer than a frame taken out of the middle of the
    // file (see `core/thumbnails.ts`). `Name.jpg` beside `Name.mkv` is the
    // convention Jellyfin, Plex and Emby already read, so this costs one small
    // file and buys a poster everywhere, not only in CasaTube.
    //
    // ⚠️ `--convert-thumbnails jpg` is not cosmetic: YouTube serves WebP, and a
    // `.webp` poster is invisible to several media servers. The conversion is
    // an ffmpeg post-processor, so where ffmpeg is missing the original stays —
    // which is why the collector accepts all three formats.
    //
    // ⚠️ A thumbnail that cannot be downloaded is a warning in yt-dlp, never a
    // failure, so this cannot cost a video. And the file is excluded from the
    // progress budget by `SIDECAR_EXTENSIONS` — it arrives *first*, like
    // subtitles do, and without that the bar would jump to 100% before the
    // video started.
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg",
    ...(manual.length > 0 ? ["--write-subs"] : []),
    ...(automatic.length > 0 ? ["--write-auto-subs"] : []),
    ...(subLanguages.length > 0 ? ["--sub-langs", subLanguages.join(",")] : []),
    ...(manual.length + automatic.length > 0 ? ["--no-abort-on-error"] : []),
    ...(plan.sponsorblock
      ? [
          "--sponsorblock-remove",
          opts.sponsorblockRemove ?? DEFAULT_SPONSORBLOCK_REMOVE,
          "--sponsorblock-mark",
          opts.sponsorblockMark ?? DEFAULT_SPONSORBLOCK_MARK,
        ]
      : []),
    ...buildLanguageMetadataArgs(plan),
    plan.url,
  ];
}

/**
 * Enable Bun as yt-dlp's JavaScript runtime when we can point at it.
 *
 * yt-dlp supports deno, node, quickjs and bun, but enables only deno by
 * default. Bun ships in our image already, so this is free.
 */
function jsRuntimeArgs(): string[] {
  const bun = process.env.BUN_BINARY ?? process.execPath;
  return bun ? ["--js-runtimes", `bun:${bun}`] : [];
}

function defaultBinary(): string {
  return process.env.YTDLP_BIN || "yt-dlp";
}

// --- ffmpeg, as yt-dlp needs to be told about it -----------------------------

/** What {@link resolveFfmpegLocation} found. */
export interface FfmpegLocation {
  /** An existing path, ready to hand to `--ffmpeg-location`. */
  path: string;
  /**
   * Whether an `ffprobe` sits in the same directory.
   *
   * 🔴 Load-bearing, not trivia. Given a *file*, yt-dlp keeps that file as
   * ffmpeg and then builds every other program's path as
   * `dirname(location)/<program>` — so an ffmpeg with no ffprobe beside it
   * makes yt-dlp look for ffprobe at a path that does not exist **instead of
   * on `PATH`, where it would have found one**. Pointing `FFMPEG_BIN` at a
   * lone binary can therefore take ffprobe away. False here is what
   * {@link describeFfmpegLocation} turns into a line saying so.
   */
  ffprobeBeside: boolean;
}

/**
 * `FFMPEG_BIN` turned into something `--ffmpeg-location` can accept.
 *
 * ⚠️ The whole point is the `undefined` return. yt-dlp treats a location that
 * does not exist as "continue without ffmpeg" — a warning, then a failed merge
 * and a WebP thumbnail — so a value we cannot resolve must not be forwarded at
 * all, leaving yt-dlp's own `PATH` lookup as it was.
 *
 * A value with a `/` is a path and is required to exist. A bare name is
 * resolved on `PATH` here, because `PATH` is exactly what `--ffmpeg-location`
 * does not consult.
 */
export function resolveFfmpegLocation(
  binary: string | undefined,
  env: Record<string, string | undefined> = process.env,
): FfmpegLocation | undefined {
  const value = binary?.trim();
  if (!value) return undefined;

  let path: string | undefined;
  if (value.includes("/")) {
    path = existsSync(value) ? resolvePath(value) : undefined;
  } else {
    path = (env.PATH ? Bun.which(value, { PATH: env.PATH }) : Bun.which(value)) ?? undefined;
  }
  if (path === undefined) return undefined;

  // A directory is passed through as-is: yt-dlp reads every program out of it,
  // so the ffprobe question does not arise.
  if (statSync(path).isDirectory()) return { path, ffprobeBeside: existsSync(join(path, "ffprobe")) };
  return { path, ffprobeBeside: existsSync(join(dirname(path), "ffprobe")) };
}

/**
 * What the boot log should say about it — nothing, when nothing is configured.
 *
 * Separate from {@link resolveFfmpegLocation} so that both halves are testable
 * without a process: this one decides what a human is told, and every branch
 * here is a case where believing the configuration would be wrong.
 */
export function describeFfmpegLocation(
  binary: string | undefined,
  location: FfmpegLocation | undefined,
): string[] {
  const value = binary?.trim();
  if (!value) return [];
  if (location === undefined) {
    return [
      `FFMPEG_BIN is set to ${value}, which does not resolve to an existing path — ` +
        `yt-dlp is being left to find ffmpeg on PATH, and merges will fail if there is none.`,
    ];
  }
  if (!location.ffprobeBeside) {
    return [
      `yt-dlp will use ${location.path}, but there is no ffprobe beside it — ` +
        `yt-dlp looks for ffprobe next to ffmpeg and will not fall back to PATH.`,
    ];
  }
  return [`yt-dlp will use ${location.path}`];
}

// --- The provider -----------------------------------------------------------

async function listSidecarSubtitles(workDir: string, outputName: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join, extname } = await import("node:path");
  let names: string[];
  try {
    names = await readdir(workDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(`${outputName}.`) && SUBTITLE_SIDECAR_EXTENSIONS.has(extname(n).toLowerCase()))
    .sort()
    .map((n) => join(workDir, n));
}

/**
 * The thumbnail yt-dlp wrote, if it wrote one.
 *
 * ⚠️ Found by reading the directory rather than by trusting a name, for the
 * same reason the subtitles are: `--convert-thumbnails` may or may not have
 * run, the site decides the original format, and a thumbnail that failed to
 * download is a **warning**, not an error — the video is there either way.
 *
 * Preference order is the extension list's, so a folder left with both the
 * converted JPEG and an original WebP answers with the JPEG.
 */
async function listSidecarThumbnail(workDir: string, outputName: string): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const { join, extname } = await import("node:path");
  let names: string[];
  try {
    names = await readdir(workDir);
  } catch {
    return undefined;
  }
  const found = names.filter(
    (n) => n.startsWith(`${outputName}.`) && THUMBNAIL_SIDECAR_EXTENSIONS.includes(extname(n).toLowerCase()),
  );
  found.sort(
    (a, b) =>
      THUMBNAIL_SIDECAR_EXTENSIONS.indexOf(extname(a).toLowerCase()) -
      THUMBNAIL_SIDECAR_EXTENSIONS.indexOf(extname(b).toLowerCase()),
  );
  const best = found[0];
  return best === undefined ? undefined : join(workDir, best);
}

export function createYtdlpProvider(options: YtdlpOptions = {}): Provider {
  const spawn = options.spawn ?? bunSpawner;
  const opts: YtdlpOptions = {
    ...options,
    binary: options.binary ?? defaultBinary(),
    ...(options.cookiesFile ?? process.env.COOKIES_FILE
      ? { cookiesFile: options.cookiesFile ?? process.env.COOKIES_FILE }
      : {}),
  };

  async function runJson(
    args: string[],
    url: string,
    signal: AbortSignal,
  ): Promise<Result<YtdlpInfo, ProviderError>> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let outcome: SpawnOutcome;
    try {
      outcome = await spawn({
        args,
        signal,
        onStdout: (line) => stdout.push(line),
        onStderr: (line) => stderr.push(line),
      });
    } catch (cause) {
      return Result.err(
        new ProbeFailed({ url, detail: `could not run yt-dlp: ${String(cause)}` }),
      );
    }

    if (signal.aborted) {
      // ⚠️ `ProviderError` has no member for "the caller cancelled", so this is
      // the closest honest answer. Noted in the report as a contract gap.
      return Result.err(new ProbeFailed({ url, detail: "cancelled" }));
    }
    if (outcome.exitCode !== 0) {
      return Result.err(classifyError({ stderr: stderr.join("\n"), url }));
    }

    try {
      return Result.ok(JSON.parse(stdout.join("\n")) as YtdlpInfo);
    } catch (cause) {
      return Result.err(
        new ProbeFailed({ url, detail: `yt-dlp emitted unparseable JSON: ${String(cause)}` }),
      );
    }
  }

  return {
    name: "yt-dlp",

    /**
     * Everything. This is the fallback provider, it answers last (see
     * `registry.ts`), and it is what makes ~1800 sites work without anyone
     * registering anything (PLAN §5).
     */
    supports(): boolean {
      return true;
    },

    async probe(url, signal) {
      const info = await withCredentials(url, opts, (authenticated) =>
        runJson(buildProbeArgs(url, authenticated), url, signal),
      );
      if (Result.isError(info)) return info;
      return translateInfo(info.value, url);
    },

    async list(url, signal) {
      const info = await withCredentials(url, opts, (authenticated) =>
        runJson(buildListArgs(url, authenticated), url, signal),
      );
      if (Result.isError(info)) return info;
      return Result.ok(translateListing(info.value));
    },

    fetch(plan, ctx) {
      // The lease is held for the whole download — a cookie file deleted while
      // yt-dlp is still resuming a fragment is a job that fails at 80%.
      return withCredentials(plan.url, opts, (authenticated, lease) =>
        runFetch(plan, ctx, authenticated, lease),
      );
    },
  };

  async function runFetch(
    plan: DownloadPlan,
    ctx: ProviderContext,
    opts: YtdlpOptions,
    lease: CredentialLease | null,
  ): Promise<Result<FetchResult, ProviderError>> {
    const args = buildFetchArgs(plan, ctx.workDir, opts);
    const selector = buildFormatSelector(plan);
    const secrets = lease?.redact ?? [];
    const progress = new ProgressAccumulator();
    const stderr: string[] = [];
    let filePath: string | null = null;
    /** Whether any media file has finished arriving. See the postprocess branch. */
    let mediaArrived = false;

    const handleLine = (line: string, stream: "out" | "err") => {
      const download = parseDownloadLine(line);
      if (download) {
        const update = progress.update(download);
        if (update) {
          if (download.status === "finished") mediaArrived = true;
          // Every byte tick says which stage it is, so a job that was briefly
          // "processing" goes back to "downloading" when bytes flow again.
          ctx.onProgress({ ...update, stage: "download" });
        } else if (download.status === "finished") {
          ctx.log(`sidecar: ${download.filename}`);
        }
        return;
      }
      const post = parsePostProcessLine(line);
      if (post) {
        // The whole reason stderr is read at all: without this, the minutes
        // ffmpeg spends merging look like a dead process.
        ctx.log(`postprocess ${post.postprocessor ?? "?"}: ${post.status}`);
        // `stage` tells the worker this is merging, not downloading: a full bar
        // with "Downloading" beside it read as a stuck job.
        //
        // 🔴 Only once media has arrived. SponsorBlock and ThumbnailsConvertor
        // are postprocessors too and run *before* the download; treating them
        // as merging marked every YouTube job "processing" for its whole
        // download, with a live speed beside it and the bar jumping to 100%.
        if (mediaArrived) ctx.onProgress({ ...progress.snapshot(), percent: 100, stage: "postprocess" });
        return;
      }
      const printed = parseFilePathLine(line);
      if (printed) {
        filePath = printed;
        return;
      }
      if (stream === "err") {
        // 🔴 Redacted on the way in, not on the way out. `stderr` becomes the
        // `detail` of a tagged error that is rendered in the browser and
        // written to the job row, so scrubbing at the log call alone would
        // leave the password in the durable copy.
        const safe = redactLine(line, secrets);
        stderr.push(safe);
        ctx.log(safe);
      }
    };

    let outcome: SpawnOutcome;
    try {
      outcome = await spawn({
        args,
        cwd: ctx.workDir,
        signal: ctx.signal,
        onStdout: (line) => handleLine(line, "out"),
        onStderr: (line) => handleLine(line, "err"),
      });
    } catch (cause) {
      return Result.err(
        new ProbeFailed({ url: plan.url, detail: `could not run yt-dlp: ${String(cause)}` }),
      );
    }

    if (ctx.signal.aborted) {
      return Result.err(new ProbeFailed({ url: plan.url, detail: "cancelled" }));
    }
    if (outcome.exitCode !== 0) {
      return Result.err(
        classifyError({ stderr: stderr.join("\n"), url: plan.url, wanted: selector }),
      );
    }
    if (!filePath) {
      return Result.err(
        new ProbeFailed({ url: plan.url, detail: "yt-dlp reported no output file" }),
      );
    }

    // Trap 6: yt-dlp exits 0 and names a file it never wrote when a merge was
    // requested and ffmpeg is missing. Believing the exit code here produces a
    // "done" job with nothing behind it.
    if (!(await Bun.file(filePath).exists())) {
      return Result.err(
        new ProbeFailed({
          url: plan.url,
          detail:
            `yt-dlp exited 0 but ${filePath} does not exist ` +
            `(a merge was requested and ffmpeg is probably missing)`,
        }),
      );
    }

    const thumbnailFile = await listSidecarThumbnail(ctx.workDir, plan.outputName);
    return Result.ok({
      file: filePath,
      subtitleFiles: await listSidecarSubtitles(ctx.workDir, plan.outputName),
      ...(thumbnailFile === undefined ? {} : { thumbnailFile }),
    } satisfies FetchResult);
  }
}
