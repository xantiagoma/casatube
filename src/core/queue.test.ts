/**
 * Queue tests.
 *
 * ⚠️ Every case here runs against a **real SQLite file** in a temp directory,
 * never `:memory:`. The requirement these tests exist for is R2 — a job
 * survives the service restarting — and an in-memory database cannot be closed
 * and reopened, so an in-memory version of the recovery test would pass while
 * proving nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { Queue as BunQueue } from "bunqueue/client";
import { eq } from "drizzle-orm";

import { appDbPath, closeDb, openDb, queueDbPath, type Db } from "./db";
import { jobs } from "./schema";
import {
  fingerprintOf,
  openJobQueue,
  resolvePreferences,
  shutdownEmbeddedQueue,
  type EnqueueInput,
  type JobQueue,
} from "./queue";

// --- harness ----------------------------------------------------------------

let dir: string;
let clock: Date;
let live: Array<{ db: Db; queue: JobQueue }> = [];

/** The clock is injected so a lease can lapse without the test sleeping. */
function now(): Date {
  return clock;
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

interface BootOptions {
  leaseMs?: number;
  backoffMs?: number;
}

/** Open the service against the temp directory. Called twice by the restart test. */
async function boot(options: BootOptions = {}): Promise<{ db: Db; queue: JobQueue }> {
  const db = openDb({ path: appDbPath(dir) });
  const queue = await openJobQueue({
    db,
    queueDbPath: queueDbPath(dir),
    leaseMs: options.leaseMs ?? 60_000,
    backoffMs: options.backoffMs ?? 30_000,
    now,
  });
  const handle = { db, queue };
  live.push(handle);
  return handle;
}

/** Stop the service the way a container stop would. */
function stop(handle: { db: Db; queue: JobQueue }): void {
  handle.queue.close();
  closeDb(handle.db);
  live = live.filter((h) => h !== handle);
  shutdownEmbeddedQueue();
}

function input(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    url: "https://example.test/watch?v=abc",
    provider: "yt-dlp",
    destination: "Videos",
    ...overrides,
  };
}

