/**
 * Source tests.
 *
 * ⚠️ Real SQLite **files** in a temp directory and the real `JobQueue`, never
 * `:memory:` and never a stubbed queue. The claim that makes this module
 * correct — "checking twice cannot enqueue twice" — is a claim about a
 * transaction against a table, so a fake queue would have moved the proof
 * somewhere it does not live.
 *
 * The **discoverer is injected**, and that is the only seam: no test here may
 * touch the network. What a channel lists is a variable the test sets, which is
 * also the only way to write "the same listing, twice" as a test at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { appDbPath, closeDb, openDb, queueDbPath, type Db } from "./db";
import { openJobQueue, shutdownEmbeddedQueue, type JobQueue } from "./queue";
import { Blocked } from "./errors";
import { sourceSeen } from "./schema";
import type { DiscoveredItem } from "./types";
import {
  MAX_INCLUDE_EXISTING,
  MIN_INTERVAL_MINUTES,
  SourceManager,
  deriveName,
  newestFirst,
  registryDiscoverer,
  type Discoverer,
} from "./sources";
import { createRegistry } from "../providers/registry";

// --- harness ----------------------------------------------------------------

let dir: string;
let db: Db;
let queue: JobQueue;
let clock: Date;

/** What the fake source is listing right now. Tests reassign it. */
let listing: DiscoveredItem[] = [];
/** Set to make discovery fail. */
let listingError: Blocked | null = null;
let listCalls = 0;

function now(): Date {
  return clock;
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

const discover: Discoverer = async () => {
  listCalls += 1;
  if (listingError) return Result.err(listingError);
  return Result.ok(listing);
};

function item(n: number, publishedAt?: string): DiscoveredItem {
  return {
    externalId: `v${n}`,
    url: `https://example.test/watch?v=${n}`,
    title: `Video ${n}`,
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function manager(overrides: Partial<ConstructorParameters<typeof SourceManager>[0]> = {}): SourceManager {
  return new SourceManager({ db, queue, discover, now, ...overrides });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "casatube-sources-"));
  clock = new Date("2026-08-26T09:00:00.000Z");
  listing = [];
  listingError = null;
  listCalls = 0;
  db = openDb({ path: appDbPath(dir) });
  queue = await openJobQueue({ db, queueDbPath: queueDbPath(dir), now });
});

afterEach(() => {
  queue.close();
  closeDb(db);
  shutdownEmbeddedQueue();
  rmSync(dir, { recursive: true, force: true });
});

async function add(overrides: Record<string, unknown> = {}) {
  const result = await manager().add({
    url: "https://example.test/@channel",
    destination: "youtube",
    ...overrides,
  });
  if (Result.isError(result)) throw new Error(`add failed: ${result.error._tag}`);
  return result.value;
}

// --- adding -----------------------------------------------------------------

describe("adding a source", () => {
  test("🔴 marks the whole back catalogue as seen and enqueues none of it", async () => {
    listing = Array.from({ length: 800 }, (_, i) => item(i));

    const added = await add();

    expect(added.discovered).toBe(800);
    expect(added.seeded).toBe(800);
    expect(added.enqueued).toEqual([]);
    // The queue is the assertion that matters: a channel with 800 videos must
    // not put 800 rows in it.
    expect(await queue.list({ limit: 1000 })).toHaveLength(0);

    const seen = await db.select().from(sourceSeen).where(eq(sourceSeen.sourceId, added.source.id));
    expect(seen).toHaveLength(800);
  });

  test("records the listing as a check, so the first scheduled pass waits a full interval", async () => {
    listing = [item(1)];
    const added = await add();

    expect(added.source.lastCheckedAt).toBe(clock.toISOString());
    expect(await manager().due()).toEqual([]);
  });

  test("only what appears after is enqueued", async () => {
    listing = [item(1), item(2)];
    const added = await add();

    listing = [item(3), item(1), item(2)];
    const checked = await manager().check(added.source.id);
    expect(Result.isError(checked)).toBe(false);
    if (Result.isError(checked)) return;

    expect(checked.value.discovered).toBe(3);
    expect(checked.value.fresh).toBe(1);
    expect(checked.value.enqueued.map((e) => e.externalId)).toEqual(["v3"]);

    const jobs = await queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.url).toBe("https://example.test/watch?v=3");
  });

  test("⚠️ a failed listing creates no source at all", async () => {
    listingError = new Blocked({ url: "https://example.test/@channel", detail: "bot check" });

    const result = await manager().add({ url: "https://example.test/@channel", destination: "youtube" });

    expect(Result.isError(result)).toBe(true);
    // The dangerous half: a row whose history was never seeded would make the
    // first scheduled check queue the entire channel.
    expect(await manager().list()).toEqual([]);
  });

  test("the interval floor is enforced, and the default is six hours", async () => {
    listing = [];
    const impatient = await add({ intervalMinutes: 1 });
    expect(impatient.source.intervalMinutes).toBe(MIN_INTERVAL_MINUTES);

    const untouched = await add({ url: "https://example.test/@other" });
    expect(untouched.source.intervalMinutes).toBe(360);
  });

  test("a missing name is derived from the URL", async () => {
    const added = await add({ url: "https://www.youtube.com/@veritasium/videos" });
    expect(added.source.name).toBe("@veritasium");
  });
});

