/**
 * Sources — channels, playlists and watchlists, and the rules that keep them
 * from flooding the queue.
 *
 * A source is a URL that *yields items over time*. Everything hard about them
 * is a consequence of that: the same check runs again tomorrow over a list that
 * mostly has not changed, and the honest answer to "what is new?" has to
 * survive restarts, concurrent passes and a source that repeats itself.
 *
 * ## The two rules this file exists for (PLAN §11)
 *
 * 🔴 **Checking twice must not enqueue twice.** `source_seen` is the record of
 * what has already been handled, and — this is the part that matters — a row is
 * written there **before** the job is enqueued, inside the same transaction
 * that decided the item was new. The insert *is* the claim. Two passes racing
 * over the same channel cannot both see the same item as unseen, because the
 * second one reads a table the first has already written to.
 *
 * The trade is deliberate: if the process dies between the claim and the
 * enqueue, that item is lost rather than duplicated. Idempotence was the
 * requirement, and the queue's own fingerprint check (PLAN §15) is a second net
 * under the other direction anyway.
 *
 * 🔴 **A new source does not enqueue its back catalogue.** A channel with 800
 * videos would fill the queue and spend the whole IP budget in an afternoon
 * (PLAN §4.3). Adding a source marks everything it currently lists as *seen*
 * and enqueues none of it; only what appears afterwards is downloaded. The
 * opposite can be asked for — but only with a cap, and the cap is part of the
 * request's shape rather than an optional extra, so it cannot be forgotten.
 *
 * ## Discovered work goes through the same queue as everything else
 *
 * `queue.enqueue()`, never a direct write to the jobs table. A discovered
 * download is a download: same duplicate detection, same recovery on restart,
 * same row the UI already renders. What differs is *pace* — automated items are
 * queued at `low` priority and staggered behind `notBefore`, because metube's
 * seven years of evidence cover people queueing by hand and say nothing about a
 * channel check finding twenty uploads at once (PLAN §17).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { Result } from "better-result";

import type { Db } from "./db";
import { sourceSeen, sources } from "./schema";
import { NotFound, UnsupportedUrl, type ProviderError } from "./errors";
import type { JobQueue } from "./queue";
import { resolvePreferences } from "./queue";
import type { DiscoveredItem, Preferences, Priority, Source } from "./types";
import type { ProviderRegistry } from "../providers/registry";

// --- Limits -----------------------------------------------------------------

/**
 * The schema's default, repeated here so callers that build an input can use
 * the same number the column would have given them. ⚠️ If one moves, both move.
 */
export const DEFAULT_INTERVAL_MINUTES = 360;

/**
 * ⚠️ The floor, and it is not arbitrary.
 *
 * A residential IP tolerates roughly 20-100 yt-dlp downloads before it starts
 * being blocked, a datacenter one 5-10 (PLAN §4.3). Polling costs from that
 * same budget, and no channel publishes often enough for an hourly check to
 * find anything an hourly check did not. Six hours is the default; one hour is
 * as impatient as this is willing to be.
 */
export const MIN_INTERVAL_MINUTES = 60;

/**
 * The hard ceiling on `includeExisting`, on top of the cap the caller must
 * already name.
 *
 * The caller's cap is what makes the request explicit; this one is what stops
 * "explicit" from meaning 800.
 */
export const MAX_INCLUDE_EXISTING = 50;

/**
 * How many newly-discovered items one check will claim.
 *
 * Anything over the limit is **left unseen**, not dropped: the next pass finds
 * it again and takes the next batch. A channel that posts thirty videos in a
 * day is spread across passes instead of arriving as one burst — and nothing is
 * silently lost, which marking them seen would have done.
 */
export const DEFAULT_MAX_NEW_PER_CHECK = 20;

/**
 * Distance between two automated downloads, written as `notBefore`.
 *
 * Best-effort by nature — a worker free right now can claim the first item
 * before the second is even deferred — but it is enough that a twenty-item drop
 * arrives over twenty minutes rather than all at once.
 */
export const DEFAULT_ITEM_SPACING_MS = 60_000;

// --- Contract ---------------------------------------------------------------

/** What `check` and `add` are allowed to fail with. */
export type SourceError = NotFound | ProviderError;

/**
 * How items are found. Injected rather than reached for: the tests need to
 * decide what a source lists, and none of them may touch the network.
 */