/** Unwrap an `Ok`, failing the test with the tagged error otherwise. */
function unwrap<A, E>(result: Result<A, E>): A {
  if (Result.isError(result)) {
    throw new Error(`expected Ok, got Err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

async function enqueued(queue: JobQueue, overrides: Partial<EnqueueInput> = {}) {
  const result = unwrap(await queue.enqueue(input(overrides)));
  expect(result.outcome).toBe("queued");
  return result.job;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-queue-"));
  clock = new Date("2026-08-26T10:00:00.000Z");
});

afterEach(() => {
  for (const handle of [...live]) {
    handle.queue.close();
    closeDb(handle.db);
  }
  live = [];
  // The embedded manager is a process-wide singleton keyed by dataPath: without
  // this, the next test's temp directory throws a dataPath conflict.
  shutdownEmbeddedQueue();
  rmSync(dir, { recursive: true, force: true });
});

// --- enqueue ----------------------------------------------------------------

describe("enqueue", () => {
  test("writes a queued job with resolved preferences and a fingerprint", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue, { priority: "high", title: "A video" });

    expect(job.status).toBe("queued");
    expect(job.paused).toBe(false);
    expect(job.priority).toBe("high");
    expect(job.attempts).toBe(0);
    expect(job.claimedBy).toBeNull();
    expect(job.progress).toBe(0);
    expect(job.log).toEqual([]);
    expect(job.stages.map((s) => s.name)).toEqual([
      "validate",
      "analyze",
      "download",
      "postprocess",
      "metadata",
      "move",
    ]);
    expect(job.stages.every((s) => s.status === "pending")).toBe(true);
    expect(job.preferences.maxResolution).toBe(1080);
    expect(job.fingerprint).toBe(fingerprintOf(job.url, resolvePreferences(undefined)));
  });

  test("the fingerprint ignores language order but not the configuration", () => {
    const url = "https://example.test/x";
    const a = fingerprintOf(url, resolvePreferences({ subtitleLanguages: ["en", "es"] }));
    const b = fingerprintOf(url, resolvePreferences({ subtitleLanguages: ["es", "en"] }));
    const c = fingerprintOf(url, resolvePreferences({ maxResolution: 720 }));

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

// --- duplicates (PLAN §15) ---------------------------------------------------

describe("duplicate detection", () => {
  test("reports the finished job instead of queueing a second one", async () => {
    const { queue } = await boot();
    const first = await enqueued(queue);
    unwrap(await queue.update(first.id, { status: "done", outputFile: "/library/Videos/a.mkv" }));

    const second = unwrap(await queue.enqueue(input()));
    expect(second.outcome).toBe("duplicate");
    expect(second.job.id).toBe(first.id);
    expect(second.job.outputFile).toBe("/library/Videos/a.mkv");
    expect(await queue.list()).toHaveLength(1);
  });

  test("a different configuration is not a duplicate", async () => {
    const { queue } = await boot();
    const first = await enqueued(queue);
    unwrap(await queue.update(first.id, { status: "done" }));

    const second = unwrap(await queue.enqueue(input({ preferences: { maxResolution: 720 } })));
    expect(second.outcome).toBe("queued");
    expect(second.job.id).not.toBe(first.id);
  });

  test("an unfinished job with the same fingerprint does not block a new one", async () => {
    const { queue } = await boot();
    await enqueued(queue);
    const second = unwrap(await queue.enqueue(input()));
    expect(second.outcome).toBe("queued");
  });

  test("force queues it anyway", async () => {
    const { queue } = await boot();
    const first = await enqueued(queue);
    unwrap(await queue.update(first.id, { status: "done" }));

    const forced = unwrap(await queue.enqueue(input({ force: true })));
    expect(forced.outcome).toBe("queued");
    expect(forced.job.id).not.toBe(first.id);
    expect(forced.job.fingerprint).toBe(first.fingerprint);
  });
});

// --- claim order -------------------------------------------------------------

describe("claim order", () => {
  test("high before normal before low, whatever the insertion order", async () => {
    const { queue } = await boot();
    await enqueued(queue, { url: "https://example.test/low", priority: "low" });
    await enqueued(queue, { url: "https://example.test/normal", priority: "normal" });
    await enqueued(queue, { url: "https://example.test/high", priority: "high" });

    const first = unwrap(await queue.claimNext("slot-1"));
    const second = unwrap(await queue.claimNext("slot-2"));
    const third = unwrap(await queue.claimNext("slot-3"));

    expect(first?.url).toBe("https://example.test/high");
    expect(second?.url).toBe("https://example.test/normal");
    expect(third?.url).toBe("https://example.test/low");
    expect(unwrap(await queue.claimNext("slot-4"))).toBeNull();
  });

  test("oldest first within the same priority", async () => {
    const { queue } = await boot();
    const a = await enqueued(queue, { url: "https://example.test/a" });
    advance(1000);
    const b = await enqueued(queue, { url: "https://example.test/b" });
    advance(1000);
    const c = await enqueued(queue, { url: "https://example.test/c" });

    expect(unwrap(await queue.claimNext("slot-1"))?.id).toBe(a.id);
    expect(unwrap(await queue.claimNext("slot-1"))?.id).toBe(b.id);
    expect(unwrap(await queue.claimNext("slot-1"))?.id).toBe(c.id);
  });

  test("a paused job is never claimed, and resuming makes it claimable", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    unwrap(await queue.pause(job.id));

    expect(unwrap(await queue.claimNext("slot-1"))).toBeNull();

    unwrap(await queue.resume(job.id));
    expect(unwrap(await queue.claimNext("slot-1"))?.id).toBe(job.id);
  });

  test("a cancelled job is never claimed", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    unwrap(await queue.cancel(job.id));
    expect(unwrap(await queue.claimNext("slot-1"))).toBeNull();
  });

  test("claiming records the worker and a lease", async () => {
    const { queue } = await boot({ leaseMs: 30_000 });
    const job = await enqueued(queue);
    const claimed = unwrap(await queue.claimNext("slot-2"));

    expect(claimed?.claimedBy).toBe("slot-2");
    expect(claimed?.status).toBe("analyzing");
    expect(claimed?.leaseUntil).toBe(new Date(clock.getTime() + 30_000).toISOString());
  });
});

// --- atomicity ---------------------------------------------------------------

describe("claimNext atomicity", () => {
  test("concurrent claims on one job produce exactly one winner", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);

    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((w) => queue.claimNext(`slot-${w}`)),
    );
    const claimed = results.map(unwrap).filter((j) => j !== null);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(job.id);
  });

  test("two connections to the same file never hand out the same job", async () => {
    const one = await boot();
    // A second connection to the same database file: this is the shape a second
    // worker process would have, and the claim must still be a compare-and-swap.
    const two = await boot();

    const ids = new Set<string>();
    for (let i = 0; i < 8; i++) {
      ids.add((await enqueued(one.queue, { url: `https://example.test/${i}` })).id);
      advance(1);
    }

    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => one.queue.claimNext(`a-${i}`)),
      ...Array.from({ length: 8 }, (_, i) => two.queue.claimNext(`b-${i}`)),
    ]);

    const claimed = results.map(unwrap).filter((j) => j !== null);
    expect(claimed).toHaveLength(8);
    expect(new Set(claimed.map((j) => j.id)).size).toBe(8);
  });
});

