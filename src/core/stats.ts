/**
 * Storage and analytics — the numbers behind the Storage and Analytics screens.
 *
 * Two very different jobs live here, and they share this file because they are
 * the same product surface: "what is on the disk" and "what has this thing been
 * doing". Neither writes anything. The analytics half is **SELECT only** — job
 * history belongs to the queue, and a stats module that mutated it would be a
 * second writer to the one table whose correctness R1 and R2 depend on.
 *
 * ## Two hazards, both real
 *
 * ⚠️ **The library is usually a network mount, and a dead mount hangs rather
 * than failing.** `statfs()` on an unreachable NFS export blocks in the kernel,
 * so every filesystem call here runs under a deadline and reports
 * `MountUnavailable` when it expires — the same shape `destinations.ts` uses,
 * for the same reason. As there, the deadline *abandons* the call rather than
 * cancelling it: an in-flight `statfs` cannot be cancelled, and racing it is
 * the honest version of giving up.
 *
 * ⚠️ **`bun:sqlite` is synchronous.** A query that walks the whole job history
 * blocks the event loop, and with it every open SSE stream — the queue would
 * appear to freeze in the browser because someone opened the Analytics tab. So
 * the analytics query is bounded three ways: a time range in the `WHERE`, a
 * hard row cap, and a projection that leaves the fat JSON columns (`plan`,
 * `log`) in the database. What is *not* bounded is the scan itself: there is no
 * index on `jobs.created_at`, so the range predicate reads every row. See the
 * note on `MAX_ROWS`.
 */
import { desc, gte } from "drizzle-orm";
import { Result } from "better-result";
import { statfs as nodeStatfs } from "node:fs/promises";

import type { Db } from "./db";
import { MountUnavailable } from "./errors";
import { jobs } from "./schema";
import type { Stage } from "./types";

// --- Storage ----------------------------------------------------------------

/**
 * The part of `statfs` we use.
 *
 * Declared structurally rather than imported as `StatsFs` so a test can hand in
 * a function that hangs, or one that describes a 4 TB disk that is not on this
 * machine. Reading the real numbers of the developer's own laptop and asserting
 * on them proves nothing.
 */
export interface FilesystemSize {
  /** Block size, in bytes. */
  bsize: number;
  /** Total data blocks. */
  blocks: number;
  /** Free blocks. */
  bfree: number;
  /** Free blocks available to an unprivileged process. */
  bavail: number;
}

export type StatfsFn = (path: string) => Promise<FilesystemSize>;

/** Long enough for a spinning disk to answer, short enough that a dead mount is obvious. */
export const STATFS_TIMEOUT_MS = 5_000;

export interface DiskUsage {
  totalBytes: number;
  /**
   * Occupied, from the filesystem's point of view.
   *
   * ⚠️ `used + free` is deliberately **not** `total`: most filesystems reserve
   * blocks that are free but not available to us, and pretending otherwise is
   * how a "0 bytes free" disk still writes. `used` counts against `bfree`,
   * `free` reports `bavail`.
   */
  usedBytes: number;
  /** What we could actually write. */
  freeBytes: number;
  /** 0–100, one decimal. Derived here so two screens cannot round it differently. */
  usedPercent: number;
}

/**
 * One path's answer — which may be "the mount is down".
 *
 * A `Result` per path rather than one for the pair: the temp directory being
 * readable while the library is unreachable is the *normal* state of a home
 * server with a sleeping NAS, and it is exactly when someone opens this screen.
 * Failing the whole response would hide the half that still works.
 */
export type DiskReport =
  | { path: string; available: true; usage: DiskUsage }
  | { path: string; available: false; error: MountUnavailable };

export interface StorageStats {
  /** Where finished downloads go. Usually the network mount. */
  library: DiskReport;
  /** Where they are written first — see PLAN §15: a down destination fills this. */
  temp: DiskReport;
  at: string;
}

export interface StorageOptions {
  libraryDir: string;
  tempDir: string;
  timeoutMs?: number;
  statfs?: StatfsFn;
  now?: () => Date;
}

/** A sentinel, so a legitimate `undefined` cannot be mistaken for a timeout. */
const TIMED_OUT = Symbol("timed-out");

