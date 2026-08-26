/**
 * One row of the queue.
 *
 * Presentation only: it receives a `Job` and two callbacks, and knows nothing
 * about how either reaches the server. That is what makes the later skin a
 * rewrite of this file alone.
 */
import { useState } from "react";

import type { Job } from "../../core/types";
import { cancelJob, retryJob, useAction } from "../data/useQueue";
import { formatBytes, formatDuration, formatPercent, formatRelative, formatSpeed } from "../data/format";
import { isTerminal, statusLook } from "./status";
import { StageTrack } from "./StageTrack";

/**
 * The bar's own reading of "how far along".
 *
 * Bytes when we have them, because the percentage the provider reports is
 * per-file and a 1080p download is several files in sequence — the bytes are
 * the only number that counts the whole job.
 */
function percentOf(job: Job): number {
  if (job.status === "done") return 100;
  if (job.totalBytes && job.doneBytes) {
    return Math.max(0, Math.min(100, (job.doneBytes / job.totalBytes) * 100));
  }
  return Math.max(0, Math.min(100, job.progress));
}

export function JobCard({ job }: { job: Job }): React.JSX.Element {
  const [showLog, setShowLog] = useState(false);
  const cancel = useAction(cancelJob);
  const retry = useAction(retryJob);

  const look = statusLook(job.status);
  const percent = percentOf(job);
  const terminal = isTerminal(job.status);
  const barTone = job.status === "done" ? "done" : job.status === "failed" ? "failed" : "";

  return (
    <article className="job">
      <div className="job-top">
        <div style={{ minWidth: 0, flex: "1 1 260px" }}>
          <p className="job-title">{job.title ?? "Untitled — not analysed yet"}</p>
          <p className="job-url">{job.url}</p>
        </div>
        <span className={`badge ${look.tone}`}>{look.label}</span>
        <div className="job-buttons">
          {!terminal && (
            <button
              type="button"
              className="small danger"
              disabled={cancel.pending}
              onClick={() => void cancel.run(job.id)}
            >
              {cancel.pending ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {(job.status === "failed" || job.status === "cancelled") && (
            <button
              type="button"
              className="small"
              disabled={retry.pending}
              onClick={() => void retry.run(job.id)}
            >
              {retry.pending ? "Retrying…" : "Retry"}
            </button>
          )}
          {job.log.length > 0 && (
            <button type="button" className="small" onClick={() => setShowLog((open) => !open)}>
              {showLog ? "Hide log" : "Log"}
            </button>
          )}
        </div>
      </div>

      <div className={`bar ${barTone}`} role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${percent}%` }} />
      </div>

      <div className="numbers">
        <span>{formatPercent(percent)}</span>
        <span>
          {formatBytes(job.doneBytes)} / {formatBytes(job.totalBytes)}
        </span>
        <span>{formatSpeed(job.speed)}</span>
        <span>ETA {formatDuration(job.eta)}</span>
        <span>
          {job.destination === "" ? "library root" : job.destination}
          {job.priority !== "normal" ? ` · ${job.priority} priority` : ""}
        </span>
        <span>updated {formatRelative(job.updatedAt)}</span>
        {job.attempts > 0 && (
          <span>
            attempt {job.attempts + 1} of {job.maxAttempts}
          </span>
        )}
      </div>

      <StageTrack stages={job.stages} />

      {job.error && (
        <div className="note error">
          <strong>Failed.</strong> {job.error}
        </div>
      )}

      {/* Held back, not lost: the file is in the temp directory and the move is
          being retried. Saying so is the difference between a wait and a scare. */}
      {job.status === "waiting-for-destination" && (
        <div className="note warn">
          The library is not reachable. The download is finished and kept safe; the move will be retried.
        </div>
      )}

      {job.status === "done" && job.outputFile && (
        <div className="note ok">
          Saved to <code>{job.outputFile}</code>
        </div>
      )}

      {cancel.error && <div className="note error">{cancel.error.message}</div>}
      {retry.error && <div className="note error">{retry.error.message}</div>}

      {showLog && (
        <pre className="note" style={{ maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap" }}>
          {job.log.join("\n")}
        </pre>
      )}
    </article>
  );
}