// --- leases (PLAN §17, rules 2 and 4) ---------------------------------------

describe("leases", () => {
  test("an expired lease returns the job to the queue with its progress intact", async () => {
    const { queue } = await boot({ leaseMs: 10_000 });
    const job = await enqueued(queue);

    unwrap(await queue.claimNext("slot-1"));
    unwrap(
      await queue.update(job.id, {
        status: "downloading",
        progress: 63,
        doneBytes: 500_000,
        totalBytes: 800_000,
        speed: 1_000_000,
      }),
    );

    // The worker dies here. Nothing renews the lease.
    advance(11_000);

    const reclaimed = unwrap(await queue.claimNext("slot-2"));
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.claimedBy).toBe("slot-2");
    // Kept, so the download resumes rather than restarting.
    expect(reclaimed?.progress).toBe(63);
    expect(reclaimed?.doneBytes).toBe(500_000);
    expect(reclaimed?.totalBytes).toBe(800_000);
    // Cleared, because they described the worker that is gone.
    expect(reclaimed?.speed).toBeNull();
  });

  test("a live lease keeps the job out of another worker's hands", async () => {
    const { queue } = await boot({ leaseMs: 60_000 });
    await enqueued(queue);
    unwrap(await queue.claimNext("slot-1"));

    advance(30_000);
    expect(unwrap(await queue.claimNext("slot-2"))).toBeNull();
  });

  test("renewLease extends the holder's claim and refuses everyone else", async () => {
    const { queue } = await boot({ leaseMs: 10_000 });
    const job = await enqueued(queue);
    unwrap(await queue.claimNext("slot-1"));

    advance(8_000);
    const renewed = unwrap(await queue.renewLease(job.id, "slot-1"));
    expect(renewed.leaseUntil).toBe(new Date(clock.getTime() + 10_000).toISOString());

    const stolen = await queue.renewLease(job.id, "slot-9");
    expect(Result.isError(stolen)).toBe(true);
    // The job exists; this worker just stopped owning it. `NotFound` would have
    // said the wrong thing.
    if (Result.isError(stolen)) expect(stolen.error._tag).toBe("LeaseLost");

    const gone = await queue.renewLease("nope", "slot-1");
    if (Result.isError(gone)) expect(gone.error._tag).toBe("NotFound");

    advance(5_000);
    expect(unwrap(await queue.claimNext("slot-2"))).toBeNull();
  });
});

// --- 🔴 restart recovery (R2) ------------------------------------------------

