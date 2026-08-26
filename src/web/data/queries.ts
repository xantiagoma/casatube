/**
 * The data layer. React Query owns the state; components only read it.
 *
 * 🔴 **Who owns what** is the whole point of this file.
 *
 * The queue lives in the React Query cache under one key. The SSE stream does
 * **not** own it — `useJobStream` pushes each snapshot into that same cache
 * (see `stream.ts`). That ordering matters: with the stream owning a `useState`
 * of its own, a dropped connection leaves the table frozen at whatever it last
 * saw, with nothing able to refresh it and nothing to notice. With the cache
 * owning it, a dropped stream still has the last good data, React Query can
 * refetch on its own, and reconnecting simply resumes pushing.
 *
 * Actions are mutations that invalidate the same key. They never write the
 * table themselves — R3 again: the queue changes on screen because the server
 * said so, never because the browser assumed.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type { Job, MediaInfo, Preferences, Priority } from "../../core/types";
import { api, unwrap } from "./client";

/** One key for the queue. Everything that changes a job invalidates it. */
export const JOBS_KEY = ["jobs"] as const;
export const probeKey = (url: string): readonly unknown[] => ["probe", url] as const;

export interface QueueSnapshot {
  at: string;
  jobs: Job[];
}

/**
 * The queue.
 *
 * `refetchInterval` is the safety net, and it is deliberately **off while the
 * stream is live**: polling on top of a working push is wasted work, and no
 * polling at all when the push is down is a stale table. Tying the interval to
 * the connection is what makes the two mechanisms one behaviour instead of two.
 */
export function useJobs(live: boolean): UseQueryResult<QueueSnapshot, Error> {
  return useQuery({
    queryKey: JOBS_KEY,
    queryFn: async () => unwrap(await api.api.jobs.get()),
    refetchInterval: live ? false : 5_000,
    // The server is the truth and it is one hop away; there is no such thing as
    // a queue snapshot worth reusing without checking.
    staleTime: 0,
  });
}

// --- Actions ----------------------------------------------------------------

export interface EnqueueRequest {
  url: string;
  destination: string;
  preferences: Preferences;
  priority?: Priority;
  force?: boolean;
  title?: string;
  thumbnail?: string;
  duration?: number;
  source?: string;
}

/**
 * ⚠️ Both outcomes are successes. `duplicate` means the server already has this
 * URL at this exact configuration and declined to fetch it again (PLAN §15) —
 * the UI has to say so rather than pretending something was queued.
 */
export type EnqueueOutcome = { outcome: "queued" | "duplicate"; job: Job };

export function useEnqueue() {
  const client = useQueryClient();
  return useMutation<EnqueueOutcome, Error, EnqueueRequest>({
    mutationFn: async (request) =>
      unwrap(
        await api.api.jobs.post({
          url: request.url.trim(),
          destination: request.destination.trim(),
          preferences: request.preferences,
          priority: request.priority,
          force: request.force,
          title: request.title,
          thumbnail: request.thumbnail,
          duration: request.duration,
          source: request.source,
        }),
      ),
    // Invalidate rather than write the new job in: the stream is about to say
    // the same thing, and two writers of one cache entry is how they disagree.
    onSuccess: () => void client.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}

export function useCancelJob() {
  const client = useQueryClient();
  return useMutation<Job, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.jobs({ id }).delete()),
    onSuccess: () => void client.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}

export function useRetryJob() {
  const client = useQueryClient();
  return useMutation<Job, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.jobs({ id }).retry.post()),
    onSuccess: () => void client.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}

// --- Preview ----------------------------------------------------------------

export interface ProbeResult {
  provider: string;
  info: MediaInfo;
}

/**
 * Look before you queue — PLAN §15 wants the title checked before 800 MB.
 *
 * A **disabled** query, fired by `refetch()`, which is what gives the preview
 * its pending and error states for free. It stays disabled rather than reacting
 * to the URL field because every probe is a real request to the source and
 * spends the IP budget (PLAN §4.3): one per URL the user actually means, never
 * one per keystroke.
 *
 * The key carries the URL, so editing it discards the previous preview instead
 * of leaving a stale title attached to a different video.
 */
export function useProbe(url: string): UseQueryResult<ProbeResult, Error> {
  return useQuery({
    queryKey: probeKey(url.trim()),
    queryFn: async () => unwrap(await api.api.probe.post({ url: url.trim() })),
    enabled: false,
    retry: false,
    // A video's formats do not change minute to minute, and re-probing costs
    // the same budget as the first one.
    staleTime: 5 * 60_000,
  });
}
