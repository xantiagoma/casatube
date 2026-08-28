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
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { CredentialMeta } from "./credentials";
import type { DownloadPlan, Preferences, Stage } from "./types";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    /**
     * Which provider claimed this URL.
     *
     * Null until the `validate` stage resolves it: at enqueue time nobody has
     * asked yet, and requiring it there would mean resolving a provider before
     * the job is durable — work done outside the thing that survives a restart.
     */
    provider: text("provider"),
    /** Library subfolder, never an absolute path. */
    destination: text("destination").notNull(),
    /** Cleaned and safe as a filename; null until analysed. */
    title: text("title"),
    /**
     * The filename a person asked for, before any collision suffix.
     *
     * Null means "use the title", which is what every job did before this
     * existed. Kept on the row rather than only in `plan` because the plan is
     * built by the `analyze` stage, and the request has to survive from the
     * moment it was made until then — including across a restart.
     */
    outputName: text("output_name"),
    /**
     * What to do when the name is already taken in the destination.
     *
     * `suffix` — the default and the safe one — lands `Name (2)` and says so.
     * `replace` sends the existing file to `.trash/` first, where it stays
     * recoverable for the retention window; it is what "download this again"
     * means, and it is never the default because the other reading of a
     * collision is *two different videos with one title*, which is data loss.
     */
    onConflict: text("on_conflict").notNull().default("suffix"),

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

    /**
     * What `analyze` decided: formats, tracks, language tags.
     *
     * Durable because it is a decision about this job, not a working value. A
     * resume that skipped `analyze` would otherwise lose it and silently
     * download nothing — and re-probing on every resume would spend IP budget
     * to recompute something that has not changed.
     */
    plan: text("plan", { mode: "json" }).$type<DownloadPlan | null>(),

    /** Preferences resolved for this job, serialised. */
    preferences: text("preferences", { mode: "json" }).$type<Preferences>().notNull(),
    /**
     * Plugins this download opted **out** of, by name.
     *
     * 🔴 A skip-list rather than a map of on/off, because only one direction is
     * implementable and pretending otherwise would be a switch that lies: a
     * plugin that is off server-wide is never activated, its `setup()` never
     * runs and its hooks are never registered, so there is nothing to dispatch
     * to. "Off for this one download" is a real answer; "on for this one
     * download" is not, and the UI says so instead of offering it.
     *
     * Durable because it is a decision about this job: a retry a week later,
     * after the plugin was turned on for everything else, must still respect
     * the choice that was made when the job was queued.
     */
    pluginsOff: text("plugins_off", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
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
    // Analytics filters by date over the whole history, and retention defaults
    // to never deleting. Without this the scan grows for ever — and bun:sqlite
    // is synchronous, so that scan is time no SSE stream is being served.
    index("jobs_created_idx").on(t.createdAt),
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

/**
 * Credentials, per provider and per site — sealed at rest, one-way out.
 *
 * 🔴 `secret` is the only column in the database that holds something the API
 * must never return. Every read path in `core/credentials.ts` names its columns
 * one by one so that a `SELECT *` cannot put it in a variable a route could
 * serialise by accident, and the only function that opens it hands it straight
 * to a subprocess.
 *
 * ⚠️ `(scope, type)` is **unique**, and that is a design decision rather than a
 * constraint that happened. A YouTube jar expires within hours, so re-pasting
 * one is the most common thing anybody will ever do here; without the unique
 * index the table fills with dead jars for the same host and "most specific
 * scope wins" stops being a total order — two rows for `youtube.com` have no
 * defensible winner. Replacing keeps resolution decidable.
 */
export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    /** Host or pattern: `youtube.com`, `*.odysee.com`, or `*` for everything. */
    scope: text("scope").notNull(),
    /** `cookies` | `password` | `apiKey` | `custom`. */
    type: text("type").notNull(),
    /** Free text, for telling two accounts on one site apart. */
    label: text("label"),
    /** 🔴 The sealed secret. See the header. */
    secret: text("secret").notNull(),
    /**
     * `aes-256-gcm` or `plaintext` — what actually happened, not what was
     * intended. With no `CREDENTIALS_KEY` the secret is stored in the clear and
     * this column says so, so that no screen can claim encryption that is not
     * there.
     */
    protection: text("protection").notNull().default("plaintext"),
    /**
     * Non-reversible fingerprint of the key that sealed this row.
     *
     * It turns "the key was rotated" from an unexplained decryption failure
     * into a sentence the UI can print.
     */
    keyId: text("key_id"),
    /**
     * Non-secret facts *about* the secret: cookie count, the domains covered,
     * the soonest expiry, the username. Never a value that authenticates.
     */
    meta: text("meta", { mode: "json" }).$type<CredentialMeta>().notNull().default(sql`'{}'`),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    /** When a download last used it. Null means it has never been exercised. */
    lastUsedAt: text("last_used_at"),
  },
  (t) => [
    uniqueIndex("credentials_scope_type_idx").on(t.scope, t.type),
    // Resolution reads every row and ranks them in memory (the table is tens of
    // rows at most), but the uniqueness check on write goes through the index
    // above; this one serves listing by host.
    index("credentials_scope_idx").on(t.scope),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

/**
 * Transcode jobs — the one thing in CasaTube that **re-encodes**.
 *
 * 🔴 A separate table rather than a `kind` column on `jobs`, and the difference
 * is not cosmetic. A download job is a URL, a provider, a plan, a fingerprint
 * and six stages; a transcode is a file already on disk, a preset and one
 * ffmpeg. Widening `jobs` would mean half its columns are null for half its
 * rows and every reader has to ask which kind it is holding — including the
 * duplicate check, which compares a fingerprint of a URL that a transcode does
 * not have.
 *
 * ⚠️ **One at a time is a property of the runner, not of this table.** The box
 * that runs this also runs Home Assistant and Zigbee; the concurrency limit
 * lives in `core/transcode.ts` where the process is actually spawned.
 */
export const transcodes = sqliteTable(
  "transcodes",
  {
    id: text("id").primaryKey(),
    /** Library-relative path of the original. Never absolute — see `resolveInRoot`. */
    sourcePath: text("source_path").notNull(),
    /**
     * Library-relative path this will be written to.
     *
     * 🔴 Decided at enqueue time and stored, not recomputed when the job runs.
     * A name chosen twice is a name that can differ twice — and the second one
     * would be a file nobody asked for, left beside the first.
     */
    outputPath: text("output_path").notNull(),
    /** Which named preset. Raw ffmpeg flags are deliberately not storable here. */
    preset: text("preset").notNull(),

    /** `queued` | `running` | `done` | `failed` | `cancelled`. */
    status: text("status").notNull().default("queued"),
    /** 0–100, from ffmpeg's own `-progress` output against the probed duration. */
    progress: integer("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    /** Not claimable before this instant — the same shape a job's backoff uses. */
    notBefore: text("not_before"),

    /**
     * Whether the original goes to the trash once this succeeds.
     *
     * 🔴 Default **false**, and even when true the original is *moved to
     * `.trash/`*, never unlinked: "replace" that cannot be undone and "replace"
     * that can are different promises, and only one of them is safe to offer
     * for a lossy re-encode.
     */
    replaceOriginal: integer("replace_original", { mode: "boolean" }).notNull().default(false),

    /** Probed once, so progress has a denominator. */
    durationSeconds: integer("duration_seconds"),
    /** Sizes, for the one number anybody actually wants afterwards. */
    sourceBytes: integer("source_bytes"),
    outputBytes: integer("output_bytes"),

    error: text("error"),
    log: text("log", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),

    createdAt: text("created_at").notNull().default(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("transcodes_claim_idx").on(t.status, t.notBefore, t.createdAt),
    // "Is this file already being converted?" is asked once per enqueue and
    // once per card; without this it is a table scan of the whole history.
    index("transcodes_source_idx").on(t.sourcePath),
  ],
);