describe("recoverOnStart", () => {
  test("a job in flight survives a real close-and-reopen of the database file", async () => {
    const first = await boot();
    const job = await enqueued(first.queue, { priority: "high" });

    unwrap(await first.queue.claimNext("slot-1"));
    unwrap(
      await first.queue.update(job.id, {
        status: "downloading",
        progress: 41,
        doneBytes: 340_000,
        totalBytes: 830_000,
        speed: 2_000_000,
        eta: 240,
        appendLog: ["[download]  41.0%"],
      }),
    );

    // The service stops mid-download. Both database files are closed.
    stop(first);
    expect(existsSync(appDbPath(dir))).toBe(true);
    expect(existsSync(queueDbPath(dir))).toBe(true);

    // …and starts again against the same files.
    const second = await boot();
    const recovered = await second.queue.recoverOnStart();
    expect(recovered).toBe(1);

    const after = unwrap(await second.queue.get(job.id));
    expect(after.status).toBe("queued");
    expect(after.claimedBy).toBeNull();
    expect(after.leaseUntil).toBeNull();
    // The whole point: it resumes rather than starting over.
    expect(after.progress).toBe(41);
    expect(after.doneBytes).toBe(340_000);
    expect(after.totalBytes).toBe(830_000);
    expect(after.log).toEqual(["[download]  41.0%"]);
    // Stale readings from the dead worker are gone.
    expect(after.speed).toBeNull();
    expect(after.eta).toBeNull();

    // And it can actually be picked up again.
    const reclaimed = unwrap(await second.queue.claimNext("slot-1"));
    expect(reclaimed?.id).toBe(job.id);
  });

  test("every active status comes back, and terminal ones are left alone", async () => {
    const first = await boot();
    const active = await enqueued(first.queue, { url: "https://example.test/active" });
    const finished = await enqueued(first.queue, { url: "https://example.test/done" });
    const failed = await enqueued(first.queue, { url: "https://example.test/failed" });
    const waiting = await enqueued(first.queue, { url: "https://example.test/waiting" });

    unwrap(await first.queue.update(active.id, { status: "moving", claimedBy: "slot-1" }));
    unwrap(await first.queue.update(finished.id, { status: "done" }));
    unwrap(await first.queue.update(failed.id, { status: "failed", error: "boom" }));
    unwrap(await first.queue.update(waiting.id, { status: "waiting-for-destination" }));

    stop(first);

    const second = await boot();
    expect(await second.queue.recoverOnStart()).toBe(1);

    expect(unwrap(await second.queue.get(active.id)).status).toBe("queued");
    expect(unwrap(await second.queue.get(finished.id)).status).toBe("done");
    expect(unwrap(await second.queue.get(failed.id)).status).toBe("failed");
    // Not worker-held: it is waiting for a mount, not for a process.
    expect(unwrap(await second.queue.get(waiting.id)).status).toBe("waiting-for-destination");
  });

  test("a queued row still carrying a claim is unclaimed", async () => {
    const { db, queue } = await boot();
    const job = await enqueued(queue);
    // The shape a crash between the two writes leaves behind.
    await db
      .update(jobs)
      .set({ claimedBy: "slot-1", leaseUntil: "2999-01-01T00:00:00.000Z" })
      .where(eq(jobs.id, job.id));

    expect(await queue.recoverOnStart()).toBe(1);
    const after = unwrap(await queue.get(job.id));
    expect(after.claimedBy).toBeNull();
    expect(unwrap(await queue.claimNext("slot-2"))?.id).toBe(job.id);
  });

  // --- the two-database consequence (PLAN §9) -------------------------------

  test("re-creates a queue entry a live job has lost", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);

    // Behind the queue's back, as a crash between the two databases would.
    const side = new BunQueue("downloads", { embedded: true, dataPath: queueDbPath(dir) });
    await side.waitUntilReady();
    await side.removeAsync(job.id);
    expect(await side.getJobState(job.id)).toBe("unknown");

    expect(await queue.recoverOnStart()).toBe(1);
    expect(await side.getJobState(job.id)).not.toBe("unknown");
    side.close();
  });

  test("removes a queue entry whose job row is gone", async () => {
    const { db, queue } = await boot();
    const job = await enqueued(queue);

    const side = new BunQueue("downloads", { embedded: true, dataPath: queueDbPath(dir) });
    await side.waitUntilReady();
    // ⚠️ bunqueue's *listing* is eventually consistent — a just-added entry is
    // visible to getJobState() at once but not to getJobsAsync() until it has
    // been flushed. The orphan sweep reads the listing, so wait for it.
    for (let i = 0; i < 40 && !(await side.getJobsAsync()).some((e) => e.id === job.id); i++) {
      await Bun.sleep(50);
    }

    await db.delete(jobs).where(eq(jobs.id, job.id));
    expect(await queue.recoverOnStart()).toBe(0);
    expect(await side.getJobState(job.id)).toBe("unknown");
    side.close();
  });

  test("an empty database recovers nothing", async () => {
    const { queue } = await boot();
    expect(await queue.recoverOnStart()).toBe(0);
  });
});

