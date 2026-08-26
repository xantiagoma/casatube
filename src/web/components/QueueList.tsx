/**
 * The queue, live.
 *
 * Every row comes from the React Query cache, which the SSE stream keeps
 * current. Nothing here is local state, so there is no way for the screen to
 * remember something the server has forgotten (R3) — and when the stream drops,
 * the last good snapshot is still on screen with the query refreshing it,
 * rather than a frozen table nobody notices.
 */
import type { UseQueryResult } from "@tanstack/react-query";

import { formatClock } from "../data/format";
import { failureOf } from "../data/client";
import type { QueueSnapshot } from "../data/queries";
import type { ConnectionState } from "../data/stream";
import { JobCard } from "./JobCard";

interface QueueListProps {
  query: UseQueryResult<QueueSnapshot, Error>;
  connection: ConnectionState;
}

export function QueueList({ query, connection }: QueueListProps): React.JSX.Element {
  const jobs = query.data?.jobs ?? [];
  const active = jobs.filter((job) => job.status !== "done" && job.status !== "cancelled").length;
  const error = query.error ? (failureOf(query.error)?.message ?? query.error.message) : null;

  return (
    <section>
      <div className="queue-head">
        <h2>Queue</h2>
        <span className="meta">
          {jobs.length} job{jobs.length === 1 ? "" : "s"}
          {active > 0 ? ` · ${active} not finished` : ""}
          {query.data ? ` · updated ${formatClock(query.data.at)}` : ""}
          {/* Only worth showing when the push is down; otherwise every snapshot
              would flash a spinner for something that is working perfectly. */}
          {connection !== "live" && query.isFetching ? " · refreshing" : ""}
        </span>
      </div>

      {error && <div className="note error">Could not read the queue: {error}</div>}

      {query.isPending ? (
        <p className="empty">Loading the queue…</p>
      ) : jobs.length === 0 ? (
        <p className="empty">Nothing queued yet. Paste a URL above and it will show up here.</p>
      ) : (
        <div className="jobs">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </section>
  );
}
