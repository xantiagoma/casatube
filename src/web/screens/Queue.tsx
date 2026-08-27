/**
 * The queue, with the inspector beside it.
 *
 * 🔴 The filter, the search, the sort and the selected job all live in the
 * **URL**, not in this component. That is what PLAN §8 bought with TanStack
 * Router: "the failed ones, biggest first, this job open on its log" is a link
 * you can send, and it survives a reload — which matters most for the case the
 * whole project exists for, when a job fails and you want to show someone the
 * reason.
 *
 * ⚠️ **Every `navigate` here passes `resetScroll: false`, and that is not
 * cosmetic.** TanStack Router calls `window.scrollTo(0, 0)` after *any*
 * navigation unless told otherwise — including one that changes nothing but a
 * search param. Since selecting a row, typing in the search box and moving a
 * filter are all navigations, the default turned every click at the bottom of a
 * long queue into a jump back to the top. See `docs/DISCOVERIES.md`.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Loader2, MousePointerClick } from "lucide-react";

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useDockedPanels } from "@/hooks/use-media-query";
import { EmptyState, ErrorState, StatTile } from "../components/common/Bits";
import { BatchAdd } from "../components/jobs/BatchAdd";
import { JobInspector } from "../components/jobs/JobInspector";
import { SearchBox, SortControl, StatusFilter } from "../components/jobs/JobFilters";
import { JobTable } from "../components/jobs/JobTable";
import { matchesStatus, matchesText, sortJobs } from "../components/jobs/job-order";
import { RUNNING, WAITING } from "../components/jobs/job-view";
import { PageHeader } from "../components/layout/AppShell";
import { formatCount } from "../data/format";
import { useJobs } from "../data/queries";
import { useJobStream } from "../data/stream";
import type { QueueSearch } from "../search-params";

export function Queue() {
  const search = useSearch({ from: "/queue" });
  const navigate = useNavigate({ from: "/queue" });
  const stream = useJobStream();
  const jobs = useJobs(stream.connection === "live");
  const docked = useDockedPanels();

  /**
   * One writer for the URL, so `resetScroll: false` cannot be forgotten on the
   * one call that would then throw the page back to the top.
   */
  const setSearch = (patch: Partial<QueueSearch>): void =>
    void navigate({ search: (current) => ({ ...current, ...patch }), resetScroll: false });

  const all = jobs.data?.jobs ?? [];
  const shown = sortJobs(
    all.filter((job) => matchesStatus(job, search.status) && matchesText(job, search.q ?? "")),
    search.sort,
    search.order,
  );
  const selected = search.job ? (all.find((job) => job.id === search.job) ?? null) : null;

  const counts = {
    waiting: all.filter((job) => WAITING.includes(job.status)).length,
    running: all.filter((job) => RUNNING.includes(job.status)).length,
    done: all.filter((job) => job.status === "done").length,
    failed: all.filter((job) => job.status === "failed").length,
  };

  const select = (id: string): void => setSearch({ job: search.job === id ? undefined : id });

  const inspector = selected ? (
    <JobInspector
      job={selected}
      tab={search.panel}
      onTab={(panel) => setSearch({ panel })}
      onClose={() => setSearch({ job: undefined })}
    />
  ) : null;

  const filtered = search.status !== "all" || (search.q ?? "") !== "";

  return (
    <>
      <PageHeader title="Queue" description="Everything the server is holding. Closing this tab changes nothing." />

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="min-w-0 space-y-4">
          <BatchAdd />

          {/* 🔴 The numbers come before the list. They are the first thing
              anyone looks at, and under the table they are the thing nobody
              scrolls to. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Waiting" value={formatCount(counts.waiting)} hint="Jobs the worker has not claimed" />
            <StatTile label="Running" value={formatCount(counts.running)} hint="Claimed and moving" />
            <StatTile label="Completed" value={formatCount(counts.done)} hint="In the window the API returns" />
            <StatTile label="Failed" value={formatCount(counts.failed)} hint="Needs attention" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusFilter value={search.status} onChange={(status) => setSearch({ status })} />
            <SortControl sort={search.sort} order={search.order} onChange={setSearch} />
            <SearchBox
              label="Search the queue"
              value={search.q ?? ""}
              onChange={(next) => setSearch({ q: next === "" ? undefined : next })}
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Jobs{" "}
                <span className="ml-1 text-sm font-normal text-muted-foreground tabular-nums">
                  ({shown.length} of {all.length})
                </span>
              </CardTitle>
              <CardAction>
                {jobs.isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : null}
              </CardAction>
            </CardHeader>
            <CardContent className="px-0 sm:px-2">
              {jobs.isPending ? (
                <Skeleton className="mx-4 h-48" />
              ) : jobs.isError ? (
                <div className="px-4">
                  <ErrorState error={jobs.error} what="The queue" retry={() => void jobs.refetch()} />
                </div>
              ) : shown.length === 0 ? (
                <div className="px-4">
                  <EmptyState
                    title={all.length === 0 ? "The queue is empty" : "Nothing matches these filters"}
                    hint={
                      all.length === 0
                        ? "Add URLs above. A queued job survives both the browser closing and the service restarting."
                        : filtered
                          ? "Try another status, or clear the search."
                          : "Try another status."
                    }
                  />
                </div>
              ) : (
                <JobTable jobs={shown} selectedId={search.job} onSelect={select} />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Wide screens dock the inspector; narrow ones give it the whole
            screen, which is PLAN §8's "dense panels degrade to full-screen".
            Two components rather than one hidden by CSS: a hidden sheet still
            mounts an overlay, and an overlay nobody can see still eats clicks. */}
        {docked ? (
        <aside>
          <Card className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-hidden p-0">
            {inspector ?? (
              <div className="p-6">
                <EmptyState
                  icon={<MousePointerClick className="size-6" aria-hidden />}
                  title="Job inspector"
                  hint="Pick a job to see its pipeline, its details and its log."
                />
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
          <SheetTitle className="sr-only">Job inspector</SheetTitle>
          {inspector}
        </SheetContent>
      </Sheet>
    </>
  );
}
