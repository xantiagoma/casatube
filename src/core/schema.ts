/**
 * The database schema — and the single source of truth for the types.
 *
 * Everything else derives its shapes from here with `$inferSelect`. In the
 * first attempt at this project two modules drifted into two different
 * definitions of the same contract in the same folder; deriving from one schema
 * is what prevents that.
 *
 * ⚠️ No SQLite-specific SQL anywhere in the codebase (see PLAN §17, rule 6):
 * Drizzle speaks Postgres too, and distribution would need it.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Preferences, Stage } from "./types";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    /** Which provider claimed this URL. */
    provider: text("provider").notNull(),
    /** Library subfolder, never an absolute path. */
    destination: text("destination").notNull(),
    /** Cleaned and safe as a filename; null until analysed. */
    title: text("title"),

    status: text("status").notNull().default("queued"),
    /** Stage records, serialised. Derived status comes from these. */
    stages: text("stages", { mode: "json" }).$type<Stage[]>().notNull().default(sql`'[]'`),

    priority: text("priority").notNull().default("normal"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),

    /**
     * Which slot is working on this, and until when the claim is valid.
     *
     * The lease is what makes a dead worker recoverable: if it lapses, the job
     * returns to the queue. Locally that covers a crash; it is also the exact
     * mechanism distribution would need (PLAN §17, rules 2 and 4).
     */
    claimedBy: text("claimed_by"),
    leaseUntil: text("lease_until"),
    /**
     * Not claimable before this instant — how a backoff-delayed retry is
     * expressed.
     *
     * Without it, claim eligibility would depend on the *other* database's
     * `delayed` state, which is the one place R2's correctness would lean on the
     * mirror. Keeping it here makes the queue self-contained.
     */
    notBefore: text("not_before"),

    progress: integer("progress").notNull().default(0),
    totalBytes: integer("total_bytes"),
    doneBytes: integer("done_bytes"),
    speed: integer("speed"),
    eta: integer("eta"),

    thumbnail: text("thumbnail"),
    duration: integer("duration"),
    source: text("source"),

    /** Preferences resolved for this job, serialised. */
    preferences: text("preferences", { mode: "json" }).$type<Preferences>().notNull(),
    /**
     * Stable hash of url + resolved configuration.
     * Duplicate detection compares this, not the URL: 720p when 1080p is on
     * disk is a different request, not a duplicate (PLAN §15).
     */
    fingerprint: text("fingerprint").notNull(),

    log: text("log", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    error: text("error"),
    /** Absolute path once the file has been moved into the library. */
    outputFile: text("output_file"),

    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    // The claim query: eligible jobs, best priority first, oldest first.
    index("jobs_claim_idx").on(t.status, t.paused, t.notBefore, t.priority, t.createdAt),
    index("jobs_fingerprint_idx").on(t.fingerprint),
    index("jobs_lease_idx").on(t.leaseUntil),
  ],
);

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    name: text("name").notNull(),
    destination: text("destination").notNull(),
    preferences: text("preferences", { mode: "json" }).$type<Preferences>().notNull(),
    /**
     * ⚠️ Conservative by design. Polling many channels often is the fastest
     * way to burn the IP budget (PLAN §4.3).
     */
    intervalMinutes: integer("interval_minutes").notNull().default(360),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastCheckedAt: text("last_checked_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("sources_due_idx").on(t.enabled, t.lastCheckedAt)],
);

/**
 * What each source has already seen.
 *
 * Adding a source marks its current items as seen without enqueueing them: a
 * channel with 800 videos would flood the queue and burn the IP budget in one
 * go (PLAN §11).
 */
export const sourceSeen = sqliteTable(
  "source_seen",
  {
    sourceId: text("source_id").notNull(),
    externalId: text("external_id").notNull(),
    seenAt: text("seen_at").notNull().default(now),
  },
  (t) => [index("source_seen_idx").on(t.sourceId, t.externalId)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    level: text("level").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body"),
    jobId: text("job_id"),
    /** Persisted because a notification missed with the tab closed is not one. */
    readAt: text("read_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("notifications_unread_idx").on(t.readAt, t.createdAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});
