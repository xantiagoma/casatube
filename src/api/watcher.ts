/**
 * What the live queue view is built on.
 *
 * The browser only observes (R3), so the server has to be the one that says
 * "something changed". This is that mechanism — deliberately kept out of the
 * route, so the transport (SSE today) and the change detection are separable.
 *
 * ## Why it polls instead of listening
 *
 * An in-process event bus would be cheaper and would be **wrong**. Job rows are
 * written by whoever holds the lease, and the worker is only in this process by
 * today's packaging decision — `claimNext` is built so it need not be (PLAN §17
 * rule 1). A bus would silently see only the writes that happened to share our
 * memory, and the failure mode is the worst kind: the queue advances and the UI
 * says nothing.
 *
 * Re-reading the table is a handful of rows from a local SQLite file on WAL. It
 * is correct no matter who did the writing, which is the property worth paying
 * for.
 *
 * ## One poller, many subscribers
 *
 * The timer starts with the first subscriber and stops with the last, so an
 * idle server with no tab open does no work.
 */
import type { Job } from "../core/types";
import type { JobQueue } from "../core/queue";

export interface QueueSnapshot {
  /** When the server read this, ISO-8601 UTC. */
  at: string;
  jobs: Job[];
}

export type WatchEvent =
  | { type: "snapshot"; snapshot: QueueSnapshot }
  /**
   * Nothing changed, but the connection is alive.
   *
   * Without it an idle stream is indistinguishable from a dead one, and any
   * proxy in the way is free to close it.
   */
  | { type: "heartbeat"; at: string };

export interface QueueWatcherOptions {
  /** How often the table is re-read. */
  pollMs?: number;
  /** How long a silent stream waits before saying it is still there. */
  heartbeatMs?: number;
  /** Ceiling on rows per snapshot. */
  limit?: number;
}

export interface QueueWatcher {
  /** A fresh read, right now. Used by the first frame and by `GET /api/jobs`. */
  current(): Promise<QueueSnapshot>;
  /** Yields until `signal` aborts. Cleans itself up either way. */
  subscribe(signal: AbortSignal): AsyncGenerator<WatchEvent, void, unknown>;
  /** Live subscriber count — the honest answer to "is anything watching?". */
  subscribers(): number;
  /** Stops the timer regardless of subscribers. For shutdown. */
  stop(): void;
}

/**
 * Everything that would make a row look different on screen.
 *
 * `updatedAt` alone would *almost* do, and the "almost" is the problem: two
 * writes inside the same millisecond collapse into one string, and the second
 * one would never reach the browser. Progress and bytes cost nothing to include
 * and close that hole.
 */
function signatureOf(jobs: Job[]): string {
  let signature = "";
  for (const job of jobs) {
    signature += `${job.id}|${job.updatedAt}|${job.status}|${job.progress}|${job.doneBytes ?? ""}|${job.speed ?? ""}|${job.eta ?? ""}|${job.paused ? 1 : 0}\n`;
  }
  return signature;
}

export function createQueueWatcher(queue: JobQueue, options: QueueWatcherOptions = {}): QueueWatcher {
  const pollMs = options.pollMs ?? 750;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const limit = options.limit ?? 200;

  const listeners = new Set<(snapshot: QueueSnapshot) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let signature: string | null = null;
  let polling = false;

  async function read(): Promise<QueueSnapshot> {
    const jobs = await queue.list({ limit });
    return { at: new Date().toISOString(), jobs };
  }

  async function poll(): Promise<void> {
    // A slow read must not stack up behind itself; the next tick will do.
    if (polling) return;
    polling = true;
    try {
      const snapshot = await read();
      const next = signatureOf(snapshot.jobs);
      if (next === signature) return;
      signature = next;
      // Copied, because a listener may unsubscribe while we are notifying.
      for (const listener of [...listeners]) listener(snapshot);
    } catch {
      // A failed read is not worth tearing every stream down for: the next tick
      // retries, and the heartbeat keeps the connection honest meanwhile.
    } finally {
      polling = false;
    }
  }

  function ensureTimer(): void {
    if (timer !== null) return;
    timer = setInterval(() => void poll(), pollMs);
    // Node/Bun keep the process alive for an interval; this one should not.
    timer.unref?.();
  }

  function maybeStopTimer(): void {
    if (listeners.size > 0 || timer === null) return;
    clearInterval(timer);
    timer = null;
    // Forget the last signature: the next subscriber gets its own first frame
    // anyway, and a stale one would suppress a real change.
    signature = null;
  }

  return {
    current: read,
    subscribers: () => listeners.size,

    stop(): void {
      listeners.clear();
      maybeStopTimer();
    },

    async *subscribe(signal: AbortSignal): AsyncGenerator<WatchEvent, void, unknown> {
      const pending: QueueSnapshot[] = [];
      const wakers = new Set<() => void>();
      const wakeAll = (): void => {
        for (const wake of [...wakers]) wake();
      };

      const listener = (snapshot: QueueSnapshot): void => {
        // Only the newest matters — the snapshot is the whole state, so an
        // older one carries nothing the newer does not.
        pending.length = 0;
        pending.push(snapshot);
        wakeAll();
      };

      listeners.add(listener);
      ensureTimer();
      signal.addEventListener("abort", wakeAll, { once: true });

      try {
        // R3 starts here: the first frame is the entire state, so a reload
        // needs nothing it remembered from before.
        const first = await read();
        signature = signatureOf(first.jobs);
        yield { type: "snapshot", snapshot: first };

        while (!signal.aborted) {
          if (pending.length === 0) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                wakers.delete(finish);
                resolve();
              };
              const timeout = setTimeout(finish, heartbeatMs);
              wakers.add(finish);
            });
          }
          if (signal.aborted) break;

          const snapshot = pending.pop();
          pending.length = 0;
          yield snapshot
            ? { type: "snapshot", snapshot }
            : { type: "heartbeat", at: new Date().toISOString() };
        }
      } finally {
        listeners.delete(listener);
        signal.removeEventListener("abort", wakeAll);
        wakeAll();
        maybeStopTimer();
      }
    },
  };
}
