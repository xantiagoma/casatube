/**
 * The queue — the narrow seam where R1 and R2 live.
 *
 * R1 (a job survives the browser closing) and R2 (a job survives the service
 * restarting) are not properties of the worker or of the API: they are
 * properties of this file. Everything above it goes through `enqueue`,
 * `claimNext`, `update` and `recoverOnStart`, so the guarantees have exactly
 * one place to be right (PLAN §9).
 *
 * ## Two databases, on purpose
 *
 * `bunqueue` keeps its own SQLite file; our `Job` rows live in ours. Both sit
 * under `DATA_DIR`, so one volume and one directory copy still cover
 * everything — and the accepted cost is that **a job's row and its queue entry
 * cannot be written in one transaction**. They can drift.
 *
 * ## Where the truth lives
 *
 * Our table, for everything that decides behaviour:
 *
 * | Concern | Owner |
 * |---|---|
 * | Job existence, status, progress, lease | our Drizzle table |
 * | Claim order — priority, then age | our table, index `jobs_claim_idx` |
 * | **Whether a job is claimable at all** (`paused`, `notBefore`) | our table |
 * | Attempt budget, dead-letter queue | bunqueue's entry |
 *
 * 🔴 That third row is the one that matters. A backoff-delayed retry is written
 * as `notBefore` on the row, **not** read back out of bunqueue's `delayed`
 * state: if eligibility depended on the other database, R2's correctness would
 * lean on the mirror, and the mirror is the thing that is allowed to drift.
 * `recoverOnStart()` reconciles it in both directions precisely because nothing
 * important is decided by it.
 *
 * ⚠️ bunqueue's own concurrency control governs bunqueue `Worker`s, which we do
 * not use — jobs are *claimed*, never assigned (PLAN §17, rule 1). The
 * `MAX_CONCURRENT_DOWNLOADS` limit applies to the download stage and belongs to
 * the worker, not here.
 */
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { Result } from "better-result";
import { hash } from "ohash";
import { Queue as BunQueue, shutdownManager } from "bunqueue/client";

import type { Db } from "./db";
import { jobs } from "./schema";
import { InvalidTransition, LeaseLost, NotFound, type QueueError } from "./errors";
import {
  ACTIVE_STATUSES,
  DEFAULT_PREFERENCES,
  STAGE_ORDER,
  TERMINAL_STATUSES,
  type EnqueueInput,
  type EnqueueResult,
  type Job,
  type JobFilter,
  type JobPatch,
  type JobStatus,
  type Preferences,
  type Priority,
  type Stage,
} from "./types";

// The queue's own contract lives in `types.ts` — the API layer speaks it too.
// Re-exported so a caller that only wants the seam has one import.
export type { EnqueueInput, EnqueueResult, JobFilter, JobPatch } from "./types";

// --- Options ----------------------------------------------------------------

export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_BACKOFF_MS = 30_000;

/** How many candidates one claim pass looks at before re-reading the table. */
const CLAIM_BATCH = 16;

export interface JobQueueOptions {
  db: Db;
  /** bunqueue's SQLite file. **Not** the same file as `db` — see the header. */
  queueDbPath: string;
  queueName?: string;
  /** How long a claim stays valid without being renewed. */
  leaseMs?: number;
  /** Base delay for the exponential retry backoff written to `notBefore`. */
  backoffMs?: number;
  /** Injectable clock. Tests use it to make a lease or a backoff lapse. */
  now?: () => Date;
  /**
   * Called when a write to the queue mirror fails. The row is still correct and
   * `recoverOnStart()` will repair the mirror; this exists so the failure is
   * visible rather than swallowed.
   */
  onMirrorError?: (context: string, cause: unknown) => void;
}

// --- Helpers ----------------------------------------------------------------

type JobRow = typeof jobs.$inferSelect;

