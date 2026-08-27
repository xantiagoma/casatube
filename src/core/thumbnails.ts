/**
 * Thumbnails for the library: the one the provider chose, and a frame when
 * there is none.
 *
 * 🔴 **Two sources, and they are not equal.** The provider's thumbnail — the
 * creator's own cover, or the frame the site picked — is *chosen*; a frame
 * pulled out of the file is a guess. So the sidecar written next to the video
 * at download time always wins, and ffmpeg only answers for what has none: old
 * downloads, files copied in by hand, providers that publish no image.
 *
 * 🔴 **The two live in different places, because they are different kinds of
 * thing.** A sidecar is *content*: it belongs to the library, next to its
 * video, under the name every media server already looks for (`Name.jpg`). A
 * generated frame is *derived*: it belongs to `DATA_DIR`, where it can be
 * deleted without losing anything, and it is never written into the library.
 *
 * ⚠️ **Listing never generates.** A library screen showing two hundred cards
 * that each spawned an ffmpeg would be worse than having no thumbnails at all —
 * on the reference deployment that box also runs Home Assistant and Frigate.
 * Generation happens when a *thumbnail* is requested, one at a time, at most
 * {@link ThumbnailOptions.maxConcurrent} at once, each under a deadline and
 * killed when it expires.
 *
 * ⚠️ **The library is very often a network mount**, and a dead mount hangs
 * rather than failing (PLAN §15). Every filesystem call here runs under a
 * deadline and reports `MountUnavailable`, exactly as `core/library` does — the
 * deadline helper is imported from there rather than copied.
 *
 * 📌 **The cache is keyed on (path, size, mtime)**, not on the path alone, and
 * the key *is* the filename. A re-download over the same name is a different
 * file, and an entry keyed on the name would go on serving a picture of the old
 * one — the same trap `core/hls.ts` avoids for its playback verdict. Because the
 * key is the filename, a stale entry is never *found*, so nothing has to notice
 * that it is stale.
 */
import { Result } from "better-result";
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  MountUnavailable,
  NotFound,
  ThumbnailUnavailable,
  Timeout,
  type ThumbnailError,
} from "./errors";
import {
  resolveInRoot,
  THUMBNAIL_EXTENSIONS,
  THUMBNAIL_SIDECAR_EXTENSIONS,
  withDeadline,
  type MediaProbe,
} from "./library";

export { THUMBNAIL_EXTENSIONS } from "./library";

// --- Constants --------------------------------------------------------------

/** The subfolder of `DATA_DIR` this module owns outright. */
export const THUMBNAIL_DIR = "thumbnails";

/** Wide enough for a library card on a retina screen, small enough to be free. */
export const DEFAULT_THUMBNAIL_WIDTH = 480;

/**
 * How far into the video the frame is taken, as a fraction of the duration.
 *
 * ⚠️ Not a fixed offset, and not zero. An enormous number of videos open on a
 * fade from black, a title card or a logo sting, so second 0 — the obvious
 * choice — is exactly the frame most likely to be useless. A percentage adapts:
 * 10% of a 19-second clip is two seconds in, 10% of a film is past the titles.
 */
export const DEFAULT_SEEK_FRACTION = 0.1;

/** Never seek into the first second: on a short clip, 10% can round to nothing. */
const MIN_SEEK_SECONDS = 1;

/** One frame, from a file that may be on a slow mount. */
export const DEFAULT_GENERATE_TIMEOUT_MS = 20_000;

/** Per filesystem call, same reasoning — and the same number — as `core/library`. */
const STAT_TIMEOUT_MS = 5_000;

/**
 * Concurrent ffmpeg processes.
 *
 * Two, not one, so a single slow file does not hold up the rest of a grid — and
 * not more, because this shares a box with other things and a scroll through a
 * cold library is a burst of hundreds of requests.
 */
export const DEFAULT_MAX_CONCURRENT = 2;

