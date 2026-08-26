/**
 * The sources endpoints, over real HTTP shapes.
 *
 * Against a real database file and the real queue, with only the discoverer
 * faked: the interesting claims are all about what ends up in the two tables,
 * and a mocked manager would have tested the mock. Nothing here touches the
 * network — a "channel listing" is a variable the test sets.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { appDbPath, closeDb, openDb, queueDbPath, type Db } from "../core/db";
import { openJobQueue, shutdownEmbeddedQueue, type JobQueue } from "../core/queue";
import { Blocked } from "../core/errors";
import { SourceManager, type Discoverer } from "../core/sources";
import { SourceScheduler } from "../core/scheduler";
import { sources } from "../core/schema";
import type { DiscoveredItem, Source } from "../core/types";
import { sourceRoutes } from "./sources";

let dir: string;
let db: Db;
let queue: JobQueue;
let manager: SourceManager;
let scheduler: SourceScheduler;
/**
 * Only what the tests use. Annotating this as `Elysia` would fix the prefix at
 * `""` and reject the mounted `/api` instance — the route type is the routes,
 * not the class.
 */
let app: { handle(request: Request): Promise<Response> };

let listing: DiscoveredItem[] = [];
let listingError: Blocked | null = null;
/** When set, discovery parks here until the test lets it go. */
let gate: { promise: Promise<void>; open: () => void } | null = null;

const discover: Discoverer = async () => {
  if (gate) await gate.promise;
  if (listingError) return Result.err(listingError);
  return Result.ok(listing);
};

function holdDiscovery(): () => void {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  gate = { promise, open };
  return () => {
    gate = null;
    open();
  };
}

function item(n: number): DiscoveredItem {
  return { externalId: `v${n}`, url: `https://example.test/watch?v=${n}`, title: `Video ${n}` };
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://local/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "casatube-api-sources-"));
  listing = [];
  listingError = null;
  gate = null;
  db = openDb({ path: appDbPath(dir) });
  queue = await openJobQueue({ db, queueDbPath: queueDbPath(dir) });
  manager = new SourceManager({ db, queue, discover, itemSpacingMs: 0 });
  // Never started: a ticking scheduler would make the tables move underneath
  // the assertions.
  scheduler = new SourceScheduler({ manager });
  app = new Elysia({ prefix: "/api" }).use(sourceRoutes({ sources: manager, scheduler, config: { libraryDir: dir } }));
});

afterEach(() => {
  queue.close();
  closeDb(db);
  shutdownEmbeddedQueue();
  rmSync(dir, { recursive: true, force: true });
});

// --- POST /api/sources ------------------------------------------------------

describe("POST /api/sources", () => {
  test("🔴 subscribing to a channel queues nothing from its past", async () => {
    listing = Array.from({ length: 40 }, (_, i) => item(i));

    const response = await request("POST", "/sources", {
      url: "https://example.test/@channel",
      destination: "youtube/talks",
    });

    expect(response.status).toBe(200);
    const body = await json<{ source: Source; discovered: number; seeded: number; enqueued: unknown[] }>(response);
    expect(body.discovered).toBe(40);
    expect(body.seeded).toBe(40);
    expect(body.enqueued).toEqual([]);
    expect(body.source.destination).toBe("youtube/talks");
    expect(body.source.intervalMinutes).toBe(360);
    expect(await queue.list({ limit: 100 })).toHaveLength(0);
  });

  test("includeExisting queues the newest few, and nothing above the ceiling is even accepted", async () => {
    listing = Array.from({ length: 20 }, (_, i) => item(i));

    const ok = await request("POST", "/sources", {
      url: "https://example.test/@a",
      destination: "",
      includeExisting: { limit: 2 },
    });
    expect(ok.status).toBe(200);
    expect((await json<{ enqueued: unknown[] }>(ok)).enqueued).toHaveLength(2);

    // 🔴 The cap is a bound, not a suggestion: 500 does not validate.
    const absurd = await request("POST", "/sources", {
      url: "https://example.test/@b",
      destination: "",
      includeExisting: { limit: 500 },
    });
    expect(absurd.status).toBe(422);

    // And there is no way to spell "all of it": the field is an object whose
    // only member is the cap.
    const boolean = await request("POST", "/sources", {
      url: "https://example.test/@c",
      destination: "",
      includeExisting: true,
    });
    expect(boolean.status).toBe(422);
  });

  test("an interval under the floor is refused rather than quietly accepted", async () => {
    const response = await request("POST", "/sources", {
      url: "https://example.test/@a",
      destination: "",
      intervalMinutes: 5,
    });
    expect(response.status).toBe(422);
  });

  test("a destination that escapes the library is refused", async () => {
    const response = await request("POST", "/sources", {
      url: "https://example.test/@a",
      destination: "../etc",
    });
    expect(response.status).toBe(400);
    expect((await json<{ tag: string }>(response)).tag).toBe("PathOutsideRoot");
  });

  test("⚠️ a listing failure creates no source", async () => {
    listingError = new Blocked({ url: "https://example.test/@a", detail: "bot check" });

    const response = await request("POST", "/sources", { url: "https://example.test/@a", destination: "" });

    expect(response.status).toBe(502);
    expect((await json<{ tag: string }>(response)).tag).toBe("Blocked");
    expect((await json<{ sources: Source[] }>(await request("GET", "/sources"))).sources).toEqual([]);
  });
});

// --- reading, editing, removing ---------------------------------------------

