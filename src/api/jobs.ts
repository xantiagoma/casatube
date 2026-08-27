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

import { DEFAULT_PREFERENCES, JOB_SORT_KEYS, SORT_ORDERS, type JobStatus } from "../core/types";
import { AppSettingsStore } from "../core/app-settings";
import { jobFileStates } from "../core/file-state";
import { JOB_BUCKETS } from "../core/job-buckets";
import { openLibrary } from "../core/library";
import type { AppContext } from "./context";
import { InvalidTransition } from "../core/errors";
import { fail } from "./errors";
import { safeDestination } from "./destination";
import { preferencesSchema } from "./schemas";

const KNOWN_STATUSES: readonly JobStatus[] = [
  "queued", "analyzing", "downloading", "processing", "moving",
  "waiting-for-destination", "done", "failed", "cancelled",
] as const;

/**
 * The budget for one whole `POST /file-state` batch.
 *
 * ⚠️ A constant rather than an environment variable, deliberately: this file's
 * own `docs/DISCOVERIES.md` records two documented variables that nothing ever
 * read, and a knob nobody turns is a knob that lies. Three seconds is longer
 * than a healthy mount needs for 200 `stat`s by two orders of magnitude, and
 * short enough that a sleeping NAS is reported as unknown while the screen is
 * still being looked at.
 */