/** How long a request waits for a slot before giving up and returning nothing. */
export const DEFAULT_QUEUE_WAIT_MS = 30_000;

/**
 * After a failure, how long before the same file is worth another ffmpeg.
 *
 * Without this, a corrupt file in a folder of two hundred is two subprocesses
 * per card per scroll, for ever. Keyed on the cache key, so replacing the file
 * clears it.
 */
export const DEFAULT_FAILED_RETRY_MS = 5 * 60 * 1000;

/** Entries kept in the cache. At ~30 KB each this is about 150 MB. */
export const DEFAULT_MAX_ENTRIES = 5_000;

/** Generations between two sweeps of the cache directory. */
const SWEEP_EVERY = 50;

// --- Shapes -----------------------------------------------------------------

export type ThumbnailSource =
  /** The provider's own image, next to the video in the library. */
  | "sidecar"
  /** A frame generated earlier and still valid. */
  | "cache"
  /** A frame generated to answer this request. */
  | "generated";

export interface ThumbnailResult {
  /** Absolute path of the file to serve. */
  path: string;
  contentType: string;
  size: number;
  source: ThumbnailSource;
  /**
   * A validator for the HTTP layer, derived from what the picture is *of* —
   * the media file's identity for a generated frame, the sidecar's own for a
   * sidecar. Either way it changes when the picture would.
   */
  etag: string;
}

export type { ThumbnailError };

export interface ThumbnailOptions {
  /** The library root. Paths handed to this module are relative to it. */
  libraryRoot: string;
  /** Where generated frames are kept. `DATA_DIR/thumbnails` in the real server. */
  cacheDir: string;
  /**
   * What `ffprobe` says about a file, given a library-relative path.
   *
   * Injected rather than re-implemented, exactly as `core/hls.ts` does it:
   * `core/library` already spawns `ffprobe` under a deadline and parses it, and
   * a second copy would be a second thing to keep right. It is also the seam
   * that lets every decision here be tested without a media file.
   */
  probe(relPath: string): Promise<Result<MediaProbe, { _tag: string; message?: string }>>;
  ffmpegPath?: string;
  /** Longest edge of a generated frame, in pixels. Never upscales. */
  width?: number;
  generateTimeoutMs?: number;
  statTimeoutMs?: number;
  maxConcurrent?: number;
  queueWaitMs?: number;
  failedRetryMs?: number;
  maxEntries?: number;
  seekFraction?: number;
  now?(): number;
  log?(line: string): void;
}

export interface Thumbnailer {
  readonly cacheDir: string;
  /** The sidecar, the cache, or a frame — in that order. */
  thumbnail(relPath: string): Promise<Result<ThumbnailResult, ThumbnailError>>;
  /** How many entries the cache holds, and what they weigh. */
  stats(): Promise<{ dir: string; entries: number; bytes: number }>;
}

// --- Pure helpers -----------------------------------------------------------

/** `Foo.mkv` → `Foo.jpg`, `Foo.jpeg`, `Foo.png`, `Foo.webp`, in that order. */
export function sidecarNames(fileName: string): string[] {
  const dot = fileName.lastIndexOf(".");
  const base = dot <= 0 ? fileName : fileName.slice(0, dot);
  return THUMBNAIL_EXTENSIONS.map((ext) => `${base}.${ext}`);
}

