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
import { useSearch } from "@tanstack/react-router";
import { Loader2, MousePointerClick } from "lucide-react";

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useDockedPanels } from "@/hooks/use-media-query";
import { useSetSearch } from "@/hooks/use-set-search";
import { EmptyState, ErrorState, PageNote, StatTile } from "../components/common/Bits";
import { BatchAdd } from "../components/jobs/BatchAdd";
import { JobInspector } from "../components/jobs/JobInspector";
import { FileFilterControl, FileStateBadge, SearchBox, SortControl, StatusFilter } from "../components/jobs/JobFilters";
import { JobList, JobTable } from "../components/jobs/JobTable";
import { fileStateOf, finishedIds, indexFileStates, matchesFile } from "../components/jobs/job-order";
import { RUNNING, WAITING } from "../components/jobs/job-view";
import { PageHeader } from "../components/layout/AppShell";
import { formatCount } from "../data/format";
import { useJob, useJobFileStates, useJobList } from "../data/queries";
import { useJobStream } from "../data/stream";
import type { QueueFilter, QueueSearch } from "../search-params";
import type { JobStatus } from "../../core/types";

/**
 * The Queue's status filter, as statuses the route understands.
 *
 * 🔴 One mapping, sent to the server, instead of a predicate run over rows that
 * were already fetched. `all` is `undefined` rather than every status: "no
 * filter" and "a filter that happens to list everything" differ the moment a
 * status is added.
 */
const STATUSES_FOR: Record<QueueFilter, readonly JobStatus[] | undefined> = {
  all: undefined,
  waiting: WAITING,
  running: RUNNING,
  done: ["done"],
  failed: ["failed", "cancelled"],
};

/** Sum a few statuses out of the server's counts, treating absent as zero. */
function sumOf(counts: Record<JobStatus, number> | undefined, statuses: readonly JobStatus[]): number {
  if (counts === undefined) return 0;
  return statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);
}

