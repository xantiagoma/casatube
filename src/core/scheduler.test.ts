/**
 * Scheduler tests.
 *
 * The two properties worth proving are the two that would be expensive to get
 * wrong in production and invisible in review: **a pass never overlaps itself**,
 * and **sources inside a pass are spaced out**. Both are proved here against a
 * real `SourceManager` over a real database file, with the discoverer injected
 * so a "channel listing" is something the test decides instead of something the
 * network does.
 *
 * `sleep` is injected too. Spacing that is genuinely endured would make this
 * file take minutes; spacing that is *recorded* is the same assertion at no
 * cost — and the one test that does use real timers uses them deliberately,
 * because the thing it is checking is the timer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { appDbPath, closeDb, openDb, queueDbPath, type Db } from "./db";
import { openJobQueue, shutdownEmbeddedQueue, type JobQueue } from "./queue";
import { Blocked } from "./errors";
import { SourceManager, type Discoverer } from "./sources";
import { DEFAULT_SOURCE_SPACING_MS, SourceScheduler, realSleep } from "./scheduler";
import type { DiscoveredItem } from "./types";

// --- harness ----------------------------------------------------------------

let dir: string;
let db: Db;
let queue: JobQueue;
let clock: Date;
let manager: SourceManager;

/** What each source URL lists, keyed by URL. */
let listings: Map<string, DiscoveredItem[]>;
/** URLs whose listing should fail. */
let broken: Set<string>;
/** The order sources were actually asked, so spacing can be read off it. */
let asked: string[];
/** Recorded `sleep(ms)` calls — the spacing, without the waiting. */
let slept: number[];
/** When set, discovery blocks until the test resolves it. */
let gate: { promise: Promise<void>; open: () => void } | null;

function now(): Date {
  return clock;
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function openGate(): void {
  gate?.open();
  gate = null;
}

function makeGate(): void {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  gate = { promise, open };
}

const discover: Discoverer = async (url) => {
  asked.push(url);
  if (gate) await gate.promise;
  if (broken.has(url)) return Result.err(new Blocked({ url, detail: "bot check" }));
  return Result.ok(listings.get(url) ?? []);
};

const sleep = async (ms: number): Promise<void> => {
  slept.push(ms);
};

function scheduler(overrides: Partial<ConstructorParameters<typeof SourceScheduler>[0]> = {}): SourceScheduler {
  return new SourceScheduler({ manager, now, sleep, ...overrides });
}

function item(n: number): DiscoveredItem {
  return { externalId: `v${n}`, url: `https://example.test/watch?v=${n}`, title: `Video ${n}` };
}

/**
 * Add a source that lists nothing, so its history is empty and it is quiet.
 *
 * ⚠️ `asked` is cleared afterwards: adding a source performs a listing of its
 * own (that is how the back catalogue gets seeded), and leaving those calls in
 * would make every "which sources did the pass ask?" assertion read the setup
 * rather than the pass.
 */
async function addSource(url: string, intervalMinutes = 360): Promise<string> {
  listings.set(url, []);
  const added = await manager.add({ url, destination: "youtube", intervalMinutes });
  if (Result.isError(added)) throw new Error(`add failed: ${added.error._tag}`);
  asked.length = 0;
  return added.value.source.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "casatube-scheduler-"));
  clock = new Date("2026-08-26T09:00:00.000Z");
  listings = new Map();
  broken = new Set();
  asked = [];
  slept = [];
  gate = null;
  db = openDb({ path: appDbPath(dir) });
  queue = await openJobQueue({ db, queueDbPath: queueDbPath(dir), now });
  manager = new SourceManager({ db, queue, discover, now, itemSpacingMs: 0 });
});

afterEach(() => {
  queue.close();
  closeDb(db);
  shutdownEmbeddedQueue();
  rmSync(dir, { recursive: true, force: true });
});

// --- what a pass does -------------------------------------------------------

