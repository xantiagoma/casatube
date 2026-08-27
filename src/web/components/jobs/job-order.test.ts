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
  matchesStatus,
  matchesText,
  missingCount,
  sortJobs,
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

describe("sortJobs", () => {
  const older = job({ id: "older", createdAt: "2026-08-27T09:00:00.000Z" });
  const newer = job({ id: "newer", createdAt: "2026-08-27T11:00:00.000Z" });
  const middle = job({ id: "middle", createdAt: "2026-08-27T10:00:00.000Z" });

  test("newest first is what `date` + `desc` means — the default the screens use", () => {
    expect(ids(sortJobs([older, middle, newer], "date", "desc"))).toEqual(["newer", "middle", "older"]);
  });

  test("and the other direction really is the other direction", () => {
    expect(ids(sortJobs([older, middle, newer], "date", "asc"))).toEqual(["older", "middle", "newer"]);
  });

  test("it does not touch the array it was given — the cache owns that one", () => {
    const input = [older, newer];
    sortJobs(input, "date", "desc");
    expect(ids(input)).toEqual(["older", "newer"]);
  });

  test("priority ascending puts High at the top, which is what the label promises", () => {
    const high = job({ id: "high", priority: "high" });
    const low = job({ id: "low", priority: "low" });
    const normal = job({ id: "normal", priority: "normal" });
    expect(ids(sortJobs([low, normal, high], "priority", "asc"))).toEqual(["high", "normal", "low"]);
    expect(directionLabel("priority", "asc")).toBe("Highest first");
  });

  test("status ascending brings the busy rows together at the top", () => {
    const done = job({ id: "done", status: "done" });
    const downloading = job({ id: "downloading", status: "downloading" });
    const queued = job({ id: "queued", status: "queued" });
    const failed = job({ id: "failed", status: "failed" });
    expect(ids(sortJobs([done, failed, queued, downloading], "status", "asc"))).toEqual([
      "downloading",
      "queued",
      "done",
      "failed",
    ]);
  });

  test("size sorts by bytes, not by the string", () => {
    const big = job({ id: "big", totalBytes: 9_000_000_000 });
    const small = job({ id: "small", totalBytes: 900 });
    const mid = job({ id: "mid", totalBytes: 50_000_000 });
    expect(ids(sortJobs([small, big, mid], "size", "desc"))).toEqual(["big", "mid", "small"]);
  });

  test("🔴 unknown sizes sink in BOTH directions", () => {
    const known = job({ id: "known", totalBytes: 100 });
    const bigger = job({ id: "bigger", totalBytes: 200 });
    const unknown = job({ id: "unknown", totalBytes: null });
    expect(ids(sortJobs([unknown, known, bigger], "size", "desc"))).toEqual(["bigger", "known", "unknown"]);
    // Flipping the direction must not promote "we don't know" to the top.
    expect(ids(sortJobs([unknown, known, bigger], "size", "asc"))).toEqual(["known", "bigger", "unknown"]);
  });

  test("the same, for a duration nobody has measured yet", () => {
    const long = job({ id: "long", duration: 4000 });
    const short = job({ id: "short", duration: 40 });
    const none = job({ id: "none", duration: null });
    expect(ids(sortJobs([none, short, long], "duration", "desc"))).toEqual(["long", "short", "none"]);
    expect(ids(sortJobs([none, short, long], "duration", "asc"))).toEqual(["short", "long", "none"]);
  });

  test("ties break the same way every time, so an SSE frame cannot shuffle the rows", () => {
    const at = "2026-08-27T10:00:00.000Z";
    const a = job({ id: "aaa", priority: "normal", createdAt: at });
    const b = job({ id: "bbb", priority: "normal", createdAt: at });
    const c = job({ id: "ccc", priority: "normal", createdAt: at });
    const first = ids(sortJobs([c, a, b], "priority", "desc"));
    const second = ids(sortJobs([b, c, a], "priority", "desc"));
    expect(first).toEqual(second);
    expect(first).toEqual(["aaa", "bbb", "ccc"]);
  });

  test("a timestamp the server could not have written does not throw the order out", () => {
    const broken = job({ id: "broken", createdAt: "not a date" });
    const fine = job({ id: "fine", createdAt: "2026-08-27T10:00:00.000Z" });
    expect(ids(sortJobs([broken, fine], "date", "desc"))).toEqual(["fine", "broken"]);
    expect(ids(sortJobs([broken, fine], "date", "asc"))).toEqual(["fine", "broken"]);
  });
});

describe("matchesStatus", () => {
  test("`waiting` counts a job serving a retry backoff — it has not run yet", () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const backing_off = job({ id: "backoff", status: "queued", notBefore: soon });
    expect(matchesStatus(backing_off, "waiting")).toBe(true);
    expect(matchesStatus(backing_off, "running")).toBe(false);
  });

  test("`failed` covers cancelled, because both are rows that stopped", () => {
    expect(matchesStatus(job({ id: "x", status: "cancelled" }), "failed")).toBe(true);
    expect(matchesStatus(job({ id: "y", status: "failed" }), "failed")).toBe(true);
    expect(matchesStatus(job({ id: "z", status: "done" }), "failed")).toBe(false);
  });

  test("`all` really means all", () => {
    for (const status of ["queued", "downloading", "done", "failed", "cancelled"] as JobStatus[]) {
      expect(matchesStatus(job({ id: status, status }), "all")).toBe(true);
    }
  });
});

describe("matchesText", () => {
  const one = job({
    id: "one",
    title: "Me at the zoo",
    url: "https://youtube.com/watch?v=jNQXAC9IVRw",
    destination: "Videos/Family",
    outputFile: "/library/Videos/Family/Me at the zoo.mp4",
  });

  test("an empty needle keeps everything", () => {
    expect(matchesText(one, "")).toBe(true);
    expect(matchesText(one, "   ")).toBe(true);
  });

  test("title, URL, destination and the name on disk are all searchable", () => {
    expect(matchesText(one, "ZOO")).toBe(true);
    expect(matchesText(one, "jNQXAC9")).toBe(true);
    expect(matchesText(one, "family")).toBe(true);
    expect(matchesText(one, ".mp4")).toBe(true);
    expect(matchesText(one, "kittens")).toBe(false);
  });

  test("a job with no title is still findable by its URL", () => {
    const untitled = job({ id: "untitled", url: "https://vimeo.com/850123456" });
    expect(matchesText(untitled, "vimeo")).toBe(true);
  });
});

/**
 * 🔴 What is left to test here is what the *browser* decides, which is now only
 * two things: that a row with no answer is never treated as an answer, and what
 * each filter means. The verdict itself moved to the server — `POST
 * /api/jobs/file-state` — and is tested against a real disk in
 * `core/file-state.test.ts`, which is the only place it can be tested honestly.
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