/**
 * `high` > `normal` > `low`, then oldest first.
 *
 * A plain `ORDER BY priority` would sort the *words*, putting `low` above
 * `normal`. `CASE … WHEN` is ANSI SQL, so this stays portable (PLAN §17 rule 6).
 */
const PRIORITY_RANK = sql<number>`case ${jobs.priority} when 'high' then 0 when 'normal' then 1 else 2 end`;

/** bunqueue orders `priority DESC`: a higher number is claimed sooner. */
const BUNQUEUE_PRIORITY: Record<Priority, number> = { high: 3, normal: 2, low: 1 };

const ACTIVE: JobStatus[] = [...ACTIVE_STATUSES];
const TERMINAL: JobStatus[] = [...TERMINAL_STATUSES];

function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

function iso(date: Date): string {
  return date.toISOString();
}

/** The JSON columns carry their real types now, so only the string unions cast. */
function toJob(row: JobRow): Job {
  return { ...row, status: row.status as JobStatus, priority: row.priority as Priority };
}

function freshStages(): Stage[] {
  return STAGE_ORDER.map((name) => ({ name, status: "pending" as const }));
}

/** Eligible to be picked up right now: queued, not paused, and due. */
function claimable(nowIso: string): SQL | undefined {
  return and(
    eq(jobs.status, "queued"),
    eq(jobs.paused, false),
    or(isNull(jobs.notBefore), lte(jobs.notBefore, nowIso)),
  );
}

/**
 * Resolve the preferences a job actually runs with.
 *
 * Language lists are sets, so they are sorted and de-duplicated here: without
 * that, `["en","es"]` and `["es","en"]` are the same request with two different
 * fingerprints, and duplicate detection quietly stops working.
 */
export function resolvePreferences(partial: Partial<Preferences> | undefined): Preferences {
  const merged = { ...DEFAULT_PREFERENCES, ...partial };
  return {
    ...merged,
    audioLanguages: [...new Set(merged.audioLanguages)].sort(),
    subtitleLanguages: [...new Set(merged.subtitleLanguages)].sort(),
  };
}

/**
 * The key duplicate detection compares (PLAN §15).
 *
 * URL **and resolved configuration** — 720p when 1080p is on disk is a real
 * request, not a duplicate. Destination is left out on purpose: PLAN names
 * format, resolution and languages as the configuration, and "already have it"
 * should not depend on which folder was asked for.
 */
export function fingerprintOf(url: string, preferences: Preferences): string {
  return hash({ url, preferences });
}

// --- The queue --------------------------------------------------------------

export class JobQueue {
  private readonly db: Db;
  private readonly bq: BunQueue<{ jobId: string }>;
  private readonly leaseMs: number;
  private readonly backoffMs: number;
  private readonly now: () => Date;
  private readonly onMirrorError: (context: string, cause: unknown) => void;

  constructor(options: JobQueueOptions) {
    this.db = options.db;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.now = options.now ?? (() => new Date());
    this.onMirrorError = options.onMirrorError ?? (() => {});
    this.bq = new BunQueue<{ jobId: string }>(options.queueName ?? "downloads", {
      embedded: true,
      dataPath: options.queueDbPath,
    });
  }

  async ready(): Promise<void> {
    await this.bq.waitUntilReady();
  }

  /** Releases this queue's handle. The embedded manager is process-wide — see
   * `shutdownEmbeddedQueue()`. */
  close(): void {
    this.bq.close();
  }

  /** How long a retry of this attempt number waits. Exponential, from attempt 1. */
  backoffFor(attempt: number): number {
    return this.backoffMs * 2 ** Math.max(0, attempt - 1);
  }

  // --- enqueue --------------------------------------------------------------

