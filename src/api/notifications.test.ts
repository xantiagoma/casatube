/**
 * `/api/notifications`, over HTTP, against a real database file.
 *
 * The routes are mounted on their own so the test needs no queue, no registry
 * and no provider: they read and write one table and nothing else, and standing
 * up the whole application to prove that would make the test slower and less
 * specific rather than more honest.
 *
 * The rows are seeded through `NotificationStore` rather than through the API,
 * because there is deliberately no endpoint that creates one — notifications
 * are produced by the system, not by the browser.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, openDb, type Db } from "../core/db";
import { NotificationStore } from "../core/notifications";
import type { Notification } from "../core/types";
import { notificationRoutes } from "./notifications";

let dir: string;
let db: Db;
let app: ReturnType<typeof makeApp>;
let clock: Date;

function makeApp() {
  return new Elysia({ prefix: "/api" }).use(notificationRoutes({ db }));
}

/** The seeding store shares the clock, so "old" and "new" are exact. */
function store(): NotificationStore {
  return new NotificationStore({ db, now: () => clock });
}

function at(iso: string): void {
  clock = new Date(iso);
}

async function get(path: string): Promise<Response> {
  return app.handle(new Request(`http://local${path}`));
}

async function post(path: string): Promise<Response> {
  return app.handle(new Request(`http://local${path}`, { method: "POST" }));
}

async function del(path: string): Promise<Response> {
  return app.handle(new Request(`http://local${path}`, { method: "DELETE" }));
}

type Listing = { notifications: Notification[]; unreadCount: number; at: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-api-notifications-"));
  db = openDb({ path: join(dir, "casatube.db") });
  at("2026-08-26T12:00:00.000Z");
  app = makeApp();
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/notifications", () => {
  test("an empty table is an empty list and a zero badge", async () => {
    const response = await get("/api/notifications");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Listing;
    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(0);
    expect(typeof body.at).toBe("string");
  });

  test("🔴 unread first, then newest first", async () => {
    const seeder = store();
    at("2026-08-26T09:00:00.000Z");
    const oldUnread = await seeder.create({ title: "old unread" });
    at("2026-08-26T10:00:00.000Z");
    const read = await seeder.create({ title: "read" });
    at("2026-08-26T11:00:00.000Z");
    const newUnread = await seeder.create({ title: "new unread", level: "error" });
    await seeder.markRead(read.id);

    const body = (await (await get("/api/notifications")).json()) as Listing;
    expect(body.notifications.map((n) => n.id)).toEqual([newUnread.id, oldUnread.id, read.id]);
    expect(body.unreadCount).toBe(2);
  });

  test("the badge counts the table even when the page is smaller", async () => {
    const seeder = store();
    for (let i = 0; i < 6; i += 1) await seeder.create({ title: `n${i}` });

    const body = (await (await get("/api/notifications?limit=2")).json()) as Listing;
    expect(body.notifications).toHaveLength(2);
    expect(body.unreadCount).toBe(6);
  });

  test("filters to unread and to a level", async () => {
    const seeder = store();
    const one = await seeder.create({ title: "one", level: "error" });
    await seeder.create({ title: "two" });
    await seeder.markRead(one.id);

    const unread = (await (await get("/api/notifications?unread=true")).json()) as Listing;
    expect(unread.notifications.map((n) => n.title)).toEqual(["two"]);

    const errors = (await (await get("/api/notifications?level=error")).json()) as Listing;
    expect(errors.notifications.map((n) => n.title)).toEqual(["one"]);
  });

  test("a level nobody defined is refused, not quietly ignored", async () => {
    expect((await get("/api/notifications?level=catastrophe")).status).toBe(422);
  });
});

describe("POST /api/notifications/:id/read", () => {
  test("marks it and answers with the row, so the client need not re-fetch the list", async () => {
    const written = await store().create({ title: "one" });

    const response = await post(`/api/notifications/${written.id}/read`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Notification;
    expect(body.id).toBe(written.id);
    expect(body.readAt).not.toBeNull();

    expect(((await (await get("/api/notifications")).json()) as Listing).unreadCount).toBe(0);
  });

  test("an id that does not exist is a 404 with a tag", async () => {
    const response = await post("/api/notifications/nope/read");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { tag: string }).tag).toBe("NotFound");
  });

  test("marking one twice is fine, and does not move the moment it was read", async () => {
    const written = await store().create({ title: "one" });
    const first = (await (await post(`/api/notifications/${written.id}/read`)).json()) as Notification;
    const second = (await (await post(`/api/notifications/${written.id}/read`)).json()) as Notification;
    expect(second.readAt).toBe(first.readAt);
  });
});

