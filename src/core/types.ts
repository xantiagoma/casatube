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
}

export const DEFAULT_PREFERENCES: Preferences = {
  originalOnly: true,
  audioLanguages: [],
  subtitleLanguages: ["en"],
  maxResolution: 1080,
  sponsorblock: true,
};

type JobRow = typeof jobs.$inferSelect;
/** Serialised columns are typed properly here rather than as `unknown`. */
export type Job = Omit<JobRow, "stages" | "preferences" | "log" | "status" | "priority"> & {
  stages: Stage[];
  preferences: Preferences;
  log: string[];
  status: JobStatus;
  priority: Priority;
};

export type Source = Omit<typeof sources.$inferSelect, "preferences"> & {
  preferences: Preferences;
};

export type Notification = typeof notifications.$inferSelect;

// --- Provider-neutral media vocabulary --------------------------------------
// ⚠️ PLAN §5: getting this vocabulary right is the main design risk. It must
// describe media without leaking any single tool's flags or format syntax.

export interface AudioTrack {
  /** Opaque to everything above the provider. */
  id: string;
  /** ISO 639-2/B, three letters. `und` when genuinely unknown — never guessed. */
  language: string;
  /** The track the source marks as original, if any. */
  isOriginal: boolean;
  bitrate?: number;
  codec?: string;
}

export interface SubtitleTrack {
  id: string;
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
