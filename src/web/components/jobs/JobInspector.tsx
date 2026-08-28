/**
 * One job, in full: what it is, where it is in the pipeline, and what it said.
 *
 * 🔴 The three tabs are the three questions PLAN §6 says a job has to be able
 * to answer — *what was asked for*, *how far it got*, and *what happened*. The
 * log is a product feature, not debug output: when a download fails at 4 a.m.,
 * the line that says why is the difference between fixing it and guessing.
 *
 * It reads the job out of the same snapshot the table renders, so it moves with
 * the stream instead of polling beside it.
 */
import { useEffect, useRef } from "react";
import { CircleHelp, Download, ExternalLink, Pause, Play, RotateCcw, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Job, Priority } from "../../../core/types";

/**
 * The three, in the order the queue works through them.
 *
 * ⚠️ Ordered highest-first because that is what a select of ranks has to be:
 * alphabetical would read High, Low, Normal, which looks like an ordering and
 * is not one.
 */
const PRIORITIES: readonly Priority[] = ["high", "normal", "low"] as const;

const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
};
import { formatBytes, formatDateTime, formatDuration, formatSpeed, formatUntil, hostOf } from "../../data/format";
import { useCancelJob, usePauseJob, useRedownload, useResumeJob, useRetryJob, useSetPriority } from "../../data/queries";
import { PriorityMark, StatusPill } from "../common/Bits";
import { isTerminal } from "../status";
import { PausedMark } from "./JobTable";
import { FileStateBadge, unknownReasonText } from "./JobFilters";
import { StagePipeline } from "./StageTrack";
import type { ResolvedFileState } from "./job-order";
import { formatLabel, jobTitle } from "./job-view";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs font-medium">{value}</dd>
    </div>
  );
}

