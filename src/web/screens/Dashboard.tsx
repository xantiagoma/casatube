/**
 * The dashboard: queue something, see what is running, see what it costs.
 *
 * The four blocks come straight from the reference design — quick download,
 * active queue, storage, analytics — and they are deliberately *summaries*.
 * Every one of them links to the screen that owns the detail, so the dashboard
 * never becomes a second, subtly different implementation of the queue.
 */
import { Link, useSearch } from "@tanstack/react-router";
import { ArrowRight, HardDrive, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { StatsRange } from "../../core/stats";
import { Sparkline } from "../components/charts/Sparkline";
import { EmptyState, ErrorState, StatTile, UsageBar } from "../components/common/Bits";
import { DownloadForm } from "../components/jobs/DownloadForm";
import { JobList } from "../components/jobs/JobTable";
import { bucketOf } from "../components/jobs/job-view";
import { PageHeader } from "../components/layout/AppShell";
import { formatBytes, formatCount, formatElapsed } from "../data/format";
import { useJobs } from "../data/queries";
import { useAnalytics, useStorage } from "../data/stats";
import { useSetSearch } from "../hooks/use-set-search";
import { useJobStream } from "../data/stream";

function StorageCard() {
  const storage = useStorage();

  if (storage.isPending) return <Skeleton className="h-40 w-full" />;
  if (storage.isError) return <ErrorState error={storage.error} what="Storage" retry={() => void storage.refetch()} />;

  const disks = [
    { label: "Library", disk: storage.data.library },
    { label: "Temp", disk: storage.data.temp },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Storage</CardTitle>
        <CardAction><Button asChild variant="ghost" size="sm" className="gap-1 text-xs">
          <Link to="/storage">
            View storage <ArrowRight className="size-3" aria-hidden />
          </Link>
        </Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {disks.map(({ label, disk }) => (
          <div key={label}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-medium">{label}</span>
              <span className="truncate pl-2 text-muted-foreground">{disk.path}</span>
            </div>
            {disk.available ? (
              <>
                <UsageBar usedPercent={disk.usedPercent} />
                <div className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
                  <span>
                    {formatBytes(disk.usedBytes)} used ({Math.round(disk.usedPercent)}%)
                  </span>
                  <span>{formatBytes(disk.freeBytes)} free</span>
                </div>
              </>
            ) : (
              /* ⚠️ One disk being unreachable is the normal state of a sleeping
                 NAS, not a broken screen. The other card still has numbers. */
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {disk.error.message}
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  const { range } = useSearch({ from: "/" });
  /**
   * ⚠️ Not `useNavigate` directly. The analytics window lives in the URL, so
   * changing it is a navigation — and TanStack Router's `resetScroll` defaults
   * to true, which threw the dashboard back to the top every time. Measured:
   * scrollTop 448 → 0. See `use-set-search.ts`.
   */
  const setSearch = useSetSearch<{ range: StatsRange }>();
  const stream = useJobStream();
  const jobs = useJobs(stream.connection === "live");
  const analytics = useAnalytics(range);

  const all = jobs.data?.jobs ?? [];
  const active = all.filter((job) => bucketOf(job) === "active").slice(0, 6);
  const recent = all
    .filter((job) => job.status === "done")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5);

  const series = analytics.data?.series ?? [];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Paste a URL, watch the queue, and see what it is costing."
        actions={
          <Select value={range} onValueChange={(next) => setSearch((previous) => ({ ...previous, range: next as StatsRange }))}>
            {/* 🔴 The other half of the scroll bug, and it is not the router.
                Radix focuses the trigger on pointer-down with a bare `focus()`,
                and focusing an element the browser considers off-screen scrolls
                it into view — so the first use of this control threw the page
                back to the top. Measured: `scrollTop` 350 → 0 with
                `scrollHeight` unchanged, and neither `window.scrollTo` nor the
                `scrollTop` setter called; the instrumented call was
                `focus()` on this button with no options, immediately followed
                by Radix's own `focus({ preventScroll: true })`.

                Focusing it here first, with `preventScroll`, makes that second
                call a no-op on an already-focused element. It only ever bit the
                *first* interaction, which is exactly why it survived. */}
            <SelectTrigger
              className="w-28"
              aria-label="Analytics window"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">24 hours</SelectItem>
              <SelectItem value="7d">7 days</SelectItem>
              <SelectItem value="30d">30 days</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <div className="min-w-0 space-y-4">
          <DownloadForm />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Active queue{" "}
                <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                  {all.filter((job) => bucketOf(job) === "active").length}
                </span>
              </CardTitle>
              <CardAction><Button asChild variant="ghost" size="sm" className="gap-1 text-xs">
                <Link to="/queue">
                  Open queue <ArrowRight className="size-3" aria-hidden />
                </Link>
              </Button></CardAction>
            </CardHeader>
            <CardContent>
              {jobs.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : jobs.isError ? (
                <ErrorState error={jobs.error} what="The queue" retry={() => void jobs.refetch()} />
              ) : active.length === 0 ? (
                <EmptyState
                  title="Nothing running"
                  hint="Paste a URL above. Once queued, a job survives this tab closing and the server restarting."
                />
              ) : (
                <JobList jobs={active} />
              )}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <StorageCard />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recent downloads</CardTitle>
              <CardAction><Button asChild variant="ghost" size="sm" className="gap-1 text-xs">
                <Link to="/library">
                  Library <ArrowRight className="size-3" aria-hidden />
                </Link>
              </Button></CardAction>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">Nothing finished yet.</p>
              ) : (
                <JobList jobs={recent} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Analytics <span className="text-sm font-normal text-muted-foreground">({range})</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {analytics.isPending ? (
                <Skeleton className="h-32 w-full" />
              ) : analytics.isError ? (
                <ErrorState error={analytics.error} what="Analytics" retry={() => void analytics.refetch()} />
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <StatTile label="Jobs" value={formatCount(analytics.data.jobs)} className="border-0 shadow-none" />
                    <StatTile
                      label="Success rate"
                      value={`${Math.round(analytics.data.successRate * 100)}%`}
                      className="border-0 shadow-none"
                    />
                    <StatTile
                      label="Downloaded"
                      value={formatBytes(analytics.data.bytes)}
                      className="border-0 shadow-none"
                    />
                    <StatTile
                      label="Worker time"
                      value={formatElapsed(analytics.data.totalMs)}
                      className="border-0 shadow-none"
                    />
                  </div>
                  <div className="mt-2">
                    <Sparkline values={series.map((bucket) => bucket.bytes)} />
                  </div>
                  {analytics.data.truncated ? (
                    <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
                      <HardDrive className="mt-0.5 size-3 shrink-0" aria-hidden />
                      More history than the window holds — these numbers cover part of it.
                    </p>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
