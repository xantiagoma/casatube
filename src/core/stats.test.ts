/**
 * Storage and analytics, against a **real database file** and a fake disk.
 *
 * Two different kinds of honesty are needed here, and they pull in opposite
 * directions:
 *
 * - The analytics half runs against a real SQLite file with seeded rows, and
 *   every expected number is one that can be checked by hand — 3 done and 1
 *   failed is a success rate of 0.75, and three files of 1, 2 and 3 MB are
 *   6 MB. An assertion that recomputed the implementation's own arithmetic
 *   would pass whatever the implementation did.
 *
 * - The storage half runs against an **injected** `statfs`, because the
 *   interesting cases cannot be produced on a working machine: a mount that
 *   hangs for ever, and a filesystem whose geometry is known exactly. One test
 *   at the end uses the real one, to prove the default binding is wired to
 *   something that answers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { closeDb, openDb, type Db } from "./db";
import { jobs } from "./schema";
import { DEFAULT_PREFERENCES, type JobStatus, type Stage } from "./types";
import {
  analytics,
  diskUsage,
  elapsedMs,
  mediaType,
  sourceLabel,
  storageStats,
  type FilesystemSize,
} from "./stats";

let dir: string;
let db: Db;

/** A believable disk: 4 KiB blocks, ~4 GB, 60% used. */
const DISK: FilesystemSize = { bsize: 4096, blocks: 1_000_000, bfree: 400_000, bavail: 300_000 };

/** Never answers. What a sleeping NAS looks like from here. */
const hangs = () => new Promise<FilesystemSize>(() => {});

interface SeedJob {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status?: JobStatus;
  doneBytes?: number | null;
  totalBytes?: number | null;
  source?: string | null;
  url?: string;
  destination?: string;
  outputFile?: string | null;
  stages?: Stage[];
}

async function seed(rows: SeedJob[]): Promise<void> {
  for (const row of rows) {
    await db.insert(jobs).values({
      id: row.id,
      url: row.url ?? `https://example.test/watch?v=${row.id}`,
      destination: row.destination ?? "talks",
      status: row.status ?? "done",
      stages: row.stages ?? [],
      doneBytes: row.doneBytes ?? null,
      totalBytes: row.totalBytes ?? null,
      source: row.source ?? null,
      outputFile: row.outputFile ?? null,
      preferences: DEFAULT_PREFERENCES,
      fingerprint: `fp-${row.id}`,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt ?? row.createdAt,
    });
  }
}

/** Fixed so every bucket boundary in this file can be worked out on paper. */
const NOW = new Date("2026-08-26T12:30:00.000Z");
const now = () => NOW;

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-stats-"));
  // A file, not `:memory:` — the queries under test are the ones that will run
  // against a real database, indexes and all.
  db = openDb({ path: join(dir, "casatube.db") });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("diskUsage", () => {
  test("turns blocks into bytes, and does not pretend used + free is total", async () => {
    const usage = await diskUsage("/library", { statfs: async () => DISK });
    expect(Result.isOk(usage)).toBe(true);
    if (Result.isError(usage)) return;

    // 1,000,000 × 4096 = 4,096,000,000
    expect(usage.value.totalBytes).toBe(4_096_000_000);
    // (1,000,000 − 400,000) × 4096 = 2,457,600,000
    expect(usage.value.usedBytes).toBe(2_457_600_000);
    // bavail, not bfree: 300,000 × 4096 = 1,228,800,000
    expect(usage.value.freeBytes).toBe(1_228_800_000);
    // The 100,000 reserved blocks are free and not available, so the two do not add up.
    expect(usage.value.usedBytes + usage.value.freeBytes).not.toBe(usage.value.totalBytes);
    expect(usage.value.usedPercent).toBe(60);
  });

  test("an empty filesystem reports 0% rather than dividing by zero", async () => {
    const usage = await diskUsage("/empty", {
      statfs: async () => ({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }),
    });
    expect(Result.isOk(usage) && usage.value.usedPercent).toBe(0);
  });

  test("🔴 a mount that hangs gives up on the deadline instead of waiting for ever", async () => {
    const started = Date.now();
    const usage = await diskUsage("/library", { statfs: hangs, timeoutMs: 40 });

    expect(Result.isError(usage)).toBe(true);
    if (!Result.isError(usage)) return;
    expect(usage.error._tag).toBe("MountUnavailable");
    expect(usage.error.path).toBe("/library");
    expect(usage.error.detail).toContain("40 ms");
    // Generous, because the assertion is "it returned", not "it was fast".
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the event loop keeps running while a hung mount is being waited on", async () => {
    // The deadline would be worthless if the call blocked the loop: nothing
    // else could run, SSE included. A timer scheduled *after* the statfs must
    // still fire before the deadline does.
    const ticks: string[] = [];
    setTimeout(() => ticks.push("timer"), 10);

    const usage = await diskUsage("/library", { statfs: hangs, timeoutMs: 60 });
    ticks.push("deadline");

    expect(Result.isError(usage)).toBe(true);
    expect(ticks).toEqual(["timer", "deadline"]);
  });

  test("a path that is not there is a MountUnavailable with the reason in it", async () => {
    const usage = await diskUsage("/library", {
      statfs: async () => {
        throw new Error("ENOENT: no such file or directory, statfs '/library'");
      },
    });
    expect(Result.isError(usage) && usage.error._tag).toBe("MountUnavailable");
    expect(Result.isError(usage) && usage.error.detail).toContain("ENOENT");
  });
});

