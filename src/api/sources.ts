/**
 * The sources endpoints — subscriptions, and the scheduler that services them.
 *
 * Two things are worth noticing about the shapes here.
 *
 * **`POST /api/sources` is the one route in the API that talks to the network
 * before it answers.** Every other write returns as soon as a row is durable;
 * this one has to enumerate the source first, because the row is only safe once
 * its back catalogue has been marked seen. Returning early and seeding later
 * would leave a window in which a scheduler tick sees a source with no history
 * and queues eight hundred videos — the exact failure the seeding exists to
 * prevent. So a listing failure means **no source is created**, and the caller
 * gets the provider's error.
 *
 * **`includeExisting` is an object, not a boolean.** `{ limit: 10 }` is the
 * only way to ask for the back catalogue, so "give me everything" is not a
 * sentence this API can express. The bound is checked twice: here, as a
 * validation error the client can render, and again in `core/sources.ts`, which
 * is where it has to hold for callers that never went through HTTP.
 */
import { Elysia, status, t } from "elysia";
import { Result } from "better-result";

import {
  MAX_INCLUDE_EXISTING,
  MIN_INTERVAL_MINUTES,
  DEFAULT_INTERVAL_MINUTES,
} from "../core/sources";
import type { SourceManager } from "../core/sources";
import type { SourceScheduler } from "../core/scheduler";
import type { AppContext } from "./context";
import { fail, type ApiError } from "./errors";
import { safeDestination } from "./destination";
import { preferencesSchema } from "./schemas";

/** Only what these routes actually touch — see `destinations.test.ts` for why. */
export interface SourceRoutesContext {
  sources: SourceManager;
  scheduler: SourceScheduler;
  config: Pick<AppContext["config"], "libraryDir">;
}

/**
 * ⚠️ The floor is enforced, the ceiling is a month.
 *
 * `minimum` is the interesting one: polling costs from the same IP budget the
 * downloads come out of (PLAN §4.3), and a channel checked more often than
 * hourly finds nothing an hourly check would have missed.
 */
const intervalSchema = t.Integer({
  minimum: MIN_INTERVAL_MINUTES,
  maximum: 60 * 24 * 30,
  default: DEFAULT_INTERVAL_MINUTES,
});

export function sourceRoutes(ctx: SourceRoutesContext) {
  const { sources, scheduler, config } = ctx;

  return (
    new Elysia()
      .get("/sources", async () => ({ sources: await sources.list(), at: new Date().toISOString() }))

      .post(
        "/sources",
        async ({ body }) => {
          const destination = safeDestination(body.destination, config.libraryDir);
          if (Result.isError(destination)) return fail(destination.error);

          const added = await sources.add({
            url: body.url,
            ...(body.name !== undefined ? { name: body.name } : {}),
            destination: destination.value,
            ...(body.preferences !== undefined ? { preferences: body.preferences } : {}),
            ...(body.intervalMinutes !== undefined ? { intervalMinutes: body.intervalMinutes } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.includeExisting !== undefined ? { includeExisting: body.includeExisting } : {}),
          });
          if (Result.isError(added)) return fail(added.error);

          return added.value;
        },
        {
          body: t.Object({
            url: t.String({ minLength: 1 }),
            name: t.Optional(t.String()),
            /** Library subfolder. `""` is the library root. */
            destination: t.String({ default: "" }),
            preferences: t.Optional(preferencesSchema),
            intervalMinutes: t.Optional(intervalSchema),
            enabled: t.Optional(t.Boolean()),
            /**
             * 🔴 Absent means **nothing from the past is downloaded** — the
             * whole back catalogue is recorded as seen and only later uploads
             * are queued. Present, it must name its own cap.
             */
            includeExisting: t.Optional(
              t.Object({ limit: t.Integer({ minimum: 1, maximum: MAX_INCLUDE_EXISTING }) }),
            ),
          }),
        },
      )

      .get("/sources/:id", async ({ params }) => {
        const source = await sources.get(params.id);
        if (Result.isError(source)) return fail(source.error);
        return { source: source.value, seen: await sources.seenCount(params.id) };
      })

      .patch(
        "/sources/:id",
        async ({ body, params }) => {
          let destination: string | undefined;
          if (body.destination !== undefined) {
            const safe = safeDestination(body.destination, config.libraryDir);
            if (Result.isError(safe)) return fail(safe.error);
            destination = safe.value;
          }

          const updated = await sources.update(params.id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(destination !== undefined ? { destination } : {}),
            ...(body.preferences !== undefined ? { preferences: body.preferences } : {}),
            ...(body.intervalMinutes !== undefined ? { intervalMinutes: body.intervalMinutes } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          });
          if (Result.isError(updated)) return fail(updated.error);
          return updated.value;
        },
        {
          body: t.Object({
            name: t.Optional(t.String()),
            destination: t.Optional(t.String()),
            preferences: t.Optional(preferencesSchema),
            intervalMinutes: t.Optional(intervalSchema),
            enabled: t.Optional(t.Boolean()),
          }),
        },
      )

      /** Unsubscribe. Jobs already queued are left alone — see `remove`. */
      .delete("/sources/:id", async ({ params }) => {
        const removed = await sources.remove(params.id);
        if (Result.isError(removed)) return fail(removed.error);
        return removed.value;
      })

      /**
       * Check one source right now.
       *
       * `force` because the button exists to answer "is this thing working?",
       * and a disabled source is the one you most want to be able to ask. The
       * check is still idempotent: forcing it re-reads the source, and anything
       * already seen stays unqueued.
       */
      .post(
        "/sources/:id/check",
        async ({ params, body }) => {
          const checked = await sources.check(params.id, { force: body?.force ?? true });
          if (Result.isError(checked)) return fail(checked.error);
          return checked.value;
        },
        { body: t.Optional(t.Object({ force: t.Optional(t.Boolean()) })) },
      )

      /** What the scheduler is doing, and when it will next do it. */
      .get("/scheduler", async () => scheduler.status())

      /**
       * Run a pass now.
       *
       * ⚠️ **409, not a second pass**, when one is already in flight. Silently
       * starting another would put two sweeps on the same due list, which is
       * precisely the double-check `source_seen` has to defend against.
       */
      .post("/scheduler/run", async () => {
        const pass = scheduler.runPass();
        if (pass === null) {
          const busy: ApiError = {
            tag: "SchedulerBusy",
            message: "A pass is already running. Nothing was started.",
            retryable: true,
          };
          return status(409, busy);
        }
        return pass;
      })
  );
}
