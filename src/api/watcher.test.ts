/**
 * The live snapshot — which rows it carries, and which it must never drop.
 *
 * The stream's other properties (heartbeats, one poller for many subscribers,
 * the first frame being a whole snapshot) are exercised through the HTTP suite.
 * What is here is the choice of *rows*, because that choice was wrong in a way
 * nothing could see: the snapshot was the queue's own page, so past its cap the
 * live table showed the oldest jobs and a download started today was simply
 * absent from it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { appDbPath, closeDb, openDb, queueDbPath, type Db } from "../core/db";
import { openJobQueue, shutdownEmbeddedQueue, type JobQueue } from "../core/queue";
import { ACTIVE_STATUSES, ALL_STATUSES, TERMINAL_STATUSES, type JobStatus } from "../core/types";
import { createQueueWatcher } from "./watcher";

let dir: string;
let db: Db;
let queue: JobQueue;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "casatube-watcher-"));
  db = openDb({ path: appDbPath(dir) });
  queue = await openJobQueue({ db, queueDbPath: queueDbPath(dir) });
});

afterEach(() => {
  queue.close();
  closeDb(db);
  shutdownEmbeddedQueue();
  rmSync(dir, { recursive: true, force: true });
});

function unwrap<A, E>(result: Result<A, E>): A {
  if (Result.isError(result)) throw new Error(`expected Ok: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function enqueue(url: string): Promise<string> {
  const result = unwrap(await queue.enqueue({ url, provider: "test", destination: "Videos" }));
  return result.job.id;
}

/** Move a job to a terminal status the way the worker would. */
async function finish(id: string, status: JobStatus): Promise<void> {
  unwrap(await queue.update(id, { status }));
}

describe("the snapshot's rows", () => {
  test("🔴 a job added past the cap is in the live view; the oldest are what fall off", async () => {
    // The bug: `queue.list({ limit })` is priority-then-oldest, so with more
    // jobs than the cap the snapshot was the oldest ones and the newest
    // download never appeared on the Queue screen at all.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await enqueue(`https://example.test/v${i}`));
    for (const id of ids.slice(0, 10)) await finish(id, "done");
    const newest = await enqueue("https://example.test/just-now");

    const watcher = createQueueWatcher(queue, { limit: 5 });
    const snapshot = await watcher.current();
    watcher.stop();

    const shown = snapshot.jobs.map((job) => job.id);
    expect(shown).toContain(newest);
    // The two still queued from before, plus the newest: everything unfinished.
    expect(shown.slice(0, 3).sort()).toEqual([ids[10]!, ids[11]!, newest].sort());
    expect(shown).toHaveLength(5);
  });

  test("🔴 a failed job is not pushed off the end by newer completed ones", async () => {
    // A single query ordered by status rank would do exactly that: `done`
    // ranks above `failed`, so a long history of successes would bury the rows
    // somebody actually needs to see.
    const failed = await enqueue("https://example.test/broken");
    await finish(failed, "failed");
    for (let i = 0; i < 10; i++) await finish(await enqueue(`https://example.test/ok${i}`), "done");

    const watcher = createQueueWatcher(queue, { limit: 20 });
    const snapshot = await watcher.current();
    watcher.stop();

    expect(snapshot.jobs.map((job) => job.id)).toContain(failed);
  });

  test("history is newest first, so the cap drops the oldest", async () => {
    const older = await enqueue("https://example.test/older");
    await finish(older, "done");
    const newer = await enqueue("https://example.test/newer");
    await finish(newer, "done");

    const watcher = createQueueWatcher(queue, { limit: 1 });
    const snapshot = await watcher.current();
    watcher.stop();

    expect(snapshot.jobs.map((job) => job.id)).toEqual([newer]);
  });

  test("unfinished work takes the whole page when there is that much of it", async () => {
    for (let i = 0; i < 6; i++) await enqueue(`https://example.test/q${i}`);
    const watcher = createQueueWatcher(queue, { limit: 3 });
    const snapshot = await watcher.current();
    watcher.stop();

    expect(snapshot.jobs).toHaveLength(3);
    expect(snapshot.jobs.every((job) => job.status === "queued")).toBe(true);
  });
});

describe("the two lists of statuses", () => {
  test("🔴 every status is either unfinished or terminal — a forgotten one is an invisible job", () => {
    // The snapshot is the union of two queries. A status in neither would be a
    // job that exists, may be running, and never appears in the live table.
    const unfinished: readonly JobStatus[] = [...ACTIVE_STATUSES, "queued", "waiting-for-destination"];
    const covered = [...unfinished, ...TERMINAL_STATUSES].sort();
    expect(covered).toEqual([...ALL_STATUSES].sort());
    expect(new Set(covered).size).toBe(ALL_STATUSES.length);
  });
});