export type Discoverer = (
  url: string,
  signal: AbortSignal,
) => Promise<Result<DiscoveredItem[], ProviderError>>;

/** The real one: whichever provider claims the URL, asked to enumerate it. */
export function registryDiscoverer(registry: ProviderRegistry): Discoverer {
  return async (url, signal) => {
    const provider = registry.resolve(url);
    if (Result.isError(provider)) return provider;
    const list = provider.value.list;
    // Claiming a URL is not the same as being able to enumerate it. A provider
    // without `list` can still download that URL by hand; it just cannot be a
    // source, and saying so plainly beats returning an empty listing that would
    // read as "this channel has no videos".
    if (!list) return Result.err(new UnsupportedUrl({ url }));
    return list.call(provider.value, url, signal);
  };
}

/** How many of the newest existing items to enqueue when a source is added. */
export interface IncludeExisting {
  /**
   * ⚠️ Mandatory, and that is the whole design. `includeExisting: true` with an
   * optional limit is one forgotten field away from queueing a back catalogue;
   * a shape that cannot express "all of it" cannot be misused into it.
   */
  limit: number;
}

export interface AddSourceInput {
  url: string;
  name?: string;
  /** Library subfolder. Validated at the HTTP boundary, stored as given. */
  destination: string;
  preferences?: Partial<Preferences>;
  intervalMinutes?: number;
  enabled?: boolean;
  includeExisting?: IncludeExisting;
  signal?: AbortSignal;
}

export interface UpdateSourceInput {
  name?: string;
  destination?: string;
  preferences?: Partial<Preferences>;
  intervalMinutes?: number;
  enabled?: boolean;
}

/** What one enqueued item became. */
export interface EnqueuedItem {
  jobId: string;
  externalId: string;
  url: string;
  title: string;
  /** `duplicate` means the queue already has this finished — PLAN §15. */
  outcome: "queued" | "duplicate";
}

export interface AddSourceResult {
  source: Source;
  /** Items the source listed at the moment it was added. */
  discovered: number;
  /** Marked as seen so they are never enqueued. The back catalogue. */
  seeded: number;
  /** Enqueued because `includeExisting` asked for them. */
  enqueued: EnqueuedItem[];
  /** The requested `limit` was above {@link MAX_INCLUDE_EXISTING} and was cut. */
  capped: boolean;
}

export interface CheckResult {
  sourceId: string;
  checkedAt: string;
  /** Everything the source listed. */
  discovered: number;
  /** Of those, not previously seen. */
  fresh: number;
  enqueued: EnqueuedItem[];
  /** Fresh items left unclaimed by the per-check cap. Next pass takes them. */
  heldBack: number;
  /** Set when nothing was asked of the network at all. */
  skipped?: "disabled";
}

export interface CheckOptions {
  /** Check even when the source is disabled. What the manual button does. */
  force?: boolean;
  signal?: AbortSignal;
  /** Overrides {@link DEFAULT_MAX_NEW_PER_CHECK} for this call. */
  maxNew?: number;
  /** Overrides the configured stagger for this call. `0` disables it. */
  itemSpacingMs?: number;
}

export interface SourceManagerOptions {
  db: Db;
  /** 🔴 The same queue a manual download goes through. Never the jobs table. */
  queue: JobQueue;
  discover: Discoverer;
  /** Injectable clock, so a test can make a source due without waiting. */
  now?: () => Date;
  /** Priority for automated work. `low` by default — manual always goes first. */
  priority?: Priority;
  itemSpacingMs?: number;
  maxNewPerCheck?: number;
}

// --- Helpers ----------------------------------------------------------------

type SourceRow = typeof sources.$inferSelect;

function toSource(row: SourceRow): Source {
  return row;
}

function iso(date: Date): string {
  return date.toISOString();
}

/** Whichever integer is nearest the allowed band. */
function clampInterval(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.trunc(minutes));
}

/**
 * A readable name when the caller did not give one: the last meaningful bit of
 * the URL. `@veritasium`, `PLxyz`, the host as a last resort.
 */
export function deriveName(url: string): string {
  try {
    const parsed = new URL(url);
    const listId = parsed.searchParams.get("list");
    if (listId) return listId;
    const segments = parsed.pathname.split("/").filter((s) => s !== "" && s !== "videos" && s !== "playlists");
    const last = segments.at(-1);
    return last && last.length > 0 ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return url;
  }
}

