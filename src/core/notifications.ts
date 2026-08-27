/**
 * Notifications — persisted, because a notification you missed is not one.
 *
 * PLAN §15 is unusually blunt about this: *"Persisted in the database and pushed
 * to the browser live. Persisted because a notification you missed because the
 * tab was closed is not a notification."* That single sentence decides the
 * whole design. A toast emitted into an SSE stream is delivered to whoever
 * happens to be watching, which on a home server is nobody at 3am — exactly
 * when the job that needed telling about fails. So the row is written first and
 * the stream is only an accelerator: a browser that connects tomorrow morning
 * gets the same list, in the same order, with the same unread marks.
 *
 * That is also why `readAt` is a timestamp rather than a boolean. "Read" is an
 * event that happened at a moment, and having the moment costs nothing and
 * makes "what did I miss overnight" answerable.
 *
 * ## Writes, unlike the rest of the read-only reporting layer
 *
 * This module owns the `notifications` table completely — nothing else writes
 * to it — so it needs no lease, no claim and no reconciliation. It touches no
 * other table: a notification *references* `jobId` but there is no foreign key,
 * on purpose, so that deleting job history (PLAN §15, retention) cannot fail on
 * a notification still pointing at it.
 */
import { and, asc, count, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { Result } from "better-result";

import type { Db } from "./db";
import { NotFound } from "./errors";
import { notifications } from "./schema";
import type { Job, Notification } from "./types";

/**
 * How loud a notification is.
 *
 * Exported as the tuple as well as the union so the HTTP layer validates
 * against this list rather than restating it — a fifth level would otherwise
 * have two places to be added, and the second one would be forgotten.
 */
export const NOTIFICATION_LEVELS = ["info", "success", "warning", "error"] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export interface CreateNotification {
  level?: NotificationLevel;
  title: string;
  body?: string | null;
  /** The job this is about, if any. No foreign key — see the header. */
  jobId?: string | null;
}

export interface ListNotifications {
  limit?: number;
  offset?: number;
  /** Only the ones not yet read. The bell's badge, rather than the bell's list. */
  unreadOnly?: boolean;
  level?: NotificationLevel;
}

export interface PurgeOptions {
  /** Delete notifications created strictly before this instant. */
  before: Date;
  /**
   * Spare the unread ones.
   *
   * Defaults to **true**, and that default is the whole point: "tidy up old
   * notifications" must never be able to delete the warning nobody has seen
   * yet, which is the only notification that still has a job to do.
   */
  onlyRead?: boolean;
}

/**
 * Retention: what the sweeper is allowed to remove, and what it must not.
 *
 * Two rules, because one is not enough. Age alone does **not** bound this
 * table: `purge` spares unread notifications by design, so a bell nobody ever
 * opens keeps every row it was ever given, for ever. A ceiling is what makes
 * the growth stop; the age rule is what keeps the ceiling from ever being the
 * thing that acts.
 */
export interface RetentionPolicy {
  /**
   * Read notifications older than this are removed. `0` disables the rule.
   *
   * Only read ones — this is the same promise `purge` makes, and it is the
   * reason the age rule is safe to run unattended.
   */
  retentionDays: number;
  /**
   * Hard ceiling on the number of rows. `0` disables the ceiling.
   *
   * ⚠️ **This one can delete an unread notification**, and it is the only thing
   * in the codebase that can do so without being asked. That is deliberate and
   * it is the lesser evil: without it "grows for ever" is the actual behaviour.
   * The eviction order is what makes it defensible — see
   * {@link NotificationStore.enforceRetention}.
   */
  maxEntries: number;
}

/** What one sweep did. Every number here is a thing that was lost. */
export interface RetentionOutcome {
  /** Read notifications removed for being older than `retentionDays`. */
  byAge: number;
  /** Notifications removed for being over `maxEntries`. */
  byCap: number;
  /**
   * How many of `byCap` had never been read.
   *
   * 🔴 Separated out so it can be *said*. A cap that quietly drops warnings
   * nobody has seen is exactly the silent substitution this project keeps
   * paying for; the number exists so the log line can name it.
   */
  unreadDropped: number;
}

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_ENTRIES = 5_000;

/**
 * How many ids one `DELETE ... IN (...)` may carry.
 *
 * SQLite has a ceiling on bound parameters, and the first sweep after this
 * feature ships may have thousands of rows to remove. Chunking is not an
 * optimisation here — it is the difference between a sweep and an exception.
 */
const DELETE_CHUNK = 500;

/** Ceiling on one page, so a bell menu cannot ask for the whole table. */
export const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

/**
 * Unread first, then newest first.
 *
 * ⚠️ Expressed as a `CASE`, not as `read_at IS NULL DESC`: SQLite sorts that
 * expression as 0/1 and Postgres as a boolean, and the two disagree about which
 * way round `DESC` puts them. `CASE` gives an integer both dialects order the
 * same way (PLAN §17 rule 6 — the same reason `queue.ts` ranks priority this
 * way).
 *
 * 📌 The `notifications_unread_idx` index on `(read_at, created_at)` does **not**
 * serve this ordering, because an expression is not a column. It is a small
 * table with a capped page size, so the sort is over tens of rows; if
 * notifications ever grow into the hundreds of thousands, the fix is two
 * queries — unread, then read — not a cleverer `ORDER BY`.
 */
const UNREAD_FIRST = sql<number>`case when ${notifications.readAt} is null then 0 else 1 end`;

export interface NotificationStoreOptions {
  db: Db;
  /** Injectable clock, so a test can age a notification without waiting. */
  now?: () => Date;
  /** Injectable ids, for tests that assert on order. */
  newId?: () => string;
}

export class NotificationStore {
  private readonly db: Db;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: NotificationStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    // v7: time-ordered, so ids break `createdAt` ties in creation order rather
    // than at random — two notifications written in the same millisecond still
    // come back in the order they happened.
    this.newId = options.newId ?? (() => Bun.randomUUIDv7());
  }

  /**
   * Write one.
   *
   * `createdAt` is set here rather than left to the column default so that the
   * clock is injectable, and so that every timestamp in a batch comes from one
   * reading instead of from however long the inserts took.
   */
  async create(input: CreateNotification): Promise<Notification> {
    const row = {
      id: this.newId(),
      level: input.level ?? "info",
      title: input.title,
      body: input.body ?? null,
      jobId: input.jobId ?? null,
      readAt: null,
      createdAt: this.now().toISOString(),
    };
    const inserted = await this.db.insert(notifications).values(row).returning();
    // `returning()` on an insert of one row cannot be empty; the fallback is
    // for the type, not for a case that happens.
    return inserted[0] ?? row;
  }

  /** Listing cannot fail, so it does not carry a `Result` — as `queue.list`. */
  async list(options: ListNotifications = {}): Promise<Notification[]> {
    const conditions: SQL[] = [];
    if (options.unreadOnly === true) conditions.push(isNull(notifications.readAt));
    if (options.level !== undefined) conditions.push(eq(notifications.level, options.level));

    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);

    return this.db
      .select()
      .from(notifications)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(UNREAD_FIRST), desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .offset(Math.max(options.offset ?? 0, 0));
  }

  /**
   * How many are unread.
   *
   * A separate query rather than a field on the list, because the badge is
   * about the *table* and the list is about a page of it: counting what came
   * back would say "3 unread" when there are thirty and the menu shows ten.
   *
   * An aggregate rather than rows: `notifications_unread_idx` starts with
   * `read_at`, so this is answered from the index without touching the table.
   */
  async unreadCount(): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(isNull(notifications.readAt));
    return rows[0]?.value ?? 0;
  }

  async get(id: string): Promise<Result<Notification, NotFound>> {
    const found = await this.db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
    const row = found[0];
    if (!row) return Result.err(new NotFound({ what: "notification", id }));
    return Result.ok(row);
  }

  /**
   * Mark one read.
   *
   * Idempotent by omission: an already-read notification keeps its original
   * `readAt` rather than having it moved forward, because when it was read is a
   * fact and the second click is not a new one.
   */
  async markRead(id: string): Promise<Result<Notification, NotFound>> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: this.now().toISOString() })
      .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
      .returning();

    const row = updated[0];
    if (row) return Result.ok(row);
    // Either it does not exist, or it was already read. Only the first is an
    // error, and telling them apart needs the read that the update skipped.
    return this.get(id);
  }

  /** Mark everything read. Returns how many actually changed. */
  async markAllRead(): Promise<number> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: this.now().toISOString() })
      .where(isNull(notifications.readAt))
      .returning({ id: notifications.id });
    return updated.length;
  }

  /**
   * Delete old notifications. Returns how many went.
   *
   * `RETURNING` rather than a driver-specific "changes" count: SQLite and
   * Postgres both support it, and `bun:sqlite`'s `changes` would be one more
   * thing that only works on one dialect (PLAN §17 rule 6).
   */
  async purge(options: PurgeOptions): Promise<number> {
    const conditions: SQL[] = [lt(notifications.createdAt, options.before.toISOString())];
    if (options.onlyRead !== false) conditions.push(sql`${notifications.readAt} is not null`);

    const deleted = await this.db
      .delete(notifications)
      .where(and(...conditions))
      .returning({ id: notifications.id });
    return deleted.length;
  }

  /**
   * One retention sweep: the age rule, then the ceiling.
   *
   * ## Why the ceiling evicts read notifications first
   *
   * The obvious rule — "keep the newest N" — is the wrong one for a bell. It
   * would drop a warning from last month that nobody has read while keeping a
   * "download finished" from this morning that has already been seen and acted
   * on. So the eviction order is **read before unread, oldest first within
   * each**: everything already seen is spent before anything unseen is
   * touched, and a table that is entirely unread loses its oldest entries only
   * because there is nothing else left to lose.
   *
   * The rows are selected and then deleted by id rather than deleted by
   * predicate in one statement, for two reasons: the ids are how the unread
   * count is known (a `DELETE` cannot tell us what it removed under an
   * expression `ORDER BY` on either dialect), and a `LIMIT` on `DELETE` is a
   * SQLite compile option rather than a guarantee (PLAN §17 rule 6).
   */
  async enforceRetention(policy: RetentionPolicy): Promise<RetentionOutcome> {
    const byAge =
      policy.retentionDays > 0
        ? await this.purge({
            before: new Date(this.now().getTime() - policy.retentionDays * 86_400_000),
            onlyRead: true,
          })
        : 0;

    if (policy.maxEntries <= 0) return { byAge, byCap: 0, unreadDropped: 0 };

    const [total] = await this.db.select({ n: count() }).from(notifications);
    const excess = (total?.n ?? 0) - policy.maxEntries;
    if (excess <= 0) return { byAge, byCap: 0, unreadDropped: 0 };

    const doomed = await this.db
      .select({ id: notifications.id, readAt: notifications.readAt })
      .from(notifications)
      // `UNREAD_FIRST` is 0 for unread and 1 for read, so *descending* puts the
      // read ones first — the exact reverse of what the bell's list wants, and
      // exactly what an eviction order wants.
      .orderBy(desc(UNREAD_FIRST), asc(notifications.createdAt), asc(notifications.id))
      .limit(excess);

    const unreadDropped = doomed.filter((row) => row.readAt === null).length;
    for (let i = 0; i < doomed.length; i += DELETE_CHUNK) {
      const ids = doomed.slice(i, i + DELETE_CHUNK).map((row) => row.id);
      await this.db.delete(notifications).where(inArray(notifications.id, ids));
    }

    return { byAge, byCap: doomed.length, unreadDropped };
  }
}

