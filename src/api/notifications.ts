/**
 * `/api/notifications` — the bell menu, and the retention broom behind it.
 *
 * These endpoints are a thin layer over `core/notifications`: the list, two
 * ways of marking things read, and a delete. What is worth writing down is what
 * they deliberately do *not* do.
 *
 * 📌 **There is no `POST /api/notifications`.** Notifications are produced by
 * the system — a job finished, a job failed, the library went away — not by the
 * browser. An endpoint that let a client invent one would be a way to fake a
 * report about work that never happened, and nothing in the UI wants it.
 *
 * 📌 **The list is polled, not streamed.** `GET /api/events` carries queue
 * snapshots and nothing else, so the bell asks for its list like any other
 * screen. That is fine and it is also *the point of the table*: the stream is
 * an accelerator for whoever is watching, and the rows are what makes a
 * notification survive a closed tab (PLAN §15).
 *
 * ⚠️ **`DELETE` is destructive and its defaults say so.** Unread notifications
 * are spared unless explicitly included, and the age cutoff defaults to 30 days
 * — "clear old ones" must never be able to remove the warning nobody has read
 * yet, which is the only one still doing a job.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";

import type { Db } from "../core/db";
import { MAX_PAGE, NotificationStore, NOTIFICATION_LEVELS } from "../core/notifications";
import { fail } from "./errors";

/** Only what these routes use — see the note in `stats.ts`. */
export interface NotificationsContext {
  db: Db;
}

/** Default age cutoff for `DELETE`, in days. Conservative on purpose. */
export const DEFAULT_PURGE_DAYS = 30;

const DAY_MS = 86_400_000;

export function notificationRoutes(ctx: NotificationsContext) {
  const store = new NotificationStore({ db: ctx.db });

  return (
    new Elysia({ prefix: "/notifications" })
      /**
       * The list, unread first.
       *
       * `unreadCount` travels with it because it is a fact about the table and
       * the list is one page of it: counting the page would show "3" when
       * thirty are waiting and the menu holds ten.
       */
      .get(
        "/",
        async ({ query }) => {
          const [items, unread] = await Promise.all([
            store.list({
              limit: query.limit,
              offset: query.offset,
              unreadOnly: query.unread === true,
              level: query.level,
            }),
            store.unreadCount(),
          ]);
          return { notifications: items, unreadCount: unread, at: new Date().toISOString() };
        },
        {
          query: t.Object({
            limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE })),
            offset: t.Optional(t.Integer({ minimum: 0 })),
            /** `?unread=true` for the badge's own list. */
            unread: t.Optional(t.BooleanString()),
            /**
             * ⚠️ `default: undefined` is load-bearing. `t.UnionEnum` sets
             * `default: values[0]` for its own error messages, and Elysia's
             * query coercion then *applies* that default — so an absent
             * `?level=` silently arrives as `"info"` and the list comes back
             * filtered to info notifications. Verified against 1.4.29: without
             * this, "give me everything" and "give me the info ones" are the
             * same request.
             */
            level: t.Optional(t.UnionEnum(NOTIFICATION_LEVELS, { default: undefined })),
          }),
        },
      )

      /**
       * Mark one read.
       *
       * Returns the row so the client can replace it in place instead of
       * re-fetching the whole list to learn one boolean. Marking an
       * already-read one again is a 200 with the original `readAt`: the second
       * click is not a new reading, and a 409 would make the UI handle a case
       * that is not a problem.
       */
      .post(
        "/:id/read",
        async ({ params }) => {
          const marked = await store.markRead(params.id);
          if (Result.isError(marked)) return fail(marked.error);
          return marked.value;
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )

      /** Mark everything read. Answers with how many actually changed. */
      .post("/read-all", async () => ({ updated: await store.markAllRead() }))

      /**
       * Dismiss one.
       *
       * ⚠️ It removes an **unread** notification too, and that is the point:
       * deciding you do not need a report is the ordinary reason to press the
       * button. The rules that spare unread rows belong to the two *bulk*
       * operations — retention and `DELETE /`, where "tidy up" must never be
       * able to take the warning nobody has seen.
       */
      .delete(
        "/:id",
        async ({ params }) => {
          const removed = await store.remove(params.id);
          if (Result.isError(removed)) return fail(removed.error);
          return removed.value;
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )

      /**
       * Clear everything that has been read.
       *
       * The bell's own broom, and bounded by *read* rather than by age: after
       * dealing with forty notifications what somebody wants is an empty list,
       * and "older than 30 days" is not that.
       */
      .post("/clear-read", async () => ({ deleted: await store.clearRead() }))

      /**
       * Delete old ones.
       *
       * `olderThanDays: 0` means "everything up to now", which is the honest
       * spelling of "clear all" — still limited to read notifications unless
       * `includeUnread` is asked for.
       */
      .delete(
        "/",
        async ({ query }) => {
          const days = query.olderThanDays ?? DEFAULT_PURGE_DAYS;
          const before = new Date(Date.now() - days * DAY_MS);
          const deleted = await store.purge({
            before,
            onlyRead: query.includeUnread !== true,
          });
          return { deleted, before: before.toISOString() };
        },
        {
          query: t.Object({
            olderThanDays: t.Optional(t.Integer({ minimum: 0, maximum: 3650 })),
            includeUnread: t.Optional(t.BooleanString()),
          }),
        },
      )
  );
}
