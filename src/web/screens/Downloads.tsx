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
import { useSearch } from "@tanstack/react-router";
import { FileX2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useDockedPanels } from "@/hooks/use-media-query";
import { useSetSearch } from "@/hooks/use-set-search";
import { Sparkline } from "../components/charts/Sparkline";
import { EmptyState, ErrorState, PageNote, StatTile } from "../components/common/Bits";
import { JobInspector } from "../components/jobs/JobInspector";
import { FileFilterControl, FileStateBadge, SearchBox, SortControl } from "../components/jobs/JobFilters";
import { JobTable } from "../components/jobs/JobTable";
import {
  fileStateOf,
  finishedIds,
  indexFileStates,
  matchesFile,
  missingCount,
} from "../components/jobs/job-order";
import { PageHeader } from "../components/layout/AppShell";
import { formatBytes, formatCount, formatSpeed } from "../data/format";
import { useJob, useJobFileStates, useJobList, useJobs } from "../data/queries";
import { useAnalytics } from "../data/stats";
import { useJobStream } from "../data/stream";
import { DOWNLOAD_TABS, type DownloadTab, type DownloadsSearch } from "../search-params";

const TAB_LABEL: Record<DownloadTab, string> = {
  active: "Active",
  completed: "Completed",
  // "Stopped", not "Failed": the bucket holds cancelled jobs too, and
  // cancelling something is not a failure (core/job-buckets.ts).
  failed: "Stopped",
  scheduled: "Scheduled",
};

