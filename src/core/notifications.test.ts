/**
 * Notifications, against a **real database file**.
 *
 * The claim being tested is a persistence claim — "a notification you missed
 * because the tab was closed is still there" — so the store is opened on a real
 * file and, in one test, closed and reopened. `:memory:` would make that test a
 * tautology.
 *
 * The clock is injected throughout. Ordering unread-first and ageing rows out
 * are both time-dependent, and a test that waited for real milliseconds to pass
 * would be slow *and* flaky.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { closeDb, openDb, type Db } from "./db";
import { createJobNotifier, describeRetention, NotificationStore } from "./notifications";
import { DEFAULT_PREFERENCES, type Job } from "./types";

let dir: string;
let db: Db;
let clock: Date;

const now = () => clock;

function at(iso: string): void {
  clock = new Date(iso);
}

function storeFor(database: Db = db): NotificationStore {
  return new NotificationStore({ db: database, now });
}

const JOB: Job = {
  id: "job-1",
  url: "https://example.test/watch?v=abc",
  provider: "yt-dlp",
  destination: "talks",
  title: "A talk about nothing",
  status: "done",
  stages: [],
  priority: "normal",
  attempts: 1,
  maxAttempts: 3,
  paused: false,
  claimedBy: null,
  leaseUntil: null,
  notBefore: null,
  progress: 100,
  totalBytes: 1_000,
  doneBytes: 1_000,
  speed: null,
  eta: null,
  thumbnail: null,
  duration: 610,
  source: "youtube",
  plan: null,
  preferences: DEFAULT_PREFERENCES,
  fingerprint: "fp-1",
  log: [],
  error: null,
  outputFile: "/library/talks/A talk about nothing.mkv",
  createdAt: "2026-08-26T10:00:00.000Z",
  updatedAt: "2026-08-26T10:10:00.000Z",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-notifications-"));
  db = openDb({ path: join(dir, "casatube.db") });
  at("2026-08-26T12:00:00.000Z");
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("create", () => {
  test("writes a row with the level, the moment, and no read mark", async () => {
    const store = storeFor();
    const written = await store.create({ level: "warning", title: "Library is asleep", body: "NFS" });

    expect(written.level).toBe("warning");
    expect(written.title).toBe("Library is asleep");
    expect(written.body).toBe("NFS");
    expect(written.readAt).toBeNull();
    expect(written.createdAt).toBe("2026-08-26T12:00:00.000Z");
    expect(written.jobId).toBeNull();
  });

  test("defaults to info", async () => {
    expect((await storeFor().create({ title: "Nothing much" })).level).toBe("info");
  });

  test("🔴 survives the process that wrote it", async () => {
    await storeFor().create({ title: "Failed overnight", level: "error" });
    // The tab was closed, the service restarted, and the machine forgot
    // everything it held in memory.
    closeDb(db);

    db = openDb({ path: join(dir, "casatube.db") });
    const found = await storeFor().list();
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe("Failed overnight");
    expect(found[0]?.readAt).toBeNull();
  });
});

describe("list", () => {
  test("🔴 unread first, then newest first", async () => {
    const store = storeFor();
    at("2026-08-26T09:00:00.000Z");
    const oldUnread = await store.create({ title: "old unread" });
    at("2026-08-26T10:00:00.000Z");
    const read = await store.create({ title: "read" });
    at("2026-08-26T11:00:00.000Z");
    const newUnread = await store.create({ title: "new unread" });

    at("2026-08-26T12:00:00.000Z");
    await store.markRead(read.id);

    // The read one is the *newest of the three* by nothing — it is the middle
    // one — and it still sorts last, because unread comes first whatever the
    // clock says.
    expect((await store.list()).map((n) => n.id)).toEqual([newUnread.id, oldUnread.id, read.id]);
  });

  test("two written in the same millisecond keep the order they happened", async () => {
    const store = storeFor();
    const first = await store.create({ title: "first" });
    const second = await store.create({ title: "second" });
    expect(first.createdAt).toBe(second.createdAt);
    // v7 ids are time-ordered, so the tiebreak is creation order, not chance.
    expect((await store.list()).map((n) => n.title)).toEqual(["second", "first"]);
  });

  test("filters to unread, and to a level", async () => {
    const store = storeFor();
    const one = await store.create({ title: "one", level: "error" });
    await store.create({ title: "two", level: "info" });
    await store.markRead(one.id);

    expect((await store.list({ unreadOnly: true })).map((n) => n.title)).toEqual(["two"]);
    expect((await store.list({ level: "error" })).map((n) => n.title)).toEqual(["one"]);
  });

  test("pages, and refuses to be asked for the whole table", async () => {
    const store = storeFor();
    for (let i = 0; i < 5; i += 1) {
      at(`2026-08-26T1${i}:00:00.000Z`);
      await store.create({ title: `n${i}` });
    }

    expect((await store.list({ limit: 2 })).map((n) => n.title)).toEqual(["n4", "n3"]);
    expect((await store.list({ limit: 2, offset: 2 })).map((n) => n.title)).toEqual(["n2", "n1"]);
    // 10,000 is not a page size; it is a way of asking for everything.
    expect(await store.list({ limit: 10_000 })).toHaveLength(5);
  });

  test("an empty table is an empty list, not an error", async () => {
    expect(await storeFor().list()).toEqual([]);
  });
});

describe("markRead", () => {
  test("stamps the moment it was read", async () => {
    const store = storeFor();
    const written = await store.create({ title: "one" });

    at("2026-08-26T13:00:00.000Z");
    const marked = await store.markRead(written.id);

    expect(Result.isOk(marked)).toBe(true);
    expect(Result.isOk(marked) && marked.value.readAt).toBe("2026-08-26T13:00:00.000Z");
    expect(await store.unreadCount()).toBe(0);
  });

  test("reading it twice does not move the moment it was read", async () => {
    const store = storeFor();
    const written = await store.create({ title: "one" });
    at("2026-08-26T13:00:00.000Z");
    await store.markRead(written.id);

    at("2026-08-26T18:00:00.000Z");
    const again = await store.markRead(written.id);
    expect(Result.isOk(again) && again.value.readAt).toBe("2026-08-26T13:00:00.000Z");
  });

  test("an id that does not exist is a NotFound, not a silent success", async () => {
    const marked = await storeFor().markRead("nope");
    expect(Result.isError(marked)).toBe(true);
    expect(Result.isError(marked) && marked.error._tag).toBe("NotFound");
  });
});

describe("markAllRead", () => {
  test("reports how many actually changed", async () => {
    const store = storeFor();
    const one = await store.create({ title: "one" });
    await store.create({ title: "two" });
    await store.create({ title: "three" });
    await store.markRead(one.id);

    expect(await store.markAllRead()).toBe(2);
    // Nothing left to change, so the honest answer is zero — not three.
    expect(await store.markAllRead()).toBe(0);
    expect(await store.unreadCount()).toBe(0);
  });
});

describe("unreadCount", () => {
  test("counts the table, not the page", async () => {
    const store = storeFor();
    for (let i = 0; i < 12; i += 1) await store.create({ title: `n${i}` });
    expect(await store.list({ limit: 5 })).toHaveLength(5);
    expect(await store.unreadCount()).toBe(12);
  });
});

describe("purge", () => {
  test("🔴 spares the unread ones by default", async () => {
    const store = storeFor();
    at("2026-08-01T00:00:00.000Z");
    const oldRead = await store.create({ title: "old and read" });
    const oldUnread = await store.create({ title: "old and unread" });
    at("2026-08-26T00:00:00.000Z");
    await store.markRead(oldRead.id);

    const deleted = await store.purge({ before: new Date("2026-08-10T00:00:00.000Z") });

    expect(deleted).toBe(1);
    // The one nobody has seen is the only one still doing a job.
    expect((await store.list()).map((n) => n.id)).toEqual([oldUnread.id]);
  });

  test("includes the unread ones when asked explicitly", async () => {
    const store = storeFor();
    at("2026-08-01T00:00:00.000Z");
    await store.create({ title: "old and unread" });

    expect(
      await store.purge({ before: new Date("2026-08-10T00:00:00.000Z"), onlyRead: false }),
    ).toBe(1);
    expect(await store.list()).toEqual([]);
  });

  test("the cutoff is strict, and newer notifications are untouched", async () => {
    const store = storeFor();
    at("2026-08-10T00:00:00.000Z");
    const exactly = await store.create({ title: "exactly on the cutoff" });
    at("2026-08-11T00:00:00.000Z");
    const after = await store.create({ title: "after" });
    await store.markAllRead();

    expect(await store.purge({ before: new Date("2026-08-10T00:00:00.000Z") })).toBe(0);
    expect((await store.list()).map((n) => n.id).sort()).toEqual([exactly.id, after.id].sort());
  });
});

describe("enforceRetention", () => {
  /** `n` notifications, one per day, oldest first. */
  async function seed(store: NotificationStore, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let day = 1; day <= n; day++) {
      at(`2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`);
      ids.push((await store.create({ title: `day ${day}` })).id);
    }
    return ids;
  }

  test("the age rule removes read notifications and only those", async () => {
    const store = storeFor();
    at("2026-07-01T00:00:00.000Z");
    const oldRead = await store.create({ title: "old and read" });
    const oldUnread = await store.create({ title: "old and unread" });
    at("2026-08-27T00:00:00.000Z");
    await store.markRead(oldRead.id);
    const recent = await store.create({ title: "recent" });
    await store.markRead(recent.id);

    const outcome = await store.enforceRetention({ retentionDays: 30, maxEntries: 0 });

    expect(outcome).toEqual({ byAge: 1, byCap: 0, unreadDropped: 0 });
    expect((await store.list()).map((n) => n.id).sort()).toEqual([oldUnread.id, recent.id].sort());
  });

  test("🔴 the ceiling is what actually bounds the table, because age spares unread", async () => {
    // The failure this exists for: a bell nobody opens. Every row is unread, so
    // the age rule can never remove one and the table grows for ever.
    const store = storeFor();
    await seed(store, 10);
    at("2027-01-01T00:00:00.000Z");

    expect(await store.enforceRetention({ retentionDays: 30, maxEntries: 0 })).toEqual({
      byAge: 0,
      byCap: 0,
      unreadDropped: 0,
    });
    expect(await store.list()).toHaveLength(10);

    const outcome = await store.enforceRetention({ retentionDays: 30, maxEntries: 4 });
    expect(outcome).toEqual({ byAge: 0, byCap: 6, unreadDropped: 6 });
    expect(await store.list()).toHaveLength(4);
  });

  test("🔴 read notifications are spent before any unread one is touched", async () => {
    const store = storeFor();
    const ids = await seed(store, 6);
    // The two *newest* are read; the four oldest were never seen.
    await store.markRead(ids[4]!);
    await store.markRead(ids[5]!);
    at("2026-09-01T00:00:00.000Z");

    // Keeping "the newest four" would drop two unread warnings and keep two
    // notifications already seen and acted on. It keeps the unread ones.
    const outcome = await store.enforceRetention({ retentionDays: 0, maxEntries: 4 });

    expect(outcome).toEqual({ byAge: 0, byCap: 2, unreadDropped: 0 });
    expect((await store.list()).map((n) => n.id).sort()).toEqual(
      [ids[0]!, ids[1]!, ids[2]!, ids[3]!].sort(),
    );
  });

  test("under the ceiling nothing is removed, and 0 means no ceiling at all", async () => {
    const store = storeFor();
    await seed(store, 3);
    at("2026-09-01T00:00:00.000Z");

    expect(await store.enforceRetention({ retentionDays: 0, maxEntries: 3 })).toEqual({
      byAge: 0,
      byCap: 0,
      unreadDropped: 0,
    });
    expect(await store.enforceRetention({ retentionDays: 0, maxEntries: 0 })).toEqual({
      byAge: 0,
      byCap: 0,
      unreadDropped: 0,
    });
    expect(await store.list()).toHaveLength(3);
  });

  test("retentionDays 0 disables the age rule rather than meaning 'now'", async () => {
    // 0 is "keep them for ever" on the Settings screen. Read as a cutoff it
    // would mean "everything older than this instant" — the whole table.
    const store = storeFor();
    await seed(store, 3);
    await store.markAllRead();
    at("2027-01-01T00:00:00.000Z");

    expect(await store.enforceRetention({ retentionDays: 0, maxEntries: 0 })).toEqual({
      byAge: 0,
      byCap: 0,
      unreadDropped: 0,
    });
    expect(await store.list()).toHaveLength(3);
  });

  test("a sweep bigger than one DELETE's worth of parameters still completes", async () => {
    // The chunking is not an optimisation: the first sweep after this shipped
    // can have thousands of rows to remove, and SQLite has a bound-parameter
    // ceiling.
    const store = storeFor();
    at("2026-08-01T00:00:00.000Z");
    for (let i = 0; i < 1_200; i++) await store.create({ title: `n${i}` });
    at("2026-09-01T00:00:00.000Z");

    const outcome = await store.enforceRetention({ retentionDays: 0, maxEntries: 10 });

    expect(outcome.byCap).toBe(1_190);
    expect(await store.unreadCount()).toBe(10);
  });
});

