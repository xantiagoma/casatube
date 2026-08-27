/**
 * The queue's ordering and filtering, checked.
 *
 * These are the only part of the two job screens a test can reach — there is no
 * DOM harness in this repo — which is exactly why the sort, the filters and the
 * file-state rule were written as pure functions instead of inline in the
 * components.
 */
import { describe, expect, test } from "bun:test";

import type { TrashEntry } from "../../../core/library";
import { DEFAULT_PREFERENCES, type Job, type JobStatus, type Priority } from "../../../core/types";
import {
  directionLabel,
  fileStateOf,
  indexTrash,
  isTrashed,
  matchesFile,
  matchesStatus,
  matchesText,
  sortJobs,
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

describe("the file's fate", () => {
  const entry = (path: string): TrashEntry => ({
    id: `t-${path}`,
    deletedAt: "2026-08-27T12:00:00.000Z",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    files: [],
    size: 0,
  });

  test("a finished job whose file is in the trash says so", () => {
    const index = indexTrash([entry("Videos/Family/Me at the zoo.mp4")]);
    const done = job({
      id: "done",
      status: "done",
      destination: "Videos/Family",
      outputFile: "/library/Videos/Family/Me at the zoo.mp4",
    });
    expect(isTrashed(done, index)).toBe(true);
    expect(fileStateOf(done, index)).toBe("trashed");
  });

  test("a finished job whose file is not in the trash is `filed`", () => {
    const index = indexTrash([entry("Videos/Something else.mp4")]);
    const done = job({
      id: "done",
      status: "done",
      destination: "Videos",
      outputFile: "/library/Videos/Me at the zoo.mp4",
    });
    expect(fileStateOf(done, index)).toBe("filed");
  });

  test("🔴 a name at the library root does not match the same name in a folder", () => {
    // `endsWith("/Foo.mp4")` would say yes here, and it would be wrong: the
    // trashed file is the one in the root, the job's is the one in Videos/.
    const index = indexTrash([entry("Foo.mp4")]);
    const done = job({ id: "done", status: "done", destination: "Videos", outputFile: "/library/Videos/Foo.mp4" });
    expect(isTrashed(done, index)).toBe(false);
  });

  test("a file that did not land under its declared destination is still recognised", () => {
    const index = indexTrash([entry("Music/Track.m4a")]);
    const done = job({ id: "done", status: "done", destination: "Videos", outputFile: "/library/Music/Track.m4a" });
    expect(isTrashed(done, index)).toBe(true);
  });

  test("`.` and a trailing slash name the same folder as `''`", () => {
    const index = indexTrash([entry("Clip.mp4")]);
    const rooted = job({ id: "rooted", status: "done", destination: ".", outputFile: "/library/Clip.mp4" });
    expect(isTrashed(rooted, index)).toBe(true);
  });

  test("finished with no output path recorded is its own state", () => {
    const done = job({ id: "done", status: "done", outputFile: null });
    expect(fileStateOf(done, indexTrash([]))).toBe("none");
  });

  test("🔴 nothing is claimed about a job that has not finished", () => {
    const running = job({ id: "running", status: "downloading", outputFile: "/library/partial.mp4" });
    expect(fileStateOf(running, indexTrash([]))).toBe("unknown");
  });

  test("🔴 nothing is claimed when the trash could not be read", () => {
    const done = job({ id: "done", status: "done", outputFile: "/library/Videos/A.mp4" });
    // `filed` here would be a guess: the file may be sitting in the trash and
    // this build simply cannot see it.
    expect(fileStateOf(done, null)).toBe("unknown");
  });

  test("`any` keeps every state, including the unknown one", () => {
    for (const state of ["filed", "trashed", "none", "unknown"] as const) {
      expect(matchesFile(state, "any")).toBe(true);
    }
    expect(matchesFile("filed", "trashed")).toBe(false);
    expect(matchesFile("trashed", "trashed")).toBe(true);
  });
});