const FILE_STATE_BUDGET_MS = 3_000;

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

  /**
   * The library, opened here for exactly one thing: `POST /file-state`.
   *
   * `openLibrary` is a closure over paths and deadlines — no connection, no
   * handle, nothing to close — so a second one beside `api/library.ts`'s costs
   * nothing and keeps this route from depending on that module's assembly.
   */
  const library = openLibrary({ root: config.libraryDir });

  return (
    new Elysia({ prefix: "/jobs" })
      /**
       * The list.
       *
       * 🔴 `sort`, `order` and `q` are the database's work, not the browser's.
       * Until they existed the screens re-ordered the page they had been given,
       * so past two hundred jobs "the largest failed download" quietly became
       * "the largest of the latest two hundred" — with nothing on screen
       * marking the difference. `total` is the other half of that fix: a page
       * that is a page has to say what it is a page *of*.
       *
       * Omitting `sort` keeps the queue's own order — priority, then oldest
       * first — because that is the order work will be done in, and every
       * internal caller wants it.
       */
      .get(
        "/",
        async ({ query }) => {
          const filter = {
            status: parseStatuses(query.status),
            bucket: query.bucket,
            q: query.q,
            sort: query.sort,
            order: query.order,
          };
          const limit = query.limit ?? 200;
          const offset = query.offset ?? 0;
          const [jobs, total, byStatus, byBucket] = await Promise.all([
            queue.list({ ...filter, limit, offset }),
            queue.count(filter),
            // ⚠️ Both counted with the status and bucket filters dropped, on
            // purpose: these numbers sit on the tiles and tabs *above* the
            // table, and a tab that counted only its own contents would say "0"
            // while another tab's rows were on screen.
            queue.countsByStatus(filter),
            queue.countsByBucket(filter),
          ]);
          return {
            jobs,
            total,
            counts: { byStatus, byBucket },
            limit,
            offset,
            at: new Date().toISOString(),
          };
        },
        {
          query: t.Object({
            /** Comma-separated, e.g. `queued,downloading`. */
            status: t.Optional(t.String()),
            /** Free text over title, URL, output file and destination. */
            q: t.Optional(t.String()),
            /** One of the Downloads tabs — see `core/job-buckets.ts`. */
            bucket: t.Optional(t.Union(JOB_BUCKETS.map((bucket) => t.Literal(bucket)))),
            sort: t.Optional(t.Union(JOB_SORT_KEYS.map((key) => t.Literal(key)))),
            order: t.Optional(t.Union(SORT_ORDERS.map((value) => t.Literal(value)))),
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
       * 🔴 **Does the file still exist?** — the one question a job row cannot
       * answer about itself.
       *
       * ## Why this is a route of its own, and not a field on `GET /jobs`
       *
       * The obvious design is a `fileState` computed while the listing is
       * built. It is wrong here for a reason that is specific to this
       * application and worth writing down:
       *
       * **`GET /api/jobs` and the SSE stream are the same payload.**
       * `api/watcher.ts` re-reads the job table every **750 ms** and pushes a
       * whole snapshot to every open tab, and `web/data/stream.ts` writes that
       * snapshot straight into the same React Query entry the listing fills.
       * So a `fileState` on the job row is not "200 stats when the page loads"
       * — it is **200 stats per second, forever, against a network mount**, for
       * as long as one browser tab is open. And the only way to avoid that is
       * to leave the field off the pushed frames, which makes every badge
       * flicker from checked to unknown and back, twice a second.
       *
       * Separating it also separates the failures, which is the part that
       * matters when the mount is down: the queue lives in local SQLite and is
       * always answerable, and it stays answerable while this route reports
       * that it cannot see the disk. A queue that 503s because a NAS is asleep
       * would be the tail wagging the dog.
       *
       * ## The contract
       *
       * - Takes the **job ids** the browser is actually looking at, not paths.
       *   The browser has never been told where the library root is, and
       *   `Job.outputFile` is absolute; translating it is the server's job
       *   (`core/file-state.ts` → `libraryRelativeOutput`), and taking ids
       *   means no browser-supplied path is ever `stat`ed.
       * - **Never fails because of the disk.** Every way of not knowing comes
       *   back as `state: "unknown"` with a `reason`, per job. A dead mount is
       *   a 200 full of `unknown`, not a 503 — the caller is drawing a badge
       *   per row and needs an answer for each one.
       * - **Bounded.** One root check, one trash read, and a pool of at most
       *   16 `stat`s under a {@link FILE_STATE_BUDGET_MS} budget for the whole
       *   batch. Anything unanswered when it expires is `timed-out`, never
       *   `missing`.
       * - An id the queue does not know is simply **absent** from `states`. The
       *   caller treats an id it gets no answer for as unknown, which is what
       *   it is.
       */
      .post(
        "/file-state",
        async ({ body }) => {
          const ids = [...new Set(body.ids)];
          if (ids.length === 0) {
            return { states: [], checked: 0, elapsedMs: 0, exhausted: false, budgetMs: FILE_STATE_BUDGET_MS, at: new Date().toISOString() };
          }
          const jobs = await queue.list({ ids, limit: ids.length });
          const report = await jobFileStates(jobs, library, { budgetMs: FILE_STATE_BUDGET_MS });
          return { ...report, budgetMs: FILE_STATE_BUDGET_MS };
        },
        {
          body: t.Object({
            ids: t.Array(t.String({ minLength: 1 }), { maxItems: 500 }),
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
       * 🔴 **Download it again** — the only sensible reaction to a file that is
       * no longer there.
       *
       * Not `retry`: that revives *this* row, and `retry` refuses a `done` job
       * for a good reason — the pipeline finished, its stages are all `done`,
       * and re-running them in place would rewrite the history of a job that
       * did succeed. A missing file is a **new** download of the same thing.
       *
       * 🔴 **Rebuilt from the stored row, never from the browser.** The url,
       * the destination and — the one that matters — the resolved
       * `preferences` are read back out of the job, so the second copy is the
       * same 1080p H.264 with the same audio tracks as the first. A client
       * reconstructing that request is a client free to get it subtly wrong,
       * and "it came back at 360p" is exactly the kind of silent substitution
       * this project refuses to make.
       *
       * `force: true`, necessarily: the finished job it is copying is precisely
       * the duplicate that would otherwise cancel it.
       *
       * ⚠️ It does **not** re-check the disk. The caller has just been told the
       * file is gone, and a second `stat` here would only widen the window in
       * which the answer could change — while making a re-download impossible
       * for the case where someone wants one anyway.
       */
      .post("/:id/redownload", async ({ params }) => {
        const found = await queue.get(params.id);
        if (Result.isError(found)) return fail(found.error);
        const job = found.value;

        // A job still moving is already downloading this; a second copy would
        // be two writers racing for one filename.
        if (!["done", "failed", "cancelled"].includes(job.status)) {
          return fail(new InvalidTransition({ jobId: job.id, from: job.status, to: "queued" }));
        }

        const enqueued = await queue.enqueue({
          url: job.url,
          destination: job.destination,
          preferences: job.preferences,
          priority: job.priority,
          title: job.title,
          thumbnail: job.thumbnail,
          duration: job.duration,
          source: job.source,
          force: true,
        });
        if (Result.isError(enqueued)) return fail(enqueued.error);
        return enqueued.value;
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