/**
 * The line a sweep deserves in the log — or nothing, when it removed nothing.
 *
 * Silence when nothing happened is the point: a retention sweep every six hours
 * that always prints becomes noise nobody reads, and the one line that mattered
 * (an unread notification dropped) would be lost inside it.
 */
export function describeRetention(outcome: RetentionOutcome): string | undefined {
  if (outcome.byAge === 0 && outcome.byCap === 0) return undefined;
  const parts: string[] = [];
  if (outcome.byAge > 0) parts.push(`${outcome.byAge} read past retention`);
  if (outcome.byCap > 0) {
    parts.push(
      outcome.unreadDropped > 0
        ? `${outcome.byCap} over the cap, ⚠️ ${outcome.unreadDropped} of them never read`
        : `${outcome.byCap} over the cap`,
    );
  }
  return `removed ${parts.join(", ")}`;
}

// --- The emitter the worker will use ----------------------------------------

/**
 * What a job's outcome sounds like.
 *
 * 📌 **Not wired into the worker.** The worker is another agent's file this
 * session, so this is the seam it will take rather than a change to it: the
 * pipeline accepts a `JobNotifier`, calls it when a job ends, and gets a row in
 * the table for free. Nothing here reads the queue or the job table, so a
 * worker holding one of these cannot deadlock against its own transaction.
 *
 * ⚠️ Every method swallows its own failure. A notification is a *report about*
 * work, and a report that fails must not fail the work it was reporting on — a
 * finished 800 MB download marked failed because an INSERT went wrong would be
 * the exact class of bug this project exists to remove.
 */
