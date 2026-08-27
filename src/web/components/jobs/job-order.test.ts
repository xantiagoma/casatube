/**
 * The queue's ordering and filtering, checked.
 *
 * These are the only part of the two job screens a test can reach — there is no
 * DOM harness in this repo — which is exactly why the sort, the filters and the
 * file-state rule were written as pure functions instead of inline in the
 * components.
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_PREFERENCES, type Job, type JobStatus, type Priority } from "../../../core/types";
import type { JobFileState } from "../../data/queries";
import {
  directionLabel,
  fileStateOf,
  finishedIds,
  indexFileStates,
  matchesFile,
  missingCount,
  type ResolvedFileState,
} from "./job-order";

function job(over: Partial<Job> & { id: string }): Job {
  return {
    url: `https://example.com/${over.id}`,
    provider: "ytdlp",
    destination: "",
    title: null,
    status: "queued" as JobStatus,
    stages: [],
    priority: "normal" as Priority,
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
    plan: null,
    preferences: DEFAULT_PREFERENCES,
    fingerprint: `fp-${over.id}`,
    log: [],
    error: null,
    outputFile: null,
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
    ...over,
  } as Job;
}

const ids = (jobs: readonly Job[]): string[] => jobs.map((one) => one.id);

/**
 * ⚠️ `sortJobs`, `matchesStatus` and `matchesText` were tested here and are
 * gone. They sorted and filtered the page the server had already sent; the
 * database does it now, and the rules they encoded — unknown values sinking,
 * equal keys breaking on newest-first, the lifecycle order of statuses — are
 * asserted against real SQL in `src/core/queue.test.ts`. Deleting these tests
 * with the code they covered is the point: a suite that still passed over
 * unused functions would report coverage of behaviour nothing runs.
 */

describe("the file's fate", () => {
  const done = job({ id: "done", status: "done", outputFile: "/library/Videos/A.mp4" });
  const present: JobFileState = { id: "done", state: "present", path: "Videos/A.mp4", size: 10 };

  test("a row is given the answer that carries its own id", () => {
    const index = indexFileStates([
      { id: "other", state: "missing" },
      present,
      { id: "third", state: "trashed" },
    ]);
    expect(fileStateOf(done, index).state).toBe("present");
    expect(fileStateOf(done, index).size).toBe(10);
  });

  test("🔴 a job the check has no answer for is `not-checked`, never `missing`", () => {
    const index = indexFileStates([{ id: "someone-else", state: "missing" }]);
    const state = fileStateOf(done, index);
    expect(state.state).toBe("unknown");
    expect(state.reason).toBe("not-checked");
  });

  test("🔴 no check at all is `not-checked` — the badge draws nothing, not a verdict", () => {
    const state = fileStateOf(done, indexFileStates(undefined));
    expect(state.state).toBe("unknown");
    expect(state.reason).toBe("not-checked");
  });

  test("the server's reason and sentence survive the trip to the row", () => {
    const index = indexFileStates([
      { id: "done", state: "unknown", reason: "library-empty", detail: "the library root /library is empty" },
    ]);
    const state = fileStateOf(done, index);
    expect(state.reason).toBe("library-empty");
    expect(state.detail).toContain("empty");
  });

  test("`any` keeps every state, including the unknown ones", () => {
    const states: ResolvedFileState[] = [
      { state: "present" },
      { state: "missing" },
      { state: "trashed" },
      { state: "none" },
      { state: "unknown", reason: "mount-unavailable" },
      { state: "unknown", reason: "not-finished" },
    ];
    for (const state of states) expect(matchesFile(state, "any")).toBe(true);
  });

  test("a named filter keeps exactly that state", () => {
    expect(matchesFile({ state: "missing" }, "missing")).toBe(true);
    expect(matchesFile({ state: "present" }, "missing")).toBe(false);
    expect(matchesFile({ state: "trashed" }, "trashed")).toBe(true);
    expect(matchesFile({ state: "none" }, "none")).toBe(true);
  });

  test("🔴 `Could not check` means the library, not every job still running", () => {
    expect(matchesFile({ state: "unknown", reason: "mount-unavailable" }, "unknown")).toBe(true);
    expect(matchesFile({ state: "unknown", reason: "timed-out" }, "unknown")).toBe(true);
    expect(matchesFile({ state: "unknown", reason: "trash-unreadable" }, "unknown")).toBe(true);
    // These two are "there is nothing to look at yet", which is not a fault and
    // would bury the handful of rows the filter exists to surface.
    expect(matchesFile({ state: "unknown", reason: "not-finished" }, "unknown")).toBe(false);
    expect(matchesFile({ state: "unknown", reason: "not-checked" }, "unknown")).toBe(false);
  });

  test("missingCount counts only what the server said is gone", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" }), job({ id: "d" })];
    const index = indexFileStates([
      { id: "a", state: "missing" },
      { id: "b", state: "present" },
      { id: "c", state: "missing" },
      { id: "d", state: "unknown", reason: "mount-unavailable" },
    ]);
    expect(missingCount(jobs, index)).toBe(2);
  });

  test("🔴 an unreadable library contributes nothing to the missing count", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const index = indexFileStates([
      { id: "a", state: "unknown", reason: "mount-unavailable" },
      { id: "b", state: "unknown", reason: "mount-unavailable" },
    ]);
    expect(missingCount(jobs, index)).toBe(0);
    expect(missingCount(jobs, indexFileStates(undefined))).toBe(0);
  });
});

describe("finishedIds", () => {
  test("only the finished jobs, in the order they were given", () => {
    const jobs = [
      job({ id: "a", status: "downloading" }),
      job({ id: "b", status: "done" }),
      job({ id: "c", status: "failed" }),
      job({ id: "d", status: "done" }),
    ];
    expect(finishedIds(jobs)).toEqual(["b", "d"]);
  });

  test("nothing finished is an empty list, which is what disables the query", () => {
    expect(finishedIds([job({ id: "a", status: "queued" })])).toEqual([]);
  });
});
