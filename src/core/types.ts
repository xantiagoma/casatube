/**
 * The shared contract. Shapes derive from the schema; the unions and the
 * provider-neutral vocabulary live here.
 */
import type { Result } from "better-result";
import type { jobs, notifications, sources } from "./schema";
import type { ProviderError } from "./errors";

export type JobStatus =
  | "queued" | "analyzing" | "downloading" | "processing"
  | "moving" | "waiting-for-destination" | "done" | "failed" | "cancelled";

export type StageName =
  | "validate" | "analyze" | "download" | "postprocess" | "metadata" | "move";

export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface Stage {
  name: StageName;
  status: StageStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export const STAGE_ORDER: readonly StageName[] = [
  "validate", "analyze", "download", "postprocess", "metadata", "move",
] as const;

/** Statuses a worker can hold. On startup these return to `queued` — PLAN R2. */
export const ACTIVE_STATUSES: readonly JobStatus[] = [
  "analyzing", "downloading", "processing", "moving",
] as const;

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "done", "failed", "cancelled",
] as const;

export type Priority = "high" | "normal" | "low";

export interface Preferences {
  /** Exactly one audio track: the one marked original. */
  originalOnly: boolean;
  audioLanguages: string[];
  /** ⚠️ Independent of audio — PLAN R7. Never derive one from the other. */
  subtitleLanguages: string[];
  maxResolution: number;
  sponsorblock: boolean;
  /**
   * Embed subtitles in the container, or write them alongside as files.
   *
   * The reference designs expose this as a toggle, so it belongs to the user
   * rather than to the plan. Sidecars are the default: every media server reads
   * them and they can be replaced without touching the video.
   */
  embedSubtitles: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  originalOnly: true,
  audioLanguages: [],
  subtitleLanguages: ["en"],
  maxResolution: 1080,
  sponsorblock: true,
  embedSubtitles: false,
};

type JobRow = typeof jobs.$inferSelect;
/**
 * The row, with its two string unions narrowed.
 *
 * `stages`, `preferences` and `log` are already typed by the schema itself via
 * `.$type<>()`, so they need no help here.
 */
export type Job = Omit<JobRow, "status" | "priority"> & {
  status: JobStatus;
  priority: Priority;
};

export type Source = Omit<typeof sources.$inferSelect, "preferences"> & {
  preferences: Preferences;
};

export type Notification = typeof notifications.$inferSelect;

// --- Queue contract ---------------------------------------------------------
// What the API layer hands the queue and gets back. These live here rather than
// in `queue.ts` because the HTTP layer speaks them too, and a second definition
// of the same shape is exactly the drift this file exists to prevent.

export interface EnqueueInput {
  url: string;
  /** Which provider claimed the URL. */
  provider: string;
  /** Library subfolder, never an absolute path. */
  destination: string;
  preferences?: Partial<Preferences>;
  priority?: Priority;
  maxAttempts?: number;
  title?: string | null;
  source?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  /**
   * Re-download even when a finished job with the same fingerprint exists.
   * Always offered, because the usual reason to ask again is that something
   * went wrong with the first copy (PLAN §15).
   */
  force?: boolean;
}

/**
 * ⚠️ Wider than a bare `Job`, deliberately.
 *
 * "Already have it" is not an error — PLAN §15 says *report* it — but it is
 * also not the same answer as "queued". Folding it into one shape would make
 * the two indistinguishable at the call site, which is precisely what the UI
 * has to tell apart to render "already downloaded" instead of "queued".
 */
export type EnqueueResult =
  | { outcome: "queued"; job: Job }
  | { outcome: "duplicate"; job: Job };

/** Fields a worker may write back. `url` and `preferences` are not among them. */
export type JobPatch = Partial<
  Pick<
    Job,
    | "status"
    | "title"
    | "stages"
    | "progress"
    | "totalBytes"
    | "doneBytes"
    | "speed"
    | "eta"
    | "thumbnail"
    | "duration"
    | "source"
    | "error"
    | "outputFile"
    | "priority"
    | "attempts"
    | "claimedBy"
    | "leaseUntil"
    | "notBefore"
  >
> & {
  /** Appended to the log rather than replacing it. */
  appendLog?: string[];
};