/** Is this name an image that could be a sidecar? Lowercased extension only. */
export function isThumbnailName(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return false;
  return THUMBNAIL_SIDECAR_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot <= 0 ? "" : fileName.slice(dot + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/**
 * The cache filename for one file at one moment.
 *
 * Path, size and mtime — see the module header. The width is in there too
 * because a frame generated at 480 px is not an answer to a request for 960.
 */
export function cacheKey(input: {
  relPath: string;
  size: number;
  mtimeMs: number;
  width: number;
}): string {
  return createHash("sha256")
    .update(`${input.relPath} ${input.size} ${Math.round(input.mtimeMs)} ${input.width}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Where in the video to take the frame.
 *
 * See {@link DEFAULT_SEEK_FRACTION} for why this is a fraction. Two guards on
 * top of it: never before one second (10% of a six-second clip is 0.6 s, which
 * is still inside the fade), and never past the end — a seek beyond the last
 * frame produces no output at all, which would turn a perfectly good video into
 * "no thumbnail".
 */
export function seekSeconds(durationSeconds: number | null, fraction = DEFAULT_SEEK_FRACTION): number {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    // Nothing said how long it is. Zero is the only offset guaranteed to exist.
    return 0;
  }
  if (durationSeconds <= MIN_SEEK_SECONDS) return 0;
  const wanted = Math.max(MIN_SEEK_SECONDS, durationSeconds * fraction);
  // Half a second of headroom: `duration` is itself an approximation in most
  // containers, and a seek to the very last frame is a coin toss.
  return Math.min(wanted, Math.max(0, durationSeconds - 0.5));
}

/**
 * One frame, as a pure function, so the flags can be asserted without running
 * anything.
 *
 * - `-ss` **before** `-i` — input seeking, which jumps by the index instead of
 *   decoding everything up to that point. On a two-hour film that is the
 *   difference between a thumbnail and a timeout.
 * - `-map 0:v:0` + `-frames:v 1` — the first video stream, one frame. Without
 *   the map, a file with cover art *and* video can answer with the wrong one.
 * - `scale='min(iw,W)':-2` — never upscale. A 320 px video enlarged to 480 is
 *   the same picture, blurrier and four times the bytes.
 * - `-an -sn -dn` — a still image has no use for the other streams, and an
 *   embedded subtitle stream is enough to fail the whole command.
 * - `-nostdin` — a spawned ffmpeg with an inherited terminal eats keystrokes.
 */
export function buildThumbnailArgs(
  input: string,
  output: string,
  options: { seek: number; width: number },
): string[] {
  const seek = Math.max(0, options.seek);
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    ...(seek > 0 ? ["-ss", seek.toFixed(3)] : []),
    "-i", input,
    "-map", "0:v:0",
    "-frames:v", "1",
    "-vf", `scale='min(iw,${Math.round(options.width)})':-2`,
    "-an", "-sn", "-dn",
    "-q:v", "4",
    "-f", "image2",
    "-y",
    output,
  ];
}

// --- The thumbnailer --------------------------------------------------------

function describeCause(cause: unknown): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code: unknown }).code)
      : undefined;
  const message = cause instanceof Error ? cause.message : String(cause);
  return code === undefined ? message : `${code}: ${message}`;
}

interface Caught<T> {
  ok: boolean;
  value?: T;
  cause?: unknown;
}

function capture<T>(work: Promise<T>): Promise<Caught<T>> {
  return work.then(
    (value) => ({ ok: true, value }),
    (cause: unknown) => ({ ok: false, cause }),
  );
}

export function createThumbnailer(options: ThumbnailOptions): Thumbnailer {
  const libraryRoot = options.libraryRoot;
  const cacheDir = options.cacheDir;
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const width = options.width ?? DEFAULT_THUMBNAIL_WIDTH;
  const generateTimeoutMs = options.generateTimeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
  const statTimeoutMs = options.statTimeoutMs ?? STAT_TIMEOUT_MS;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const queueWaitMs = options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS;
  const failedRetryMs = options.failedRetryMs ?? DEFAULT_FAILED_RETRY_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const seekFraction = options.seekFraction ?? DEFAULT_SEEK_FRACTION;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((line: string) => console.log(line));

  /** Generations in flight, so ten cards for one file are one ffmpeg. */
  const inFlight = new Map<string, Promise<Result<ThumbnailResult, ThumbnailError>>>();
  /** Keys that failed recently, and when. See {@link DEFAULT_FAILED_RETRY_MS}. */
  const failures = new Map<string, { at: number; detail: string }>();
  let running = 0;
  const waiting: (() => void)[] = [];
  let sinceSweep = 0;

  // --- filesystem primitives, all deadlined -------------------------------

  async function statFile(
    absolute: string,
    what: string,
  ): Promise<Result<{ size: number; mtimeMs: number; isFile: boolean }, MountUnavailable | NotFound>> {
    const raced = await withDeadline(capture(stat(absolute)), statTimeoutMs, absolute, what);
    if (Result.isError(raced)) return raced;
    const caught = raced.value;
    if (!caught.ok || caught.value === undefined) {
      const code =
        typeof caught.cause === "object" && caught.cause !== null && "code" in caught.cause
          ? String((caught.cause as { code: unknown }).code)
          : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return Result.err(new NotFound({ what: "file", id: basename(absolute) }));
      }
      return Result.err(new MountUnavailable({ path: absolute, detail: describeCause(caught.cause) }));
    }
    const stats = caught.value;
    return Result.ok({ size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile() });
  }

  // --- the three sources --------------------------------------------------

  /**
   * The provider's image, if it is there.
   *
   * ⚠️ Four `stat`s at worst, not a `readdir`: a library folder can hold
   * thousands of entries, and reading all of them to find one name is the kind
   * of call that turns a slow mount into a stalled page. A `stat` of a name
   * that is not there is the cheapest question a filesystem answers.
   */
  async function sidecar(
    relPath: string,
    absolute: string,
  ): Promise<Result<ThumbnailResult, MountUnavailable> | null> {
    const folder = dirname(absolute);
    for (const name of sidecarNames(basename(relPath))) {
      const candidate = join(folder, name);
      const stats = await statFile(candidate, "looking for a thumbnail");
      if (Result.isError(stats)) {
        // Not there is the normal case and says nothing. A mount that is *down*
        // is a different answer, and it must not be reported as "no thumbnail".
        if (stats.error._tag === "MountUnavailable") return Result.err(stats.error);
        continue;
      }
      if (!stats.value.isFile || stats.value.size === 0) continue;
      return Result.ok({
        path: candidate,
        contentType: contentTypeFor(name),
        size: stats.value.size,
        source: "sidecar",
        etag: `"s-${cacheKey({ relPath: `${relPath}/${name}`, size: stats.value.size, mtimeMs: stats.value.mtimeMs, width: 0 })}"`,
      });
    }
    return null;
  }

  function cachePath(key: string): string {
    return join(cacheDir, `${key}.jpg`);
  }

  async function cached(key: string): Promise<ThumbnailResult | null> {
    const stats = await statFile(cachePath(key), "reading the thumbnail cache");
    if (Result.isError(stats) || !stats.value.isFile || stats.value.size === 0) return null;
    return {
      path: cachePath(key),
      contentType: "image/jpeg",
      size: stats.value.size,
      source: "cache",
      etag: `"g-${key}"`,
    };
  }

  /** Wait for one of the {@link maxConcurrent} slots, or give up. */
  async function acquire(): Promise<boolean> {
    if (running < maxConcurrent) {
      running += 1;
      return true;
    }
    let release: (() => void) | undefined;
    const queued = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
      waiting.push(release);
    });
    const expired = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(1, queueWaitMs));
      timer.unref?.();
    });
    const got = await Promise.race([queued, expired]);
    if (!got) {
      const index = release === undefined ? -1 : waiting.indexOf(release);
      if (index !== -1) waiting.splice(index, 1);
      return false;
    }
    running += 1;
    return true;
  }

  function release(): void {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  /**
   * Run ffmpeg for one frame, and **kill it if it overruns**.
   *
   * The output goes to a per-attempt temporary name and is renamed into place
   * only once ffmpeg has exited successfully. Two reasons, and both have bitten
   * this codebase before: a reader must never be handed a file that is still
   * being written (see `docs/DISCOVERIES.md` on HLS segments), and a run that
   * is killed half-way must leave nothing behind that a later request would
   * mistake for a valid cache entry.
   */
  async function runFfmpeg(input: string, output: string, seek: number): Promise<Result<number, ThumbnailUnavailable | Timeout>> {
    const partial = `${output}.${Math.random().toString(36).slice(2, 10)}.part`;
    const args = buildThumbnailArgs(input, partial, { seek, width });

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      // `Bun.spawn`, never `Bun.$` — library filenames are full of quotes and
      // brackets, and a shell in the middle would reinterpret them.
      proc = Bun.spawn([ffmpegPath, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    } catch (cause) {
      return Result.err(
        new ThumbnailUnavailable({ path: input, detail: `ffmpeg could not start: ${describeCause(cause)}` }),
      );
    }

    const finished = (async () => {
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      return { stderr, exitCode };
    })();

    const raced = await withDeadline(capture(finished), generateTimeoutMs, input, "ffmpeg");
    if (Result.isError(raced)) {
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
      await rm(partial, { force: true }).catch(() => {});
      return Result.err(new Timeout({ what: `a thumbnail for ${basename(input)}`, ms: generateTimeoutMs }));
    }
    if (!raced.value.ok || raced.value.value === undefined) {
      await rm(partial, { force: true }).catch(() => {});
      return Result.err(
        new ThumbnailUnavailable({ path: input, detail: describeCause(raced.value.cause) }),
      );
    }

    const { stderr, exitCode } = raced.value.value;
    if (exitCode !== 0) {
      await rm(partial, { force: true }).catch(() => {});
      return Result.err(
        new ThumbnailUnavailable({ path: input, detail: stderr.trim() || `ffmpeg exited with ${exitCode}` }),
      );
    }

    // ⚠️ ffmpeg can exit 0 having written nothing — a seek past the last frame
    // is the usual way. Believing the exit code here would cache an empty file
    // and serve a broken image for as long as the video stays put.
    const produced = await statFile(partial, "reading the generated frame");
    if (Result.isError(produced) || produced.value.size === 0) {
      await rm(partial, { force: true }).catch(() => {});
      return Result.err(
        new ThumbnailUnavailable({ path: input, detail: "ffmpeg produced no image" }),
      );
    }

    try {
      await rename(partial, output);
    } catch (cause) {
      await rm(partial, { force: true }).catch(() => {});
      return Result.err(
        new ThumbnailUnavailable({ path: input, detail: `could not store the thumbnail: ${describeCause(cause)}` }),
      );
    }
    return Result.ok(produced.value.size);
  }

  /**
   * Keep the cache from growing for ever.
   *
   * Cheap because it only reads the directory once every {@link SWEEP_EVERY}
   * generations, and only stats anything at all when the count is over the cap.
   * A failure here is logged and swallowed: an over-full cache is a disk
   * problem, not a reason to fail the request that filled it.
   */
  async function sweepCache(): Promise<void> {
    sinceSweep += 1;
    if (sinceSweep < SWEEP_EVERY) return;
    sinceSweep = 0;
    try {
      const names = (await readdir(cacheDir)).filter((name) => name.endsWith(".jpg"));
      if (names.length <= maxEntries) return;
      const dated = await Promise.all(
        names.map(async (name) => ({
          name,
          at: await stat(join(cacheDir, name)).then(
            (s) => s.mtimeMs,
            () => 0,
          ),
        })),
      );
      dated.sort((a, b) => a.at - b.at);
      // Down to 90% of the cap rather than exactly to it, so the next
      // generation does not immediately trigger another sweep.
      const doomed = dated.slice(0, names.length - Math.floor(maxEntries * 0.9));
      await Promise.all(doomed.map((entry) => rm(join(cacheDir, entry.name), { force: true }).catch(() => {})));
      log(`[casatube] thumbnails: pruned ${doomed.length} cached frame(s)`);
    } catch (cause) {
      log(`[casatube] thumbnails: could not prune the cache: ${describeCause(cause)}`);
    }
  }

  async function generate(
    relPath: string,
    absolute: string,
    key: string,
  ): Promise<Result<ThumbnailResult, ThumbnailError>> {
    const probed = await options.probe(relPath);
    if (Result.isError(probed)) {
      return Result.err(
        new ThumbnailUnavailable({
          path: relPath,
          detail: `ffprobe could not read it: ${probed.error.message ?? probed.error._tag}`,
        }),
      );
    }
    // 📌 Asked before ffmpeg is spawned, not after it fails: a file with no
    // video stream at all — an audio download, a stray text file — has no frame
    // to take, and the honest answer costs nothing.
    if (!probed.value.streams.some((stream) => stream.kind === "video")) {
      return Result.err(
        new ThumbnailUnavailable({ path: relPath, detail: "there is no video stream to take a frame from" }),
      );
    }

    const gotSlot = await acquire();
    if (!gotSlot) {
      return Result.err(
        new ThumbnailUnavailable({
          path: relPath,
          detail: `no thumbnail slot came free within ${queueWaitMs} ms`,
        }),
      );
    }

    try {
      await mkdir(cacheDir, { recursive: true });
      const target = cachePath(key);
      const seek = seekSeconds(probed.value.durationSeconds, seekFraction);
      const made = await runFfmpeg(absolute, target, seek);
      if (Result.isError(made)) return made;
      void sweepCache();
      log(`[casatube] thumbnails: generated ${relPath} at ${seek.toFixed(1)}s`);
      return Result.ok({
        path: target,
        contentType: "image/jpeg",
        size: made.value,
        source: "generated",
        etag: `"g-${key}"`,
      });
    } finally {
      release();
    }
  }

  async function thumbnail(relPath: string): Promise<Result<ThumbnailResult, ThumbnailError>> {
    const absolute = resolveInRoot(libraryRoot, relPath);
    if (Result.isError(absolute)) return absolute;

    const stats = await statFile(absolute.value, "reading a file");
    if (Result.isError(stats)) {
      if (stats.error._tag === "NotFound") {
        return Result.err(new NotFound({ what: "library file", id: relPath }));
      }
      return Result.err(stats.error);
    }
    if (!stats.value.isFile) return Result.err(new NotFound({ what: "library file", id: relPath }));

    // 1. The provider's own image. Always preferred — see the module header.
    const beside = await sidecar(relPath, absolute.value);
    if (beside !== null) {
      if (Result.isError(beside)) return beside;
      return beside;
    }

    const key = cacheKey({ relPath, size: stats.value.size, mtimeMs: stats.value.mtimeMs, width });

    // 2. A frame generated earlier for *this* file at *this* moment.
    const hit = await cached(key);
    if (hit !== null) return Result.ok(hit);

    const failed = failures.get(key);
    if (failed !== undefined && now() - failed.at < failedRetryMs) {
      return Result.err(new ThumbnailUnavailable({ path: relPath, detail: failed.detail }));
    }
    failures.delete(key);

    // 3. Generate one — once, however many requests are asking.
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    const work = generate(relPath, absolute.value, key)
      .then((outcome) => {
        if (Result.isError(outcome) && outcome.error._tag === "ThumbnailUnavailable") {
          failures.set(key, { at: now(), detail: String((outcome.error as ThumbnailUnavailable).detail) });
        }
        return outcome;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, work);
    return work;
  }

  async function stats(): Promise<{ dir: string; entries: number; bytes: number }> {
    try {
      const names = (await readdir(cacheDir)).filter((name) => name.endsWith(".jpg"));
      const sizes = await Promise.all(
        names.map((name) =>
          stat(join(cacheDir, name)).then(
            (s) => s.size,
            () => 0,
          ),
        ),
      );
      return { dir: cacheDir, entries: names.length, bytes: sizes.reduce((total, size) => total + size, 0) };
    } catch {
      return { dir: cacheDir, entries: 0, bytes: 0 };
    }
  }

  return { cacheDir, thumbnail, stats };
}
