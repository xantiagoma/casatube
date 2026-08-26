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