// --- includeExisting --------------------------------------------------------

describe("includeExisting", () => {
  test("enqueues only up to the cap it was asked to name — the rest is still seen", async () => {
    listing = Array.from({ length: 10 }, (_, i) => item(i));

    const added = await add({ includeExisting: { limit: 3 } });

    expect(added.enqueued).toHaveLength(3);
    expect(added.seeded).toBe(10);
    expect(added.capped).toBe(false);
    expect(await queue.list()).toHaveLength(3);

    // 🔴 Everything listed is seen, including what was queued: the next check
    // must not find the back catalogue again.
    listing = [...listing];
    const again = await manager().check(added.source.id, { force: true });
    if (Result.isError(again)) throw new Error("check failed");
    expect(again.value.fresh).toBe(0);
    expect(await queue.list()).toHaveLength(3);
  });

  test("⚠️ an absurd cap is clamped, and says so", async () => {
    listing = Array.from({ length: 200 }, (_, i) => item(i));

    const added = await add({ includeExisting: { limit: 500 } });

    expect(added.capped).toBe(true);
    expect(added.enqueued).toHaveLength(MAX_INCLUDE_EXISTING);
    expect(await queue.list({ limit: 500 })).toHaveLength(MAX_INCLUDE_EXISTING);
  });

  test("takes the newest, when the source dates its items", async () => {
    listing = [
      item(1, "2026-01-01T00:00:00.000Z"),
      item(3, "2026-03-01T00:00:00.000Z"),
      item(2, "2026-02-01T00:00:00.000Z"),
    ];

    const added = await add({ includeExisting: { limit: 1 } });
    expect(added.enqueued.map((e) => e.externalId)).toEqual(["v3"]);
  });
});

// --- idempotence ------------------------------------------------------------

describe("🔴 idempotence", () => {
  test("checking twice over the same listing enqueues once", async () => {
    listing = [item(1)];
    const added = await add();

    listing = [item(2), item(1)];
    const first = await manager().check(added.source.id);
    const second = await manager().check(added.source.id);

    if (Result.isError(first) || Result.isError(second)) throw new Error("check failed");
    expect(first.value.enqueued).toHaveLength(1);
    expect(second.value.enqueued).toHaveLength(0);
    expect(second.value.fresh).toBe(0);

    // Not the queue's fingerprint check doing this: that only fires for a job
    // that is already `done`, so a second enqueue would have produced a second
    // `queued` row. One row means `source_seen` refused the item.
    expect(await queue.list()).toHaveLength(1);
  });

  test("two checks racing over the same source still enqueue once each item", async () => {
    listing = [];
    const added = await add();

    listing = [item(1), item(2), item(3)];
    const [a, b] = await Promise.all([
      manager().check(added.source.id),
      manager().check(added.source.id),
    ]);

    if (Result.isError(a) || Result.isError(b)) throw new Error("check failed");
    expect(a.value.enqueued.length + b.value.enqueued.length).toBe(3);

    const jobs = await queue.list();
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.url)).size).toBe(3);
  });

  test("a source repeating an id in one listing is one item", async () => {
    listing = [];
    const added = await add();

    listing = [item(1), item(1), item(1)];
    const checked = await manager().check(added.source.id);
    if (Result.isError(checked)) throw new Error("check failed");

    expect(checked.value.discovered).toBe(1);
    expect(await queue.list()).toHaveLength(1);
  });

  test("survives a restart: seen items stay seen across a reopen", async () => {
    listing = [item(1)];
    const added = await add();
    listing = [item(2), item(1)];
    await manager().check(added.source.id);

    queue.close();
    closeDb(db);
    shutdownEmbeddedQueue();
    db = openDb({ path: appDbPath(dir) });
    queue = await openJobQueue({ db, queueDbPath: queueDbPath(dir), now });

    const again = await manager().check(added.source.id, { force: true });
    if (Result.isError(again)) throw new Error("check failed");
    expect(again.value.fresh).toBe(0);
    expect(await queue.list()).toHaveLength(1);
  });
});

