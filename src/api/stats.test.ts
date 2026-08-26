/**
 * `/api/stats/*`, over HTTP.
 *
 * Storage is tested against the **real filesystem**, as `destinations.test.ts`
 * is and for the same reason: the endpoint's whole job is what the disk says,
 * and a stubbed `statfs` at this level would only prove that the stub was
 * called. The unreachable case is a path that is genuinely not there — the
 * *hanging* mount, which cannot be produced on a working machine, is covered by
 * `core/stats.test.ts` with an injected `statfs` that never answers.
 *
 * Analytics is tested against a real database file with seeded rows, so the
 * numbers on the wire are the numbers a browser would draw.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, openDb, type Db } from "../core/db";
import { jobs } from "../core/schema";
import type { Analytics } from "../core/stats";
import { DEFAULT_PREFERENCES, type JobStatus } from "../core/types";
import { loadConfig } from "./config";
import { statsRoutes, type DiskPayload } from "./stats";

let dir: string;
let db: Db;

function makeApp(overrides: { libraryDir?: string; tempDir?: string } = {}) {
  const config = {
    ...loadConfig({}),
    libraryDir: overrides.libraryDir ?? join(dir, "library"),
    tempDir: overrides.tempDir ?? join(dir, "tmp"),
  };
  return new Elysia({ prefix: "/api" }).use(statsRoutes({ db, config }));
}

async function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return app.handle(new Request(`http://local${path}`));
}

async function seed(rows: { id: string; status?: JobStatus; doneBytes?: number; minutesAgo: number }[]): Promise<void> {
  for (const row of rows) {
    const when = new Date(Date.now() - row.minutesAgo * 60_000).toISOString();
    await db.insert(jobs).values({
      id: row.id,
      url: `https://example.test/watch?v=${row.id}`,
      destination: "talks",
      status: row.status ?? "done",
      stages: [],
      doneBytes: row.doneBytes ?? null,
      source: "youtube",
      outputFile: `/library/talks/${row.id}.mkv`,
      preferences: DEFAULT_PREFERENCES,
      fingerprint: `fp-${row.id}`,
      createdAt: when,
      updatedAt: when,
    });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-api-stats-"));
  db = openDb({ path: join(dir, "casatube.db") });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/stats/storage", () => {
  test("reports both filesystems in bytes", async () => {
    // Both paths exist here: `dir` itself stands in for library and temp.
    const app = makeApp({ libraryDir: dir, tempDir: dir });
    const response = await get(app, "/api/stats/storage");
    expect(response.status).toBe(200);

    const body = (await response.json()) as { library: DiskPayload; temp: DiskPayload; at: string };
    expect(body.library.available).toBe(true);
    if (!body.library.available) return;
    expect(body.library.path).toBe(dir);
    expect(body.library.totalBytes).toBeGreaterThan(0);
    expect(body.library.freeBytes).toBeGreaterThanOrEqual(0);
    expect(body.library.usedPercent).toBeLessThanOrEqual(100);
    expect(body.temp.available).toBe(true);
    expect(typeof body.at).toBe("string");
  });

  test("🔴 an unreachable library is reported inside a 200, and does not take the temp disk with it", async () => {
    const app = makeApp({ libraryDir: join(dir, "no-such-mount"), tempDir: dir });
    const response = await get(app, "/api/stats/storage");

    // 200 on purpose: half the answer is real, and the Storage screen shows it.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { library: DiskPayload; temp: DiskPayload };

    expect(body.library.available).toBe(false);
    if (body.library.available) return;
    // The same tagged shape every other endpoint fails with, so the client has
    // one branch rather than a special case for this screen.
    expect(body.library.error.tag).toBe("MountUnavailable");
    expect(body.library.error.retryable).toBe(true);
    expect(body.library.error.message).toContain("library is unreachable");

    expect(body.temp.available).toBe(true);
  });
});

describe("GET /api/stats/analytics", () => {
  test("the default window is 24 hourly buckets", async () => {
    const app = makeApp();
    const response = await get(app, "/api/stats/analytics");
    expect(response.status).toBe(200);

    const body = (await response.json()) as Analytics;
    expect(body.range).toBe("24h");
    expect(body.series).toHaveLength(24);
    expect(body.jobs).toBe(0);
    expect(body.truncated).toBe(false);
  });

  test("counts what is in the window", async () => {
    await seed([
      { id: "a", minutesAgo: 30, doneBytes: 1_000_000 },
      { id: "b", minutesAgo: 90, doneBytes: 3_000_000 },
      { id: "c", minutesAgo: 120, status: "failed" },
      // Six days back: outside 24h, inside 7d.
      { id: "d", minutesAgo: 6 * 24 * 60, doneBytes: 5_000_000 },
    ]);
    const app = makeApp();

    const day = (await (await get(app, "/api/stats/analytics")).json()) as Analytics;
    expect(day.jobs).toBe(3);
    expect(day.completed).toBe(2);
    expect(day.failed).toBe(1);
    expect(day.bytes).toBe(4_000_000);
    // 2 of 3 finished jobs succeeded.
    expect(day.successRate).toBeCloseTo(0.6667, 3);
    expect(day.topSources).toEqual([{ source: "youtube", jobs: 3, completed: 2, failed: 1, bytes: 4_000_000 }]);
    expect(day.byType).toEqual([{ key: "video", jobs: 2, bytes: 4_000_000 }]);
    expect(day.byDestination).toEqual([{ key: "talks", jobs: 2, bytes: 4_000_000 }]);

    const week = (await (await get(app, "/api/stats/analytics?range=7d")).json()) as Analytics;
    expect(week.range).toBe("7d");
    expect(week.series).toHaveLength(7);
    expect(week.jobs).toBe(4);
    expect(week.bytes).toBe(9_000_000);
  });

  test("30d is a month of daily buckets", async () => {
    const body = (await (await get(makeApp(), "/api/stats/analytics?range=30d")).json()) as Analytics;
    expect(body.range).toBe("30d");
    expect(body.series).toHaveLength(30);
  });

  test("🔴 a range nobody offers is refused rather than turned into a table scan", async () => {
    expect((await get(makeApp(), "/api/stats/analytics?range=5y")).status).toBe(422);
  });

  test("an absent range is not silently some other range", async () => {
    // `t.UnionEnum` carries a default that Elysia applies to missing query
    // parameters; this asserts the endpoint answers for the window it says it
    // does, which is the part that would break silently.
    const body = (await (await get(makeApp(), "/api/stats/analytics")).json()) as Analytics;
    const spanMs = Date.parse(body.until) - Date.parse(body.since);
    // 24 hourly buckets, the last one partial: between 23 and 24 hours wide.
    expect(spanMs).toBeGreaterThan(23 * 3_600_000);
    expect(spanMs).toBeLessThanOrEqual(24 * 3_600_000);
  });
});
