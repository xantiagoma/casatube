/**
 * The queue as a table.
 *
 * 🔴 Everything here is read from one React Query entry that the SSE stream
 * pushes into. No row keeps state of its own, so a reload — or a dropped
 * stream, or a server restart — rebuilds the whole table from the server and
 * nothing is lost in a component that went away (R3).
 *
 * ⚠️ Selecting a row writes the id into the URL, not into a `useState`. That is
 * what makes an inspector view shareable and survive a refresh (PLAN §8).
 */
import type { ReactNode } from "react";
import { ExternalLink, Pause, Play, RotateCcw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Job } from "../../../core/types";
import { formatBytes, formatClock, formatDuration, formatPercent, formatSpeed, hostOf } from "../../data/format";
import { useCancelJob, usePauseJob, useResumeJob, useRetryJob } from "../../data/queries";
import { PriorityMark, ProgressBar, StatusPill } from "../common/Bits";
import { isTerminal } from "../status";
import { StageTrack } from "./StageTrack";
import { formatLabel, jobTitle, progressOf } from "./job-view";

/**
 * The thumbnail on a row.
 *
 * **128 px wide, 16:9.** It was 64, which is small enough that a video is a
 * coloured smudge — and the thumbnail is how you recognise a row at a glance,
 * so at that size the column was costing space without paying for it. The
 * duration chip grew with it, for the same reason.
 */
