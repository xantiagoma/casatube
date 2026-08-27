/**
 * The retention sweeper.
 *
 * The store's own rules are tested in `notifications.test.ts`; what is left
 * here is the timer's promises — that the policy is read *again* on every pass,
 * that two sweeps cannot run at once, and that a sweep which failed does not
 * take the process with it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, openDb, type Db } from "./db";
import { NotificationRetention, policyFromSettings } from "./notification-retention";
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_RETENTION_DAYS,
  NotificationStore,
  type RetentionPolicy,
} from "./notifications";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-retention-"));
  db = openDb({ path: join(dir, "casatube.db") });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

async function seed(store: NotificationStore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await store.create({ title: `n${i}` });
}

/** Waits for a condition, or gives up — never a bare sleep of hope. */
async function until(predicate: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("NotificationRetention", () => {
  test("🔴 the policy is read on every pass, not captured at construction", async () => {
    // The failure this prevents: the Settings form saves a live value, says so,
    // and nothing changes until the next restart.
    const store = new NotificationStore({ db });
    await seed(store, 10);

    let policy: RetentionPolicy = { retentionDays: 0, maxEntries: 0 };
    const retention = new NotificationRetention({ store, policy: async () => policy });

    expect((await retention.sweep())?.byCap).toBe(0);
    policy = { retentionDays: 0, maxEntries: 4 };
    expect((await retention.sweep())?.byCap).toBe(6);
    expect(await store.list()).toHaveLength(4);
  });

  test("a sweep already in flight refuses a second rather than doubling it", async () => {
    const store = new NotificationStore({ db });
    await seed(store, 10);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retention = new NotificationRetention({
      store,
      policy: async () => {
        await gate;
        return { retentionDays: 0, maxEntries: 4 };
      },
    });

    const first = retention.sweep();
    // Both passes would compute an excess of 6 from the same COUNT and between
    // them delete twelve rows out of ten.
    expect(retention.sweep()).toBeNull();
    release();
    expect((await first)?.byCap).toBe(6);
    expect(retention.sweep()).not.toBeNull();
  });

  test("logs only when something was removed", async () => {
    const store = new NotificationStore({ db });
    await seed(store, 3);
    const lines: string[] = [];
    const retention = new NotificationRetention({
      store,
      policy: async () => ({ retentionDays: 0, maxEntries: 3 }),
      log: (line) => lines.push(line),
    });

    await retention.sweep();
    expect(lines).toEqual([]);
  });

  test("the timer sweeps, and stop() ends it", async () => {
    const store = new NotificationStore({ db });
    await seed(store, 10);
    const lines: string[] = [];
    const retention = new NotificationRetention({
      store,
      policy: async () => ({ retentionDays: 0, maxEntries: 4 }),
      sweepMs: 5,
      log: (line) => lines.push(line),
    });

    retention.start();
    retention.start(); // idempotent: a second call must not give a second timer
    await until(() => lines.length > 0);
    expect(lines[0]).toContain("notifications removed 6 over the cap");
    expect(await store.list()).toHaveLength(4);

    retention.stop();
    await retention.drain();
    expect(retention.isStarted()).toBe(false);
    const after = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lines).toHaveLength(after);
  });

  test("🔴 a failing sweep is reported and the timer keeps its appointment", async () => {
    // A broom that throws must not stop the server, and must not stop sweeping.
    const store = new NotificationStore({ db });
    const errors: unknown[] = [];
    let calls = 0;
    const retention = new NotificationRetention({
      store,
      policy: async () => {
        calls++;
        throw new Error("settings unavailable");
      },
      sweepMs: 5,
      onError: (error) => errors.push(error),
    });

    retention.start();
    await until(() => calls >= 2);
    retention.stop();
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toBe("settings unavailable");
  });
});

test("🔴 openDb refuses a bare path, because bun test would not have noticed", () => {
  // How this test exists: `openDb(join(dir, "casatube.db"))` is a type error,
  // `bun test` transpiles without type-checking, and the string's `.path` is
  // undefined — so the fallback opened ./data/casatube.db and the sweep deleted
  // rows out of the development database. The guard is the only thing standing
  // between a typo in a test and the real table.
  // @ts-expect-error — the mistake this guards against, on purpose.
  expect(() => openDb(join(dir, "casatube.db"))).toThrow(/options object/);
});

describe("policyFromSettings", () => {
  test("takes the stored numbers", async () => {
    const stored: Record<string, unknown> = {
      "notifications.retentionDays": 7,
      "notifications.maxEntries": 100,
    };
    expect(await policyFromSettings(async (key) => stored[key])).toEqual({
      retentionDays: 7,
      maxEntries: 100,
    });
  });

  test("🔴 falls back rather than turning a missing setting into 0", async () => {
    // 0 means "no ceiling" and "keep for ever", so reading an absent or broken
    // value as 0 would silently disable the whole feature.
    expect(await policyFromSettings(async () => null)).toEqual({
      retentionDays: DEFAULT_RETENTION_DAYS,
      maxEntries: DEFAULT_MAX_ENTRIES,
    });
    expect(await policyFromSettings(async () => "30")).toEqual({
      retentionDays: DEFAULT_RETENTION_DAYS,
      maxEntries: DEFAULT_MAX_ENTRIES,
    });
    expect(await policyFromSettings(async () => -1)).toEqual({
      retentionDays: DEFAULT_RETENTION_DAYS,
      maxEntries: DEFAULT_MAX_ENTRIES,
    });
  });

  test("0 is honoured, because it is a real choice on the screen", async () => {
    expect(await policyFromSettings(async () => 0)).toEqual({ retentionDays: 0, maxEntries: 0 });
  });
});