describe("GET/PATCH/DELETE /api/sources", () => {
  async function create(): Promise<Source> {
    listing = [item(1), item(2)];
    const response = await request("POST", "/sources", { url: "https://example.test/@a", destination: "" });
    return (await json<{ source: Source }>(response)).source;
  }

  test("lists what is subscribed", async () => {
    const created = await create();
    const body = await json<{ sources: Source[] }>(await request("GET", "/sources"));
    expect(body.sources.map((s) => s.id)).toEqual([created.id]);
  });

  test("one source comes with how much it has already accounted for", async () => {
    const created = await create();
    const body = await json<{ source: Source; seen: number }>(await request("GET", `/sources/${created.id}`));
    expect(body.seen).toBe(2);
  });

  test("an unknown id is 404 everywhere", async () => {
    expect((await request("GET", "/sources/nope")).status).toBe(404);
    expect((await request("PATCH", "/sources/nope", { enabled: false })).status).toBe(404);
    expect((await request("DELETE", "/sources/nope")).status).toBe(404);
    expect((await request("POST", "/sources/nope/check", {})).status).toBe(404);
  });

  test("a patch changes only what it names", async () => {
    const created = await create();
    const response = await request("PATCH", `/sources/${created.id}`, { enabled: false, name: "Talks" });
    expect(response.status).toBe(200);

    const updated = await json<Source>(response);
    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe("Talks");
    expect(updated.destination).toBe(created.destination);
    expect(updated.intervalMinutes).toBe(created.intervalMinutes);
  });

  test("deleting forgets the source and its history", async () => {
    const created = await create();
    expect((await request("DELETE", `/sources/${created.id}`)).status).toBe(200);
    expect((await json<{ sources: Source[] }>(await request("GET", "/sources"))).sources).toEqual([]);
    expect(await manager.seenCount(created.id)).toBe(0);
  });
});

// --- POST /api/sources/:id/check --------------------------------------------

describe("POST /api/sources/:id/check", () => {
  test("🔴 forcing a check twice queues the new item once", async () => {
    listing = [item(1)];
    const created = (
      await json<{ source: Source }>(
        await request("POST", "/sources", { url: "https://example.test/@a", destination: "" }),
      )
    ).source;

    listing = [item(2), item(1)];
    const first = await json<{ fresh: number; enqueued: unknown[] }>(
      await request("POST", `/sources/${created.id}/check`, {}),
    );
    const second = await json<{ fresh: number; enqueued: unknown[] }>(
      await request("POST", `/sources/${created.id}/check`, {}),
    );

    expect(first.enqueued).toHaveLength(1);
    expect(second.fresh).toBe(0);
    expect(second.enqueued).toEqual([]);
    expect(await queue.list()).toHaveLength(1);
  });

  test("checks a disabled source, because that is what the button is for", async () => {
    listing = [];
    const created = (
      await json<{ source: Source }>(
        await request("POST", "/sources", { url: "https://example.test/@a", destination: "", enabled: false }),
      )
    ).source;

    listing = [item(1)];
    const body = await json<{ skipped?: string; enqueued: unknown[] }>(
      await request("POST", `/sources/${created.id}/check`, {}),
    );
    expect(body.skipped).toBeUndefined();
    expect(body.enqueued).toHaveLength(1);

    // …and `force: false` is still respectable.
    listing = [item(1), item(2)];
    const polite = await json<{ skipped?: string }>(
      await request("POST", `/sources/${created.id}/check`, { force: false }),
    );
    expect(polite.skipped).toBe("disabled");
  });
});

// --- GET /api/scheduler -----------------------------------------------------

describe("the scheduler endpoint", () => {
  test("reports its state and when it next looks", async () => {
    listing = [];
    await request("POST", "/sources", { url: "https://example.test/@a", destination: "" });

    const idle = await json<{ running: boolean; nextPassAt: string | null; sources: number; dueNow: number }>(
      await request("GET", "/scheduler"),
    );
    expect(idle.running).toBe(false);
    expect(idle.nextPassAt).toBeNull();
    expect(idle.sources).toBe(1);
    expect(idle.dueNow).toBe(0);

    scheduler.start();
    const started = await json<{ running: boolean; nextPassAt: string | null }>(await request("GET", "/scheduler"));
    expect(started.running).toBe(true);
    expect(started.nextPassAt).not.toBeNull();
    scheduler.stop();
  });

  test("🔴 asking for a pass while one is running is refused, not run alongside", async () => {
    listing = [];
    const created = (
      await json<{ source: Source }>(
        await request("POST", "/sources", { url: "https://example.test/@a", destination: "", intervalMinutes: 60 }),
      )
    ).source;
    // Make it due without waiting an hour. `add` recorded the listing it just
    // performed, which is exactly what normally keeps a fresh source quiet.
    await db.update(sources).set({ lastCheckedAt: null }).where(eq(sources.id, created.id));

    listing = [item(1)];
    const release = holdDiscovery();
    const held = scheduler.runPass();
    expect(held).not.toBeNull();
    await Bun.sleep(5);
    expect(scheduler.isRunning()).toBe(true);

    const response = await request("POST", "/scheduler/run");
    expect(response.status).toBe(409);
    expect((await json<{ tag: string }>(response)).tag).toBe("SchedulerBusy");

    release();
    await held;
    expect(scheduler.isRunning()).toBe(false);
    // One pass ran, so the one new item was queued once.
    expect(await queue.list()).toHaveLength(1);
  });
});