describe("a pass", () => {
  test("checks only what is due, and queues what it finds", async () => {
    const soon = await addSource("https://example.test/@soon", 60);
    await addSource("https://example.test/@later", 24 * 60);

    advance(2 * 60 * 60_000);
    listings.set("https://example.test/@soon", [item(1), item(2)]);
    asked = [];

    const pass = await scheduler().runPass()!;

    expect(pass.due).toBe(1);
    expect(asked).toEqual(["https://example.test/@soon"]);
    expect(pass.checked.map((c) => c.sourceId)).toEqual([soon]);
    expect(pass.checked[0]?.enqueued).toHaveLength(2);
    expect(await queue.list()).toHaveLength(2);
  });

  test("nothing due is a pass that asks nobody anything", async () => {
    await addSource("https://example.test/@a");
    asked = [];

    const pass = await scheduler().runPass()!;

    expect(pass.due).toBe(0);
    expect(pass.checked).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a source that fails does not end the pass", async () => {
    await addSource("https://example.test/@broken");
    const good = await addSource("https://example.test/@good");
    advance(7 * 60 * 60_000);

    broken.add("https://example.test/@broken");
    listings.set("https://example.test/@good", [item(1)]);

    const errors: string[] = [];
    const pass = await scheduler({ onError: (id) => errors.push(id) }).runPass()!;

    expect(pass.failures.map((f) => f.tag)).toEqual(["Blocked"]);
    expect(pass.checked.map((c) => c.sourceId)).toEqual([good]);
    expect(errors).toHaveLength(1);
    expect(await queue.list()).toHaveLength(1);
  });
});

// --- spacing ----------------------------------------------------------------

