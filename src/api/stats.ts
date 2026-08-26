/**
 * `GET /api/stats/*` — the Storage and Analytics screens.
 *
 * Both endpoints are pure reads and neither touches the queue. What is worth
 * knowing about them is how they fail and how long they take:
 *
 * ⚠️ **Storage answers 200 even when the library is unreachable.** That looks
 * wrong next to `/api/destinations`, which 503s, and the difference is
 * deliberate: destinations has *one* answer and cannot give it, while storage
 * has two and usually has one of them. On a home server the normal state is a
 * live temp disk and a NAS that went to sleep — the exact moment someone opens
 * this screen — so the failure is reported *inside* the payload, per path, with
 * the same tagged `ApiError` shape every other endpoint uses. The card renders
 * "library unreachable" and the temp card still shows its numbers.
 *
 * ⚠️ **Analytics runs a synchronous query on the event loop.** `bun:sqlite`
 * does not do otherwise, so a slow one stalls every open SSE stream. The window
 * and the row cap in `core/stats.ts` are what keep it short; if the history
 * ever outgrows them the response says `truncated: true` rather than quietly
 * averaging half the data.
 */
import { Elysia, t } from "elysia";

import type { Db } from "../core/db";
import { analytics, storageStats, STATS_RANGES, type DiskReport } from "../core/stats";
import type { ServerConfig } from "./config";
import { toApiError, type ApiError } from "./errors";

/**
 * Only what these routes use.
 *
 * Structural rather than `AppContext` so this file compiles against any context
 * that carries a database and a config — the routes need no queue, no registry
 * and no watcher, and saying so keeps them testable with two fields.
 */
export interface StatsContext {
  db: Db;
  config: ServerConfig;
}

/** The wire shape of one disk card. The error is the standard `ApiError`. */
export type DiskPayload =
  | { path: string; available: true; totalBytes: number; usedBytes: number; freeBytes: number; usedPercent: number }
  | { path: string; available: false; error: ApiError };

function toPayload(report: DiskReport): DiskPayload {
  if (!report.available) {
    return { path: report.path, available: false, error: toApiError(report.error) };
  }
  return { path: report.path, available: true, ...report.usage };
}

export function statsRoutes(ctx: StatsContext) {
  const { db, config } = ctx;

  return (
    new Elysia({ prefix: "/stats" })
      /**
       * Free space where the downloads go, and where they are written first.
       *
       * The two paths matter separately because PLAN §15 makes them fail
       * differently: when the library is gone the file stays in the temp
       * directory, so a library that has been down for a week shows up here as
       * a *temp* disk filling, and that is the number that predicts trouble.
       */
      .get("/storage", async () => {
        const stats = await storageStats({
          libraryDir: config.libraryDir,
          tempDir: config.tempDir,
        });
        return {
          library: toPayload(stats.library),
          temp: toPayload(stats.temp),
          at: stats.at,
        };
      })

      /**
       * The history, over a window.
       *
       * The range is a closed set rather than a free-form duration: three
       * values is what the design offers, and letting the browser ask for `5y`
       * would be letting it ask for a table scan.
       */
      .get(
        "/analytics",
        async ({ query }) => analytics({ db, range: query.range ?? "24h" }),
        {
          query: t.Object({
            // `default: undefined` for the reason spelled out in
            // `notifications.ts`: `t.UnionEnum` carries a default that Elysia
            // applies to absent query parameters. Here it would happen to be
            // the value we want, which is exactly what makes it worth pinning
            // — the day the first range stops being the default one, nothing
            // would say so.
            range: t.Optional(t.UnionEnum(STATS_RANGES, { default: undefined })),
          }),
        },
      )
  );
}