/**
 * Newest first, and honest about when it cannot tell.
 *
 * Sorting by `publishedAt` is only correct when every item has one. A partial
 * sort would interleave dated and undated items on a field half of them do not
 * have, so in that case the provider's own order is kept — yt-dlp's
 * `--flat-playlist` already returns a channel newest-first, and its order is a
 * better guess than an invented one.
 */
export function newestFirst(items: DiscoveredItem[]): DiscoveredItem[] {
  const allDated = items.length > 0 && items.every((item) => item.publishedAt !== undefined);
  if (!allDated) return [...items];
  return [...items].sort((a, b) => (a.publishedAt! < b.publishedAt! ? 1 : a.publishedAt! > b.publishedAt! ? -1 : 0));
}

/** First occurrence wins. A source repeating an id is not two items. */
function dedupe(items: DiscoveredItem[]): DiscoveredItem[] {
  const byId = new Map<string, DiscoveredItem>();
  for (const item of items) if (!byId.has(item.externalId)) byId.set(item.externalId, item);
  return [...byId.values()];
}

// --- The manager ------------------------------------------------------------

export class SourceManager {
  private readonly db: Db;
  private readonly queue: JobQueue;
  private readonly discover: Discoverer;
  private readonly now: () => Date;
  private readonly priority: Priority;
  private readonly itemSpacingMs: number;
  private readonly maxNewPerCheck: number;

  constructor(options: SourceManagerOptions) {
    this.db = options.db;
    this.queue = options.queue;
    this.discover = options.discover;
    this.now = options.now ?? (() => new Date());
    this.priority = options.priority ?? "low";
    this.itemSpacingMs = options.itemSpacingMs ?? DEFAULT_ITEM_SPACING_MS;
    this.maxNewPerCheck = options.maxNewPerCheck ?? DEFAULT_MAX_NEW_PER_CHECK;
  }

  // --- reads ----------------------------------------------------------------

  async list(): Promise<Source[]> {
    const rows = await this.db.select().from(sources).orderBy(asc(sources.createdAt), asc(sources.id));
    return rows.map(toSource);
  }

  async get(id: string): Promise<Result<Source, NotFound>> {
    const found = await this.db.select().from(sources).where(eq(sources.id, id)).limit(1);
    const row = found[0];
    if (!row) return Result.err(new NotFound({ what: "source", id }));
    return Result.ok(toSource(row));
  }

  /** How many items this source has already accounted for. */
  async seenCount(id: string): Promise<number> {
    const rows = await this.db
      .select({ externalId: sourceSeen.externalId })
      .from(sourceSeen)
      .where(eq(sourceSeen.sourceId, id));
    return rows.length;
  }

  /**
   * When this source is next allowed to be checked.
   *
   * A source that has never been checked is due immediately — but note that a
   * source only reaches that state if `add` failed to seed it, since a
   * successful add records the check it just performed.
   */
  nextDueAt(source: Source): Date {
    if (!source.lastCheckedAt) return new Date(0);
    return new Date(Date.parse(source.lastCheckedAt) + source.intervalMinutes * 60_000);
  }

  /**
   * Enabled sources whose interval has elapsed, longest-waiting first.
   *
   * The filtering is in JavaScript rather than SQL on purpose: the interval is
   * a per-row number, so the comparison would need date arithmetic, and every
   * dialect spells that differently (PLAN §17 rule 6). There are tens of
   * sources, not millions.
   */
  async due(at: Date = this.now()): Promise<Source[]> {
    const rows = await this.db.select().from(sources).where(eq(sources.enabled, true));
    return rows
      .map(toSource)
      .filter((source) => this.nextDueAt(source).getTime() <= at.getTime())
      .sort((a, b) => (a.lastCheckedAt ?? "").localeCompare(b.lastCheckedAt ?? ""));
  }

  // --- writes ---------------------------------------------------------------