describe("POST /api/notifications/read-all", () => {
  test("reports how many actually changed", async () => {
    const seeder = store();
    const one = await seeder.create({ title: "one" });
    await seeder.create({ title: "two" });
    await seeder.create({ title: "three" });
    await seeder.markRead(one.id);

    expect((await (await post("/api/notifications/read-all")).json())).toEqual({ updated: 2 });
    expect((await (await post("/api/notifications/read-all")).json())).toEqual({ updated: 0 });
  });
});

describe("DELETE /api/notifications/:id", () => {
  test("🔴 dismisses one, unread included", async () => {
    const written = await store().create({ title: "never seen", level: "error" });

    const response = await del(`/api/notifications/${written.id}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Notification).id).toBe(written.id);

    const listing = (await (await get("/api/notifications")).json()) as Listing;
    expect(listing.notifications).toEqual([]);
    expect(listing.unreadCount).toBe(0);
  });

  test("one that is already gone is a 404, not a quiet success", async () => {
    const response = await del("/api/notifications/no-such-id");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { tag: string }).tag).toBe("NotFound");
  });

  test("it takes exactly one, and leaves the rest", async () => {
    const seeder = store();
    const first = await seeder.create({ title: "one" });
    const second = await seeder.create({ title: "two" });

    await del(`/api/notifications/${first.id}`);
    const listing = (await (await get("/api/notifications")).json()) as Listing;
    expect(listing.notifications.map((n) => n.id)).toEqual([second.id]);
  });
});

describe("POST /api/notifications/clear-read", () => {
  test("🔴 clears what has been read and keeps what has not", async () => {
    const seeder = store();
    const seen = await seeder.create({ title: "dealt with" });
    const unseen = await seeder.create({ title: "still waiting" });
    await seeder.markRead(seen.id);

    const body = (await (await post("/api/notifications/clear-read")).json()) as { deleted: number };
    expect(body.deleted).toBe(1);

    const listing = (await (await get("/api/notifications")).json()) as Listing;
    expect(listing.notifications.map((n) => n.id)).toEqual([unseen.id]);
    expect(listing.unreadCount).toBe(1);
  });

  test("nothing read means nothing removed", async () => {
    await store().create({ title: "one" });
    expect(((await (await post("/api/notifications/clear-read")).json()) as { deleted: number }).deleted).toBe(0);
  });
});

describe("DELETE /api/notifications", () => {
  test("🔴 by default it never deletes something nobody has read", async () => {
    const seeder = store();
    at("2026-06-01T00:00:00.000Z");
    const oldRead = await seeder.create({ title: "old and read" });
    await seeder.create({ title: "old and unread", level: "error" });
    at("2026-08-26T12:00:00.000Z");
    await seeder.markRead(oldRead.id);

    const response = await del("/api/notifications");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { deleted: number }).deleted).toBe(1);

    const left = (await (await get("/api/notifications")).json()) as Listing;
    expect(left.notifications.map((n) => n.title)).toEqual(["old and unread"]);
  });

  test("`olderThanDays=0` with `includeUnread` is the honest spelling of clear all", async () => {
    const seeder = store();
    await seeder.create({ title: "one" });
    await seeder.create({ title: "two" });

    const body = (await (
      await del("/api/notifications?olderThanDays=0&includeUnread=true")
    ).json()) as { deleted: number; before: string };
    expect(body.deleted).toBe(2);
    expect(typeof body.before).toBe("string");
    expect(((await (await get("/api/notifications")).json()) as Listing).notifications).toEqual([]);
  });

  test("recent notifications are not old, whatever the broom is told", async () => {
    // ⚠️ Ten minutes before the *real* now, not the fixed clock: the route
    // measures age with `Date.now()`, so a fixed date here turned into "old" the
    // day the calendar passed it by thirty days — a test with an expiry date.
    at(new Date(Date.now() - 10 * 60_000).toISOString());
    const seeder = store();
    const written = await seeder.create({ title: "from ten minutes ago" });
    await seeder.markRead(written.id);

    expect(
      ((await (await del("/api/notifications?olderThanDays=30")).json()) as { deleted: number }).deleted,
    ).toBe(0);
  });

  test("a nonsense age is refused rather than guessed at", async () => {
    expect((await del("/api/notifications?olderThanDays=-5")).status).toBe(422);
  });
});