export interface JobNotifier {
  completed(job: Job): Promise<void>;
  failed(job: Job, reason?: string): Promise<void>;
  /** The library went away after the bytes were on disk — PLAN §15. */
  waitingForDestination(job: Job, detail?: string): Promise<void>;
  /** Anything else worth a line in the bell menu. */
  emit(input: CreateNotification): Promise<void>;
}

function nameOf(job: Job): string {
  return job.title ?? job.url;
}

export function createJobNotifier(
  store: NotificationStore,
  onError: (cause: unknown) => void = () => {},
): JobNotifier {
  const write = async (input: CreateNotification): Promise<void> => {
    try {
      await store.create(input);
    } catch (cause) {
      onError(cause);
    }
  };

  return {
    completed: (job) =>
      write({
        level: "success",
        title: `Downloaded ${nameOf(job)}`,
        // The path, because the next question after "it finished" is always
        // "where did it go", and the answer is not guessable from the title.
        body: job.outputFile ?? null,
        jobId: job.id,
      }),

    failed: (job, reason) =>
      write({
        level: "error",
        title: `Failed: ${nameOf(job)}`,
        body: reason ?? job.error ?? null,
        jobId: job.id,
      }),

    waitingForDestination: (job, detail) =>
      write({
        // A warning and not an error: the file is safe in the temp directory
        // and the move will be retried. Nothing has been lost yet — but the
        // temp disk is filling, which is why it is not `info` either.
        level: "warning",
        title: `Waiting for the library: ${nameOf(job)}`,
        body: detail ?? "The destination is unavailable. The file is being kept in the temp directory.",
        jobId: job.id,
      }),

    emit: write,
  };
}