  /**
   * Add a source, and settle its history in the same breath.
   *
   * ⚠️ **Discovery failing means no source is created.** A row whose back
   * catalogue was never marked seen is a trap: the first scheduled check would
   * find eight hundred "new" videos and queue every one. Refusing to add is the
   * safe half of that choice, and the caller can simply try again.
   */
  async add(input: AddSourceInput): Promise<Result<AddSourceResult, SourceError>> {
    const at = this.now();
    const requested = input.includeExisting?.limit ?? 0;
    const enqueueLimit = Math.min(Math.max(0, Math.trunc(requested)), MAX_INCLUDE_EXISTING);
    const capped = requested > MAX_INCLUDE_EXISTING;

    const listed = await this.discover(input.url, input.signal ?? new AbortController().signal);
    if (Result.isError(listed)) return listed;
    const items = dedupe(newestFirst(listed.value));

    const id = Bun.randomUUIDv7();
    const source: SourceRow = {
      id,
      url: input.url,
      name: input.name?.trim() || deriveName(input.url),
      destination: input.destination,
      preferences: resolvePreferences(input.preferences),
      intervalMinutes: clampInterval(input.intervalMinutes),
      enabled: input.enabled ?? true,
      // The listing above *is* a check. Recording it is what makes the first
      // scheduled pass wait a full interval instead of firing immediately.
      lastCheckedAt: iso(at),
      createdAt: iso(at),
    };
    await this.db.insert(sources).values(source);

    // 🔴 Everything listed becomes seen, including whatever is enqueued below:
    // the point of the back catalogue is that it is never discovered again.
    const claim = this.claim(id, items, { enqueueLimit, markRestSeen: true }, at);
    const enqueued = await this.enqueueItems(toSource(source), claim.toEnqueue, this.itemSpacingMs);

    return Result.ok({
      source: toSource(source),
      discovered: items.length,
      seeded: claim.fresh,
      enqueued,
      capped,
    });
  }

  async update(id: string, patch: UpdateSourceInput): Promise<Result<Source, NotFound>> {
    const current = await this.get(id);
    if (Result.isError(current)) return current;

    const values: Partial<SourceRow> = {};
    if (patch.name !== undefined) values.name = patch.name.trim() || current.value.name;
    if (patch.destination !== undefined) values.destination = patch.destination;
    if (patch.preferences !== undefined) {
      // Merged onto what is stored, so a PATCH of one field does not silently
      // reset the rest to the global defaults.
      values.preferences = resolvePreferences({ ...current.value.preferences, ...patch.preferences });
    }
    if (patch.intervalMinutes !== undefined) values.intervalMinutes = clampInterval(patch.intervalMinutes);
    if (patch.enabled !== undefined) values.enabled = patch.enabled;

    if (Object.keys(values).length === 0) return Result.ok(current.value);

    const updated = await this.db.update(sources).set(values).where(eq(sources.id, id)).returning();
    const row = updated[0];
    if (!row) return Result.err(new NotFound({ what: "source", id }));
    return Result.ok(toSource(row));
  }

  /**
   * Delete a source and everything it remembers.
   *
   * The seen rows go too. Keeping them would make a re-added source silently
   * skip items it never downloaded; jobs already queued are left alone, because
   * unsubscribing is not a request to cancel a download in flight.
   */
  async remove(id: string): Promise<Result<Source, NotFound>> {
    const current = await this.get(id);
    if (Result.isError(current)) return current;
    await this.db.delete(sourceSeen).where(eq(sourceSeen.sourceId, id));
    await this.db.delete(sources).where(eq(sources.id, id));
    return Result.ok(current.value);
  }

  // --- the check ------------------------------------------------------------