// --- the per-check cap ------------------------------------------------------

describe("the per-check cap", () => {
  test("holds the overflow back unseen, so the next pass takes it", async () => {
    listing = [];
    const added = await add();

    listing = Array.from({ length: 5 }, (_, i) => item(i));
    const first = await manager({ maxNewPerCheck: 2 }).check(added.source.id);
    if (Result.isError(first)) throw new Error("check failed");

    expect(first.value.fresh).toBe(5);
    expect(first.value.enqueued).toHaveLength(2);
    expect(first.value.heldBack).toBe(3);

    // ⚠️ Held back, not dropped. The proof is that the next check finds them.
    const second = await manager({ maxNewPerCheck: 2 }).check(added.source.id, { force: true });
    if (Result.isError(second)) throw new Error("check failed");
    expect(second.value.enqueued).toHaveLength(2);
    expect(second.value.heldBack).toBe(1);

    const third = await manager({ maxNewPerCheck: 2 }).check(added.source.id, { force: true });
    if (Result.isError(third)) throw new Error("check failed");
    expect(third.value.enqueued).toHaveLength(1);
    expect(await queue.list()).toHaveLength(5);
  });
});

// --- pacing -----------------------------------------------------------------

describe("automated work is paced", () => {
  test("discovered downloads are queued at low priority so manual work goes first", async () => {
    listing = [];
    const added = await add();
    listing = [item(1)];
    await manager().check(added.source.id);

    const jobs = await queue.list();
    expect(jobs[0]?.priority).toBe("low");
    expect(jobs[0]?.source).toBe(added.source.name);
    expect(jobs[0]?.title).toBe("Video 1");
  });

  test("⚠️ items in one check are staggered behind notBefore", async () => {
    listing = [];
    const added = await add();

    listing = [item(1), item(2), item(3)];
    await manager({ itemSpacingMs: 60_000 }).check(added.source.id);

    const byUrl = new Map((await queue.list()).map((job) => [job.url, job]));
    // The first is immediate; each later one waits a further minute.
    expect(byUrl.get("https://example.test/watch?v=1")?.notBefore).toBeNull();
    expect(byUrl.get("https://example.test/watch?v=2")?.notBefore).toBe(
      new Date(clock.getTime() + 60_000).toISOString(),
    );
    expect(byUrl.get("https://example.test/watch?v=3")?.notBefore).toBe(
      new Date(clock.getTime() + 120_000).toISOString(),
    );
  });

  test("the stagger can be turned off for a single check", async () => {
    listing = [];
    const added = await add();
    listing = [item(1), item(2)];
    await manager().check(added.source.id, { itemSpacingMs: 0 });

    expect((await queue.list()).every((job) => job.notBefore === null)).toBe(true);
  });
});

// --- being due --------------------------------------------------------------