/**
 * Run `work`, or give up on it.
 *
 * The abandoned promise's rejection is swallowed on purpose: nobody is
 * listening once the deadline has passed, and an unhandled rejection from a NAS
 * that woke up late would take the process down.
 */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  path: string,
  what: string,
): Promise<Result<T, MountUnavailable>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });

  try {
    const outcome = await Promise.race([work.then((value) => ({ value })), expired]);
    if (outcome === TIMED_OUT) {
      void work.catch(() => {});
      return Result.err(new MountUnavailable({ path, detail: `${what} did not answer within ${ms} ms` }));
    }
    return Result.ok(outcome.value);
  } catch (cause) {
    return Result.err(
      new MountUnavailable({ path, detail: cause instanceof Error ? cause.message : String(cause) }),
    );
  } finally {
    clearTimeout(timer);
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * How much space one path's filesystem has.
 *
 * Reports the **filesystem** the path is on, not the size of what is inside it:
 * measuring the library itself would mean walking tens of thousands of files
 * over the mount that is already the slow part of this screen.
 */
export async function diskUsage(
  path: string,
  options: { timeoutMs?: number; statfs?: StatfsFn } = {},
): Promise<Result<DiskUsage, MountUnavailable>> {
  const statfs = options.statfs ?? ((p: string) => nodeStatfs(p) as Promise<FilesystemSize>);
  const stats = await withDeadline(
    statfs(path),
    options.timeoutMs ?? STATFS_TIMEOUT_MS,
    path,
    "reading free space",
  );
  if (Result.isError(stats)) return stats;

  const { bsize, blocks, bfree, bavail } = stats.value;
  const totalBytes = blocks * bsize;
  const usedBytes = (blocks - bfree) * bsize;
  const freeBytes = bavail * bsize;

  return Result.ok({
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0,
  });
}

async function reportFor(path: string, options: StorageOptions): Promise<DiskReport> {
  const usage = await diskUsage(path, { timeoutMs: options.timeoutMs, statfs: options.statfs });
  return Result.isError(usage)
    ? { path, available: false, error: usage.error }
    : { path, available: true, usage: usage.value };
}

/**
 * Both paths, measured in parallel.
 *
 * In parallel because they are usually on *different* devices — a local temp
 * disk and a remote library — so measuring them in series would make the fast
 * one wait out the slow one's deadline.
 */
export async function storageStats(options: StorageOptions): Promise<StorageStats> {
  const now = options.now ?? (() => new Date());
  const [library, temp] = await Promise.all([
    reportFor(options.libraryDir, options),
    reportFor(options.tempDir, options),
  ]);
  return { library, temp, at: now().toISOString() };
}

// --- Analytics --------------------------------------------------------------

/**
 * The windows the Analytics screen offers.
 *
 * A closed set, exported as the tuple rather than as a union type alone, so the
 * HTTP layer can validate against *this* list instead of restating it — a
 * fourth range then has one place to be added.
 */
export const STATS_RANGES = ["24h", "7d", "30d"] as const;

export type StatsRange = (typeof STATS_RANGES)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * How each range is cut up.
 *
 * ⚠️ Buckets are aligned to **UTC** boundaries (epoch division), not to the
 * server's local calendar. That makes the series deterministic and the same on
 * every machine; a UI that wants local days has to say "UTC" or shift them
 * itself. Aligning here to a server timezone would silently change the numbers
 * when the container's `TZ` changed.
 */
const BUCKETS: Record<StatsRange, { bucketMs: number; count: number }> = {
  "24h": { bucketMs: HOUR_MS, count: 24 },
  "7d": { bucketMs: DAY_MS, count: 7 },
  "30d": { bucketMs: DAY_MS, count: 30 },
};

/**
 * Ceiling on rows one analytics call reads.
 *
 * 🔴 Retention defaults to *never delete* (PLAN §15), so job history only grows,
 * and there is no index on `jobs.created_at` — the range predicate is a table
 * scan whatever this number is. The cap bounds the part that would hurt most:
 * the rows materialised, parsed and aggregated in JS while the event loop
 * waits. A library that outgrows it gets `truncated: true` and the **newest**
 * rows, never a silently wrong average.
 */
export const MAX_ROWS = 5_000;

/** How many sources the "top sources" list keeps. */
export const TOP_SOURCES = 10;

export interface AnalyticsBucket {
  /** Bucket start, ISO-8601 UTC. Inclusive; the next bucket's start is exclusive. */
  start: string;
  jobs: number;
  completed: number;
  failed: number;
  bytes: number;
}

export interface SourceStat {
  /** `jobs.source` when the provider set one, otherwise the URL's host. */
  source: string;
  jobs: number;
  completed: number;
  failed: number;
  bytes: number;
}

export interface DistributionSlice {
  key: string;
  jobs: number;
  bytes: number;
}

export interface Analytics {
  range: StatsRange;
  /** Start of the first bucket, inclusive. */
  since: string;
  /** When this was computed. The last bucket is partial up to here. */
  until: string;
  /** Every job created in the window, whatever became of it. */
  jobs: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Still queued or being worked on — neither a success nor a failure yet. */
  active: number;
  /**
   * `completed / (completed + failed)`, 0–1.
   *
   * Cancelled jobs are excluded on both sides: the user changing their mind is
   * not a failure, and counting it as one would make "success rate" a measure
   * of how often they change their mind.
   */
  successRate: number;
  /** Bytes actually fetched by the jobs that finished. */
  bytes: number;
  /** Wall-clock time those jobs spent in the pipeline. */
  totalMs: number;
  series: AnalyticsBucket[];
  topSources: SourceStat[];
  /** For the donut: video / audio / other, from what was written. */
  byType: DistributionSlice[];
  /** For the donut: which library subfolder it landed in. */
  byDestination: DistributionSlice[];
  /** How many rows were read. */
  sampled: number;
  /** True when the row cap was hit — the oldest part of the window is missing. */
  truncated: boolean;
}

export interface AnalyticsOptions {
  db: Db;
  range?: StatsRange;
  now?: () => Date;
  maxRows?: number;
  topSources?: number;
}

/** Just enough of a job row to answer every question on the screen. */
const ANALYTICS_COLUMNS = {
  status: jobs.status,
  createdAt: jobs.createdAt,
  updatedAt: jobs.updatedAt,
  doneBytes: jobs.doneBytes,
  totalBytes: jobs.totalBytes,
  source: jobs.source,
  url: jobs.url,
  destination: jobs.destination,
  outputFile: jobs.outputFile,
  stages: jobs.stages,
} as const;

type AnalyticsRow = {
  [K in keyof typeof ANALYTICS_COLUMNS]: (typeof jobs.$inferSelect)[K];
};

const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "webm", "mov", "avi", "m4v", "flv", "ts", "mpg", "mpeg"]);
const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "opus", "ogg", "oga", "flac", "wav", "aac", "wma"]);

