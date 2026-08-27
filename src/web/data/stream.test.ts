/**
 * What the stream does to the sorted pages — the part with no screen to look at.
 *
 * The stream stopped being the only source of job rows when the server took
 * over sorting: the screens hold a *page* the database chose, and the stream
 * still has to keep it moving. Two behaviours carry that, and they pull in
 * opposite directions — patch rows constantly, refetch almost never — so both
 * are tested here rather than left to be noticed as "the progress bar is stuck"
 * or "the table refetches twice a second".
 */
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { DEFAULT_PREFERENCES, type Job } from "../../core/types";
import { keys } from "./keys";
import { applyToPages, membershipOf } from "./stream";
import type { JobPage, QueueSnapshot } from "./queries";

function job(over: Partial<Job> & { id: string }): Job {
  return {
    url: `https://example.test/${over.id}`,
    provider: "yt-dlp",
    destination: "Videos",
    title: over.id,
    status: "downloading",
    stages: [],
    priority: "normal",
    attempts: 0,
    maxAttempts: 3,
    paused: false,
    claimedBy: null,
    leaseUntil: null,
    notBefore: null,
    progress: 0,
    totalBytes: null,
    doneBytes: null,
    speed: null,
    eta: null,
    thumbnail: null,
    duration: null,
    source: null,
    error: null,
    plan: null,
    preferences: DEFAULT_PREFERENCES,
    outputFile: null,
    fingerprint: `fp-${over.id}`,
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
    ...over,
  } as Job;
}

const PAGE_KEY = keys.jobList({ sort: "date" });

function pageOf(jobs: Job[]): JobPage {
  return {
    at: "2026-08-27T10:00:00.000Z",
    jobs,
    total: jobs.length,
    counts: {
      byStatus: {
        queued: 0, analyzing: 0, downloading: jobs.length, processing: 0, moving: 0,
        "waiting-for-destination": 0, done: 0, failed: 0, cancelled: 0,
      },
      byBucket: { active: jobs.length, completed: 0, failed: 0, scheduled: 0 },
    },
    limit: 200,
    offset: 0,
  };
}

function clientWith(jobs: Job[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData<JobPage>(PAGE_KEY, pageOf(jobs));
  return client;
}

const snapshotOf = (jobs: Job[]): QueueSnapshot => ({ at: "2026-08-27T10:00:01.000Z", jobs });

describe("membershipOf", () => {
  test("🔴 a moving progress bar is not a membership change", () => {
    // If it were, every frame would refetch the sorted page — twice a second,
    // for a page the server would return unchanged.
    const before = snapshotOf([job({ id: "a", progress: 10, doneBytes: 100, speed: 5, eta: 30 })]);
    const after = snapshotOf([job({ id: "a", progress: 90, doneBytes: 900, speed: 7, eta: 3 })]);
    expect(membershipOf(after)).toBe(membershipOf(before));
  });

  test("everything a filter or a sort could care about is a membership change", () => {
    const base = job({ id: "a" });
    const changes: Partial<Job>[] = [
      { status: "done" },
      { paused: true },
      { notBefore: "2026-08-27T18:00:00.000Z" },
      { priority: "high" },
      { totalBytes: 1_000 },
      { duration: 60 },
    ];
    for (const change of changes) {
      expect(membershipOf(snapshotOf([{ ...base, ...change } as Job]))).not.toBe(
        membershipOf(snapshotOf([base])),
      );
    }
    // And a job appearing or disappearing, which is the obvious half.
    expect(membershipOf(snapshotOf([base, job({ id: "b" })]))).not.toBe(membershipOf(snapshotOf([base])));
    expect(membershipOf(snapshotOf([]))).not.toBe(membershipOf(snapshotOf([base])));
  });
});

describe("applyToPages", () => {
  test("patches a held page's rows in place, keeping its order and its counts", async () => {
    const client = clientWith([job({ id: "a", progress: 10 }), job({ id: "b", progress: 20 })]);
    const membership = membershipOf(snapshotOf([job({ id: "a", progress: 10 })]));

    applyToPages(client, snapshotOf([job({ id: "b", progress: 80 }), job({ id: "a", progress: 40 })]), membership);

    const page = client.getQueryData<JobPage>(PAGE_KEY)!;
    // The stream's order is the live queue's, not this page's. Patching must
    // not reorder a page the database sorted.
    expect(page.jobs.map((row) => row.id)).toEqual(["a", "b"]);
    expect(page.jobs.map((row) => row.progress)).toEqual([40, 80]);
    expect(page.total).toBe(2);
  });

  test("🔴 a job the page does not hold is not inserted into it", async () => {
    // The snapshot is the live queue's own window, not this screen's filtered
    // page. Adding a row here would put it somewhere the sort did not choose.
    const client = clientWith([job({ id: "a" })]);
    applyToPages(client, snapshotOf([job({ id: "a" }), job({ id: "z" })]), null);

    expect(client.getQueryData<JobPage>(PAGE_KEY)!.jobs.map((row) => row.id)).toEqual(["a"]);
  });

  test("returns the new membership, and only a change invalidates", async () => {
    const client = clientWith([job({ id: "a", progress: 10 })]);
    let invalidated = 0;
    const original = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((...args: Parameters<typeof original>) => {
      invalidated += 1;
      return original(...args);
    }) as typeof client.invalidateQueries;

    const first = applyToPages(client, snapshotOf([job({ id: "a", progress: 10 })]), null);
    // The first frame has nothing to compare against: invalidating on it would
    // refetch the page every time the stream reconnects.
    expect(invalidated).toBe(0);

    const second = applyToPages(client, snapshotOf([job({ id: "a", progress: 55 })]), first);
    expect(second).toBe(first);
    expect(invalidated).toBe(0);

    applyToPages(client, snapshotOf([job({ id: "a", status: "done" })]), second);
    expect(invalidated).toBe(1);
  });

  test("a page that has not loaded yet is left alone, not created", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    applyToPages(client, snapshotOf([job({ id: "a" })]), null);
    expect(client.getQueryData<JobPage>(PAGE_KEY)).toBeUndefined();
  });
});
