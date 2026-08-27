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

import type { DestinationFolder } from "../../api/destinations";
import type { MediaOptions, Suggestion } from "../../api/options";
import type { Job, MediaInfo, Preferences, Priority } from "../../core/types";
import { api, unwrap } from "./client";
import { keys } from "./keys";

/** One key for the queue. Everything that changes a job invalidates it. */
export const JOBS_KEY = keys.jobs;
export const DESTINATIONS_KEY = keys.destinations;
export const probeKey = (url: string): readonly unknown[] => keys.probe(url);

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

/**
 * Hold a job in the queue — `POST /api/jobs/:id/pause`.
 *
 * ⚠️ **It is a hold, not a stop.** `paused` is a column the claim query filters
 * on (`core/queue.ts`), so what it prevents is the worker *picking the job up*.
 * Nothing in the worker reads it mid-run: pausing something that is already
 * downloading does not interrupt the download, and the button is offered only
 * where the distinction cannot bite — see `JobActions`.
 */
export function usePauseJob() {
  const client = useQueryClient();
  return useMutation<Job, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.jobs({ id }).pause.post()),
    onSuccess: () => void client.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}

/**
 * Let it be claimed again — `POST /api/jobs/:id/resume`.
 *
 * 🔴 The other half of pause, and it was on the server with nothing calling it:
 * a job put on hold could not be taken off hold from anywhere in the app, which
 * makes "pause" a one-way door dressed as a toggle. The two live in the same
 * place, always — a screen that can pause and cannot resume is the bug.
 */
export function useResumeJob() {
  const client = useQueryClient();
  return useMutation<Job, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.jobs({ id }).resume.post()),
    onSuccess: () => void client.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}

// --- Preview ----------------------------------------------------------------