describe("storageStats", () => {
  test("🔴 a dead library does not hide a healthy temp disk", async () => {
    const stats = await storageStats({
      libraryDir: "/library",
      tempDir: "/data/tmp",
      timeoutMs: 40,
      now,
      statfs: async (path) => (path === "/library" ? hangs() : DISK),
    });

    expect(stats.library.available).toBe(false);
    if (stats.library.available) return;
    expect(stats.library.error._tag).toBe("MountUnavailable");
    expect(stats.library.path).toBe("/library");

    expect(stats.temp.available).toBe(true);
    if (!stats.temp.available) return;
    expect(stats.temp.usage.totalBytes).toBe(4_096_000_000);
    expect(stats.at).toBe(NOW.toISOString());
  });

  test("both paths are measured in parallel, not one after the other", async () => {
    // Two 40 ms deadlines in series would take 80. The margin is wide enough
    // that this is not a timing test in disguise.
    const started = Date.now();
    const stats = await storageStats({
      libraryDir: "/library",
      tempDir: "/tmp",
      timeoutMs: 40,
      statfs: hangs,
    });
    expect(Date.now() - started).toBeLessThan(70);
    expect(stats.library.available).toBe(false);
    expect(stats.temp.available).toBe(false);
  });

  test("the real statfs answers for a directory that exists", async () => {
    const stats = await storageStats({ libraryDir: dir, tempDir: dir });
    expect(stats.library.available).toBe(true);
    if (!stats.library.available) return;
    expect(stats.library.usage.totalBytes).toBeGreaterThan(0);
    expect(stats.library.usage.usedPercent).toBeGreaterThanOrEqual(0);
    expect(stats.library.usage.usedPercent).toBeLessThanOrEqual(100);
  });
});

describe("mediaType", () => {
  test("sorts what was written into video, audio and other", () => {
    expect(mediaType("/library/talks/A Talk.mkv")).toBe("video");
    expect(mediaType("/library/talks/A Talk.MP4")).toBe("video");
    expect(mediaType("/library/music/Song.m4a")).toBe("audio");
    expect(mediaType("/library/music/Song.opus")).toBe("audio");
    expect(mediaType("/library/notes.txt")).toBe("other");
    expect(mediaType("/library/no-extension")).toBe("other");
    // Nothing was written, so there is nothing to classify — not "other".
    expect(mediaType(null)).toBe("unknown");
  });
});

describe("sourceLabel", () => {
  test("prefers what the provider said, and falls back to the host", () => {
    expect(sourceLabel({ source: "youtube", url: "https://youtu.be/x" })).toBe("youtube");
    // A job that failed before `analyze` has no source, and "unknown" for every
    // failure would make the list useless exactly when it matters.
    expect(sourceLabel({ source: null, url: "https://vimeo.com/123" })).toBe("vimeo.com");
    expect(sourceLabel({ source: "", url: "https://vimeo.com/123" })).toBe("vimeo.com");
    expect(sourceLabel({ source: null, url: "not a url" })).toBe("unknown");
  });
});

describe("elapsedMs", () => {
  test("measures the stages, not the time spent queued behind other jobs", () => {
    const elapsed = elapsedMs({
      createdAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T12:00:00.000Z",
      stages: [
        { name: "validate", status: "done", startedAt: "2026-08-26T11:58:30.000Z", finishedAt: "2026-08-26T11:58:31.000Z" },
        { name: "download", status: "done", startedAt: "2026-08-26T11:58:31.000Z", finishedAt: "2026-08-26T12:00:00.000Z" },
      ],
    });
    // 11:58:30 → 12:00:00 is 90 s. The two hours it sat in the queue are not
    // time this download took.
    expect(elapsed).toBe(90_000);
  });

  test("falls back to the row's own timestamps when no stage ever ran", () => {
    expect(
      elapsedMs({
        createdAt: "2026-08-26T10:00:00.000Z",
        updatedAt: "2026-08-26T10:00:05.000Z",
        stages: [],
      }),
    ).toBe(5_000);
  });
});

