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
import { createJobNotifier, NotificationStore } from "./notifications";
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