describe("being due", () => {
  test("is decided by the source's own interval", async () => {
    listing = [];
    const added = await add({ intervalMinutes: 360 });
    const m = manager();

    advance(5 * 60 * 60_000);
    expect(await m.due()).toEqual([]);

    advance(60 * 60_000 + 1);
    expect((await m.due()).map((s) => s.id)).toEqual([added.source.id]);
  });

  test("a disabled source is never due, and is skipped rather than checked", async () => {
    listing = [];
    const added = await add({ enabled: false });
    advance(24 * 60 * 60_000);

    expect(await manager().due()).toEqual([]);

    const before = listCalls;
    const checked = await manager().check(added.source.id);
    if (Result.isError(checked)) throw new Error("check failed");
    expect(checked.value.skipped).toBe("disabled");
    expect(listCalls).toBe(before);

    // `force` is the manual button, and it does reach the network.
    const forced = await manager().check(added.source.id, { force: true });
    expect(Result.isError(forced)).toBe(false);
    expect(listCalls).toBe(before + 1);
  });

  test("⚠️ a failed check still moves lastCheckedAt, so a blocked source is not retried every tick", async () => {
    listing = [];
    const added = await add();
    advance(7 * 60 * 60_000);
    expect(await manager().due()).toHaveLength(1);

    listingError = new Blocked({ url: added.source.url, detail: "bot check" });
    const checked = await manager().check(added.source.id);
    expect(Result.isError(checked)).toBe(true);

    expect(await manager().due()).toEqual([]);
  });
});

// --- editing and removing ---------------------------------------------------

describe("editing and removing", () => {
  test("a patch merges preferences instead of resetting them", async () => {
    listing = [];
    const added = await add({ preferences: { maxResolution: 720, subtitleLanguages: ["es"] } });

    const updated = await manager().update(added.source.id, { preferences: { sponsorblock: false } });
    if (Result.isError(updated)) throw new Error("update failed");

    expect(updated.value.preferences.maxResolution).toBe(720);
    expect(updated.value.preferences.subtitleLanguages).toEqual(["es"]);
    expect(updated.value.preferences.sponsorblock).toBe(false);
  });

  test("an unknown id is NotFound, not a silent no-op", async () => {
    const missing = await manager().update("nope", { enabled: false });
    expect(Result.isError(missing)).toBe(true);
    if (Result.isError(missing)) expect(missing.error._tag).toBe("NotFound");

    const removed = await manager().remove("nope");
    expect(Result.isError(removed)).toBe(true);
  });

  test("removing a source forgets what it had seen", async () => {
    listing = [item(1), item(2)];
    const added = await add();
    expect(await manager().seenCount(added.source.id)).toBe(2);

    await manager().remove(added.source.id);

    expect(await manager().list()).toEqual([]);
    expect(await db.select().from(sourceSeen).where(eq(sourceSeen.sourceId, added.source.id))).toEqual([]);
  });
});

// --- pure helpers -----------------------------------------------------------

describe("helpers", () => {
  test("newestFirst sorts only when every item is dated", () => {
    const dated = [item(1, "2026-01-01T00:00:00.000Z"), item(2, "2026-05-01T00:00:00.000Z")];
    expect(newestFirst(dated).map((i) => i.externalId)).toEqual(["v2", "v1"]);

    // Half-dated: the provider's own order is a better guess than a sort on a
    // field half the items do not have.
    const mixed = [item(1), item(2, "2026-05-01T00:00:00.000Z")];
    expect(newestFirst(mixed).map((i) => i.externalId)).toEqual(["v1", "v2"]);
  });

  test("deriveName picks the handle, the list id, or the host", () => {
    expect(deriveName("https://www.youtube.com/@veritasium/videos")).toBe("@veritasium");
    expect(deriveName("https://www.youtube.com/playlist?list=PL123")).toBe("PL123");
    expect(deriveName("https://example.test/")).toBe("example.test");
    expect(deriveName("not a url")).toBe("not a url");
  });

  test("a provider that cannot enumerate is refused rather than read as empty", async () => {
    const registry = createRegistry({
      fallback: {
        name: "no-list",
        supports: () => true,
        probe: async () => Result.err(new Blocked({ url: "", detail: "" })),
        fetch: async () => Result.err(new Blocked({ url: "", detail: "" })),
      },
    });

    const result = await registryDiscoverer(registry)("https://example.test/x", new AbortController().signal);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) expect(result.error._tag).toBe("UnsupportedUrl");
  });
});
