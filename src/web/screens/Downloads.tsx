/**
 * Downloads: the same jobs as the Queue, arranged the way the reference design
 * arranges them — by *what you would do about them* rather than by raw status.
 *
 * The four tabs are not four statuses. **Scheduled** is the one that earns its
 * place: a job whose `notBefore` is in the future is waiting out a retry
 * backoff, and that column exists precisely so the wait survives a restart
 * (PLAN R2). Without a tab for it, such a job reads as "queued and stuck".
 *
 * ⚠️ **Every `navigate` passes `resetScroll: false`.** TanStack Router scrolls
 * the window to the top after any navigation unless told not to, and changing a
 * search param *is* a navigation — so opening a download near the bottom of the
 * list used to throw the page back to the top. See `docs/DISCOVERIES.md`.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";

import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDockedPanels } from "@/hooks/use-media-query";
import { Sparkline } from "../components/charts/Sparkline";
import { EmptyState, ErrorState, StatTile } from "../components/common/Bits";
import { JobInspector } from "../components/jobs/JobInspector";
import { FileFilterControl, FileStateBadge, SearchBox, SortControl } from "../components/jobs/JobFilters";
import { JobTable } from "../components/jobs/JobTable";
import { fileStateOf, indexTrash, matchesFile, matchesText, sortJobs } from "../components/jobs/job-order";
import { bucketOf } from "../components/jobs/job-view";
import { PageHeader } from "../components/layout/AppShell";
import { formatBytes, formatCount, formatSpeed } from "../data/format";
import { useTrash } from "../data/library";
import { useJobs } from "../data/queries";
import { useAnalytics } from "../data/stats";
import { useJobStream } from "../data/stream";
import { DOWNLOAD_TABS, type DownloadTab, type DownloadsSearch } from "../search-params";

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

  /**
   * 🔴 The trash is the *only* thing that can be said about a downloaded file
   * with any certainty, and it costs one request: the journal is small and
   * complete, so an entry in it is proof, and its absence is proof of absence.
   *
   * ⚠️ Asked for only once something has actually finished. On a fresh install
   * there is nothing to ask about, and the library is often a network mount —
   * so the cheapest correct request is the one not sent.
   */
  const anyFinished = all.some((job) => job.status === "done");
  const trash = useTrash(anyFinished);
  // `null` is "cannot say", and it travels all the way to the badge, which then
  // draws nothing rather than guessing. Pending counts as cannot-say.
  const trashIndex = trash.isSuccess ? indexTrash(trash.data.entries) : null;

  /** One writer for the URL, so `resetScroll: false` cannot be forgotten. */
  const setSearch = (patch: Partial<DownloadsSearch>): void =>
    void navigate({ search: (current) => ({ ...current, ...patch }), resetScroll: false });

  const inTab = all.filter((job) => bucketOf(job) === search.tab);
  const shown = sortJobs(
    inTab.filter(
      (job) => matchesText(job, search.q ?? "") && matchesFile(fileStateOf(job, trashIndex), search.file),
    ),
    search.sort,
    search.order,
  );

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
      onTab={(panel) => setSearch({ panel })}
      onClose={() => setSearch({ job: undefined })}
    />
  ) : null;

  const filtered = (search.q ?? "") !== "" || search.file !== "any";

  return (
    <>
      <PageHeader title="Downloads" description="What is running, what finished, and what is waiting to try again." />

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={search.tab} onValueChange={(next) => setSearch({ tab: next as DownloadTab })}>
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

            <SearchBox
              label="Search downloads"
              value={search.q ?? ""}
              onChange={(next) => setSearch({ q: next === "" ? undefined : next })}
            />
          </div>

          {/* 🔴 The metrics come **before** the list. They were under it, which
              is where the numbers you check first go to be never seen: on a
              screen with twenty rows you have to scroll past the whole table to
              find out whether anything is moving at all. */}
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

          <div className="flex flex-wrap items-center gap-2">
            <SortControl sort={search.sort} order={search.order} onChange={setSearch} />
            <FileFilterControl
              value={search.file}
              onChange={(file) => setSearch({ file })}
              unavailable={anyFinished && !trash.isSuccess}
            />
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
                    title={filtered ? "Nothing matches these filters" : `Nothing ${TAB_LABEL[search.tab].toLowerCase()}`}
                    hint={
                      filtered
                        ? "Clear the search, or set the file state back to any."
                        : search.tab === "scheduled"
                          ? "Jobs appear here while they wait out a retry backoff — the wait is a column on the row, so it survives a restart."
                          : "Queue something from the dashboard."
                    }
                  />
                </div>
              ) : (
                <JobTable
                  jobs={shown}
                  selectedId={search.job}
                  onSelect={(id) => setSearch({ job: search.job === id ? undefined : id })}
                  badge={(job) => <FileStateBadge state={fileStateOf(job, trashIndex)} />}
                />
              )}
            </CardContent>
          </Card>
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
          if (!open) setSearch({ job: undefined });
        }}
      >
        {/* The inspector brings its own close button; the sheet's default one
            would land right beside it — the double X Santi hit on the iPad. */}
        <SheetContent side="right" className="w-full p-0 sm:max-w-lg" showCloseButton={false}>
          <SheetTitle className="sr-only">Download details</SheetTitle>
          {inspector}
        </SheetContent>
      </Sheet>
    </>
  );
}
