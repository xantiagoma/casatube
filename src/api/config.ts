/**
 * Server configuration, read from the environment — PLAN §12.
 *
 * Everything the HTTP layer needs to boot lives here, so the image is the only
 * artefact and a deployment is a set of variables. Defaults are the ones PLAN
 * §12 names, because the default is what happens when nobody is watching.
 */
import { dataDir } from "../core/db";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SEGMENT_SECONDS,
  DEFAULT_TRANSCODE_IDLE_MS,
} from "../core/hls";
import {
  DEFAULT_GENERATE_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_THUMBNAIL_WIDTH,
} from "../core/thumbnails";

export interface ServerConfig {
  port: number;
  /** Both SQLite files live here. */
  dataDir: string;
  /** Downloads land here before the move — the worker owns it, we only report it. */
  tempDir: string;
  /** Destination root. Job destinations are subfolders of this, never absolute. */
  libraryDir: string;
  /** ⚠️ Credentials. Never echoed back through the API — PLAN §12. */
  cookiesFile?: string;
  ytdlpBinary?: string;
  /**
   * ffmpeg and ffprobe, when they are not simply on `PATH`.
   *
   * Both are in the image, so the defaults are right in production. They exist
   * because a development machine often has neither — and because pointing at a
   * specific build is the only way to reproduce a codec problem.
   */
  ffmpegBinary?: string;
  ffprobeBinary?: string;
  /** On-demand HLS playback — see `core/hls.ts`. */
  hls: HlsConfig;
  /** Library thumbnails — see `core/thumbnails.ts`. */
  thumbnails: ThumbnailConfig;
  /**
   * How often the queue is re-read to decide whether the SSE stream has
   * anything new to say.
   *
   * Polling rather than an in-process event bus on purpose: the rows can also
   * be written by a worker in another process, and a bus would only see the
   * writes that happen to share our memory. See `events.ts`.
   */
  eventsPollMs: number;
  /**
   * Jobs that may be in the download stage at once — the only stage the source
   * sees. Was documented everywhere and read nowhere until 2026-08-27.
   */
  maxConcurrentDownloads: number;
  /**
   * How long a deleted item stays in `.trash/` before a purge may remove it.
   *
   * Deleting moves rather than unlinks, so this is the width of the undo
   * window — the thing that makes a mistaken delete recoverable.
   */
  trashRetentionDays: number;
  /** Rebuild the client bundle on every page load. Off in the image. */
  dev: boolean;
}

/**
 * The knobs on on-demand playback.
 *
 * ⚠️ Every one of these is a limit on **temp disk or CPU**, not a preference.
 * A remux leaves hundreds of megabytes under `TEMP_DIR` and an orphaned ffmpeg
 * burns a core indefinitely, so the defaults are chosen to fail small: three
 * sessions, five minutes of grace for a remux nobody is reading, an hour for
 * one that has finished.
 */
export interface HlsConfig {
  /** Target segment length. ⚠️ Approximate: `-c:v copy` cuts at keyframes. */
  segmentSeconds: number;
  /** A finished session with nobody reading it is removed after this. */
  idleMs: number;
  /** A session still remuxing with nobody reading it is **killed** after this. */
  transcodeIdleMs: number;
  maxSessions: number;
}

/**
 * The knobs on library thumbnails.
 *
 * ⚠️ Like the HLS ones, these are limits on **CPU and disk**, not preferences.
 * A generated frame costs an ffprobe and an ffmpeg; the cache costs `DATA_DIR`.
 * The defaults are chosen so that scrolling a cold library of a thousand files
 * cannot become a thousand simultaneous subprocesses.
 */
export interface ThumbnailConfig {
  /** Width of a generated frame, in pixels. Sidecars are served as they are. */
  width: number;
  /** ffmpeg processes at once. */
  maxConcurrent: number;
  /** Per generation, after which the process is killed. */
  timeoutMs: number;
  /** Cached frames kept before the oldest are pruned. */
  maxEntries: number;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function str(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const dir = env.DATA_DIR ?? dataDir();
  return {
    port: int(env.PORT, 8520),
    dataDir: dir,
    tempDir: env.TEMP_DIR ?? `${dir}/tmp`,
    libraryDir: env.LIBRARY_DIR ?? "/library",
    cookiesFile: str(env.COOKIES_FILE),
    ytdlpBinary: str(env.YTDLP_BIN),
    ffmpegBinary: str(env.FFMPEG_BIN),
    ffprobeBinary: str(env.FFPROBE_BIN),
    eventsPollMs: int(env.EVENTS_POLL_MS, 750),
    maxConcurrentDownloads: int(env.MAX_CONCURRENT_DOWNLOADS, 3),
    hls: {
      segmentSeconds: int(env.HLS_SEGMENT_SECONDS, DEFAULT_SEGMENT_SECONDS),
      idleMs: int(env.HLS_IDLE_MS, DEFAULT_IDLE_MS),
      transcodeIdleMs: int(env.HLS_TRANSCODE_IDLE_MS, DEFAULT_TRANSCODE_IDLE_MS),
      maxSessions: int(env.HLS_MAX_SESSIONS, DEFAULT_MAX_SESSIONS),
    },
    thumbnails: {
      width: int(env.THUMBNAIL_WIDTH, DEFAULT_THUMBNAIL_WIDTH),
      maxConcurrent: int(env.THUMBNAIL_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT),
      timeoutMs: int(env.THUMBNAIL_TIMEOUT_MS, DEFAULT_GENERATE_TIMEOUT_MS),
      maxEntries: int(env.THUMBNAIL_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
    },
    trashRetentionDays: int(env.TRASH_RETENTION_DAYS, 30),
    dev: env.NODE_ENV !== "production" && str(env.CASATUBE_DEV) !== undefined,
  };
}