describe("analytics", () => {
  test("counts the window, and every number can be checked by hand", async () => {
    await seed([
      { id: "a", createdAt: minutesBefore(30), doneBytes: 1_000_000 },
      { id: "b", createdAt: minutesBefore(60), doneBytes: 2_000_000 },
      { id: "c", createdAt: minutesBefore(90), doneBytes: 3_000_000 },
      { id: "d", createdAt: minutesBefore(120), status: "failed" },
      // Cancelled is neither a success nor a failure — the user changed their mind.
      { id: "e", createdAt: minutesBefore(150), status: "cancelled", doneBytes: 9_000_000 },
      { id: "f", createdAt: minutesBefore(10), status: "downloading", doneBytes: 500 },
    ]);

    const stats = await analytics({ db, range: "24h", now });

    expect(stats.jobs).toBe(6);
    expect(stats.completed).toBe(3);
    expect(stats.failed).toBe(1);
    expect(stats.cancelled).toBe(1);
    expect(stats.active).toBe(1);
    // 3 done out of 4 finished. The cancelled one is on neither side of it.
    expect(stats.successRate).toBe(0.75);
    // Only what finished counts: 1 + 2 + 3 MB. The cancelled job's 9 MB and the
    // half-finished job's 500 bytes are not downloads that happened.
    expect(stats.bytes).toBe(6_000_000);
    expect(stats.truncated).toBe(false);
    expect(stats.sampled).toBe(6);
    expect(stats.until).toBe(NOW.toISOString());
  });

  test("nothing finished is a 0 success rate, not a division by zero", async () => {
    await seed([{ id: "a", createdAt: minutesBefore(5), status: "queued" }]);
    const stats = await analytics({ db, range: "24h", now });
    expect(stats.successRate).toBe(0);
    expect(stats.active).toBe(1);
  });

  test("the window excludes what is older than it, and a wider range includes it", async () => {
    await seed([
      { id: "recent", createdAt: minutesBefore(60), doneBytes: 10 },
      // Three days ago: outside 24h, inside 7d.
      { id: "old", createdAt: minutesBefore(3 * 24 * 60), doneBytes: 20 },
    ]);

    const day = await analytics({ db, range: "24h", now });
    expect(day.jobs).toBe(1);
    expect(day.bytes).toBe(10);

    const week = await analytics({ db, range: "7d", now });
    expect(week.jobs).toBe(2);
    expect(week.bytes).toBe(30);
  });

  test("the series is 24 hourly buckets ending at the current hour", async () => {
    await seed([
      // 12:20 — the last bucket, the one `now` is in.
      { id: "late", createdAt: "2026-08-26T12:20:00.000Z", doneBytes: 5 },
      // 13:30 yesterday — the first bucket starts at 13:00 yesterday.
      { id: "early", createdAt: "2026-08-25T13:30:00.000Z", status: "failed" },
    ]);

    const stats = await analytics({ db, range: "24h", now });

    expect(stats.series).toHaveLength(24);
    expect(stats.since).toBe("2026-08-25T13:00:00.000Z");
    expect(stats.series[0]?.start).toBe("2026-08-25T13:00:00.000Z");
    expect(stats.series[23]?.start).toBe("2026-08-26T12:00:00.000Z");

    expect(stats.series[0]?.jobs).toBe(1);
    expect(stats.series[0]?.failed).toBe(1);
    expect(stats.series[23]?.jobs).toBe(1);
    expect(stats.series[23]?.completed).toBe(1);
    expect(stats.series[23]?.bytes).toBe(5);
    // Everything in between is a real zero, not a gap the chart has to guess at.
    expect(stats.series.slice(1, 23).every((bucket) => bucket.jobs === 0)).toBe(true);
  });

  test("7d and 30d are daily buckets, aligned to UTC midnight", async () => {
    const week = await analytics({ db, range: "7d", now });
    expect(week.series).toHaveLength(7);
    expect(week.since).toBe("2026-08-20T00:00:00.000Z");
    expect(week.series[6]?.start).toBe("2026-08-26T00:00:00.000Z");

    const month = await analytics({ db, range: "30d", now });
    expect(month.series).toHaveLength(30);
    expect(month.since).toBe("2026-07-28T00:00:00.000Z");
  });

  test("total time adds up the stages of the jobs that finished", async () => {
    await seed([
      {
        id: "a",
        createdAt: minutesBefore(30),
        stages: [
          { name: "download", status: "done", startedAt: "2026-08-26T12:00:00.000Z", finishedAt: "2026-08-26T12:01:00.000Z" },
        ],
      },
      {
        id: "b",
        createdAt: minutesBefore(40),
        stages: [
          { name: "download", status: "done", startedAt: "2026-08-26T11:00:00.000Z", finishedAt: "2026-08-26T11:00:30.000Z" },
        ],
      },
      // Failed, so its time is not "time spent downloading things I have".
      { id: "c", createdAt: minutesBefore(50), status: "failed", stages: [] },
    ]);

    const stats = await analytics({ db, range: "24h", now });
    expect(stats.totalMs).toBe(90_000);
  });

  test("the donut: by type and by subfolder, counted over what was written", async () => {
    await seed([
      { id: "a", createdAt: minutesBefore(10), destination: "talks", outputFile: "/library/talks/a.mkv", doneBytes: 100 },
      { id: "b", createdAt: minutesBefore(20), destination: "talks", outputFile: "/library/talks/b.mp4", doneBytes: 200 },
      { id: "c", createdAt: minutesBefore(30), destination: "music", outputFile: "/library/music/c.m4a", doneBytes: 50 },
      { id: "d", createdAt: minutesBefore(40), destination: "", outputFile: "/library/d.mkv", doneBytes: 10 },
      // Failed: no file, so it is in neither distribution.
      { id: "e", createdAt: minutesBefore(50), status: "failed", destination: "talks" },
    ]);

    const stats = await analytics({ db, range: "24h", now });

    expect(stats.byType).toEqual([
      { key: "video", jobs: 3, bytes: 310 },
      { key: "audio", jobs: 1, bytes: 50 },
    ]);
    expect(stats.byDestination).toEqual([
      { key: "talks", jobs: 2, bytes: 300 },
      { key: "music", jobs: 1, bytes: 50 },
      // The library root has a name, because a blank slice label is worse than a word.
      { key: "(root)", jobs: 1, bytes: 10 },
    ]);
  });

  test("top sources counts failures too, and keeps the list short", async () => {
    await seed([
      { id: "a", createdAt: minutesBefore(10), source: "youtube", doneBytes: 100 },
      { id: "b", createdAt: minutesBefore(20), source: "youtube", status: "failed" },
      { id: "c", createdAt: minutesBefore(30), source: "vimeo", doneBytes: 50 },
      { id: "d", createdAt: minutesBefore(40), source: null, url: "https://twitch.tv/x", status: "failed" },
    ]);

    const stats = await analytics({ db, range: "24h", now, topSources: 2 });

    expect(stats.topSources).toEqual([
      { source: "youtube", jobs: 2, completed: 1, failed: 1, bytes: 100 },
      { source: "vimeo", jobs: 1, completed: 1, failed: 0, bytes: 50 },
    ]);
    // twitch.tv is real and third; the cap is what left it out, not the data.
    expect(stats.topSources).toHaveLength(2);
  });

  test("a history bigger than the cap keeps the newest rows and says so", async () => {
    await seed([
      { id: "oldest", createdAt: minutesBefore(180), doneBytes: 1 },
      { id: "middle", createdAt: minutesBefore(120), doneBytes: 2 },
      { id: "newest", createdAt: minutesBefore(60), doneBytes: 4 },
    ]);

    const stats = await analytics({ db, range: "24h", now, maxRows: 2 });

    expect(stats.truncated).toBe(true);
    expect(stats.sampled).toBe(2);
    // 2 + 4: the two most recent. Truncation drops the oldest, never a random half.
    expect(stats.bytes).toBe(6);
  });

  test("an empty history is zeros and a full series, not an error", async () => {
    const stats = await analytics({ db, range: "24h", now });
    expect(stats.jobs).toBe(0);
    expect(stats.bytes).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.byType).toEqual([]);
    expect(stats.topSources).toEqual([]);
    expect(stats.series).toHaveLength(24);
  });

  test("reads only: the job rows are exactly as they were left", async () => {
    await seed([{ id: "a", createdAt: minutesBefore(30), doneBytes: 7, status: "done" }]);
    const before = await db.select().from(jobs);

    await analytics({ db, range: "24h", now });
    await analytics({ db, range: "30d", now });

    expect(await db.select().from(jobs)).toEqual(before);
  });
});