export interface ProbeResult {
  provider: string;
  info: MediaInfo;
  /** The media as *choices* — see `api/options.ts`. */
  options: MediaOptions;
  /** What the selection logic would pick, so the form can start there. */
  suggested: Suggestion;
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
export function useProbe(url: string, preferences: Preferences): UseQueryResult<ProbeResult, Error> {
  return useQuery({
    // ⚠️ The URL alone. Preferences travel in the body — they only shape the
    // *suggestion* — and keying on them would re-probe the same video every
    // time a checkbox moved, which is the IP budget spent on nothing.
    queryKey: probeKey(url.trim()),
    queryFn: async () => unwrap(await api.api.probe.post({ url: url.trim(), preferences })),
    enabled: false,
    retry: false,
    // A video's formats do not change minute to minute, and re-probing costs
    // the same budget as the first one.
    staleTime: 5 * 60_000,
  });
}

// --- Destinations -----------------------------------------------------------

export interface DestinationListing {
  root: string;
  folders: DestinationFolder[];
  truncated: boolean;
  at: string;
}

/**
 * The folders the library really has.
 *
 * ⚠️ **This one is allowed to fail and must not take the form with it.** The
 * library is often a network mount, and a mount that is asleep answers slowly
 * or not at all (the route puts a deadline on it and reports `MountUnavailable`).
 * So: one retry, a short cache, and a picker that falls back to typing a name —
 * which still works, because the worker creates the folder at the move.
 */
export function useDestinations(): UseQueryResult<DestinationListing, Error> {
  return useQuery({
    queryKey: DESTINATIONS_KEY,
    queryFn: async () => unwrap(await api.api.destinations.get()),
    // Folders do not appear on their own; re-reading a slow mount on every
    // render of the form would be the expensive kind of pointless.
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * Create one, before queueing rather than after.
 *
 * Strictly a convenience — the move stage creates whatever the job names — but
 * it is the same convenience `/api/probe` provides: finding out that a name is
 * refused, or that the library is read-only, before 800 MB instead of after.
 */
export function useCreateDestination() {
  const client = useQueryClient();
  return useMutation<{ path: string; created: boolean }, Error, string>({
    mutationFn: async (path) => unwrap(await api.api.destinations.post({ path })),
    onSuccess: () => void client.invalidateQueries({ queryKey: DESTINATIONS_KEY }),
  });
}

// --- Defaults ---------------------------------------------------------------

export interface JobDefaults {
  preferences: Preferences;
  resolved: Preferences;
}

/**
 * What a fresh form starts from.
 *
 * From the server rather than a constant in the bundle: the defaults are the
 * ones the worker will apply if the form sends nothing, and a second copy of
 * them in the browser is a copy free to be wrong.
 */
export function useJobDefaults(): UseQueryResult<JobDefaults, Error> {
  return useQuery({
    queryKey: keys.jobDefaults,
    queryFn: async () => unwrap(await api.api.jobs.defaults.get()),
    staleTime: Infinity,
  });
}

// --- What became of the file ------------------------------------------------

/**
 * The disk check, as the server reports it — `POST /api/jobs/file-state`.
 *
 * 🔴 **A query of its own, and that is the design.** The obvious alternative is
 * a `fileState` field on the job row, and it is wrong here for a reason that is
 * particular to this app: `GET /api/jobs` and the SSE stream carry the *same*
 * payload into the *same* cache entry, and the stream re-reads the job table
 * every 750 ms. A field on the row would therefore be a `stat` per download per
 * frame — two hundred filesystem calls a second against a NAS, for as long as a
 * tab is open — or, if left off the pushed frames, a badge that flickers from
 * checked to unknown twice a second. Neither is acceptable, and the split fixes
 * both.
 *
 * It also splits the *failures*, which is what matters when the library is
 * asleep: the queue is local SQLite and keeps answering, while this query says
 * "could not check" — instead of a screen that loses its table because a NAS
 * did not wake up.
 *
 * ⚠️ **Not on an interval.** A file does not vanish while you watch; it is gone
 * when you come back. So this refetches on mount and on window focus, and
 * offers a button — a poll would put the load back that the split just removed.
 */
export interface JobFileState {
  id: string;
  state: "present" | "missing" | "trashed" | "none" | "unknown";
  reason?: "not-finished" | "mount-unavailable" | "library-empty" | "timed-out" | "unreadable" | "outside-library" | "trash-unreadable";
  detail?: string;
  path?: string;
  size?: number;
  modifiedAt?: string;
  trashId?: string;
}

export interface FileStateSnapshot {
  states: JobFileState[];
  /** How many paths the server actually `stat`ed. */
  checked: number;
  /** What the whole check cost, in ms — shown, because it is the honest label on the answer. */
  elapsedMs: number;
  /** True when the budget ran out and some rows are `timed-out`. */
  exhausted: boolean;
  budgetMs: number;
  at: string;
}

/**
 * @param ids The jobs to ask about. Sorted into the cache key, so the order the
 * caller happens to hand them in cannot split one answer into two entries.
 */
export function useJobFileStates(ids: readonly string[]): UseQueryResult<FileStateSnapshot, Error> {
  return useQuery({
    queryKey: keys.jobFileState(ids),
    queryFn: async () => unwrap(await api.api.jobs["file-state"].post({ ids: [...ids] })),
    enabled: ids.length > 0,
    // ⚠️ The set of finished jobs grows by one when a download completes, which
    // is a *new key*. Without this the badges would blank out on every
    // completion while the new answer was in flight.
    placeholderData: (previous) => previous,
    // A disk check that is a few seconds old is still a better answer than no
    // answer; anything older is worth paying a `stat` for.
    staleTime: 15_000,
    // One retry: a mount that woke up late is the normal case. Note the route
    // does not fail *because of* the disk — a 200 full of `unknown` is the
    // answer for that — so a retry here is about the request, not the library.
    retry: 1,
  });
}

/**
 * Download it again, from the job the server already has.
 *
 * 🔴 Not `retry`. A `done` job's pipeline finished and its stages all say so;
 * re-running them in place would rewrite the history of something that did
 * succeed. This asks for a **new** job built from the stored row — same URL,
 * same destination, and the same resolved preferences, so the replacement is
 * the same 1080p H.264 the first one was.
 *
 * ⚠️ The browser sends nothing but an id, on purpose. Reconstructing the
 * request here would be a second copy of it, free to differ, and "it came back
 * at 360p" is exactly the silent substitution this project refuses.
 */
export function useRedownload() {
  const client = useQueryClient();
  return useMutation<EnqueueOutcome, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.jobs({ id }).redownload.post()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: JOBS_KEY });
      // The new job is `queued`, so its own file state is not interesting yet —
      // but the *old* one is about to be overwritten on disk, and the answer
      // sitting in this cache says "missing" until something says otherwise.
      void client.invalidateQueries({ queryKey: ["jobs", "file-state"] });
    },
  });
}