  async enqueue(input: EnqueueInput): Promise<Result<EnqueueResult, QueueError>> {
    const preferences = resolvePreferences(input.preferences);
    const fingerprint = fingerprintOf(input.url, preferences);

    if (!input.force) {
      const existing = await this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.fingerprint, fingerprint), eq(jobs.status, "done")))
        .orderBy(asc(jobs.createdAt))
        .limit(1);
      const found = existing[0];
      if (found) {
        return Result.ok({ outcome: "duplicate", job: toJob(found) });
      }
    }

    const nowIso = iso(this.now());
    // UUIDv7: time-ordered, so `id` is a stable tie-break for two jobs created
    // in the same millisecond.
    const id = Bun.randomUUIDv7();
    const priority: Priority = input.priority ?? "normal";

    const inserted = await this.db
      .insert(jobs)
      .values({
        id,
        url: input.url,
        provider: input.provider,
        destination: input.destination,
        title: input.title ?? null,
        status: "queued",
        stages: freshStages(),
        priority,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        paused: false,
        notBefore: null,
        preferences,
        fingerprint,
        log: [],
        thumbnail: input.thumbnail ?? null,
        duration: input.duration ?? null,
        source: input.source ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning();

    const row = inserted[0];
    /* c8 ignore next */
    if (!row) throw new Error("insert returned no row — impossible state");

    // The mirror. If this throws the row is still correct and recoverOnStart()
    // will put the entry back: that is the whole reason it exists.
    await this.mirrorAdd(id, priority, row.maxAttempts);

    return Result.ok({ outcome: "queued", job: toJob(row) });
  }

  // --- claim ----------------------------------------------------------------

  /**
   * Take the next eligible job, atomically.
   *
   * Atomicity does not come from a lock or a transaction spanning the read: it
   * comes from a **compare-and-swap**. The candidate list is only a hint; the
   * claim is an `UPDATE … WHERE id = ? AND status = 'queued' AND claimed_by IS
   * NULL AND (not_before IS NULL OR not_before <= ?)` that returns the row.
   * Exactly one caller can see a row come back, so two concurrent claims can
   * never hold the same job — and the same statement works unchanged against
   * Postgres the day this becomes distributed (PLAN §17, rule 1).
   *
   * The whole eligibility test is repeated inside that `WHERE` rather than
   * trusting the candidate list. In one process on a synchronous driver that
   * repetition is belt-and-braces and no test can tell the difference; it earns
   * its place the moment the read and the write are genuinely concurrent, which
   * is the case rule 4 of §17 is written for.
   */
  async claimNext(workerId: string): Promise<Result<Job | null, QueueError>> {
    await this.reapExpiredLeases();

    const startedAt = this.now();
    const nowIso = iso(startedAt);
    const leaseUntil = iso(new Date(startedAt.getTime() + this.leaseMs));

    for (;;) {
      const candidates = await this.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(claimable(nowIso))
        .orderBy(PRIORITY_RANK, asc(jobs.createdAt), asc(jobs.id))
        .limit(CLAIM_BATCH);

      if (candidates.length === 0) return Result.ok(null);

      for (const candidate of candidates) {
        const claimed = await this.db
          .update(jobs)
          .set({
            status: "analyzing",
            claimedBy: workerId,
            leaseUntil,
            // The backoff is spent; leaving it behind would only mislead a reader.
            notBefore: null,
            updatedAt: nowIso,
          })
          .where(and(eq(jobs.id, candidate.id), isNull(jobs.claimedBy), claimable(nowIso)))
          .returning();

        const row = claimed[0];
        if (row) return Result.ok(toJob(row));
        // Lost the race. Someone else holds it; try the next candidate.
      }
      // Every candidate was taken by someone else, so the eligible set strictly
      // shrank: re-reading terminates.
    }
  }

  /**
   * Extend a claim the caller still holds.
   *
   * A 1080p download outlives any sane lease, so the worker has to say it is
   * still alive. Without this, the lease is either uselessly long or it lapses
   * under a healthy worker.
   */
  async renewLease(id: string, workerId: string): Promise<Result<Job, QueueError>> {
    const startedAt = this.now();
    const renewed = await this.db
      .update(jobs)
      .set({
        leaseUntil: iso(new Date(startedAt.getTime() + this.leaseMs)),
        updatedAt: iso(startedAt),
      })
      .where(and(eq(jobs.id, id), eq(jobs.claimedBy, workerId), inArray(jobs.status, ACTIVE)))
      .returning();

    const row = renewed[0];
    if (!row) {
      // The job may well exist — we just stopped owning it. The worker has to
      // stop either way, and `LeaseLost` says which of the two happened.
      const exists = await this.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).limit(1);
      if (!exists[0]) return Result.err(new NotFound({ what: "job", id }));
      return Result.err(new LeaseLost({ jobId: id, workerId }));
    }
    return Result.ok(toJob(row));
  }

  /**
   * Return jobs whose lease has lapsed to the queue.
   *
   * `progress` and `doneBytes` are left untouched so the download resumes where
   * it stopped; `speed` and `eta` are cleared because they describe a worker
   * that is gone.
   */
  async reapExpiredLeases(): Promise<number> {
    const nowIso = iso(this.now());
    const reaped = await this.db
      .update(jobs)
      .set({ status: "queued", claimedBy: null, leaseUntil: null, speed: null, eta: null, updatedAt: nowIso })
      .where(and(inArray(jobs.status, ACTIVE), isNotNull(jobs.leaseUntil), lt(jobs.leaseUntil, nowIso)))
      .returning({ id: jobs.id });
    return reaped.length;
  }

  // --- recovery -------------------------------------------------------------

  /**
   * 🔴 The reason this project exists (R2).
   *
   * Everything a worker was holding goes back to `queued` — `analyzing`,
   * `downloading`, `processing`, `moving` — with `progress` and `doneBytes`
   * kept, so the download resumes instead of starting over.
   *
   * And because the queue entry lives in a **different database** from the row,
   * the two can be out of step after a crash: this also re-creates the entry
   * for any live job that has lost it, and removes entries for jobs that are
   * finished or gone. Nothing about eligibility is decided by that entry, but
   * leaving it wrong would make the queue's own bookkeeping a lie.
   *
   * @returns how many job rows needed recovering.
   */
  async recoverOnStart(): Promise<number> {
    const nowIso = iso(this.now());
    const recovered = new Set<string>();

    // 1. Anything a worker was holding.
    const requeued = await this.db
      .update(jobs)
      .set({ status: "queued", claimedBy: null, leaseUntil: null, speed: null, eta: null, updatedAt: nowIso })
      .where(inArray(jobs.status, ACTIVE))
      .returning({ id: jobs.id });
    for (const row of requeued) recovered.add(row.id);

    // 2. Half-written claims: a row that is queued but still carries a claim.
    const unclaimed = await this.db
      .update(jobs)
      .set({ claimedBy: null, leaseUntil: null, updatedAt: nowIso })
      .where(and(eq(jobs.status, "queued"), isNotNull(jobs.claimedBy)))
      .returning({ id: jobs.id });
    for (const row of unclaimed) recovered.add(row.id);

    // 3. Drift, our side: a live job whose queue entry is missing.
    const live = await this.db.select().from(jobs).where(notInArray(jobs.status, TERMINAL));
    const liveIds = new Set(live.map((row) => row.id));
    for (const row of live) {
      if ((await this.queueState(row.id)) === "unknown") {
        await this.mirrorAdd(row.id, row.priority as Priority, row.maxAttempts);
        recovered.add(row.id);
      }
    }

    // 4. Drift, their side: an entry for a job that is finished or gone.
    try {
      const entries = await this.bq.getJobsAsync();
      for (const entry of entries) {
        if (!liveIds.has(entry.id)) await this.bq.removeAsync(entry.id);
      }
    } catch (cause) {
      this.onMirrorError("recoverOnStart: sweeping orphan entries", cause);
    }

    return recovered.size;
  }

  // --- reads ----------------------------------------------------------------

  async get(id: string): Promise<Result<Job, QueueError>> {
    const found = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    const row = found[0];
    if (!row) return Result.err(new NotFound({ what: "job", id }));
    return Result.ok(toJob(row));
  }

  /** Listing cannot fail, so it does not carry a `Result`. */
  async list(filter: JobFilter = {}): Promise<Job[]> {
    const conditions: SQL[] = [];
    if (filter.status !== undefined) {
      conditions.push(
        Array.isArray(filter.status)
          ? inArray(jobs.status, filter.status)
          : eq(jobs.status, filter.status),
      );
    }
    if (filter.paused !== undefined) conditions.push(eq(jobs.paused, filter.paused));
    if (filter.claimedBy !== undefined) conditions.push(eq(jobs.claimedBy, filter.claimedBy));
    if (filter.fingerprint !== undefined) conditions.push(eq(jobs.fingerprint, filter.fingerprint));
    if (filter.url !== undefined) conditions.push(eq(jobs.url, filter.url));

    const rows = await this.db
      .select()
      .from(jobs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(PRIORITY_RANK, asc(jobs.createdAt), asc(jobs.id))
      .limit(filter.limit ?? 200)
      .offset(filter.offset ?? 0);

    return rows.map(toJob);
  }

  // --- writes ---------------------------------------------------------------

  async update(id: string, patch: JobPatch): Promise<Result<Job, QueueError>> {
    const current = await this.get(id);
    if (Result.isError(current)) return current;
    const job = current.value;

    if (patch.status !== undefined && patch.status !== job.status && isTerminal(job.status)) {
      // `done`, `failed` and `cancelled` are final here. Reviving a job is
      // `retry()`, which also re-creates the queue entry — an `update` back to
      // `queued` would leave the job unclaimable forever.
      return Result.err(new InvalidTransition({ jobId: id, from: job.status, to: patch.status }));
    }

    const { appendLog, ...fields } = patch;
    const values: Partial<JobRow> = { ...fields, updatedAt: iso(this.now()) };

    if (appendLog !== undefined && appendLog.length > 0) {
      values.log = [...job.log, ...appendLog];
    }
    if (patch.status !== undefined && isTerminal(patch.status)) {
      values.claimedBy = null;
      values.leaseUntil = null;
      values.speed = null;
      values.eta = null;
    }

    const updated = await this.db.update(jobs).set(values).where(eq(jobs.id, id)).returning();
    const row = updated[0];
    if (!row) return Result.err(new NotFound({ what: "job", id }));

    if (patch.status !== undefined && isTerminal(patch.status)) {
      await this.mirrorRemove(id);
    } else if (patch.priority !== undefined && patch.priority !== job.priority) {
      await this.mirrorPriority(id, patch.priority);
    }

    return Result.ok(toJob(row));
  }

  /**
   * Hold a job back for a while without failing it.
   *
   * This is what a worker does with `RateLimited`: `demandsBackoff` says slow
   * down, and `notBefore` is where "slow down" is written so that every worker
   * and every restart sees it.
   */
  async defer(id: string, ms: number): Promise<Result<Job, QueueError>> {
    return this.update(id, { notBefore: iso(new Date(this.now().getTime() + ms)) });
  }

  /** The user cancelled. Not a failure — see `errors.ts`. */
  async cancel(id: string): Promise<Result<Job, QueueError>> {
    const current = await this.get(id);
    if (Result.isError(current)) return current;
    const job = current.value;

    if (job.status === "cancelled") return Result.ok(job); // idempotent
    if (isTerminal(job.status)) {
      return Result.err(new InvalidTransition({ jobId: id, from: job.status, to: "cancelled" }));
    }

    return this.update(id, { status: "cancelled" });
  }

  async pause(id: string): Promise<Result<Job, QueueError>> {
    return this.setPaused(id, true);
  }

  async resume(id: string): Promise<Result<Job, QueueError>> {
    return this.setPaused(id, false);
  }

  /**
   * Put a finished-badly job back in the queue, behind its backoff.
   *
   * The delay is `notBefore` on the row: the job reads `queued` and `claimNext`
   * passes over it until it is due. One database decides that, and it survives
   * a restart because it is a column and not a timer.
   */
  async retry(id: string): Promise<Result<Job, QueueError>> {
    const current = await this.get(id);
    if (Result.isError(current)) return current;
    const job = current.value;

    if (job.status !== "failed" && job.status !== "cancelled") {
      return Result.err(new InvalidTransition({ jobId: id, from: job.status, to: "queued" }));
    }

    const startedAt = this.now();
    const attempts = job.attempts + 1;
    const updated = await this.db
      .update(jobs)
      .set({
        status: "queued",
        attempts,
        error: null,
        claimedBy: null,
        leaseUntil: null,
        notBefore: iso(new Date(startedAt.getTime() + this.backoffFor(attempts))),
        speed: null,
        eta: null,
        updatedAt: iso(startedAt),
      })
      .where(eq(jobs.id, id))
      .returning();

    const row = updated[0];
    if (!row) return Result.err(new NotFound({ what: "job", id }));

    await this.mirrorRemove(id);
    await this.mirrorAdd(id, row.priority as Priority, row.maxAttempts);

    return Result.ok(toJob(row));
  }

  // --- the mirror -----------------------------------------------------------

  private async setPaused(id: string, paused: boolean): Promise<Result<Job, QueueError>> {
    const current = await this.get(id);
    if (Result.isError(current)) return current;
    const job = current.value;

    if (isTerminal(job.status)) {
      return Result.err(new InvalidTransition({ jobId: id, from: job.status, to: paused ? "paused" : "queued" }));
    }
    if (job.paused === paused) return Result.ok(job);

    const updated = await this.db
      .update(jobs)
      .set({ paused, updatedAt: iso(this.now()) })
      .where(eq(jobs.id, id))
      .returning();

    const row = updated[0];
    if (!row) return Result.err(new NotFound({ what: "job", id }));
    return Result.ok(toJob(row));
  }

  /** `unknown` when bunqueue has no entry — the drift `recoverOnStart` repairs. */
  private async queueState(id: string): Promise<string> {
    try {
      return await this.bq.getJobState(id);
    } catch (cause) {
      this.onMirrorError(`queueState(${id})`, cause);
      return "unknown";
    }
  }

  private async mirrorAdd(id: string, priority: Priority, maxAttempts: number): Promise<void> {
    try {
      await this.bq.add(
        "download",
        { jobId: id },
        {
          jobId: id,
          priority: BUNQUEUE_PRIORITY[priority],
          attempts: maxAttempts,
          backoff: { type: "exponential", delay: this.backoffMs },
        },
      );
    } catch (cause) {
      this.onMirrorError(`mirrorAdd(${id})`, cause);
    }
  }

  private async mirrorRemove(id: string): Promise<void> {
    try {
      await this.bq.removeAsync(id);
    } catch (cause) {
      this.onMirrorError(`mirrorRemove(${id})`, cause);
    }
  }

  private async mirrorPriority(id: string, priority: Priority): Promise<void> {
    try {
      await this.bq.changeJobPriority(id, { priority: BUNQUEUE_PRIORITY[priority] });
    } catch (cause) {
      this.onMirrorError(`mirrorPriority(${id})`, cause);
    }
  }
}

/** Open a queue and wait until its embedded store is ready. */
export async function openJobQueue(options: JobQueueOptions): Promise<JobQueue> {
  const queue = new JobQueue(options);
  await queue.ready();
  return queue;
}

/**
 * ⚠️ bunqueue's embedded manager is a **process-wide singleton keyed by
 * `dataPath`**: opening a second queue on a different file throws until this is
 * called. One process, one queue database — which is what we run, and what
 * tests have to reset between cases.
 */
export function shutdownEmbeddedQueue(): void {
  shutdownManager();
}