function Thumb({ job }: { job: Job }) {
  return (
    <span className="relative block h-18 w-32 shrink-0 overflow-hidden rounded-md bg-muted">
      {job.thumbnail ? (
        <img src={job.thumbnail} alt="" className="size-full object-cover" loading="lazy" />
      ) : null}
      {job.duration ? (
        <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] leading-tight text-white tabular-nums">
          {formatDuration(job.duration)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The mark that a job is on hold.
 *
 * 🔴 It has to be its own badge because `paused` is **not a status**: it is a
 * separate column, and the status underneath goes on saying `Queued`. Without
 * this, a held job and a waiting job are the same row on screen — which is how
 * "why has this never started?" becomes a twenty-minute question.
 */
export function PausedMark() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning ring-1 ring-warning/30 ring-inset whitespace-nowrap">
      <Pause className="size-2.5" aria-hidden />
      Paused
    </span>
  );
}

/**
 * Pause and resume, together, always.
 *
 * 🔴 `POST /api/jobs/:id/resume` existed with **nothing calling it**, which is
 * the shape of bug worth naming: a hold with no release. The two buttons are
 * written in one place so neither can be shipped without the other.
 *
 * ⚠️ **Pause is offered on a queued job only.** `paused` is a column the claim
 * query filters on, and nothing in the worker reads it mid-run — so pausing
 * something that is already downloading would leave the download running and
 * the button looking broken. Cancel is the honest control for a job in flight,
 * and it is already here.
 */
function JobActions({ job, compact = false }: { job: Job; compact?: boolean }) {
  const cancel = useCancelJob();
  const retry = useRetryJob();
  const pause = usePauseJob();
  const resume = useResumeJob();
  const canRetry = job.status === "failed" || job.status === "cancelled";
  const canPause = job.status === "queued" && job.paused !== true;
  const canResume = job.paused === true && !isTerminal(job.status);

  return (
    <div className="flex items-center gap-1">
      {canResume ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-warning hover:text-warning"
              disabled={resume.isPending}
              onClick={(event) => {
                event.stopPropagation();
                resume.mutate(job.id);
              }}
              aria-label="Resume"
            >
              <Play className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Let the worker pick it up again</TooltipContent>
        </Tooltip>
      ) : null}

      {canPause ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={pause.isPending}
              onClick={(event) => {
                event.stopPropagation();
                pause.mutate(job.id);
              }}
              aria-label="Pause"
            >
              <Pause className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hold it in the queue — nothing is lost</TooltipContent>
        </Tooltip>
      ) : null}

      {canRetry ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={retry.isPending}
              onClick={(event) => {
                event.stopPropagation();
                retry.mutate(job.id);
              }}
              aria-label="Retry"
            >
              <RotateCcw className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Put it back in the queue</TooltipContent>
        </Tooltip>
      ) : null}

      {!isTerminal(job.status) ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive"
              disabled={cancel.isPending}
              onClick={(event) => {
                event.stopPropagation();
                cancel.mutate(job.id);
              }}
              aria-label="Cancel"
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Cancel this job</TooltipContent>
        </Tooltip>
      ) : null}

      {!compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => event.stopPropagation()}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Open the source"
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </TooltipTrigger>
          <TooltipContent>Open the source URL</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function JobTable({
  jobs,
  selectedId,
  onSelect,
  badge,
}: {
  jobs: Job[];
  selectedId?: string | undefined;
  onSelect(id: string): void;
  /**
   * An extra mark beside the status pill.
   *
   * Additive and optional: Downloads uses it to say what became of the file,
   * which is a fact about the *download*, not about the job's status — and the
   * Queue, where nothing has finished moving yet, passes nothing and looks
   * exactly as it did.
   */
  badge?: ((job: Job) => ReactNode) | undefined;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Priority</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Format</th>
            <th className="px-3 py-2 font-medium">Retries</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="w-56 px-3 py-2 font-medium">Progress</th>
            <th className="px-3 py-2 font-medium">Added</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const progress = progressOf(job);
            const selected = job.id === selectedId;
            return (
              <tr
                key={job.id}
                onClick={() => onSelect(job.id)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(job.id);
                  }
                }}
                aria-selected={selected}
                className={cn(
                  "cursor-pointer border-b transition-colors last:border-0 hover:bg-accent/40",
                  selected && "bg-primary/5",
                )}
              >
                <td className="px-3 py-2.5">
                  <PriorityMark priority={job.priority} />
                </td>
                <td className="max-w-[22rem] px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Thumb job={job} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{jobTitle(job)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{hostOf(job.url)}</span>
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{formatLabel(job)}</td>
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-muted-foreground">
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill status={job.status} />
                    {job.paused ? <PausedMark /> : null}
                    {badge?.(job)}
                  </div>
                </td>
                <td className="w-48 min-w-40 px-3 py-2.5">
                  <ProgressBar
                    percent={progress.percent}
                    indeterminate={progress.indeterminate}
                    tone={job.status === "failed" ? "destructive" : job.status === "done" ? "success" : "primary"}
                  />
                  <span className="mt-1 flex justify-between gap-2 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                    <span>{progress.indeterminate ? "working" : formatPercent(progress.percent)}</span>
                    <span>
                      {job.speed ? formatSpeed(job.speed) : job.totalBytes ? formatBytes(job.totalBytes) : ""}
                    </span>
                  </span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                  {formatClock(job.createdAt)}
                </td>
                <td className="px-3 py-2.5">
                  <JobActions job={job} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The same rows, stacked — what the dashboard and a narrow screen show.
 *
 * Deliberately **not** selectable: the row already carries its own buttons, and
 * a whole <li> that reacts to a click is a control a keyboard cannot reach. The
 * screens that need selection use `JobTable`, whose rows are focusable.
 */
export function JobList({ jobs }: { jobs: Job[] }) {
  return (
    <ul className="divide-y">
      {jobs.map((job) => {
        const progress = progressOf(job);
        return (
          <li key={job.id} className="flex items-center gap-3 px-1 py-2.5">
            <Thumb job={job} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{jobTitle(job)}</p>
              <div className="mt-1 flex items-center gap-2">
                <ProgressBar
                  percent={progress.percent}
                  indeterminate={progress.indeterminate}
                  tone={job.status === "failed" ? "destructive" : job.status === "done" ? "success" : "primary"}
                  className="flex-1"
                />
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {progress.indeterminate ? "…" : formatPercent(progress.percent)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {[formatLabel(job), job.speed ? formatSpeed(job.speed) : null, job.eta ? `${formatDuration(job.eta)} left` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <StageTrack stages={job.stages} className="mt-1.5" />
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <StatusPill status={job.status} />
              {job.paused ? <PausedMark /> : null}
              <JobActions job={job} compact />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