export function Queue() {
  const search = useSearch({ from: "/queue" });
  const stream = useJobStream();
  const jobs = useJobList(
    {
      status: STATUSES_FOR[search.status]?.join(","),
      q: search.q,
      sort: search.sort,
      order: search.order,
    },
    stream.connection === "live",
  );
  const docked = useDockedPanels();

  /**
   * One writer for the URL, so `resetScroll: false` cannot be forgotten on the
   * one call that would then throw the page back to the top.
   *
   * ⚠️ The intersection is not decoration: `useSetSearch` constrains its
   * parameter to `Record<string, unknown>`, and an `interface` — unlike a type
   * alias — has no implicit index signature.
   */
  const setSearch = useSetSearch<QueueSearch & Record<string, unknown>>();
  const patch = (fields: Partial<QueueSearch>): void => setSearch((current) => ({ ...current, ...fields }));

  const page = jobs.data;
  const all = page?.jobs ?? [];
  const total = page?.total ?? 0;

  /**
   * 🔴 The same disk check the Downloads screen makes, over the same cache
   * entry — the ids are sorted into the key, so both screens open at once ask
   * the server **once**. Only finished jobs: nothing else has a file yet.
   */
  const wanted = finishedIds(all);
  const files = useJobFileStates(wanted);
  const fileIndex = indexFileStates(files.data?.states);

  /**
   * ⚠️ The **only** filtering left in the browser, and it belongs here.
   *
   * The status, the search and the order are the database's now. What became of
   * the file is not a column — it is the answer to a `stat` the server made
   * separately (`POST /api/jobs/file-state`), so it can only be applied to rows
   * that are already in hand. That is why the count below says how many rows
   * this page kept, and not what the server would have returned.
   */
  const shown = all.filter((job) => matchesFile(fileStateOf(job, fileIndex), search.file));

  /**
   * The selected job, even when the filters do not include it.
   *
   * `?job=…` is a link worth sending someone; before the server owned the page,
   * "not on this page" and "does not exist" looked identical and the inspector
   * simply drew nothing.
   */
  const onPage = search.job ? (all.find((job) => job.id === search.job) ?? null) : null;
  const fetched = useJob(search.job, search.job !== undefined && onPage === null);
  const selected = onPage ?? fetched.data ?? null;

  // 🔴 From the server, over the whole table — not from the rows on screen. The
  // tiles used to count the page, so "Completed 200" meant "200 of the ones we
  // happened to be sent" and the hint underneath had to admit it.
  const byStatus = page?.counts.byStatus;
  const counts = {
    waiting: sumOf(byStatus, WAITING),
    running: sumOf(byStatus, RUNNING),
    done: byStatus?.done ?? 0,
    // The same set the "Failed or cancelled" filter lists — a tile that counted
    // one status while its filter showed two disagreed with itself.
    stopped: sumOf(byStatus, STATUSES_FOR.failed!),
    failedOnly: byStatus?.failed ?? 0,
  };

  const select = (id: string): void => patch({ job: search.job === id ? undefined : id });

  const inspector = selected ? (
    <JobInspector
      job={selected}
      tab={search.panel}
      onTab={(panel) => patch({ panel })}
      onClose={() => patch({ job: undefined })}
      fileState={fileStateOf(selected, fileIndex)}
    />
  ) : null;

  const filtered = search.status !== "all" || (search.q ?? "") !== "" || search.file !== "any";

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
            <StatTile label="Completed" value={formatCount(counts.done)} hint="Every finished job on the server" />
            <StatTile
              label="Stopped"
              value={formatCount(counts.stopped)}
              hint={counts.failedOnly > 0 ? `${formatCount(counts.failedOnly)} failed — needs attention` : "Failed or cancelled"}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusFilter value={search.status} onChange={(status) => patch({ status })} />
            {/* 🔴 The file filter is here too, not only on Downloads. "Which of
                my downloads lost its file" is not a question about a tab, and a
                filter that lived on one screen made the answer depend on which
                screen you happened to open. */}
            <FileFilterControl
              value={search.file}
              onChange={(file) => patch({ file })}
              onRecheck={() => void files.refetch()}
              checking={files.isFetching}
              checkedAt={files.data?.at}
              elapsedMs={files.data?.elapsedMs}
              unavailable={wanted.length > 0 && files.isError}
            />
            <SortControl sort={search.sort} order={search.order} onChange={patch} />
            <SearchBox
              label="Search the queue"
              value={search.q ?? ""}
              onChange={(next) => patch({ q: next === "" ? undefined : next })}
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Jobs{" "}
                {/* 🔴 `total` is the server's count over the whole table, not
                    the length of what was fetched. The difference between
                    "12 of 40" and "12 of 3,412" is the difference between a
                    filter and a filter over an arbitrary window — and the
                    window used to be the only number here. */}
                <span className="ml-1 text-sm font-normal text-muted-foreground tabular-nums">
                  ({shown.length} of {formatCount(total)})
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
                    title={total === 0 ? "The queue is empty" : "Nothing matches these filters"}
                    hint={
                      total === 0
                        ? "Add URLs above. A queued job survives both the browser closing and the service restarting."
                        : filtered
                          ? "Try another status, set the file state back to any, or clear the search."
                          : "Try another status."
                    }
                  />
                </div>
              ) : (
                <>
                  {/* Stacked on a phone, the table from `sm` up — see Downloads. */}
                  <div className="sm:hidden">
                    <JobList
                      jobs={shown}
                      selectedId={search.job}
                      onSelect={select}
                      badge={(job) => <FileStateBadge state={fileStateOf(job, fileIndex)} />}
                    />
                  </div>
                  <div className="hidden sm:block">
                    <JobTable
                      jobs={shown}
                      selectedId={search.job}
                      onSelect={select}
                      badge={(job) => <FileStateBadge state={fileStateOf(job, fileIndex)} />}
                    />
                  </div>
                  <PageNote shown={shown.length} total={total} limit={page?.limit ?? 200} noun="jobs" />
                </>
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
          if (!open) patch({ job: undefined });
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