/** Video, audio, or neither — the three slices the dashboard cards already name. */
export function mediaType(outputFile: string | null): string {
  if (!outputFile) return "unknown";
  const dot = outputFile.lastIndexOf(".");
  if (dot < 0 || dot === outputFile.length - 1) return "other";
  const extension = outputFile.slice(dot + 1).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return "other";
}

/**
 * What to call this job's source.
 *
 * `jobs.source` is set by `analyze`, so anything that failed before that has
 * none — and "unknown" for every failure would make the one list that could
 * show *which site is refusing us* useless. The host is a fair stand-in, and it
 * is the only part of the URL that belongs on a shared chart.
 */
export function sourceLabel(row: Pick<AnalyticsRow, "source" | "url">): string {
  if (row.source && row.source.trim() !== "") return row.source;
  try {
    return new URL(row.url).host || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * How long this job took, wall clock.
 *
 * From the stage records when they have run, because `createdAt → updatedAt`
 * includes however long the job sat in the queue behind three others — which is
 * a fact about the queue, not about the download. The row timestamps are the
 * fallback for jobs whose stages never started.
 */
export function elapsedMs(row: Pick<AnalyticsRow, "stages" | "createdAt" | "updatedAt">): number {
  let first: number | null = null;
  let last: number | null = null;

  for (const stage of row.stages as Stage[]) {
    const started = stage.startedAt ? Date.parse(stage.startedAt) : Number.NaN;
    const finished = stage.finishedAt ? Date.parse(stage.finishedAt) : Number.NaN;
    if (Number.isFinite(started) && (first === null || started < first)) first = started;
    if (Number.isFinite(finished) && (last === null || finished > last)) last = finished;
  }

  if (first !== null && last !== null && last >= first) return last - first;

  const created = Date.parse(row.createdAt);
  const updated = Date.parse(row.updatedAt);
  if (Number.isFinite(created) && Number.isFinite(updated) && updated > created) return updated - created;
  return 0;
}

/** What this job actually pulled down. `totalBytes` is the estimate, `doneBytes` the truth. */
function bytesOf(row: Pick<AnalyticsRow, "doneBytes" | "totalBytes">): number {
  return row.doneBytes ?? row.totalBytes ?? 0;
}

function bump(into: Map<string, DistributionSlice>, key: string, bytes: number): void {
  const slice = into.get(key);
  if (slice) {
    slice.jobs += 1;
    slice.bytes += bytes;
    return;
  }
  into.set(key, { key, jobs: 1, bytes });
}

/** Biggest first, ties broken by name so the order never flickers between polls. */
function sortSlices(slices: Iterable<DistributionSlice>): DistributionSlice[] {
  return [...slices].sort((a, b) => b.jobs - a.jobs || b.bytes - a.bytes || a.key.localeCompare(b.key));
}

/**
 * The Analytics screen, in one bounded query.
 *
 * One query and not five: five `SELECT count(*)`s over the same window would
 * scan the same rows five times, and every one of those scans is time the event
 * loop is not serving SSE. Reading the window once and aggregating in memory is
 * both fewer scans and the only way to compute the distributions without
 * dialect-specific string SQL (PLAN §17 rule 6 — `substr` and `strftime` are
 * not portable in the shape we would need them).
 */
export async function analytics(options: AnalyticsOptions): Promise<Analytics> {
  const range = options.range ?? "24h";
  const now = (options.now ?? (() => new Date()))();
  const maxRows = options.maxRows ?? MAX_ROWS;
  const topLimit = options.topSources ?? TOP_SOURCES;

  const { bucketMs, count } = BUCKETS[range];
  // The last bucket is the one `now` falls in, so the series always ends at the
  // present rather than at the last completed hour.
  const lastStart = Math.floor(now.getTime() / bucketMs) * bucketMs;
  const firstStart = lastStart - (count - 1) * bucketMs;
  const sinceIso = new Date(firstStart).toISOString();

  // Newest first, so a history bigger than the cap loses the *oldest* rows —
  // the ones furthest from the question being asked.
  const rows = (await options.db
    .select(ANALYTICS_COLUMNS)
    .from(jobs)
    .where(gte(jobs.createdAt, sinceIso))
    .orderBy(desc(jobs.createdAt))
    .limit(maxRows + 1)) as AnalyticsRow[];

  const truncated = rows.length > maxRows;
  const sample = truncated ? rows.slice(0, maxRows) : rows;

  const series: AnalyticsBucket[] = [];
  const byBucket = new Map<number, AnalyticsBucket>();
  for (let i = 0; i < count; i += 1) {
    const start = firstStart + i * bucketMs;
    const bucket: AnalyticsBucket = {
      start: new Date(start).toISOString(),
      jobs: 0,
      completed: 0,
      failed: 0,
      bytes: 0,
    };
    series.push(bucket);
    byBucket.set(start, bucket);
  }

  const sources = new Map<string, SourceStat>();
  const types = new Map<string, DistributionSlice>();
  const destinations = new Map<string, DistributionSlice>();

  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let bytes = 0;
  let totalMs = 0;

  for (const row of sample) {
    const isDone = row.status === "done";
    const isFailed = row.status === "failed";
    const isCancelled = row.status === "cancelled";
    const rowBytes = isDone ? bytesOf(row) : 0;

    if (isDone) {
      completed += 1;
      bytes += rowBytes;
      totalMs += elapsedMs(row);
      bump(types, mediaType(row.outputFile), rowBytes);
      // `""` is the library root, and a blank slice label is worse than a word.
      bump(destinations, row.destination === "" ? "(root)" : row.destination, rowBytes);
    } else if (isFailed) {
      failed += 1;
    } else if (isCancelled) {
      cancelled += 1;
    }

    const label = sourceLabel(row);
    const stat = sources.get(label) ?? { source: label, jobs: 0, completed: 0, failed: 0, bytes: 0 };
    stat.jobs += 1;
    if (isDone) stat.completed += 1;
    if (isFailed) stat.failed += 1;
    stat.bytes += rowBytes;
    sources.set(label, stat);

    const created = Date.parse(row.createdAt);
    if (Number.isFinite(created)) {
      const bucket = byBucket.get(Math.floor(created / bucketMs) * bucketMs);
      if (bucket) {
        bucket.jobs += 1;
        if (isDone) bucket.completed += 1;
        if (isFailed) bucket.failed += 1;
        bucket.bytes += rowBytes;
      }
    }
  }

  const finished = completed + failed;

  return {
    range,
    since: sinceIso,
    until: now.toISOString(),
    jobs: sample.length,
    completed,
    failed,
    cancelled,
    active: sample.length - completed - failed - cancelled,
    successRate: finished === 0 ? 0 : Math.round((completed / finished) * 10_000) / 10_000,
    bytes,
    totalMs,
    series,
    topSources: [...sources.values()]
      .sort((a, b) => b.jobs - a.jobs || b.bytes - a.bytes || a.source.localeCompare(b.source))
      .slice(0, topLimit),
    byType: sortSlices(types.values()),
    byDestination: sortSlices(destinations.values()),
    sampled: sample.length,
    truncated,
  };
}
