/**
 * The live queue, as React sees it.
 *
 * 🔴 R3 in one file: this subscribes and renders what the server says. It never
 * decides anything about a download, it holds no state the server does not
 * also hold, and a reload rebuilds everything from the first SSE frame — which
 * is a whole snapshot, not a delta, precisely so that reconnecting needs no
 * memory of what came before.
 *
 * The stream is read through Eden, like every other call. `EventSource` was the
 * obvious alternative and loses the types: it hands back `string`, so the frame
 * shapes would be re-declared here and free to drift from the server's. What it
 * would have given for free is reconnection, so that is written out below —
 * about fifteen lines, and it can be made to back off properly, which
 * `EventSource` cannot.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { Job, MediaInfo, Preferences, Priority } from "../../core/types";
import { api, normalise, type ActionResult, type ApiFailure } from "./client";

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface QueueView {
  jobs: Job[];
  /** When the server read this snapshot. */
  at: string | null;
  connection: ConnectionState;
  /** Set when the stream cannot be established at all. */
  problem: string | null;
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Narrow a wire frame.
 *
 * The stream crosses a process boundary, so it is checked rather than trusted:
 * a server that is mid-upgrade can legitimately send a frame this build has
 * never seen, and the right answer to that is to ignore it, not to crash the
 * page.
 */
function snapshotOf(frame: unknown): { at: string; jobs: Job[] } | null {
  if (!frame || typeof frame !== "object") return null;
  const { event, data } = frame as { event?: unknown; data?: unknown };
  if (event !== "snapshot" || !data || typeof data !== "object") return null;
  const { at, jobs } = data as { at?: unknown; jobs?: unknown };
  if (typeof at !== "string" || !Array.isArray(jobs)) return null;
  return { at, jobs: jobs as Job[] };
}

export function useQueue(): QueueView {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [at, setAt] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;

    const run = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const stream = await api.api.events.get({ fetch: { signal: controller.signal } });
          if (controller.signal.aborted) return;
          if (!stream.data) throw new Error("the server did not open the stream");

          attempt = 0;
          setConnection("live");
          setProblem(null);

          for await (const frame of stream.data as AsyncIterable<unknown>) {
            if (controller.signal.aborted) return;
            const snapshot = snapshotOf(frame);
            if (!snapshot) continue; // heartbeat, or something newer than this build
            setJobs(snapshot.jobs);
            setAt(snapshot.at);
          }
        } catch (cause) {
          if (controller.signal.aborted) return;
          setProblem(cause instanceof Error ? cause.message : String(cause));
        }

        if (controller.signal.aborted) return;
        // The stream ended — a restart, a dropped connection, a sleeping
        // laptop. The queue is unaffected by any of them (R1, R2); only this
        // view needs putting back together.
        setConnection("reconnecting");
        attempt += 1;
        await sleep(Math.min(FIRST_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS));
      }
    };

    void run();
    return () => controller.abort();
  }, []);

  return { jobs, at, connection, problem };
}

// --- Actions ----------------------------------------------------------------
// Ordinary requests, going the other way. Nothing here waits for the result to
// appear in the table: the SSE snapshot is what updates the UI, so there is
// exactly one path by which the queue changes on screen.

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
 * URL at this exact configuration and declined to fetch it again — the UI has
 * to say so rather than pretending something was queued.
 */
export type EnqueueOutcome = { outcome: "queued" | "duplicate"; job: Job };

export async function enqueue(request: EnqueueRequest): Promise<ActionResult<EnqueueOutcome>> {
  const response = await api.api.jobs.post({
    url: request.url.trim(),
    destination: request.destination.trim(),
    preferences: request.preferences,
    priority: request.priority,
    force: request.force,
    title: request.title,
    thumbnail: request.thumbnail,
    duration: request.duration,
    source: request.source,
  });
  return normalise(response);
}

export async function cancelJob(id: string): Promise<ActionResult<Job>> {
  return normalise(await api.api.jobs({ id }).delete());
}

export async function retryJob(id: string): Promise<ActionResult<Job>> {
  return normalise(await api.api.jobs({ id }).retry.post());
}

export interface ProbeResult {
  provider: string;
  info: MediaInfo;
}

/** Look before queueing — PLAN §15 wants the title checked before 800 MB. */
export async function probe(url: string): Promise<ActionResult<ProbeResult>> {
  return normalise(await api.api.probe.post({ url: url.trim() }));
}

/**
 * A one-shot action with its pending flag and its last failure.
 *
 * Every button in the app has the same three states, and writing them out per
 * component is how they end up subtly different from each other.
 */
export function useAction<A extends unknown[], T>(
  action: (...args: A) => Promise<ActionResult<T>>,
): {
  run: (...args: A) => Promise<ActionResult<T>>;
  pending: boolean;
  error: ApiFailure | null;
  clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  // The component can unmount while the request is in flight — a cancel button
  // on a row that then disappears is the ordinary case, not an edge one.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: A): Promise<ActionResult<T>> => {
      setPending(true);
      setError(null);
      try {
        const result = await action(...args);
        if (alive.current && !result.ok) setError(result.error);
        return result;
      } finally {
        if (alive.current) setPending(false);
      }
    },
    [action],
  );

  return { run, pending, error, clearError: () => setError(null) };
}
