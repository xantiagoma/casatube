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
import { ExternalLink, RotateCcw, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { Job } from "../../../core/types";
import { formatBytes, formatDateTime, formatDuration, formatSpeed, formatUntil, hostOf } from "../../data/format";
import { useCancelJob, useRetryJob } from "../../data/queries";
import { PriorityMark, StatusPill } from "../common/Bits";
import { isTerminal } from "../status";
import { StagePipeline } from "./StageTrack";
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
}: {
  job: Job;
  tab: "details" | "tasks" | "logs";
  onTab(next: "details" | "tasks" | "logs"): void;
  onClose(): void;
}) {
  const cancel = useCancelJob();
  const retry = useRetryJob();
  const logEnd = useRef<HTMLDivElement>(null);

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
              <Row label="Status" value={<StatusPill status={job.status} />} />
              <Row label="Priority" value={<PriorityMark priority={job.priority} />} />
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
