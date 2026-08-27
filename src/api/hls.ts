/**
 * `/api/library/hls` — playback for the files a browser refuses to open.
 *
 * A separate module from `api/library.ts` on purpose. These routes own a
 * **stateful thing** — running ffmpeg processes and hundreds of megabytes of
 * temp disk — while everything in `library.ts` is a read of the filesystem.
 * Mounting them apart keeps the manager's lifetime explicit: it is created once
 * with the process, handed in through {@link AppContext}, and stopped with it.
 *
 * ## The shape of the thing
 *
 * | Route | What it does |
 * |---|---|
 * | `GET /playback?path=` | The verdict: `direct`, `hls` or `unsupported`, and the URL to use. **No side effects** — nothing is started by asking |
 * | `GET /index.m3u8?path=` | Starts the session if there is none, and answers with the index as soon as one segment exists |
 * | `GET /<nnnnn>.ts?path=` | One segment |
 * | `GET /sessions` | What is running, and what it is costing in disk |
 *
 * 🔴 **The playlist is rewritten on the way out.** ffmpeg writes bare filenames
 * and a player resolves those against the playlist's URL — where our `?path=`
 * lives, and a query string takes no part in that resolution. Every segment
 * line therefore leaves here carrying its own `?path=`; see `rewritePlaylist`.
 *
 * ⚠️ **A failing segment answers with an empty body**, never with JSON or
 * prose. An HLS player handed a paragraph where it expected MPEG-TS does not
 * report a clean error — it misbehaves, and the failure surfaces somewhere else
 * entirely. On the segment route the status code is the whole message.
 *
 * 🔴 **`safeDestination` runs on every path**, exactly as the rest of the
 * library routes do. This module hands a path to `ffmpeg -i`, which reads
 * whatever it is given: an unvalidated `?path=../../etc/shadow` would be a read
 * of the whole host, dressed up as a video.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";

import { createHlsManager, PLAYLIST_NAME, SEGMENT_NAME, type HlsManager } from "../core/hls";
import { openLibrary } from "../core/library";
import type { ServerConfig } from "./config";
import type { AppContext } from "./context";
import { safeDestination } from "./destination";
import { fail, statusForTag } from "./errors";

/**
 * The URL a player should be pointed at, given a verdict.
 *
 * Built on the server for the same reason the download options are (PLAN §8,
 * R3): the server owns its routes, and a path assembled inside a component is
 * exactly the thing that survives a rename and 404s in production.
 */
export function playbackUrl(mode: string, path: string): string | null {
  const query = `path=${encodeURIComponent(path)}`;
  if (mode === "direct") return `/api/library/file?${query}`;
  if (mode === "hls") return `/api/library/hls/${PLAYLIST_NAME}?${query}`;
  return null;
}

/**
 * The process-wide manager.
 *
 * ⚠️ One per process, and it must be **stopped**: it holds an interval and, at
 * any moment, up to `maxSessions` ffmpeg processes. `main()` builds it, puts it
 * on the context and stops it in the shutdown path.
 */
export function createLibraryHlsManager(config: ServerConfig): HlsManager {
  // Its own handle on the library rather than one shared with `library.ts`:
  // `openLibrary` is a closure over paths and timeouts, not a connection, so a
  // second one costs nothing — and it is what lets this module pass the
  // configured `ffprobe` through without editing a file another agent owns.
  const library = openLibrary({
    root: config.libraryDir,
    ...(config.ffprobeBinary === undefined ? {} : { ffprobePath: config.ffprobeBinary }),
  });

  return createHlsManager({
    libraryRoot: config.libraryDir,
    tempDir: config.tempDir,
    probe: (relPath) => library.probe(relPath),
    ...(config.ffmpegBinary === undefined ? {} : { ffmpegPath: config.ffmpegBinary }),
    segmentSeconds: config.hls.segmentSeconds,
    idleMs: config.hls.idleMs,
    transcodeIdleMs: config.hls.transcodeIdleMs,
    maxSessions: config.hls.maxSessions,
  });
}

export function hlsRoutes(ctx: AppContext) {
  const { config } = ctx;
  // Same fallback as `plugins`: an app assembled without one still answers,
  // because `createApp` has to stand up in a test without a media pipeline.
  const manager = ctx.hls ?? createLibraryHlsManager(config);

  return (
    new Elysia({ prefix: "/library/hls" })
      /**
       * How this file should be played — **without starting anything**.
       *
       * The distinction matters: a library screen rendering twenty cards must
       * be able to ask twenty times without spawning twenty ffmpegs. The
       * verdict is cached per (size, mtime), so the second ask is free as well
       * as harmless.
       */
      .get(
        "/playback",
        async ({ query }) => {
          const path = safeDestination(query.path, config.libraryDir);
          if (Result.isError(path)) return fail(path.error);

          const decided = await manager.verdict(path.value);
          if (Result.isError(decided)) return fail(decided.error);
          return { path: path.value, ...decided.value, url: playbackUrl(decided.value.mode, path.value) };
        },
        { query: t.Object({ path: t.String({ minLength: 1 }) }) },
      )

      /** What is running, and what it is costing. See the disk warning in `core/hls.ts`. */
      .get("/sessions", () => manager.stats())

      /**
       * The index. Starts the session if there is none, and **answers as soon
       * as the first segment exists** rather than when the last one does —
       * which is what lets a two-hour film start playing in a couple of seconds.
       *
       * ⚠️ `cache-control: no-store`. An `event` playlist grows as ffmpeg
       * works; a cached copy is a playlist frozen at three segments, which is a
       * video that stops after eighteen seconds and never says why.
       */
      .get(
        `/${PLAYLIST_NAME}`,
        async ({ query }) => {
          const path = safeDestination(query.path, config.libraryDir);
          if (Result.isError(path)) return fail(path.error);

          const answered = await manager.playlist(path.value);
          if (Result.isError(answered)) return fail(answered.error);

          return new Response(answered.value.body, {
            headers: {
              "content-type": "application/vnd.apple.mpegurl",
              "cache-control": "no-store",
            },
          });
        },
        { query: t.Object({ path: t.String({ minLength: 1 }) }) },
      )

      /**
       * One segment.
       *
       * ⚠️ Every failure here is an **empty** response — see the module header.
       *
       * 📌 A segment is immutable once written: ffmpeg never goes back and
       * rewrites one. So unlike the playlist it is safe, and worth it, to let
       * the browser hold on to it — seeking backwards then costs no request at
       * all.
       */
      .get(
        "/:segment",
        async ({ params, query }) => {
          const path = safeDestination(query.path, config.libraryDir);
          if (Result.isError(path) || !SEGMENT_NAME.test(params.segment)) {
            return new Response(null, { status: 404 });
          }

          const found = await manager.segment(path.value, params.segment);
          if (Result.isError(found)) {
            return new Response(null, { status: statusForTag(found.error._tag) });
          }

          return new Response(Bun.file(found.value.path), {
            headers: {
              "content-type": "video/mp2t",
              "content-length": String(found.value.size),
              "cache-control": "private, max-age=3600",
            },
          });
        },
        { query: t.Object({ path: t.String({ minLength: 1 }) }), params: t.Object({ segment: t.String() }) },
      )
  );
}
