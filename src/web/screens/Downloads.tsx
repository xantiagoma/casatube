/**
 * Downloads: the same jobs as the Queue, arranged the way the reference design
 * arranges them — by *what you would do about them* rather than by raw status.
 *
 * The four tabs are not four statuses. **Scheduled** is the one that earns its
 * place: a job whose `notBefore` is in the future is waiting out a retry
 * backoff, and that column exists precisely so the wait survives a restart
 * (PLAN R2). Without a tab for it, such a job reads as "queued and stuck".
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDockedPanels } from "@/hooks/use-media-query";
import { Sparkline } from "../components/charts/Sparkline";
import { EmptyState, ErrorState, StatTile } from "../components/common/Bits";
import { JobInspector } from "../components/jobs/JobInspector";
import { JobTable } from "../components/jobs/JobTable";
import { bucketOf, jobTitle } from "../components/jobs/job-view";
import { PageHeader } from "../components/layout/AppShell";
import { formatBytes, formatCount, formatSpeed } from "../data/format";
import { useJobs } from "../data/queries";
import { useAnalytics } from "../data/stats";
import { useJobStream } from "../data/stream";
import { DOWNLOAD_TABS, type DownloadTab } from "../search-params";

const TAB_LABEL: Record<DownloadTab, string> = {
  active: "Active",
  completed: "Completed",
  failed: "Failed",
  scheduled: "Scheduled",
};

export function Downloads() {
  const search = useSearch({ from: "/downloads" });
  const navigate = useNavigate({ from: "/downloads" });
  const stream = useJobStream();
  const jobs = useJobs(stream.connection === "live");
  const analytics = useAnalytics("24h");
  const docked = useDockedPanels();

  const all = jobs.data?.jobs ?? [];
  const needle = (search.q ?? "").toLowerCase();
  const inTab = all.filter((job) => bucketOf(job) === search.tab);
  const shown =
    needle === ""
      ? inTab
      : inTab.filter((job) => jobTitle(job).toLowerCase().includes(needle) || job.url.toLowerCase().includes(needle));

  const counts = Object.fromEntries(
    DOWNLOAD_TABS.map((tab) => [tab, all.filter((job) => bucketOf(job) === tab).length]),
  ) as Record<DownloadTab, number>;

  const selected = search.job ? (all.find((job) => job.id === search.job) ?? null) : null;
  const running = all.filter((job) => job.status === "downloading");
  const speed = running.reduce((sum, job) => sum + (job.speed ?? 0), 0);

  // 🔴 The tab is read from the URL and written back to it. It used to be the
  // literal "details" with an `onTab` that did nothing, which made the panel
  // look like it had three tabs and behave as if it had one: clicking Tasks or
  // Logs changed a value the component immediately overwrote with the same
  // constant, so nothing moved and nothing said why. This is the screen where
  // you go to find out what happened when a download failed, and the log is on
  // the tab that could not be opened.
  const inspector = selected ? (
    <JobInspector
      job={selected}
      tab={search.panel}
      onTab={(panel) => void navigate({ search: (current) => ({ ...current, panel }) })}
      onClose={() => void navigate({ search: (current) => ({ ...current, job: undefined }) })}
    />
  ) : null;

  return (
    <>
      <PageHeader title="Downloads" description="What is running, what finished, and what is waiting to try again." />

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs
              value={search.tab}
              onValueChange={(next) => void navigate({ search: (current) => ({ ...current, tab: next as DownloadTab }) })}
            >
              <TabsList>
                {DOWNLOAD_TABS.map((tab) => (
                  <TabsTrigger key={tab} value={tab} className="gap-1.5">
                    {TAB_LABEL[tab]}
                    <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums">
                      {counts[tab]}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="relative min-w-48 flex-1">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={search.q ?? ""}
                placeholder="Search downloads…"
                aria-label="Search downloads"
                className="pl-8"
                onChange={(event) =>
                  void navigate({
                    search: (current) => ({ ...current, q: event.target.value === "" ? undefined : event.target.value }),
                  })
                }
              />
            </div>
          </div>

          <Card>
            <CardContent className="px-0 py-2 sm:px-2">
              {jobs.isPending ? (
                <Skeleton className="mx-4 h-48" />
              ) : jobs.isError ? (
                <div className="px-4">
                  <ErrorState error={jobs.error} what="Downloads" retry={() => void jobs.refetch()} />
                </div>
              ) : shown.length === 0 ? (
                <div className="px-4 py-2">
                  <EmptyState
                    title={`Nothing ${TAB_LABEL[search.tab].toLowerCase()}`}
                    hint={
                      search.tab === "scheduled"
                        ? "Jobs appear here while they wait out a retry backoff — the wait is a column on the row, so it survives a restart."
                        : "Queue something from the dashboard."
                    }
                  />
                </div>
              ) : (
                <JobTable
                  jobs={shown}
                  selectedId={search.job}
                  onSelect={(id) =>
                    void navigate({ search: (current) => ({ ...current, job: current.job === id ? undefined : id }) })
                  }
                />
              )}
            </CardContent>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Downloaded (24h)"
              value={formatBytes(analytics.data?.bytes)}
              chart={<Sparkline values={(analytics.data?.series ?? []).map((bucket) => bucket.bytes)} />}
            />
            <StatTile label="Current speed" value={formatSpeed(speed)} hint={`${running.length} downloading now`} />
            <StatTile
              label="Success rate (24h)"
              value={analytics.data ? `${Math.round(analytics.data.successRate * 100)}%` : "—"}
              chart={
                <Sparkline
                  tone="text-success"
                  values={(analytics.data?.series ?? []).map((bucket) => bucket.completed)}
                />
              }
            />
            <StatTile
              label="Failures (24h)"
              value={formatCount(analytics.data?.failed)}
              chart={
                <Sparkline
                  tone="text-destructive"
                  values={(analytics.data?.series ?? []).map((bucket) => bucket.failed)}
                />
              }
            />
          </div>
        </div>

        {docked ? (
          <aside>
            <Card className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-hidden p-0">
              {inspector ?? (
                <div className="p-6">
                  <EmptyState title="Details" hint="Pick a download to see its details and history." />
                </div>
              )}
            </Card>
          </aside>
        ) : null}
      </div>

      <Sheet
        open={!docked && selected !== null}
        onOpenChange={(open) => {
          if (!open) void navigate({ search: (current) => ({ ...current, job: undefined }) });
        }}
      >
        {/* The inspector brings its own close button; the sheet's default one
            would land right beside it — the double X Santi hit on the iPad. */}
        <SheetContent side="right" className="w-full p-0 sm:max-w-md" showCloseButton={false}>
          <SheetTitle className="sr-only">Download details</SheetTitle>
          {inspector}
        </SheetContent>
      </Sheet>
    </>
  );
}
