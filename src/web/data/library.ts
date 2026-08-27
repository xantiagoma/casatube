/**
 * The library, the trash, and the one call that removes something.
 *
 * 🔴 Deleting is a **move to `.trash/`** (PLAN §18) — reversible, and the UI
 * has to say so, because "Delete" that cannot be undone and "Delete" that can
 * are different promises. `useEmptyTrash` is the only thing here that frees
 * space, and it is the only one worded as final.
 *
 * ⚠️ The library is usually a network mount. Every query here can legitimately
 * fail with `MountUnavailable` while the rest of the app is perfectly healthy,
 * so nothing retries hard and no screen treats a library failure as fatal.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type { EmptyTrashResult, LibraryListing, MediaProbe, RestoreResult, TrashEntry } from "../../core/library";
import { api, unwrap } from "./client";
import { keys } from "./keys";

/**
 * Containers a browser will actually play, as extensions without the dot.
 *
 * 🔴 The codec inside is not the question. An MKV holding H.264 is still an
 * MKV, and Chrome and Safari refuse the container regardless — so a player
 * pointed at one produces a black rectangle and an error nobody can act on.
 * The honest answer for those is the download button, and `Library` says so in
 * words rather than showing a player that cannot work.
 *
 * ⚠️ Deliberately conservative. `.mov` is absent because Firefox does not play
 * it; offering a download for something one browser could have played is a far
 * smaller failure than a play button that does nothing.
 */
const PLAYABLE_CONTAINERS = new Set([
  "mp4",
  "m4v",
  "webm",
  "ogv",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "oga",
  "opus",
  "flac",
  "wav",
]);

/** An extension, lower-cased and without its dot — the form everything here compares. */
export function normaliseExt(ext: string): string {
  return ext.toLowerCase().replace(/^\./, "");
}

export function isBrowserPlayable(ext: string): boolean {
  return PLAYABLE_CONTAINERS.has(normaliseExt(ext));
}

/**
 * The URL that serves a library file's bytes — `GET /api/library/file`, which
 * answers range requests, so a player can seek in it.
 *
 * 🔴 It lives in the data layer with everything else that names a server route
 * (R3), even though the consumers are a `<video src>` and an `<a href>` rather
 * than a query: the point of the rule is that one folder knows the API, and a
 * path built inside a component is exactly the thing that survives a rename.
 *
 * ⚠️ Not an Eden call, and it cannot be one — a media element fetches its own
 * bytes and a download is the browser's, not ours. Both need a URL string.
 */
export function libraryFileUrl(path: string, options: { download?: boolean } = {}): string {
  const query = new URLSearchParams({ path });
  if (options.download === true) query.set("download", "1");
  return `/api/library/file?${query.toString()}`;
}

/**
 * The HLS index for a file no browser opens directly — `GET
 * /api/library/hls/index.m3u8`, which starts an on-demand remux of the video
 * stream (copied, never re-encoded) and answers as soon as the first segment
 * exists. Seeking works because every segment stays listed in the index.
 */
export function libraryHlsUrl(path: string): string {
  const query = new URLSearchParams({ path });
  return `/api/library/hls/index.m3u8?${query.toString()}`;
}

/**
 * Whether this browser plays HLS by itself.
 *
 * 🔴 A **capability check, not a feature flag**. Safari and everything on iOS —
 * which is where this is actually watched — play an `.m3u8` from a plain
 * `<video src>`. Firefox does not, and needs `hls.js`. When the player learns
 * `hls.js`, this function is the single place that changes.
 *
 * ⚠️ **Chromium is excluded even though it says yes**, and that is the whole
 * reason this is not a one-line `canPlayType`. Chrome 152 answers `"maybe"` for
 * `application/vnd.apple.mpegurl` and does play a *finished* playlist — but a
 * playlist that is still being written has no `#EXT-X-ENDLIST`, so Chrome reads
 * it as live and its MPEG-TS pipeline dies a few seconds in with
 * `DEMUXER_ERROR_COULD_NOT_PARSE`. Every *first* play is a playlist still being
 * written. Verified against the real 67 MB MKV: hls.js played and seeked it
 * throughout, Chrome's own player failed at 0:19 — on byte-identical segments.
 *
 * 📌 So the honest answer for Chromium today is the download button, until the
 * player carries `hls.js` — at which point the browser sniff below goes and
 * this becomes "does anything here play HLS at all".
 */
export function canPlayHlsNatively(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof navigator !== "undefined" && /Chrome|Chromium|Edg\//.test(navigator.userAgent)) return false;
  const probe = document.createElement("video");
  return probe.canPlayType("application/vnd.apple.mpegurl") !== "";
}

export interface LibraryParams {
  folder?: string;
  q?: string;
  sort?: "name" | "size" | "modified";
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
  recursive?: boolean;
}

export function useLibrary(params: LibraryParams): UseQueryResult<LibraryListing, Error> {
  const query = {
    ...(params.folder ? { folder: params.folder } : {}),
    ...(params.q ? { q: params.q } : {}),
    ...(params.sort ? { sort: params.sort } : {}),
    ...(params.order ? { order: params.order } : {}),
    ...(params.limit ? { limit: params.limit } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.recursive === false ? { recursive: "false" } : {}),
  };
  return useQuery({
    queryKey: keys.library(query),
    queryFn: async () => unwrap(await api.api.library.get({ query })),
    // A mount that woke up slowly is the normal case, not a bug worth hammering.
    retry: 1,
    staleTime: 10_000,
  });
}

export interface LibraryItemResult {
  item: import("../../core/library").LibraryItem;
  probe: MediaProbe | null;
  probeError?: string;
}

/**
 * One item, and — only when asked — what `ffprobe` says about it.
 *
 * `probe` is opt-in on the server because it opens the file; it is opt-in here
 * for the same reason. The detail panel asks for it, the grid never does.
 */
export function useLibraryItem(path: string | null, probe = true): UseQueryResult<LibraryItemResult, Error> {
  return useQuery({
    queryKey: keys.libraryItem(path ?? "", probe),
    queryFn: async () =>
      unwrap(await api.api.library.item.get({ query: { path: path ?? "", ...(probe ? { probe: "true" } : {}) } })),
    enabled: path !== null && path !== "",
    retry: 1,
  });
}

/** 🔴 Not an unlink: a rename into `.trash/`. Reversible by `useRestore`. */
export function useTrashItem() {
  const client = useQueryClient();
  return useMutation<{ trashed: TrashEntry }, Error, string>({
    mutationFn: async (path) => unwrap(await api.api.library.delete(undefined, { query: { path, reason: "ui" } })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export interface TrashListing {
  entries: TrashEntry[];
  retentionDays: number;
  bytes: number;
}

export function useTrash(enabled = true): UseQueryResult<TrashListing, Error> {
  return useQuery({
    queryKey: keys.trash,
    queryFn: async () => unwrap(await api.api.library.trash.get()),
    enabled,
    retry: 1,
  });
}

export function useRestore() {
  const client = useQueryClient();
  return useMutation<RestoreResult, Error, string>({
    mutationFn: async (path) => unwrap(await api.api.library.restore.post({ path })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

/** ⚠️ The only call that actually frees space. `0` empties the trash outright. */
export function useEmptyTrash() {
  const client = useQueryClient();
  return useMutation<EmptyTrashResult, Error, number | undefined>({
    mutationFn: async (olderThanDays) =>
      unwrap(await api.api.library.trash.empty.post(olderThanDays === undefined ? {} : { olderThanDays })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["library"] });
      void client.invalidateQueries({ queryKey: keys.storage });
    },
  });
}
