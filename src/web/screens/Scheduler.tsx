/**
 * The scheduler: what it is doing, and when it will do it next.
 *
 * ⚠️ **"Run a pass now" answers 409 when one is already in flight** — the
 * server refuses to start a second sweep over the same due list rather than
 * silently doubling it. The button surfaces that as a message instead of
 * looking like it did nothing.
 */
import { useNavigate } from "@tanstack/react-router";
import { CalendarClock, CircleCheck, Play, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState, StatTile } from "../components/common/Bits";
import { PageHeader } from "../components/layout/AppShell";
import { formatCount, formatDateTime, formatInterval, formatRelative, formatUntil } from "../data/format";
import { useRunScheduler, useScheduler, useSources } from "../data/sources";

export function SchedulerScreen() {
  const status = useScheduler();
  const run = useRunScheduler();
  const sources = useSources();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Scheduler"
        description="One timer, servicing the sources that are due."
        actions={
          <Button className="gap-1.5" disabled={run.isPending || status.data?.inFlight} onClick={() => run.mutate()}>
            <Play className="size-4" aria-hidden />
            {status.data?.inFlight ? "A pass is running" : "Run a pass now"}
          </Button>
        }
      />

      {status.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : status.isError ? (
        <ErrorState error={status.error} what="The scheduler" retry={() => void status.refetch()} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="State"
              value={status.data.running ? (status.data.inFlight ? "Sweeping" : "Idle") : "Stopped"}
              hint={status.data.running ? `Ticks every ${formatInterval(status.data.tickMs / 60_000)}` : "Not started"}
            />
            <StatTile
              label="Next pass"
              value={status.data.nextPassAt ? formatUntil(status.data.nextPassAt) : "—"}
              hint={status.data.nextPassAt ? formatDateTime(status.data.nextPassAt) : "No pass scheduled"}
            />
            <StatTile
              label="Due now"
              value={formatCount(status.data.dueNow)}
              hint={
                status.data.nextSourceDueAt
                  ? `Next source ${formatUntil(status.data.nextSourceDueAt)}`
                  : "Nothing waiting"
              }
            />
            <StatTile
              label="Sources"
              value={formatCount(status.data.sources)}
              hint={`At most ${status.data.maxSourcesPerPass} per pass`}
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Last pass</CardTitle>
            </CardHeader>
            <CardContent>
              {status.data.lastPass === null ? (
                <EmptyState
                  icon={<CalendarClock className="size-6" aria-hidden />}
                  title="No pass has run yet"
                  hint="The scheduler sweeps on its own timer; you can also start one now."
                />
              ) : (
                <div className="space-y-3">
                  <p className="text-sm">
                    {formatRelative(status.data.lastPass.finishedAt)} — {status.data.lastPass.due} due,{" "}
                    {status.data.lastPass.checked.length} checked, {status.data.lastPass.deferred} deferred.
                  </p>
                  {status.data.lastPass.checked.length > 0 ? (
                    <ul className="divide-y text-sm">
                      {status.data.lastPass.checked.map((check) => {
                        const source = sources.data?.sources.find((candidate) => candidate.id === check.sourceId);
                        return (
                          <li key={check.sourceId} className="flex items-center gap-3 py-2">
                            <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{source?.name ?? check.sourceId}</span>
                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                              {check.discovered} found · {check.fresh} new · {check.enqueued.length} queued
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}

                  {status.data.lastPass.failures.length > 0 ? (
                    <ul className="space-y-1">
                      {status.data.lastPass.failures.map((failure) => {
                        const source = sources.data?.sources.find((candidate) => candidate.id === failure.sourceId);
                        return (
                          <li key={failure.sourceId} className="flex items-center gap-2 text-xs text-destructive">
                            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                            {source?.name ?? failure.sourceId}: {failure.tag}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          {run.isError ? (
            <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
              {run.error.message}
            </p>
          ) : null}
          {run.data ? (
            <p className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success">
              Pass finished: {run.data.due} due, {run.data.checked.length} checked, {run.data.deferred} deferred.
            </p>
          ) : null}

          <Button variant="outline" onClick={() => void navigate({ to: "/sources" })}>
            Manage sources
          </Button>
        </div>
      )}
    </>
  );
}
