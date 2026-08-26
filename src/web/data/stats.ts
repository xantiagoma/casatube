/**
 * Storage and analytics.
 *
 * ⚠️ `useStorage` answers 200 even when the library is unreachable: each disk
 * reports its own availability inside the payload. So the card renders
 * "library unreachable" while the temp card still shows numbers — which is the
 * normal state of a home server whose NAS went to sleep, not an error page.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type { Analytics, StatsRange } from "../../core/stats";
import type { DiskPayload } from "../../api/stats";
import { api, unwrap } from "./client";
import { keys } from "./keys";

export interface StoragePayload {
  library: DiskPayload;
  temp: DiskPayload;
  at: string;
}

export function useStorage(): UseQueryResult<StoragePayload, Error> {
  return useQuery({
    queryKey: keys.storage,
    queryFn: async () => unwrap(await api.api.stats.storage.get()),
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function useAnalytics(range: StatsRange): UseQueryResult<Analytics, Error> {
  return useQuery({
    queryKey: keys.analytics(range),
    queryFn: async () => unwrap(await api.api.stats.analytics.get({ query: { range } })),
    refetchInterval: 60_000,
  });
}

export interface Health {
  ok: boolean;
  version: string;
  watchers: number;
  providers: string[];
}

/** The "Server online" dot. Cheap, and the one thing worth asking often. */
export function useHealth(): UseQueryResult<Health, Error> {
  return useQuery({
    queryKey: keys.health,
    queryFn: async () => unwrap(await api.api.health.get()),
    refetchInterval: 30_000,
    retry: 0,
  });
}
