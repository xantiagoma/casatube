/**
 * The queue, live.
 *
 * Every row comes from the last SSE snapshot — nothing here is local state, so
 * there is no way for the screen to remember something the server has forgotten
 * (R3).
 */
import type { Job } from "../../core/types";
import { formatClock } from "../data/format";
import type { ConnectionState } from "../data/useQueue";
import { JobCard } from "./JobCard";

interface QueueListProps {
  jobs: Job[];
  at: string | null;
  connection: ConnectionState;
}

export function QueueList({ jobs, at, connection }: QueueListProps): React.JSX.Element {
  const active = jobs.filter((job) => job.status !== "done" && job.status !== "cancelled").length;

  return (
    <section>
      <div className="queue-head">
        <h2>Queue</h2>
        <span className="meta">
          {jobs.length} job{jobs.length === 1 ? "" : "s"}
          {active > 0 ? ` · ${active} not finished` : ""}
          {at ? ` · updated ${formatClock(at)}` : ""}
        </span>
      </div>

      {jobs.length === 0 ? (
        <p className="empty">
          {connection === "live"
            ? "Nothing queued yet. Paste a URL above and it will show up here."
            : "Waiting for the server…"}
        </p>
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
