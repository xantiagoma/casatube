/**
 * `/api/library` — browsing what has already been downloaded, and the one
 * endpoint that removes it.
 *
 * 🔴 **Read-only apart from the delete**, and the delete is a move: PLAN §18
 * settles that a deletion renames into `.trash/` inside the library, keeps a
 * configurable retention, and records every removal. `DELETE /api/library` is
 * therefore reversible by `POST /api/library/restore`, and the only thing that
 * actually frees space is `POST /api/library/trash/empty`.
 *
 * 🔴 **Nothing outside the library root.** Two independent checks, on purpose:
 * `safeDestination` refuses the *string* here at the edge — `..`, absolute
 * paths, backslashes, Windows device names — and `core/library` refuses the
 * *resolved* path against the real root before it touches anything. Either one
 * alone would be a rule that a second entry point can walk past.
 *
 * ⚠️ **The library is very often a network mount**, and a dead mount hangs
 * rather than failing. Every filesystem call underneath runs under a deadline
 * and surfaces as `MountUnavailable` → 503, so a browser tab gets an error it
 * can render instead of a request that never returns.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";

import {
  DEFAULT_TRASH_RETENTION_DAYS,
  openLibrary,
  type LibraryQuery,
  type LibrarySort,
  type SortOrder,
} from "../core/library";
import type { AppContext } from "./context";
import { safeDestination } from "./destination";
import { fail } from "./errors";

/**
 * Trash retention, in days.
 *
 * ⚠️ Read from the environment here rather than from `ServerConfig` because
 * `api/config.ts` belongs to another agent this session. It is a `PLAN §12`
 * variable and belongs in `loadConfig` — see the note in the handover.
 */
function retentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRASH_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRASH_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TRASH_RETENTION_DAYS;
}

/** `"false"`, `"0"` and `"no"` are all a person saying no in a URL. */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

export function libraryRoutes(ctx: AppContext) {
  const { config } = ctx;
  const library = openLibrary({
    root: config.libraryDir,
    retentionDays: retentionDays(),
  });

  return (
    new Elysia({ prefix: "/library" })
      /**
       * What is in the library: a page of items, newest first by default.
       *
       * Paged by **cursor**, not offset. The library changes exactly when a
       * download finishes, and an offset silently repeats or skips a row when
       * that happens mid-scroll; a cursor resumes from a position instead of
       * from a count.
       */
      .get(
        "/",
        async ({ query }) => {
          const folder = safeDestination(query.folder ?? "", config.libraryDir);
          if (Result.isError(folder)) return fail(folder.error);

          const request: LibraryQuery = {
            folder: folder.value,
            recursive: flag(query.recursive, true),
          };
          if (query.q !== undefined && query.q.trim() !== "") request.search = query.q;
          if (query.sort !== undefined) request.sort = query.sort as LibrarySort;
          if (query.order !== undefined) request.order = query.order as SortOrder;
          if (query.limit !== undefined) request.limit = query.limit;
          if (query.cursor !== undefined && query.cursor !== "") request.cursor = query.cursor;

          const listing = await library.list(request);
          if (Result.isError(listing)) return fail(listing.error);
          return listing.value;
        },
        {
          query: t.Object({
            folder: t.Optional(t.String()),
            q: t.Optional(t.String()),
            recursive: t.Optional(t.String()),
            sort: t.Optional(t.Union([t.Literal("name"), t.Literal("size"), t.Literal("modified")])),
            order: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 500 })),
            cursor: t.Optional(t.String()),
          }),
        },
      )

      /**
       * One item, and — only when asked — what `ffprobe` says about it.
       *
       * `probe` is opt-in because it opens the file: on a network mount that is
       * the difference between a page and a stall, which is why the listing
       * never does it and this route does it one item at a time.
       */
      .get(
        "/item",
        async ({ query }) => {
          const path = safeDestination(query.path, config.libraryDir);
          if (Result.isError(path)) return fail(path.error);

          const found = await library.item(path.value);
          if (Result.isError(found)) return fail(found.error);
          if (!flag(query.probe, false)) return { item: found.value, probe: null };

          const probed = await library.probe(path.value);
          // A failed probe is not a failed request: the item is real and the
          // browser can render everything except the duration. Same rule the
          // download form follows — not being able to look must not stop you.
          return {
            item: found.value,
            probe: Result.isOk(probed) ? probed.value : null,
            probeError: Result.isError(probed) ? probed.error._tag : undefined,
          };
        },
        { query: t.Object({ path: t.String({ minLength: 1 }), probe: t.Optional(t.String()) }) },
      )

      /**
       * Delete — i.e. **move to `.trash/`**. Reversible, and recorded.
       *
       * Sidecar subtitles travel with the item: leaving them behind would fill
       * the library with subtitles for videos that no longer exist, and half an
       * item cannot be restored.
       */
      .delete(
        "/",
        async ({ query }) => {
          const path = safeDestination(query.path, config.libraryDir);
          if (Result.isError(path)) return fail(path.error);

          const removed = await library.remove(path.value, { reason: query.reason ?? "api" });
          if (Result.isError(removed)) return fail(removed.error);
          return { trashed: removed.value };
        },
        { query: t.Object({ path: t.String({ minLength: 1 }), reason: t.Optional(t.String()) }) },
      )

      /** What is in the trash, newest first. */
      .get("/trash", async () => {
        const entries = await library.listTrash();
        if (Result.isError(entries)) return fail(entries.error);
        return {
          entries: entries.value,
          retentionDays: library.retentionDays,
          bytes: entries.value.reduce((total, entry) => total + entry.size, 0),
        };
      })

      /**
       * Undo a delete. Accepts the entry id, the original path, or the path
       * inside `.trash/` — all three name one entry.
       */
      .post(
        "/restore",
        async ({ body }) => {
          const path = safeDestination(body.path, config.libraryDir);
          if (Result.isError(path)) return fail(path.error);

          const restored = await library.restore(path.value);
          if (Result.isError(restored)) return fail(restored.error);
          return restored.value;
        },
        { body: t.Object({ path: t.String({ minLength: 1 }) }) },
      )

      /**
       * Empty the trash for real — the only call that frees space.
       *
       * `olderThanDays` is the retention window; omitted, the configured
       * default applies. **`0` empties it outright**, which is the force-delete
       * PLAN §18 asks for.
       */
      .post(
        "/trash/empty",
        async ({ body }) => {
          const emptied = await library.emptyTrash(body?.olderThanDays);
          if (Result.isError(emptied)) return fail(emptied.error);
          return emptied.value;
        },
        { body: t.Optional(t.Object({ olderThanDays: t.Optional(t.Number({ minimum: 0 })) })) },
      )
  );
}