export function Downloads() {
  const search = useSearch({ from: "/downloads" });
  const stream = useJobStream();
  // 🔴 The tab, the search and the order are the server's now. The tab is a
  // *bucket*, whose rule lives in `core/job-buckets.ts` so that the SQL behind
  // this request and the badge on a row cannot disagree about what "scheduled"
  // means.
  const jobs = useJobList(
    { bucket: search.tab, q: search.q, sort: search.sort, order: search.order },
    stream.connection === "live",
  );
  // The live queue, for the "right now" numbers. One entry, pushed by the
  // stream, shared with every other screen that asks.
  const liveJobs = useJobs(stream.connection === "live");
  const analytics = useAnalytics("24h");
  const docked = useDockedPanels();

  const page = jobs.data;
  const all = page?.jobs ?? [];
  const total = page?.total ?? 0;

  /**
   * 🔴 **The disk, asked about once for the whole screen.**
   *
   * Only the finished jobs, because nothing else has a file yet — and only
   * their ids, because the server owns the translation from a recorded absolute
   * path to something it is willing to `stat` (see `core/file-state.ts`).
   *
   * ⚠️ The ids are sorted into the cache key, so the same set of downloads is
   * one entry however the table happens to be ordered — and the *only* thing
   * that makes this refetch is a download finishing, not a progress bar moving.
   * The alternative, a `fileState` on the job row, would be a `stat` per row on
   * every SSE frame: two hundred a second against a network mount.
   */
  const wanted = finishedIds(all);
  const files = useJobFileStates(wanted);
  // `null` is "no answer yet", and it travels all the way to the badge, which
  // then draws nothing rather than guessing. Pending counts as no answer.
  const fileIndex = indexFileStates(files.data?.states);

  /** One writer for the URL, so `resetScroll: false` cannot be forgotten. */
  // ⚠️ The intersection is not decoration: `useSetSearch` constrains its
  // parameter to `Record<string, unknown>`, and an `interface` — unlike a type
  // alias — has no implicit index signature, so `DownloadsSearch` alone does
  // not satisfy it. Same workaround as `screens/Library.tsx`.
  const setSearch = useSetSearch<DownloadsSearch & Record<string, unknown>>();
  const patch = (fields: Partial<DownloadsSearch>): void =>
    setSearch((current) => ({ ...current, ...fields }));

  /**
   * ⚠️ The only filtering left here, and it has to be: what became of the file
   * is not a column but the answer to a `stat` the server made separately, so
   * it can only be applied to rows already in hand.
   */
  const shown = all.filter((job) => matchesFile(fileStateOf(job, fileIndex), search.file));
  const gone = missingCount(all, fileIndex);

  // From the server, over the whole table — the tab badges used to count the
  // page, so a tab could read "0" while holding thousands of rows.
  const counts = (page?.counts.byBucket ?? {
    active: 0,
    completed: 0,
    failed: 0,
    scheduled: 0,
  }) as Record<DownloadTab, number>;

  /**
   * The selected job, even when this tab does not contain it — `?job=…` is a
   * link worth sending, and "not on this page" used to look like "gone".
   */
  const onPage = search.job ? (all.find((job) => job.id === search.job) ?? null) : null;
  const fetched = useJob(search.job, search.job !== undefined && onPage === null);
  const selected = onPage ?? fetched.data ?? null;

  /**
   * ⚠️ Speed comes from the **live stream's** snapshot, not from this page.
   * "How fast is it going right now" is a question about what is running, and
   * the Downloads screen may well be showing the Completed tab.
   */
  const live = liveJobs.data?.jobs ?? [];
  const running = live.filter((job) => job.status === "downloading");
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
      onTab={(panel) => patch({ panel })}
      onClose={() => patch({ job: undefined })}
      fileState={fileStateOf(selected, fileIndex)}
    />
  ) : null;

  const filtered = (search.q ?? "") !== "" || search.file !== "any";

  return (
    <>
      <PageHeader title="Downloads" description="What is running, what finished, and what is waiting to try again." />

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Scrolls rather than clips: four tabs with counts are wider than
                a phone, and the last one ("Scheduled") was simply cut off. */}
            <Tabs
              className="max-w-full overflow-x-auto"
              value={search.tab}
              onValueChange={(next) => patch({ tab: next as DownloadTab })}
            >
              <TabsList>
                {DOWNLOAD_TABS.map((tab) => (
                  <TabsTrigger key={tab} value={tab} className="gap-1.5">
                    {TAB_LABEL[tab]}
                    {/* Counts only from `sm` up: with them, four tabs are wider
                        than a phone, and a strip that scrolls gives no hint that
                        it does. The Active count is on the stat tiles anyway. */}
                    <span className="hidden rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums sm:inline">
                      {counts[tab]}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <SearchBox
              label="Search downloads"
              value={search.q ?? ""}
              onChange={(next) => patch({ q: next === "" ? undefined : next })}
            />
          </div>

          {/* 🔴 The metrics come **before** the list. They were under it, which
              is where the numbers you check first go to be never seen: on a
              screen with twenty rows you have to scroll past the whole table to
              find out whether anything is moving at all. */}
          {/* Two across even on a phone: stacked one per row, the four tiles
              pushed every job below the fold of the screen that lists them. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
            <SortControl sort={search.sort} order={search.order} onChange={patch} />
            <FileFilterControl
              value={search.file}
              onChange={(file) => patch({ file })}
              onRecheck={() => void files.refetch()}
              checking={files.isFetching}
              checkedAt={files.data?.at}
              elapsedMs={files.data?.elapsedMs}
              // The check itself never fails because of the disk — a dead mount
              // is a 200 full of `unknown` — so this is only about the request.
              unavailable={wanted.length > 0 && files.isError}
            />
          </div>

          {/* 🔴 A count, not a colour on a row somebody has to find. Downloads
              whose file has gone are the reason this screen checks the disk at
              all, and on a tab of a hundred rows the badge alone would need
              hunting for. One line, and it filters. */}
          {gone > 0 && search.file !== "missing" ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
              <FileX2 className="size-4 shrink-0 text-destructive" aria-hidden />
              <p className="min-w-0 flex-1 text-xs">
                <span className="font-medium text-destructive">
                  {gone} {gone === 1 ? "download has" : "downloads have"} lost {gone === 1 ? "its" : "their"} file.
                </span>{" "}
                <span className="text-muted-foreground">
                  The library answered and there is nothing at the recorded path. Open one to download it again.
                </span>
              </p>
              <Button variant="outline" size="sm" onClick={() => patch({ file: "missing" })}>
                Show them
              </Button>
            </div>
          ) : null}

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
                <>
                  <JobTable
                    jobs={shown}
                    selectedId={search.job}
                    onSelect={(id) => patch({ job: search.job === id ? undefined : id })}
                    badge={(job) => <FileStateBadge state={fileStateOf(job, fileIndex)} />}
                  />
                  <PageNote
                    shown={shown.length}
                    total={total}
                    limit={page?.limit ?? 200}
                    noun="downloads"
                  />
                </>
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
          if (!open) patch({ job: undefined });
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