// --- update, cancel, pause, retry -------------------------------------------

describe("update", () => {
  test("NotFound for an unknown id", async () => {
    const { queue } = await boot();
    const result = await queue.update("nope", { progress: 10 });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) expect(result.error._tag).toBe("NotFound");
  });

  test("appendLog appends rather than replacing", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    unwrap(await queue.update(job.id, { appendLog: ["one"] }));
    const after = unwrap(await queue.update(job.id, { appendLog: ["two", "three"] }));
    expect(after.log).toEqual(["one", "two", "three"]);
  });

  test("a terminal job cannot be moved back by update", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    unwrap(await queue.update(job.id, { status: "done" }));

    const result = await queue.update(job.id, { status: "queued" });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) expect(result.error._tag).toBe("InvalidTransition");
  });

  test("reaching a terminal status releases the claim", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    unwrap(await queue.claimNext("slot-1"));
    const done = unwrap(await queue.update(job.id, { status: "done" }));
    expect(done.claimedBy).toBeNull();
    expect(done.leaseUntil).toBeNull();
  });
});

describe("cancel, pause and resume", () => {
  test("cancel is terminal and idempotent", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    expect(unwrap(await queue.cancel(job.id)).status).toBe("cancelled");
    expect(unwrap(await queue.cancel(job.id)).status).toBe("cancelled");
  });

  test("cancelling a finished job is an invalid transition", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    unwrap(await queue.update(job.id, { status: "done" }));
    const result = await queue.cancel(job.id);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) expect(result.error._tag).toBe("InvalidTransition");
  });

  test("pausing a finished job is an invalid transition", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    unwrap(await queue.update(job.id, { status: "failed" }));
    expect(Result.isError(await queue.pause(job.id))).toBe(true);
  });

  test("pause and resume are idempotent", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    expect(unwrap(await queue.pause(job.id)).paused).toBe(true);
    expect(unwrap(await queue.pause(job.id)).paused).toBe(true);
    expect(unwrap(await queue.resume(job.id)).paused).toBe(false);
  });
});

describe("retry", () => {
  test("a failed job goes back to queued behind its backoff", async () => {
    const { queue } = await boot({ backoffMs: 60_000 });
    const job = await enqueued(queue);
    unwrap(await queue.update(job.id, { status: "failed", error: "yt-dlp exited 1" }));

    const retried = unwrap(await queue.retry(job.id));
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(1);
    expect(retried.error).toBeNull();
    expect(retried.notBefore).toBe(new Date(clock.getTime() + 60_000).toISOString());

    // Queued, but not yet due.
    expect(unwrap(await queue.claimNext("slot-1"))).toBeNull();

    advance(60_000);
    const claimed = unwrap(await queue.claimNext("slot-1"));
    expect(claimed?.id).toBe(job.id);
    // The backoff is spent once it has been honoured.
    expect(claimed?.notBefore).toBeNull();
  });

  test("the backoff grows with each attempt", async () => {
    const { queue } = await boot({ backoffMs: 1_000 });
    const job = await enqueued(queue);

    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      unwrap(await queue.update(job.id, { status: "failed" }));
      const retried = unwrap(await queue.retry(job.id));
      delays.push(Date.parse(retried.notBefore ?? "") - clock.getTime());
      advance(delays[i] ?? 0);
      unwrap(await queue.claimNext("slot-1"));
    }

    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  test("retrying a job that has not finished badly is refused", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    const result = await queue.retry(job.id);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) expect(result.error._tag).toBe("InvalidTransition");
  });

  test("a cancelled job can be retried", async () => {
    const { queue } = await boot({ backoffMs: 0 });
    const job = await enqueued(queue);
    unwrap(await queue.cancel(job.id));
    expect(unwrap(await queue.retry(job.id)).status).toBe("queued");
    expect(unwrap(await queue.claimNext("slot-1"))?.id).toBe(job.id);
  });

  test("retry on an unknown id is NotFound", async () => {
    const { queue } = await boot();
    expect(Result.isError(await queue.retry("nope"))).toBe(true);
  });
});