export interface JobFilter {
  status?: JobStatus | JobStatus[];
  paused?: boolean;
  claimedBy?: string;
  fingerprint?: string;
  url?: string;
  limit?: number;
  offset?: number;
}

// --- Provider-neutral media vocabulary --------------------------------------
// ⚠️ PLAN §5: getting this vocabulary right is the main design risk. It must
// describe media without leaking any single tool's flags or format syntax.

export interface AudioTrack {
  /** Opaque to everything above the provider. */
  id: string;
  /**
   * **As the provider stated it**, not normalised: `en-US`, `es-419`, `pt-BR`.
   *
   * Normalisation to a container tag happens in exactly one place —
   * `selection.toLanguageTag()` — which maps to ISO 639-2/B and to `und` when
   * genuinely unknown. Never guessed.
   *
   * Providers must pass this through raw. Normalising here would discard the
   * region before anything could use it, and do the work twice.
   */
  language: string;
  /** The track the source marks as original, if any. */
  isOriginal: boolean;
  bitrate?: number;
  codec?: string;
  /**
   * Approximate size, so the total can be seeded before the track starts.
   *
   * Without it the progress total grows as each file begins and the percentage
   * dips — audio is a few percent of a 1080p download, so it is a small dip
   * rather than a reset, but it is still the bar telling a small lie.
   */
  approxBytes?: number;
}

export interface SubtitleTrack {
  id: string;
  /** As the provider stated it — see {@link AudioTrack.language}. */
  language: string;
  /** Machine-generated captions rather than authored subtitles. */
  automatic: boolean;
  format?: string;
}

export interface VideoFormat {
  id: string;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrate?: number;
  approxBytes?: number;
}

export interface MediaInfo {
  /** The provider's own identifier for this item. */
  externalId: string;
  title: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  /** "youtube", "vimeo"… for display and grouping. */
  source: string;
  videoFormats: VideoFormat[];
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
}

/** What the selection logic decided, in provider-neutral terms. */
export interface DownloadPlan {
  url: string;
  video: VideoFormat | null;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  /**
   * Track id → real language tag, for the container.
   *
   * 🔴 This exists because HomeTube gets it wrong: it writes `por` and `pan`
   * onto tracks that are English and Spanish (PLAN §4.1). The tag must come
   * from the track, and be passed to the muxer explicitly.
   */
  languageTags: Record<string, string>;
  sponsorblock: boolean;
  /**
   * Embedded in the container, or written alongside as separate files.
   *
   * Sidecars are easier to replace later and every media server reads them;
   * embedded travels with the file. The plan has to say which, because the
   * provider cannot guess.
   */
  subtitleMode: "embed" | "sidecar";
  /** Safe filename, without extension. */
  outputName: string;
}

export interface DiscoveredItem {
  externalId: string;
  url: string;
  title: string;
  publishedAt?: string;
}

export interface ProviderContext {
  /** Worker-local. ⚠️ Never stored as if another worker could see it — PLAN §17 rule 5. */
  workDir: string;
  signal: AbortSignal;
  onProgress(p: ProgressUpdate): void;
  log(line: string): void;
}

export interface ProgressUpdate {
  /**
   * Which stage this reading describes.
   *
   * Without it, "100%" during post-processing is indistinguishable from "done"
   * — the UI needs to say *merging* rather than leaving a full bar sitting
   * there while ffmpeg works.
   */
  stage?: StageName;
  percent?: number;
  doneBytes?: number;
  totalBytes?: number;
  speed?: number;
  eta?: number;
}

export interface FetchResult {
  /** Absolute path inside `workDir`. */
  file: string;
  /** Sidecar subtitle files, if not embedded. */
  subtitleFiles: string[];
}

export interface Provider {
  name: string;
  /** Asked in registration order; the built-in yt-dlp provider answers last. */
  supports(url: string): boolean;
  probe(url: string, signal: AbortSignal): Promise<Result<MediaInfo, ProviderError>>;
  fetch(plan: DownloadPlan, ctx: ProviderContext): Promise<Result<FetchResult, ProviderError>>;
  list?(url: string, signal: AbortSignal): Promise<Result<DiscoveredItem[], ProviderError>>;
}