  /**
   * Ask a source what it has, and queue whatever is genuinely new.
   *
   * ⚠️ `lastCheckedAt` moves **even when discovery fails**. Otherwise a source
   * that is rate-limiting us stays permanently due and gets retried on every
   * tick — which is the exact behaviour that turns a throttle into a block
   * (PLAN §4.3).
   */
  async check(id: string, options: CheckOptions = {}): Promise<Result<CheckResult, SourceError>> {
    const found = await this.get(id);
    if (Result.isError(found)) return found;
    const source = found.value;

    if (!source.enabled && !options.force) {
      return Result.ok({
        sourceId: id,
        checkedAt: source.lastCheckedAt ?? iso(this.now()),
        discovered: 0,
        fresh: 0,
        enqueued: [],
        heldBack: 0,
        skipped: "disabled",
      });
    }

    const signal = options.signal ?? new AbortController().signal;
    const listed = await this.discover(source.url, signal);
    const at = this.now();
    await this.db.update(sources).set({ lastCheckedAt: iso(at) }).where(eq(sources.id, id));
    if (Result.isError(listed)) return listed;

    const items = dedupe(newestFirst(listed.value));
    const enqueueLimit = Math.max(0, Math.trunc(options.maxNew ?? this.maxNewPerCheck));
    const claim = this.claim(id, items, { enqueueLimit, markRestSeen: false }, at);
    const enqueued = await this.enqueueItems(
      source,
      claim.toEnqueue,
      options.itemSpacingMs ?? this.itemSpacingMs,
    );

    return Result.ok({
      sourceId: id,
      checkedAt: iso(at),
      discovered: items.length,
      fresh: claim.fresh,
      enqueued,
      heldBack: claim.heldBack,
    });
  }

  // --- the claim ------------------------------------------------------------

  /**
   * 🔴 Decide what is new and take ownership of it, atomically.
   *
   * Read the seen set, subtract it, write the winners back — **in one
   * transaction**, before a single job is enqueued. The write is what makes the
   * decision stick: a second pass reading this table afterwards cannot reach
   * the same conclusion about the same item, so "checked twice" cannot become
   * "queued twice" no matter how the two passes interleave.
   *
   * Everything above `enqueueLimit` is left *unseen* rather than discarded
   * (unless `markRestSeen`, which is what adding a source does deliberately),
   * so a channel that drops thirty videos is spread over passes and none of
   * them is quietly lost.
   */
  private claim(
    sourceId: string,
    items: DiscoveredItem[],
    opts: { enqueueLimit: number; markRestSeen: boolean },
    at: Date,
  ): { fresh: number; toEnqueue: DiscoveredItem[]; heldBack: number } {
    return this.db.transaction((tx) => {
      const ids = items.map((item) => item.externalId);
      const seen = new Set<string>();
      // Chunked: SQLite's parameter limit is finite and a channel listing is
      // not. 500 keeps every statement far below it on any dialect.
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const rows = tx
          .select({ externalId: sourceSeen.externalId })
          .from(sourceSeen)
          .where(and(eq(sourceSeen.sourceId, sourceId), inArray(sourceSeen.externalId, chunk)))
          .all();
        for (const row of rows) seen.add(row.externalId);
      }

      const fresh = items.filter((item) => !seen.has(item.externalId));
      const toEnqueue = fresh.slice(0, opts.enqueueLimit);
      const toMark = opts.markRestSeen ? fresh : toEnqueue;

      if (toMark.length > 0) {
        const seenAt = iso(at);
        for (let i = 0; i < toMark.length; i += 500) {
          tx.insert(sourceSeen)
            .values(toMark.slice(i, i + 500).map((item) => ({ sourceId, externalId: item.externalId, seenAt })))
            .run();
        }
      }

      return { fresh: fresh.length, toEnqueue, heldBack: fresh.length - toEnqueue.length };
    });
  }

  /**
   * Hand claimed items to the queue, spaced out.
   *
   * `low` priority so a download the user asked for by hand is always served
   * first, and `notBefore` so twenty discoveries do not become twenty downloads
   * in the same minute (PLAN §17 — "automated work is still spaced out", the
   * one caution metube's evidence does not cover).
   */
  private async enqueueItems(
    source: Source,
    items: DiscoveredItem[],
    spacingMs: number,
  ): Promise<EnqueuedItem[]> {
    const enqueued: EnqueuedItem[] = [];

    for (const [index, item] of items.entries()) {
      const result = await this.queue.enqueue({
        url: item.url,
        destination: source.destination,
        preferences: source.preferences,
        priority: this.priority,
        title: item.title,
        source: source.name,
      });
      // `enqueue` only fails with a `QueueError`, and none of its members can
      // arise from an insert. Skipping the item beats aborting the whole pass
      // over one bad row.
      if (Result.isError(result)) continue;

      const { outcome, job } = result.value;
      if (outcome === "queued" && spacingMs > 0 && index > 0) {
        await this.queue.defer(job.id, index * spacingMs);
      }
      enqueued.push({ jobId: job.id, externalId: item.externalId, url: item.url, title: item.title, outcome });
    }

    return enqueued;
  }
}