// --- notBefore: eligibility is ours, not the mirror's ------------------------

describe("notBefore", () => {
  test("a deferred job is skipped until it is due, and the rest of the queue moves on", async () => {
    const { queue } = await boot();
    const deferred = await enqueued(queue, { url: "https://example.test/deferred", priority: "high" });
    advance(1);
    const other = await enqueued(queue, { url: "https://example.test/other" });

    // What a worker does with `RateLimited`: hold this one back, do not fail it.
    unwrap(await queue.defer(deferred.id, 45_000));

    // The high-priority job is first in line but not due, so the low one runs.
    expect(unwrap(await queue.claimNext("slot-1"))?.id).toBe(other.id);
    expect(unwrap(await queue.claimNext("slot-2"))).toBeNull();

    advance(45_000);
    expect(unwrap(await queue.claimNext("slot-2"))?.id).toBe(deferred.id);
  });

  test("a notBefore in the past does not hold anything back", async () => {
    const { queue } = await boot();
    const job = await enqueued(queue);
    unwrap(await queue.update(job.id, { notBefore: "2020-01-01T00:00:00.000Z" }));
    expect(unwrap(await queue.claimNext("slot-1"))?.id).toBe(job.id);
  });

  test("a deferral written through another connection is seen by the next claim", async () => {
    const one = await boot();
    const two = await boot();
    const job = await enqueued(one.queue, { priority: "high" });

    unwrap(await two.queue.defer(job.id, 60_000));

    // Two connections to the same file, so this also pins that nothing is being
    // answered out of a stale per-connection cache.
    expect(unwrap(await one.queue.claimNext("slot-1"))).toBeNull();
    advance(60_000);
    expect(unwrap(await one.queue.claimNext("slot-1"))?.id).toBe(job.id);
  });

  test("a backoff survives the service restarting", async () => {
    const first = await boot({ backoffMs: 90_000 });
    const job = await enqueued(first.queue);
    unwrap(await first.queue.update(job.id, { status: "failed" }));
    const retried = unwrap(await first.queue.retry(job.id));

    stop(first);

    // It is a column, not a timer, so nothing about it lived in the process.
    const second = await boot({ backoffMs: 90_000 });
    await second.queue.recoverOnStart();
    expect(unwrap(await second.queue.get(job.id)).notBefore).toBe(retried.notBefore);
    expect(unwrap(await second.queue.claimNext("slot-1"))).toBeNull();

    advance(90_000);
    expect(unwrap(await second.queue.claimNext("slot-1"))?.id).toBe(job.id);
  });
});

// --- reads -------------------------------------------------------------------

describe("get and list", () => {
  test("get returns NotFound for an unknown id", async () => {
    const { queue } = await boot();
    const result = await queue.get("nope");
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) expect(result.error._tag).toBe("NotFound");
  });

  test("list filters by status, pause and worker, in claim order", async () => {
    const { queue } = await boot();
    const low = await enqueued(queue, { url: "https://example.test/1", priority: "low" });
    advance(1);
    const high = await enqueued(queue, { url: "https://example.test/2", priority: "high" });
    advance(1);
    const paused = await enqueued(queue, { url: "https://example.test/3" });
    unwrap(await queue.pause(paused.id));

    expect((await queue.list()).map((j) => j.id)).toEqual([high.id, paused.id, low.id]);
    expect((await queue.list({ paused: true })).map((j) => j.id)).toEqual([paused.id]);

    unwrap(await queue.claimNext("slot-7"));
    expect((await queue.list({ claimedBy: "slot-7" })).map((j) => j.id)).toEqual([high.id]);
    expect((await queue.list({ status: ["analyzing", "downloading"] })).map((j) => j.id)).toEqual([
      high.id,
    ]);
    expect(await queue.list({ status: "done" })).toEqual([]);
    expect((await queue.list({ fingerprint: low.fingerprint })).map((j) => j.id)).toEqual([low.id]);
  });
});
