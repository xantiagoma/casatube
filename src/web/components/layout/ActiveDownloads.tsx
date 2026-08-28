/**
 * What is running right now, next to the bell.
 *
 * 🔴 **It lives in the layout, not on a screen.** A download keeps going while
 * you are reading the Library or editing Settings, and the one place that is
 * true of every screen is the header. Putting it on the Queue screen would mean
 * it is visible exactly where it is least needed.
 *
 * 🔴 **Nothing is running: nothing is rendered.** Not a greyed-out button, not
 * "0 active" — the component returns `null`. An indicator that is present when
 * there is nothing to indicate trains you to stop looking at it, and the header
 * on an iPad has about six inches to spend.
 *
 * ⚠️ **No polling, and no second stream.** The data is the queue snapshot the
 * SSE stream already pushes into the React Query cache; `live` comes down from
 * `AppShell`, which owns the one subscription. The `useJobs` call here reads
 * the same cache entry the Queue and Downloads screens read, so it is a cache
 * lookup rather than a request. See `data/stream.ts`.
 *
 * ## Read from an iPad, at arm's length
 *
 * That is where this gets looked at, so: the trigger is a 40 px pill rather
 * than a 36 px icon button, the percentage is `text-sm` and `tabular-nums` (so
 * it stops jittering as the digits change), the popover is a comfortable 22 rem
 * capped to the viewport, and every row is real text rather than a tooltip —
 * there is no hover on a touch screen, so anything hidden behind one is
 * invisible there.
 */
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration, formatPercent, formatSpeed } from "../../data/format";
import { useJobs } from "../../data/queries";
import { summariseActivity, type ActiveJobView } from "./active-downloads";

/**
 * One job, as a card.
 *
 * The four facts, in the order they answer questions: what it is, what is
 * happening to it, how far along, and how fast. Bytes and speed are on one line
 * because either can be missing — YouTube reports a size for almost no format
 * (see docs/DISCOVERIES.md) — and a row that collapses is better than a column
 * that leaves a gap.
 */
function ActivityCard({ job }: { job: ActiveJobView }) {
  const bytes =
    job.totalBytes !== null && job.doneBytes !== null
      ? `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}`
      : job.doneBytes !== null
        ? formatBytes(job.doneBytes)
        : null;

  return (
    <li className="px-3 py-3">
      <p className="truncate text-sm font-medium" title={job.title}>
        {job.title}
      </p>

      <p className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
          <span className="truncate">{job.stage}</span>
        </span>
        {/* ⚠️ Not "0%". A job that has reported no bytes yet is not at zero,
            it is unmeasured, and the two look identical if both print a
            number. `progressOf` is what draws the distinction. */}
        <span className="shrink-0 font-medium tabular-nums text-foreground">
          {job.indeterminate ? "starting…" : formatPercent(job.percent)}
        </span>
      </p>

      <Progress
        value={job.indeterminate ? 0 : job.percent}
        className={cn("mt-2 h-2", job.indeterminate && "animate-pulse")}
        aria-label={`${job.title}: ${job.stage}`}
      />

      {bytes !== null || job.speed !== null || job.eta !== null ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
          {bytes !== null ? <span>{bytes}</span> : null}
          {job.speed !== null ? <span>{formatSpeed(job.speed)}</span> : null}
          {job.eta !== null ? <span>{formatDuration(job.eta)} left</span> : null}
        </p>
      ) : null}
    </li>
  );
}

export function ActiveDownloads({ live }: { live: boolean }) {
  // The same cache entry the queue screens read — see the header. `live`
  // decides whether React Query polls it, exactly as it does everywhere else,
  // so this component adds no traffic of its own in either state.
  const jobs = useJobs(live);
  const activity = summariseActivity(jobs.data?.jobs);

  // Nothing running, nothing drawn. See the header.
  if (activity.count === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="h-10 gap-2 px-2.5"
          aria-label={`${activity.count} download${activity.count === 1 ? "" : "s"} in progress`}
        >
          <span className="relative flex size-5 items-center justify-center">
            <Loader2 className="size-4.5 animate-spin text-primary" aria-hidden />
          </span>
          <span className="text-sm font-medium tabular-nums">
            {activity.soloPercent !== null ? formatPercent(activity.soloPercent) : activity.count}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-semibold">
            {activity.count === 1 ? "1 download running" : `${activity.count} downloads running`}
          </p>
          {activity.queued > 0 ? (
            // Context, kept out of the badge deliberately: waiting is not
            // running, and a count that mixed them would misread a long queue
            // as a busy server.
            <span className="text-xs text-muted-foreground tabular-nums">{activity.queued} waiting</span>
          ) : null}
        </div>

        <ScrollArea viewportClassName="max-h-96">
          <ul className="divide-y">
            {activity.running.map((job) => (
              <ActivityCard key={job.id} job={job} />
            ))}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
