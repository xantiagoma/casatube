/**
 * `/api/transcode` — the optional, expensive conversion, as a queue.
 *
 * ## The shape of the thing
 *
 * | Route | What it does |
 * |---|---|
 * | `GET /presets` | The named outcomes and, on every one of them, **what it costs** |
 * | `GET /` | What is queued, running and finished |
 * | `POST /` | Queue one file or many. **Returns immediately** |
 * | `DELETE /:id` | Cancel a queued job, or kill the running one |
 *
 * 🔴 **`POST` returns before any work happens, and that is the whole design.**
 * A re-encode of a film is an hour of CPU; a request that waited for it would
 * be an hour-long HTTP connection, lost the moment a phone locks its screen,
 * with no progress, no retry and nothing left behind if the server restarts.
 * The row in `transcodes` is the deliverable — see `core/transcode.ts`.
 *
 * 🔴 **The route never sees an ffmpeg flag.** It takes a preset id off a fixed
 * list, and the arguments are compiled from that list on the server. A route
 * that accepted arguments would be a route that runs arbitrary ffmpeg against
 * arbitrary paths, which is a remote shell with extra steps.
 *
 * ⚠️ `safeDestination` runs on every path here, exactly as it does under
 * `/library`, and `core/transcode` resolves it against the root a second time.
 * Both checks, because this ends in `ffmpeg -i <path>`.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";

import { createTranscodeQueue, TRANSCODE_PRESETS, type TranscodeQueue, type TranscodeStatus } from "../core/transcode";
import { openLibrary } from "../core/library";
import { TranscodeRejected } from "../core/errors";
import type { ServerConfig } from "./config";
import type { AppContext } from "./context";
import { safeDestination } from "./destination";
import { fail } from "./errors";

/**
 * The process-wide queue.
 *
 * ⚠️ One per process, and it must be **stopped**: it holds a polling loop and,
 * at any moment, one ffmpeg. `main()` builds it, puts it on the context, starts
 * it and stops it in the shutdown path — the same contract `HlsManager` has,
 * for the same reason.
 */
export function createLibraryTranscodeQueue(ctx: Pick<AppContext, "db" | "config">): TranscodeQueue {
  const { config } = ctx;
  const library = openLibrary({
    root: config.libraryDir,
    ...(config.ffprobeBinary === undefined ? {} : { ffprobePath: config.ffprobeBinary }),
  });

  return createTranscodeQueue({
    db: ctx.db,
    libraryRoot: config.libraryDir,
    probe: (relPath) => library.probe(relPath),
    // 🔴 The original is *moved to the trash*, never unlinked — and only when
    // the job was asked to replace it and the new file is verified on disk.
    trash: (relPath) => library.remove(relPath, { reason: "transcode" }),
    ...(config.ffmpegBinary === undefined ? {} : { ffmpegPath: config.ffmpegBinary }),
  });
}

const STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;

export function transcodeRoutes(ctx: AppContext) {
  const { config } = ctx;
  // Same fallback as `hlsRoutes`: an app assembled without one still answers,
  // because `createApp` has to stand up in a test with no media pipeline.
  const queue = ctx.transcodes ?? createLibraryTranscodeQueue(ctx);

  return (
    new Elysia({ prefix: "/transcode" })
      /**
       * What can be asked for, and what each one costs.
       *
       * 🔴 `cost` and `reencodesVideo` are **part of the contract**, not
       * documentation. Anything about to offer a button here has to be able to
       * say "this will take about as long as the film and use the whole
       * machine" *before* the button is pressed — and it can only say that if
       * the server tells it which presets are the expensive ones.
       */
      .get("/presets", () => ({
        presets: TRANSCODE_PRESETS.map((preset) => ({
          id: preset.id,
          label: preset.label,
          description: preset.description,
          cost: preset.cost,
          ext: preset.ext,
          reencodesVideo: preset.reencodesVideo,
        })),
        /** One at a time, always. Stated so a UI does not have to infer it. */
        concurrency: 1,
      }))

      /** What is queued, running and finished. Newest first. */
      .get(
        "/",
        async ({ query }) => {
          const status = query.status === undefined ? undefined : (query.status.split(",") as TranscodeStatus[]);
          const jobs = await queue.list({
            ...(status === undefined ? {} : { status }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          });
          return { jobs, running: queue.running };
        },
        {
          query: t.Object({
            /** Comma-separated: `queued,running`. */
            status: t.Optional(t.String()),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
          }),
        },
      )

      /**
       * Queue one file, or a batch.
       *
       * ⚠️ **A batch answers with two lists, not with a failure.** Point this at
       * a folder and some of it will be already-MP4, already-queued or missing;
       * refusing the whole request over one of those would make the feature
       * unusable on any real directory. Each rejection carries its own reason.
       */
      .post(
        "/",
        async ({ body }) => {
          const requested = body.paths ?? (body.path === undefined ? [] : [body.path]);
          if (requested.length === 0) {
            return fail(new TranscodeRejected({ path: "", detail: "No file was named." }));
          }

          const safe: string[] = [];
          const rejected: { path: string; reason: string }[] = [];
          for (const raw of requested) {
            const checked = safeDestination(raw, config.libraryDir);
            if (Result.isError(checked)) rejected.push({ path: raw, reason: "That path leaves the library." });
            else safe.push(checked.value);
          }

          const outcome = await queue.enqueueMany(safe, {
            preset: body.preset,
            ...(body.replaceOriginal === undefined ? {} : { replaceOriginal: body.replaceOriginal }),
          });

          return {
            queued: outcome.queued,
            rejected: [...rejected, ...outcome.rejected],
            /**
             * ⚠️ Repeated in the answer as well as on `/presets`, because this
             * is the response a confirmation dialog is holding when it decides
             * what to say next.
             */
            warning:
              outcome.queued.length === 0
                ? undefined
                : "Re-encoding uses the whole machine for as long as it takes. One job runs at a time; the rest wait.",
          };
        },
        {
          body: t.Object({
            /** One file… */
            path: t.Optional(t.String({ minLength: 1 })),
            /** …or many. Both are accepted; `paths` wins when both are sent. */
            paths: t.Optional(t.Array(t.String({ minLength: 1 }), { maxItems: 200 })),
            preset: t.String({ minLength: 1 }),
            /**
             * ⚠️ Off unless asked for, and even then the original is *moved to
             * `.trash/`* after the copy is verified — never deleted, never
             * before.
             */
            replaceOriginal: t.Optional(t.Boolean()),
          }),
        },
      )

      /** Cancel a queued job, or kill the one that is running. Idempotent. */
      .delete(
        "/:id",
        async ({ params }) => {
          const cancelled = await queue.cancel(params.id);
          if (Result.isError(cancelled)) return fail(cancelled.error);
          return cancelled.value;
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )
  );
}