export function JobInspector({
  job,
  tab,
  onTab,
  onClose,
  fileState,
}: {
  job: Job;
  tab: "details" | "tasks" | "logs";
  onTab(next: "details" | "tasks" | "logs"): void;
  onClose(): void;
  /**
   * What the server found on disk for this job.
   *
   * Passed in rather than fetched here: the screen already asked about every
   * row in one batch, and a panel that asked again would be a second `stat` for
   * a file that was checked a moment ago — and a second, possibly *different*,
   * answer sitting next to the badge on the row behind it.
   */
  fileState?: ResolvedFileState | undefined;
}) {
  const cancel = useCancelJob();
  const retry = useRetryJob();
  const redownload = useRedownload();
  const missing = fileState?.state === "missing";
  const uncheckable =
    fileState?.state === "unknown" && fileState.reason !== "not-finished" && fileState.reason !== "not-checked";
  const pause = usePauseJob();
  const resume = useResumeJob();
  const logEnd = useRef<HTMLDivElement>(null);

  // ⚠️ The same rule as the row's buttons, and it lives in both places on
  // purpose: pause is a *claim* filter, so it is offered where it does what it
  // says. See `JobActions` in `JobTable.tsx`.
  const priority = useSetPriority();
  // The same rule the server enforces, so the control is absent rather than
  // present-and-refused.
  const canReprioritise = !isTerminal(job.status);
  const canPause = job.status === "queued" && job.paused !== true;
  const canResume = job.paused === true && !isTerminal(job.status);

  // The interesting line is always the last one. Following it is what makes the
  // log usable while something is running rather than only afterwards.
  useEffect(() => {
    if (tab === "logs") logEnd.current?.scrollIntoView({ block: "end" });
  }, [tab, job.log.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 border-b p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{jobTitle(job)}</p>
          <p className="truncate text-xs text-muted-foreground">{hostOf(job.url)}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Added {formatDateTime(job.createdAt)} · ID {job.id.slice(0, 8)}
          </p>
        </div>
        <a
          href={job.url}
          target="_blank"
          rel="noreferrer noopener"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Open the source URL"
        >
          <ExternalLink className="size-4" aria-hidden />
        </a>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={onClose} aria-label="Close inspector">
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(next) => onTab(next as "details" | "tasks" | "logs")} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 w-[calc(100%-2rem)]">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
          <TabsContent value="details" className="mt-0">
            <dl className="divide-y">
              <Row
                label="Status"
                value={
                  <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                    <StatusPill status={job.status} />
                    {job.paused ? <PausedMark /> : null}
                  </span>
                }
              />
              {/* 🔴 Editable while the job can still be reordered, a plain mark
                  once it cannot. Priority is an instruction about *when work
                  happens*, and a job that is done, failed or cancelled has no
                  "when" left — the server refuses it with a 409, so offering
                  the control there would be a select that errors on use. */}
              <Row
                label="Priority"
                value={
                  canReprioritise ? (
                    <Select
                      value={job.priority}
                      onValueChange={(next) => priority.mutate({ id: job.id, priority: next as Priority })}
                      disabled={priority.isPending}
                    >
                      <SelectTrigger size="sm" className="h-7 w-[7.5rem]" aria-label="Priority">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRIORITIES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {PRIORITY_LABEL[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <PriorityMark priority={job.priority} />
                  )
                }
              />
              <Row label="Format" value={formatLabel(job)} />
              <Row label="Retries" value={`${job.attempts} / ${job.maxAttempts}`} />
              <Row label="Provider" value={job.provider ?? "not resolved yet"} />
              <Row label="Destination" value={job.destination === "" ? "library root" : job.destination} />
              <Row label="Duration" value={formatDuration(job.duration)} />
              <Row
                label="Downloaded"
                value={
                  job.totalBytes
                    ? `${formatBytes(job.doneBytes)} / ${formatBytes(job.totalBytes)}`
                    : formatBytes(job.doneBytes)
                }
              />
              <Row label="Speed" value={job.speed ? formatSpeed(job.speed) : "—"} />
              <Row label="ETA" value={job.eta ? formatDuration(job.eta) : "—"} />
              <Row label="Output" value={job.outputFile ?? "—"} />
              {fileState && fileState.state !== "unknown" ? (
                <Row label="File" value={<FileStateBadge state={fileState} />} />
              ) : null}
              {fileState?.state === "present" && fileState.size !== undefined ? (
                <Row label="On disk" value={formatBytes(fileState.size)} />
              ) : null}
              <Row label="Updated" value={formatDateTime(job.updatedAt)} />
              {job.notBefore ? <Row label="Next attempt" value={formatUntil(job.notBefore)} /> : null}
              {job.claimedBy ? <Row label="Worker" value={job.claimedBy} /> : null}
            </dl>

            {job.error ? (
              <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <p className="flex items-center gap-2 text-xs font-medium text-destructive">
                  <TriangleAlert className="size-3.5" aria-hidden />
                  Last error
                </p>
                <p className="mt-1 text-xs break-words text-muted-foreground">{job.error}</p>
                {job.attempts < job.maxAttempts && !isTerminal(job.status) ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Retrying ({job.attempts}/{job.maxAttempts}) {job.notBefore ? formatUntil(job.notBefore) : ""}.
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* 🔴 A held job reports its underlying status forever and shows no
                progress, which reads exactly like a stuck queue. Saying what is
                actually true — and that one button undoes it — is the whole
                reason `resume` had to be wired up. */}
            {job.paused && !isTerminal(job.status) ? (
              <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
                <p className="font-medium text-warning">On hold</p>
                <p className="mt-1 text-muted-foreground">
                  The worker will not pick this up while it is paused. Nothing has been lost and nothing expires —
                  Resume puts it back in line exactly where its priority says.
                </p>
              </div>
            ) : null}

            {/* 🔴 The one place this work has to become an action rather than a
                colour. A download whose file is gone is not information — it is
                a thing to do something about, and until now the only way to do
                it was to copy the URL out and queue it again by hand. */}
            {missing ? (
              <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <p className="flex items-center gap-2 text-xs font-medium text-destructive">
                  <TriangleAlert className="size-3.5" aria-hidden />
                  The file is not there any more
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The library answered and there is nothing at <span className="font-mono">{fileState?.path}</span>.
                  It was removed or moved outside CasaTube — the download itself succeeded.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2.5 gap-1.5"
                  disabled={redownload.isPending}
                  onClick={() => redownload.mutate(job.id)}
                >
                  <Download className="size-3.5" aria-hidden />
                  {redownload.isPending ? "Queueing…" : "Download it again"}
                </Button>
                {/* ⚠️ Said out loud, because the queue is where it lands and
                    this panel is not going to change to show it. */}
                {redownload.isSuccess ? (
                  <p className="mt-2 text-xs text-success">Queued again — it is in the queue as a new job.</p>
                ) : null}
                {redownload.isError ? (
                  <p className="mt-2 text-xs text-destructive">{redownload.error.message}</p>
                ) : null}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  It is queued with the same settings this job used, so the copy that arrives matches the one that
                  went missing.
                </p>
              </div>
            ) : null}

            {/* ⚠️ Not an error, and deliberately not styled as one. A library
                that cannot be read says nothing about the file — the mistake
                this whole feature exists to stop making is treating that
                silence as bad news. */}
            {uncheckable ? (
              <div className="mt-4 rounded-lg border bg-muted/40 p-3">
                <p className="flex items-center gap-2 text-xs font-medium">
                  <CircleHelp className="size-3.5" aria-hidden />
                  The file could not be checked
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{unknownReasonText(fileState!)}</p>
              </div>
            ) : null}

            {job.status === "waiting-for-destination" ? (
              <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
                <p className="font-medium text-warning">Waiting for the library</p>
                <p className="mt-1 text-muted-foreground">
                  The download finished and the file is safe in the temp directory. It moves as soon as the
                  destination answers — nothing has been lost.
                </p>
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="tasks" className="mt-0">
            <StagePipeline stages={job.stages} />
          </TabsContent>

          <TabsContent value="logs" className="mt-0">
            {job.log.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing logged yet.</p>
            ) : (
              <div className="scrollbar-thin max-h-[28rem] overflow-auto rounded-lg bg-foreground/[0.04] p-3 dark:bg-black/40">
                <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {job.log.join("\n")}
                </pre>
                <div ref={logEnd} />
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>

      <div className="flex flex-wrap gap-2 border-t p-3">
        {canResume && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-warning hover:text-warning"
            disabled={resume.isPending}
            onClick={() => resume.mutate(job.id)}
          >
            <Play className="size-3.5" aria-hidden />
            Resume
          </Button>
        )}
        {canPause && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={pause.isPending}
            onClick={() => pause.mutate(job.id)}
          >
            <Pause className="size-3.5" aria-hidden />
            Pause
          </Button>
        )}
        {(job.status === "failed" || job.status === "cancelled") && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={retry.isPending}
            onClick={() => retry.mutate(job.id)}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Retry
          </Button>
        )}
        {!isTerminal(job.status) && (
          <Button
            variant="outline"
            size="sm"
            className={cn("gap-1.5 text-destructive hover:text-destructive")}
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(job.id)}
          >
            <X className="size-3.5" aria-hidden />
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
