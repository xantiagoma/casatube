/**
 * The two forms of one rule, checked against each other.
 *
 * `bucketOf` classifies a job in hand; `bucketCondition` classifies rows we
 * have not fetched. Nothing in TypeScript makes them agree, and a disagreement
 * would be close to invisible on screen — a tab whose count came from one and
 * whose rows came from the other.
 *
 * So this does not test either one against a list of expected answers. It runs
 * a corpus through **both** and asserts they produce the same partition, which
 * is the only property that actually matters.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { appDbPath, closeDb, openDb, queueDbPath, type Db } from "./db";
import { JOB_BUCKETS, bucketOf, type JobBucket } from "./job-buckets";
import { bucketCondition } from "./job-buckets-query";
import { openJobQueue, shutdownEmbeddedQueue, type JobQueue } from "./queue";
import type { Job } from "./types";

let dir: string;
let db: Db;
let queue: JobQueue;
let clock: Date;

const NOW = "2026-08-27T12:00:00.000Z";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "casatube-buckets-"));
  clock = new Date(NOW);
  db = openDb({ path: appDbPath(dir) });
  queue = await openJobQueue({ db, queueDbPath: queueDbPath(dir), now: () => clock });
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

/**
 * Every shape a job can be in that the rule cares about — including the two
 * that are easy to forget: a backoff that has already elapsed, and a paused job
 * that is otherwise perfectly runnable.
 */
async function corpus(): Promise<Job[]> {
  const made: Job[] = [];
  const add = async (url: string, mutate?: (id: string) => Promise<void>): Promise<void> => {
    const { job } = unwrap(await queue.enqueue({ url, provider: "test", destination: "Videos" }));
    if (mutate) await mutate(job.id);
    made.push(unwrap(await queue.get(job.id)));
  };

  await add("https://example.test/queued");
  await add("https://example.test/done", async (id) => void unwrap(await queue.update(id, { status: "done" })));
  await add("https://example.test/failed", async (id) => void unwrap(await queue.update(id, { status: "failed" })));
  await add("https://example.test/cancelled", async (id) => void unwrap(await queue.cancel(id)));
  await add("https://example.test/paused", async (id) => void unwrap(await queue.pause(id)));
  await add("https://example.test/downloading", async (id) => {
    unwrap(await queue.claimNext("slot-1"));
    unwrap(await queue.update(id, { status: "downloading" }));
  });
  // Backoff still running: scheduled, not stuck.
  await add("https://example.test/backing-off", async (id) => {
    unwrap(await queue.update(id, { notBefore: "2026-08-27T18:00:00.000Z" }));
  });
  // Backoff already elapsed: active again, and the row still carries the column.
  await add("https://example.test/backoff-over", async (id) => {
    unwrap(await queue.update(id, { notBefore: "2026-08-27T06:00:00.000Z" }));
  });
  // A terminal job that also carries a future notBefore — the case where the
  // order of the checks decides the answer.
  await add("https://example.test/failed-with-backoff", async (id) => {
    unwrap(await queue.update(id, { notBefore: "2026-08-27T18:00:00.000Z", status: "failed" }));
  });
  return made;
}

describe("the split between the two halves", () => {
  test("🔴 the pure half imports nothing that would reach bun:sqlite", async () => {
    // The failure this guards: a value imported from a schema-importing module
    // drags bun:sqlite into the client bundle. It type-checks, then the bundle
    // fails to build and every route answers 200 with a blank page. The
    // Downloads screen imports `job-buckets.ts`, so its import graph is part of
    // the contract rather than a detail.
    const source = await Bun.file(new URL("./job-buckets.ts", import.meta.url)).text();
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["./types"]);
    // And the SQL half is genuinely a different module, not a re-export.
    expect(typeof bucketCondition).toBe("function");
  });
});

describe("bucketOf and bucketCondition", () => {
  test("🔴 the SQL and the predicate partition the same corpus the same way", async () => {
    const jobs = await corpus();
    const now = Date.parse(NOW);

    for (const bucket of JOB_BUCKETS) {
      const fromSql = (await queue.list({ bucket, limit: 500 })).map((job) => job.id).sort();
      const fromPredicate = jobs
        .filter((job) => bucketOf(job, now) === bucket)
        .map((job) => job.id)
        .sort();
      expect(fromSql).toEqual(fromPredicate);
    }
  });

  test("every job lands in exactly one bucket, and none is lost", async () => {
    const jobs = await corpus();
    const seen = new Map<string, JobBucket[]>();
    for (const bucket of JOB_BUCKETS) {
      for (const job of await queue.list({ bucket, limit: 500 })) {
        seen.set(job.id, [...(seen.get(job.id) ?? []), bucket]);
      }
    }
    expect(seen.size).toBe(jobs.length);
    for (const [id, buckets] of seen) expect([id, buckets.length]).toEqual([id, 1]);
  });

  test("the corpus is not accidentally trivial — every bucket has a member", async () => {
    // A corpus that never produced a `scheduled` row would make the agreement
    // test pass by comparing two empty lists. This is the check on the check.
    await corpus();
    for (const bucket of JOB_BUCKETS) {
      expect(await queue.count({ bucket })).toBeGreaterThan(0);
    }
  });

  test("a paused job is scheduled, and a lapsed backoff is active again", async () => {
    await corpus();
    const scheduled = (await queue.list({ bucket: "scheduled", limit: 500 })).map((job) => job.url);
    expect(scheduled).toContain("https://example.test/paused");
    expect(scheduled).toContain("https://example.test/backing-off");
    expect(scheduled).not.toContain("https://example.test/backoff-over");
    // Terminal beats a future backoff: a failed job is failed, not scheduled.
    expect(scheduled).not.toContain("https://example.test/failed-with-backoff");
  });
});