describe("describeRetention", () => {
  test("says nothing when nothing went", () => {
    expect(describeRetention({ byAge: 0, byCap: 0, unreadDropped: 0 })).toBeUndefined();
  });

  test("🔴 an unread notification dropped by the cap is named, not counted silently", () => {
    const line = describeRetention({ byAge: 4, byCap: 9, unreadDropped: 2 });
    expect(line).toContain("4 read past retention");
    expect(line).toContain("9 over the cap");
    expect(line).toContain("2 of them never read");
  });

  test("no unread loss means no alarming clause", () => {
    expect(describeRetention({ byAge: 0, byCap: 3, unreadDropped: 0 })).toBe("removed 3 over the cap");
  });
});

describe("createJobNotifier", () => {
  test("a finished job says where the file went", async () => {
    const store = storeFor();
    await createJobNotifier(store).completed(JOB);

    const written = (await store.list())[0];
    expect(written?.level).toBe("success");
    expect(written?.title).toBe("Downloaded A talk about nothing");
    // The next question after "it finished" is always "where did it go".
    expect(written?.body).toBe("/library/talks/A talk about nothing.mkv");
    expect(written?.jobId).toBe("job-1");
  });

  test("a failed job carries the reason, and an untitled one carries its URL", async () => {
    const store = storeFor();
    await createJobNotifier(store).failed({ ...JOB, title: null, error: "HTTP 403" });

    const written = (await store.list())[0];
    expect(written?.level).toBe("error");
    expect(written?.title).toBe("Failed: https://example.test/watch?v=abc");
    expect(written?.body).toBe("HTTP 403");
  });

  test("a library that went away is a warning: nothing is lost yet", async () => {
    const store = storeFor();
    await createJobNotifier(store).waitingForDestination(JOB);

    const written = (await store.list())[0];
    expect(written?.level).toBe("warning");
    expect(written?.body).toContain("temp directory");
  });

  test("🔴 a notification that cannot be written does not fail the job it reports on", async () => {
    const store = storeFor();
    const failures: unknown[] = [];
    const notifier = createJobNotifier(store, (cause) => failures.push(cause));

    // The bluntest way to make the write fail: take the database away.
    closeDb(db);
    await notifier.completed(JOB);
    // Reopened so `afterEach` has something to close.
    db = openDb({ path: join(dir, "casatube.db") });

    expect(failures).toHaveLength(1);
  });
});