describe("⚠️ spacing", () => {
  test("sources inside a pass are spaced, and the first one is not", async () => {
    for (const name of ["a", "b", "c"]) await addSource(`https://example.test/@${name}`);
    advance(7 * 60 * 60_000);

    const pass = await scheduler().runPass()!;

    expect(pass.checked).toHaveLength(3);
    // Two gaps for three sources. A gap before the first would delay a pass
    // that has one source due for nobody's benefit.
    expect(slept).toEqual([DEFAULT_SOURCE_SPACING_MS, DEFAULT_SOURCE_SPACING_MS]);
  });

  test("one due source is checked immediately", async () => {
    await addSource("https://example.test/@only");
    advance(7 * 60 * 60_000);

    await scheduler().runPass()!;

    expect(slept).toEqual([]);
  });

  test("a pass is capped, and the overflow is the next pass's first business", async () => {
    for (const name of ["a", "b", "c", "d"]) await addSource(`https://example.test/@${name}`);
    advance(7 * 60 * 60_000);

    const first = await scheduler({ maxSourcesPerPass: 2 }).runPass()!;
    expect(first.checked).toHaveLength(2);
    expect(first.deferred).toBe(2);
    expect(asked).toEqual(["https://example.test/@a", "https://example.test/@b"]);

    // `due()` returns the longest-waiting first, so the two that were skipped
    // are the two that go next. Nothing starves.
    asked = [];
    const second = await scheduler({ maxSourcesPerPass: 2 }).runPass()!;
    expect(second.checked).toHaveLength(2);
    expect(asked).toEqual(["https://example.test/@c", "https://example.test/@d"]);
  });

  test("stopping cuts the pass short instead of sitting out the spacing", async () => {
    for (const name of ["a", "b", "c"]) await addSource(`https://example.test/@${name}`);
    advance(7 * 60 * 60_000);

    const s = scheduler({
      // A sleep that observes the abort, the way the real one does.
      sleep: async (ms, signal) => {
        slept.push(ms);
        s.stop();
        expect(signal.aborted).toBe(true);
      },
    });
    s.start();
    const pass = await s.runPass()!;

    expect(pass.checked).toHaveLength(1);
    expect(pass.deferred).toBe(2);
  });

  test("realSleep resolves early when the signal aborts", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const waiting = realSleep(60_000, abort.signal);
    abort.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

// --- non-overlap ------------------------------------------------------------

describe("🔴 not overlapping with itself", () => {
  test("a second pass is refused while one is in flight, not run beside it", async () => {
    await addSource("https://example.test/@slow");
    advance(7 * 60 * 60_000);
    listings.set("https://example.test/@slow", [item(1)]);

    const s = scheduler();
    makeGate();
    const first = s.runPass();
    expect(first).not.toBeNull();
    // The pass is now parked inside `discover`.
    await Bun.sleep(5);
    expect(s.isRunning()).toBe(true);

    // 🔴 `null`, not a second sweep of the same due list.
    expect(s.runPass()).toBeNull();

    openGate();
    await first;

    expect(s.isRunning()).toBe(false);
    expect(asked).toEqual(["https://example.test/@slow"]);
    expect(await queue.list()).toHaveLength(1);
    // And the source is now free again.
    expect(s.runPass()).not.toBeNull();
  });

  test("the ticker chains rather than stacking, so a slow pass cannot pile up", async () => {
    await addSource("https://example.test/@slow", 60);

    let inFlight = 0;
    let peak = 0;
    let passes = 0;
    const slow: Discoverer = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      passes += 1;
      await Bun.sleep(60);
      inFlight -= 1;
      return Result.ok([]);
    };

    // Real timers here on purpose: the claim under test is about the timer.
    const s = new SourceScheduler({
      manager: new SourceManager({ db, queue, discover: slow, now: () => new Date(), itemSpacingMs: 0 }),
      tickMs: 20,
      sleep,
    });
    s.start();
    await Bun.sleep(300);
    s.stop();
    await s.drain();

    expect(peak).toBe(1);
    // `setInterval` at 20 ms would have fired ~15 times in 300 ms. Chaining
    // gives one pass per (60 ms of work + 20 ms of tick), so ~3-4.
    expect(passes).toBeLessThanOrEqual(6);
    expect(passes).toBeGreaterThan(0);
  });
});

// --- lifecycle and status ---------------------------------------------------

describe("lifecycle", () => {
  test("start is idempotent and stop is honest about it", () => {
    const s = scheduler({ tickMs: 10_000 });
    expect(s.isStarted()).toBe(false);
    s.start();
    s.start();
    expect(s.isStarted()).toBe(true);
    s.stop();
    expect(s.isStarted()).toBe(false);
    s.stop();
  });

  test("status says when the next pass is and what is waiting for it", async () => {
    await addSource("https://example.test/@a", 360);
    await addSource("https://example.test/@b", 60);

    const s = scheduler({ tickMs: 60_000 });
    expect((await s.status()).running).toBe(false);
    expect((await s.status()).nextPassAt).toBeNull();

    s.start();
    const idle = await s.status();
    expect(idle.running).toBe(true);
    expect(idle.nextPassAt).toBe(new Date(clock.getTime() + 60_000).toISOString());
    expect(idle.sources).toBe(2);
    expect(idle.dueNow).toBe(0);
    // The impatient source decides when there is next anything to do.
    expect(idle.nextSourceDueAt).toBe(new Date(clock.getTime() + 60 * 60_000).toISOString());

    advance(90 * 60_000);
    const due = await s.status();
    expect(due.dueNow).toBe(1);

    await s.runPass()!;
    const after = await s.status();
    expect(after.lastPassAt).toBe(clock.toISOString());
    expect(after.lastPass?.checked).toHaveLength(1);
    s.stop();
  });

  test("a stopped scheduler stops ticking", async () => {
    await addSource("https://example.test/@a", 60);
    advance(2 * 60 * 60_000);

    const s = new SourceScheduler({ manager, tickMs: 5, sleep });
    s.start();
    await Bun.sleep(40);
    s.stop();
    await s.drain();
    const seen = asked.length;
    expect(seen).toBeGreaterThan(0);

    await Bun.sleep(40);
    expect(asked.length).toBe(seen);
  });
});
