/**
 * The SSE stream — a **pusher**, not an owner.
 *
 * Every frame it receives goes into the React Query cache under `JOBS_KEY`, the
 * same entry `useJobs` reads. Nothing about the queue is stored here.
 *
 * That is the difference that matters when the stream drops: the cache still
 * holds the last good snapshot, React Query starts polling because `live` went
 * false, and reconnecting simply resumes pushing. A stream that owned its own
 * `useState` would instead leave a frozen table that nothing can refresh and
 * nobody notices.
 *
 * The stream is read through Eden like every other call. `EventSource` was the
 * obvious alternative and loses the types — it hands back `string`, so the
 * frame shapes would be re-declared here, free to drift from the server's. What
 * it gives away for free is reconnection, so that is written out below: about
 * fifteen lines, and it can back off properly, which `EventSource` cannot.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { Job } from "../../core/types";
import { api } from "./client";
import { JOBS_KEY, type JobPage, type QueueSnapshot } from "./queries";

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface StreamState {
  connection: ConnectionState;
  /** Set while the stream cannot be established. Diagnostic, not the UI's truth. */
  problem: string | null;
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Narrow a wire frame.
 *
 * The stream crosses a process boundary, so it is checked rather than trusted:
 * a server mid-upgrade can legitimately send a frame this build has never seen,
 * and the right answer to that is to ignore it — not to crash the page, and not
 * to overwrite a good snapshot with nonsense.
 */
function snapshotOf(frame: unknown): QueueSnapshot | null {
  if (!frame || typeof frame !== "object") return null;
  const { event, data } = frame as { event?: unknown; data?: unknown };
  if (event !== "snapshot" || !data || typeof data !== "object") return null;
  const { at, jobs } = data as { at?: unknown; jobs?: unknown };
  if (typeof at !== "string" || !Array.isArray(jobs)) return null;
  return { at, jobs: jobs as Job[] };
}

/**
 * Which rows exist, and in what state — everything a *filter* could care about.
 *
 * Deliberately not the whole row: progress, speed and bytes move constantly and
 * change nothing about which page a job belongs on. Including them would make
 * every frame look like a membership change and refetch the sorted page twice a
 * second, which is the poll this design exists to avoid.
 */
export function membershipOf(snapshot: QueueSnapshot): string {
  let signature = "";
  for (const job of snapshot.jobs) {
    signature += `${job.id}|${job.status}|${job.paused ? 1 : 0}|${job.notBefore ?? ""}|${job.priority}|${job.totalBytes ?? ""}|${job.duration ?? ""}\n`;
  }
  return signature;
}

/**
 * Push the frame into every sorted page the screens are holding.
 *
 * Two different things, and separating them is the point:
 *
 * 1. **Rows are patched in place, by id.** A progress bar moving is not a
 *    reason to re-ask the server for a page it would return unchanged — and a
 *    refetch would also mean the table cannot update while a request is in
 *    flight, which on a slow mount is most of the time.
 * 2. **The page is refetched only when membership changed** — a job appeared,
 *    finished, was paused, or had a value one of the sorts orders by written to
 *    it. Those are the only frames that can move a row onto or off a page, and
 *    the server is the only thing that knows where it lands.
 *
 * ⚠️ Patching cannot *add* a row: this snapshot is the live queue's own window,
 * not the screen's filtered page, and inventing a position for a new job here
 * would put it somewhere the sort did not choose. That case is a membership
 * change, which is why the refetch exists.
 */
export function applyToPages(
  client: ReturnType<typeof useQueryClient>,
  snapshot: QueueSnapshot,
  previous: string | null,
): string {
  const fresh = new Map(snapshot.jobs.map((job) => [job.id, job]));
  const pages = client.getQueryCache().findAll({ queryKey: ["jobs", "list"] });

  for (const page of pages) {
    const data = page.state.data as JobPage | undefined;
    if (!data) continue;
    let changed = false;
    const patched = data.jobs.map((job) => {
      const update = fresh.get(job.id);
      if (update === undefined || update === job) return job;
      changed = true;
      return update;
    });
    if (changed) client.setQueryData<JobPage>(page.queryKey, { ...data, jobs: patched });
  }

  const membership = membershipOf(snapshot);
  if (previous !== null && membership !== previous) {
    void client.invalidateQueries({ queryKey: ["jobs", "list"] });
  }
  return membership;
}

export function useJobStream(): StreamState {
  const client = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // What the last frame's rows *were*, so a frame that only moved a progress
    // bar can be told apart from one where a job appeared, finished or paused.
    let membership: string | null = null;
    // The signal is read on every loop turn and every frame; reaching through
    // the controller each time is a property lookup in a hot path for nothing.
    const { signal } = controller;
    let attempt = 0;

    const run = async (): Promise<void> => {
      while (!signal.aborted) {
        try {
          const stream = await api.api.events.get({ fetch: { signal } });
          if (signal.aborted) return;
          if (!stream.data) throw new Error("the server did not open the stream");

          attempt = 0;
          setConnection("live");
          setProblem(null);
          // Whatever happened while we were away is already in the first frame
          // — it is a whole snapshot — but asking costs nothing and covers the
          // case where the stream opens and then says nothing for a while.
          void client.invalidateQueries({ queryKey: JOBS_KEY });

          for await (const frame of stream.data) {
            if (signal.aborted) return;
            const snapshot = snapshotOf(frame);
            if (!snapshot) continue; // heartbeat, or something newer than this build
            client.setQueryData<QueueSnapshot>(JOBS_KEY, snapshot);
            membership = applyToPages(client, snapshot, membership);
          }
        } catch (cause) {
          if (signal.aborted) return;
          setProblem(cause instanceof Error ? cause.message : String(cause));
        }

        if (signal.aborted) return;
        // The stream ended — a restart, a dropped connection, a sleeping
        // laptop. The queue is unaffected by all of them (R1, R2); only this
        // view needs putting back together.
        setConnection("reconnecting");
        attempt += 1;
        await sleep(Math.min(FIRST_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS));
      }
    };

    void run();
    return () => controller.abort();
  }, [client]);

  return { connection, problem };
}
