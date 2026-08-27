/**
 * The jobs endpoints — everything the browser is allowed to ask for.
 *
 * Note what is *not* here: nothing downloads, nothing probes on the way in,
 * nothing blocks. Enqueueing is a row and a queue entry, so the request returns
 * immediately and R1 holds — the job is already safe before the response
 * reaches the browser, and closing the tab changes nothing.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";

import { DEFAULT_PREFERENCES, type JobStatus } from "../core/types";
import { AppSettingsStore } from "../core/app-settings";
import type { AppContext } from "./context";
import { fail } from "./errors";
import { safeDestination } from "./destination";
import { preferencesSchema } from "./schemas";

const KNOWN_STATUSES: readonly JobStatus[] = [
  "queued", "analyzing", "downloading", "processing", "moving",
  "waiting-for-destination", "done", "failed", "cancelled",
] as const;

function parseStatuses(raw: string | undefined): JobStatus[] | undefined {
  if (!raw) return undefined;
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is JobStatus => (KNOWN_STATUSES as readonly string[]).includes(s));
  return wanted.length > 0 ? wanted : undefined;
}

export function jobRoutes(ctx: AppContext) {
  const { queue, registry, config } = ctx;
  /**
   * The download defaults, read live.
   *
   * 🔴 Read on every call rather than captured here: the `downloads.*` settings
   * are the group that takes effect immediately (see `core/app-settings.ts`),
   * and a value captured at construction would make "Save" appear to work and
   * change nothing until the next restart.
   */
  const settings = ctx.settings ?? new AppSettingsStore({ db: ctx.db });

  return (
    new Elysia({ prefix: "/jobs" })
      .get(
        "/",
        async ({ query }) => {
          const jobs = await queue.list({
            status: parseStatuses(query.status),
            limit: query.limit ?? 200,
            offset: query.offset ?? 0,
          });
          return { jobs, at: new Date().toISOString() };
        },
        {
          query: t.Object({
            /** Comma-separated, e.g. `queued,downloading`. */
            status: t.Optional(t.String()),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
            offset: t.Optional(t.Integer({ minimum: 0 })),
          }),
        },
      )

      /**
       * Queue a download.
       *
       * ⚠️ **200 for both outcomes, on purpose.** "Already have it" is not an
       * error — PLAN §15 says report it — but it is not the same answer as
       * "queued" either, so it travels as `outcome` in the body where the UI
       * can render "already downloaded" instead of "queued". Making it a 409
       * would push it into the error branch and lose the finished job that came
       * with it.
       */
      .post(
        "/",
        async ({ body }) => {
          const destination = safeDestination(body.destination, config.libraryDir);
          if (Result.isError(destination)) return fail(destination.error);

          const provider = registry.resolve(body.url);
          if (Result.isError(provider)) return fail(provider.error);

          const enqueued = await queue.enqueue({
            url: body.url,
            provider: provider.value.name,
            destination: destination.value,
            // ⚠️ Layered over the stored defaults rather than passed through.
            // `resolvePreferences` fills the gaps from `DEFAULT_PREFERENCES`,
            // which is the *code's* answer — so a request that omits a field
            // would silently ignore the setting someone saved for it.
            preferences: { ...(await settings.preferences()), ...body.preferences },
            priority: body.priority,
            force: body.force,
            // Optional, and normally filled in from a preceding `/api/probe`.
            // Absent is fine: the analyze stage discovers all of it anyway, and
            // making the enqueue depend on a network call would mean a slow
            // source could stop a job from being *recorded* — the one thing
            // that must not be able to fail.
            title: body.title ?? null,
            thumbnail: body.thumbnail ?? null,
            duration: body.duration ?? null,
            source: body.source ?? null,
          });
          if (Result.isError(enqueued)) return fail(enqueued.error);

          return enqueued.value;
        },
        {
          body: t.Object({
            url: t.String({ minLength: 1 }),
            /** Library subfolder. `""` is the library root. */
            destination: t.String({ default: "" }),
            preferences: t.Optional(preferencesSchema),
            priority: t.Optional(t.Union([t.Literal("high"), t.Literal("normal"), t.Literal("low")])),
            /** Re-download even if a finished job matches — PLAN §15. */
            force: t.Optional(t.Boolean()),
            title: t.Optional(t.String()),
            thumbnail: t.Optional(t.String()),
            duration: t.Optional(t.Number()),
            source: t.Optional(t.String()),
          }),
        },
      )

      /**
       * The defaults a fresh form starts from, so the client hard-codes none.
       *
       * `preferences` is what the *code* ships and `resolved` is what a job
       * really gets — which since settings became editable are two different
       * things, because a stored override or an environment variable can sit
       * between them. Both travel: the form starts from `resolved`, and the
       * pair is what lets a screen say "this is not the code's default".
       */
      .get("/defaults", async () => ({
        preferences: DEFAULT_PREFERENCES,
        resolved: await settings.preferences(),
      }))

      .get("/:id", async ({ params }) => {
        const job = await queue.get(params.id);
        if (Result.isError(job)) return fail(job.error);
        return job.value;
      })

      /** Cancel. Idempotent on an already-cancelled job — see `queue.cancel`. */
      .delete("/:id", async ({ params }) => {
        const cancelled = await queue.cancel(params.id);
        if (Result.isError(cancelled)) return fail(cancelled.error);
        return cancelled.value;
      })

      /**
       * Put a failed or cancelled job back in the queue.
       *
       * The backoff is a column on the row, not a timer here, so it survives a
       * restart — the job simply reads `queued` until it is due.
       */
      .post("/:id/retry", async ({ params }) => {
        const retried = await queue.retry(params.id);
        if (Result.isError(retried)) return fail(retried.error);
        return retried.value;
      })

      /**
       * Hold a job without losing it.
       *
       * Paused is a column, so it outlives the process and the claim query
       * simply skips it — a paused job is not a job in a special place, it is
       * one the queue declines to hand out.
       */
      .post("/:id/pause", async ({ params }) => {
        const paused = await queue.pause(params.id);
        if (Result.isError(paused)) return fail(paused.error);
        return paused.value;
      })

      .post("/:id/resume", async ({ params }) => {
        const resumed = await queue.resume(params.id);
        if (Result.isError(resumed)) return fail(resumed.error);
        return resumed.value;
      })

  );
}
