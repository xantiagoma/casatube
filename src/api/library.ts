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
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { NotFound } from "../core/errors";

import {
  DEFAULT_TRASH_RETENTION_DAYS,
  openLibrary,
  type LibraryQuery,
  type LibrarySort,
  type SortOrder,
} from "../core/library";
import { createThumbnailer, THUMBNAIL_DIR } from "../core/thumbnails";
import type { AppContext } from "./context";
import { safeDestination } from "./destination";
import { fail, statusForTag } from "./errors";

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

/**
 * `Content-Disposition` for a file being served.
 *
 * Two filename forms on purpose: the quoted one is all a client reading only
 * ASCII can use, and `filename*` is the RFC 5987 form every current browser
 * prefers. Library names routinely carry accents, emoji and quotation marks —
 * "Dua Lipa - Love Again (Official Music Video).mkv" is the tame end of it —
 * and a single ASCII form turns those into mojibake or into a truncated name.
 */
export function contentDisposition(name: string, download: boolean): string {
  if (!download) return "inline";
  const ascii = name.replace(/["\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function libraryRoutes(ctx: AppContext) {
  const { config } = ctx;
  const library = openLibrary({
    root: config.libraryDir,
    retentionDays: retentionDays(),
    ...(config.ffprobeBinary === undefined ? {} : { ffprobePath: config.ffprobeBinary }),
  });

  /**
   * Thumbnails, with the cache under `DATA_DIR` and never in the library.
   *
   * It borrows this module's `library` for `ffprobe` rather than opening a
   * second one — `openLibrary` is a closure over paths and timeouts, not a
   * connection, and the duration it reads is the only thing the generator needs
   * before it can decide *where* to take the frame.
   *
   * ⚠️ Nothing is created on disk here. The cache directory appears the first
   * time a frame is actually generated, so standing up the routes — in a test,
   * or in a process whose library is empty — writes nothing.
   */
  const thumbnails = createThumbnailer({
    libraryRoot: config.libraryDir,
    cacheDir: join(config.dataDir, THUMBNAIL_DIR),
    probe: (relPath) => library.probe(relPath),
    ...(config.ffmpegBinary === undefined ? {} : { ffmpegPath: config.ffmpegBinary }),
    width: config.thumbnails.width,
    maxConcurrent: config.thumbnails.maxConcurrent,
    generateTimeoutMs: config.thumbnails.timeoutMs,
    maxEntries: config.thumbnails.maxEntries,
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
      /**
       * Stream a file so the browser can play it — or save it — without
       * leaving CasaTube.
       *
       * `Bun.file` gives a lazy handle, so returning it streams rather than
       * loading the file into memory — a 4 GB video would otherwise be a 4 GB
       * allocation. Range requests are what let a player seek, and every video
       * element sends them, so a route without range support plays only from
       * the start and cannot scrub.
       */
      /**
       * Everything that belongs to one video, as a single archive.
       *
       * `what=all` is the video with its sidecars; `what=extras` is only the
       * sidecars — because subtitles and a thumbnail are a few hundred
       * kilobytes and the video is the remaining 99.9%, and re-downloading a
       * 4 GB file to fetch a subtitle is not a thing anyone wants.
       *
       * ⚠️ Streamed from `zip`'s stdout rather than assembled in memory.
       * `Bun.Archive` was the obvious candidate and is the wrong tool here: it
       * buffers the whole archive before returning anything, so a large video
       * would be held in RAM in full — and it writes tar, which iOS handles
       * far less gracefully than zip.
       *
       * `-0` is store, no compression: an mp4 is already compressed, so
       * deflating it again spends CPU to save almost nothing.
       */
      .get(
        "/bundle",
        async ({ query, set }) => {
          const path = safeDestination(query.path, config.libraryDir);
          if (Result.isError(path)) return fail(path.error);

          const found = await library.item(path.value);
          if (Result.isError(found)) return fail(found.error);
          const item = found.value;

          const wantsVideo = (query.what ?? "all") === "all";
          const folder = join(config.libraryDir, item.folder);

          /**
           * Everything sharing the video's base name.
           *
           * Read from the directory rather than from the item's own fields:
           * a thumbnail written by the provider is a sidecar like any other,
           * and a listing that only knew about subtitles would silently leave
           * it out of a bundle called "all".
           */
          const base = item.name.slice(0, item.name.length - item.ext.length);
          const entries = await readdir(folder).catch(() => [] as string[]);
          const names = entries
            .filter((n) => n === item.name || n.startsWith(`${base}.`))
            .filter((n) => wantsVideo || n !== item.name)
            .sort();

          if (names.length === 0) {
            return fail(new NotFound({ what: wantsVideo ? "files" : "extras", id: path.value }));
          }
          const proc = Bun.spawn(["zip", "-0", "-q", "-", ...names], {
            cwd: folder,
            stdout: "pipe",
            stderr: "ignore",
          });

          const filename = `${base}${wantsVideo ? "" : " (extras)"}.zip`;
          return new Response(proc.stdout, {
            headers: {
              "content-type": "application/zip",
              // Both spellings: library names carry accents and quotes, and a
              // bare `filename=` mangles them.
              "content-disposition":
                `attachment; filename="${filename.replace(/["\\]/g, "_")}"; ` +
                `filename*=UTF-8''${encodeURIComponent(filename)}`,
            },
          });
        },
        { query: t.Object({ path: t.String(), what: t.Optional(t.UnionEnum(["all", "extras"], { default: undefined })) }) },
      )

      .get(
        "/file",
        async ({ query, request, set }) => {
          const path = safeDestination(query.path, config.libraryDir);
          if (Result.isError(path)) return fail(path.error);

          const found = await library.item(path.value);
          if (Result.isError(found)) return fail(found.error);

          const absolute = join(config.libraryDir, path.value);
          const file = Bun.file(absolute);
          const size = found.value.size;
          const type = file.type || "application/octet-stream";
          const disposition = contentDisposition(found.value.name, flag(query.download, false));

          const range = request.headers.get("range");
          const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
          if (!match) {
            return new Response(file, {
              headers: {
                "accept-ranges": "bytes",
                "content-length": String(size),
                "content-type": type,
                "content-disposition": disposition,
              },
            });
          }

          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Number(match[2]) : size - 1;
          if (!(start >= 0 && end < size && start <= end)) {
            set.status = 416;
            set.headers["content-range"] = `bytes */${size}`;
            return new Response(null, { status: 416 });
          }

          // ⚠️ The headers go on the Response, not on `set`: Elysia derives
          // content-length from the body it is handed, and a 206 whose
          // content-length claims the whole file makes a player give up on
          // seeking. Verified — `set.headers` lost this one.
          const slice = file.slice(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              "accept-ranges": "bytes",
              "content-range": `bytes ${start}-${end}/${size}`,
              "content-length": String(end - start + 1),
              "content-type": type,
              // ⚠️ Also on the 206: a download manager that resumes sends a
              // range, and losing the filename there is how a resumed download
              // lands as `file.bin`.
              "content-disposition": disposition,
            },
          });
        },
        {
          query: t.Object({
            path: t.String(),
            /** `?download=1` — same bytes, told to save rather than to play. */
            download: t.Optional(t.String()),
          }),
        },
      )

      /**
       * The picture for one library item.
       *
       * | | |
       * |---|---|
       * | `200` | an image — `image/jpeg` unless a sidecar says otherwise |
       * | `304` | the browser already has this exact picture |
       * | `404` | there is none and none can be made. **Not an error**: the grid draws its grey rectangle |
       * | `400` / `503` / `504` | the path left the root, the mount is down, the mount is slow |
       *
       * 🔴 **The provider's own image wins**, and it is looked for first: a
       * poster the creator chose beats a frame we picked out of the middle of
       * the file. Only what has no sidecar is generated, and only when the
       * picture is *asked for* — `GET /api/library` never generates anything,
       * which is what stops opening the screen from starting two hundred
       * ffmpegs (see `core/thumbnails.ts`).
       *
       * ⚠️ **Every failure has an empty body**, like the HLS segment route and
       * for the same reason: this URL goes in an `<img src>`, and a browser
       * handed JSON where it expected an image reports nothing useful. The
       * status code is the whole message.
       *
       * 📌 The `ETag` is derived from the file's identity — path, size, mtime —
       * so re-downloading over the same name invalidates it, and `max-age`
       * keeps a scrolled grid from asking twice.
       */
      .get(
        "/thumbnail",
        async ({ query, request }) => {
          const path = safeDestination(query.path, config.libraryDir);
          if (Result.isError(path)) {
            return new Response(null, { status: statusForTag(path.error._tag) });
          }
          if (path.value === "") return new Response(null, { status: 404 });

          const found = await thumbnails.thumbnail(path.value);
          if (Result.isError(found)) {
            return new Response(null, { status: statusForTag(found.error._tag) });
          }

          const { etag } = found.value;
          const headers = {
            "content-type": found.value.contentType,
            "cache-control": "private, max-age=3600",
            etag,
            // Which of the two sources answered. Not needed by the browser —
            // it is here because "why is this the wrong picture?" is otherwise
            // unanswerable without reading the disk.
            "x-thumbnail-source": found.value.source,
          };

          // A 304 costs one round trip and no bytes; a grid of a hundred cards
          // revalidating is the difference between 3 KB and 3 MB.
          if (request.headers.get("if-none-match") === etag) {
            return new Response(null, { status: 304, headers });
          }

          return new Response(Bun.file(found.value.path), {
            headers: { ...headers, "content-length": String(found.value.size) },
          });
        },
        { query: t.Object({ path: t.String({ minLength: 1 }) }) },
      )

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
