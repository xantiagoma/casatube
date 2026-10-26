/**
 * Storage and analytics — the two numbers a home server actually runs out of.
 *
 * ⚠️ The two disks matter **separately**. When the library is gone the file
 * stays in the temp directory, so a library that has been down for a week shows
 * up here as a *temp* disk filling — and that is the number that predicts
 * trouble, not the one on the card everybody looks at.
 *
 * 🔴 **Playback sessions are the third occupant of that temp disk**, and until
 * now nothing showed them: `GET /api/library/hls/sessions` reports what is
 * being remuxed for a browser right now and what it is holding, and no screen
 * asked. A film playing through HLS is hundreds of megabytes of `.ts` segments
 * appearing in `TEMP_DIR` with nothing on any screen to explain them.
 *
 * ⚠️ Which is why the card leads with what they are rather than with the
 * number. **They are a cache, not files anybody owns** — the library still has
 * the original — and the manager deletes each one after it goes unread. A
 * megabyte figure on a storage screen reads as "your data" unless it is told
 * otherwise, and the wrong reaction to it would be to go looking for something
 * to delete.
 */
import { useSearch } from "@tanstack/react-router";
import { HardDrive, MonitorPlay, TriangleAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { HlsSessionInfo } from "../../core/hls";
import type { StatsRange } from "../../core/stats";
import type { DiskPayload } from "../../api/stats";
import { Donut, Sparkline, TrendChart } from "../components/charts/Sparkline";
import { EmptyState, ErrorState, StatTile, UsageBar } from "../components/common/Bits";
import { PageHeader } from "../components/layout/AppShell";
import { useSetSearch } from "../hooks/use-set-search";
import { formatBytes, formatCount, formatElapsed, formatInterval, formatRelative, formatUntil } from "../data/format";
import { useHlsSessions } from "../data/library";
import { useAnalytics, useStorage } from "../data/stats";

function DiskCard({ label, disk, hint }: { label: string; disk: DiskPayload; hint: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{label}</CardTitle>
        <p className="truncate font-mono text-xs text-muted-foreground">{disk.path}</p>
      </CardHeader>
      <CardContent>
        {disk.available ? (
          <>
            <UsageBar usedPercent={disk.usedPercent} />
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                ["Total", formatBytes(disk.totalBytes)],
                ["Used", `${formatBytes(disk.usedBytes)} (${Math.round(disk.usedPercent)}%)`],
                ["Free", formatBytes(disk.freeBytes)],
              ].map(([term, value]) => (
                <div key={term}>
                  <dt className="text-xs text-muted-foreground">{term}</dt>
                  <dd className="text-sm font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">{hint}</p>
          </>
        ) : (
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-warning">
              <TriangleAlert className="size-4" aria-hidden />
              Unreachable
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{disk.error.message}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing is lost by this. Downloads finish into the temp directory and move when it answers again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * How a session reads while it is happening.
 *
 * ⚠️ `starting` and `running` mean **an ffmpeg is alive**; `complete` means the
 * remux finished and only the segments remain. The two are swept on different
 * deadlines for that reason — five minutes for a process, an hour for bytes —
 * so the state is not decoration, it decides the countdown beside it.
 */
const SESSION_LOOK: Record<HlsSessionInfo["state"], { label: string; className: string }> = {
  starting: { label: "Starting", className: "bg-info/12 text-info ring-info/25" },
  running: { label: "Remuxing", className: "bg-info/12 text-info ring-info/25" },
  complete: { label: "Ready", className: "bg-success/12 text-success ring-success/25" },
  failed: { label: "Failed", className: "bg-destructive/12 text-destructive ring-destructive/25" },
};

function SessionRow({
  session,
  idleMs,
  transcodeIdleMs,
}: {
  session: HlsSessionInfo;
  idleMs: number;
  transcodeIdleMs: number;
}) {
  const look = SESSION_LOOK[session.state] ?? SESSION_LOOK.complete;
  const alive = session.state === "starting" || session.state === "running";
  // ⚠️ `lastAccessAt` is epoch **milliseconds** — the manager's own clock, not
  // a database column — so it has to be turned into an ISO string before any of
  // the formatters, every one of which parses.
  const goesAt = new Date(session.lastAccessAt + (alive ? transcodeIdleMs : idleMs)).toISOString();
  const name = session.path.slice(session.path.lastIndexOf("/") + 1);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <span className="min-w-0 flex-1 basis-full truncate font-medium sm:basis-auto" title={session.path}>
        {name}
      </span>
      <span
        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${look.className}`}
      >
        {look.label}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatBytes(session.bytes)} · {formatCount(session.segments)} segments
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        watched {formatRelative(new Date(session.lastAccessAt).toISOString())} · clears {formatUntil(goesAt)}
      </span>
      {session.error ? (
        <span className="basis-full text-xs text-destructive">{session.error}</span>
      ) : null}
    </li>
  );
}

/**
 * The temp disk that belongs to *watching*, not to downloading.
 *
 * 🔴 Read-only, and deliberately so rather than for want of a button: there is
 * **no route that ends a session on demand**. `core/hls.ts` has `sweep()`, the
 * API does not expose it, and inventing a Close here that quietly did nothing —
 * or, worse, that deleted a directory ffmpeg is still writing into while
 * somebody is watching — would be the wrong half of the feature. So the card
 * answers the question a Close button is usually pressed for ("what is this and
 * when does it go away?") and says plainly that it goes on its own.
 */
function PlaybackSessionsCard() {
  const sessions = useHlsSessions();

  if (sessions.isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Playback sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorState error={sessions.error} what="Playback sessions" retry={() => void sessions.refetch()} />
        </CardContent>
      </Card>
    );
  }

  const data = sessions.data;
  const live = data?.sessions ?? [];
  const idleLabel = data ? formatInterval(Math.round(data.idleMs / 60_000)) : "an hour";
  const transcodeLabel = data ? formatInterval(Math.round(data.transcodeIdleMs / 60_000)) : "5 min";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Playback sessions</CardTitle>
        <p className="text-xs text-muted-foreground">
          Temporary segments, written so a browser can play a file it will not open directly. The originals are
          untouched in the library — <span className="font-medium text-foreground">these are a cache, not your
          files</span>, and CasaTube deletes each one on its own once nobody is watching.
        </p>
      </CardHeader>
      <CardContent>
        {sessions.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : live.length === 0 ? (
          <EmptyState
            icon={<MonitorPlay className="size-6" aria-hidden />}
            title="Nothing is playing"
            hint={`Sessions appear while you watch and clear themselves after ${idleLabel} without a request.`}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <p className="text-2xl font-semibold tabular-nums">{formatBytes(data?.bytes)}</p>
              <p className="text-xs text-muted-foreground">
                held by {live.length === 1 ? "1 session" : `${live.length} sessions`} of at most{" "}
                {formatCount(data?.maxSessions)}
              </p>
            </div>
            <ul className="mt-2 divide-y">
              {live.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  idleMs={data?.idleMs ?? 0}
                  transcodeIdleMs={data?.transcodeIdleMs ?? 0}
                />
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              A session still being remuxed goes {transcodeLabel} after the last segment is asked for — a closed tab
              must not leave an ffmpeg running. One that has finished is only disk, and keeps its segments for{" "}
              {idleLabel} so going back to a video costs nothing.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function Storage() {
  const { range } = useSearch({ from: "/storage" });
  // 🔴 `useSetSearch`, not `navigate`. TanStack Router treats a search-param
  // change as a navigation and scrolls to the top unless told not to; this
  // screen is long enough that the range picker sits well below the fold.
  // ⚠️ The literal rather than `StorageSearch`: an `interface` has no implicit
  // index signature, so it does not satisfy `Record<string, unknown>`. Same
  // shape, same source of truth — the route validates into it.
  const setSearch = useSetSearch<{ range: StatsRange }>();
  const storage = useStorage();
  const analytics = useAnalytics(range);

  const series = analytics.data?.series ?? [];
  const slices = (analytics.data?.byType ?? []).slice(0, 5).map((slice, index) => ({
    key: slice.key,
    label: slice.key,
    value: slice.jobs,
    color: `var(--chart-${index + 1})`,
  }));

  return (
    <>
      <PageHeader
        title="Storage &amp; analytics"
        description="Where the space goes, and what the queue has been doing."
        actions={
          <Select
            value={range}
            onValueChange={(next) => setSearch((previous) => ({ ...previous, range: next as StatsRange }))}
          >
            <SelectTrigger className="w-28" aria-label="Analytics window">
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

      <div className="space-y-4">
        {storage.isPending ? (
          <Skeleton className="h-44 w-full" />
        ) : storage.isError ? (
          <ErrorState error={storage.error} what="Storage" retry={() => void storage.refetch()} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <DiskCard
              label="Library"
              disk={storage.data.library}
              hint="Where finished downloads live. Usually a network mount."
            />
            <DiskCard
              label="Temp"
              disk={storage.data.temp}
              hint="Where downloads are written first. A library that is down shows up here as this disk filling."
            />
          </div>
        )}

        {/* Directly under the temp disk, because that is the disk it is on. */}
        <PlaybackSessionsCard />

        {analytics.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : analytics.isError ? (
          <ErrorState error={analytics.error} what="Analytics" retry={() => void analytics.refetch()} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Jobs"
                value={formatCount(analytics.data.jobs)}
                hint={`${analytics.data.active} still running`}
                chart={<Sparkline values={series.map((bucket) => bucket.jobs)} />}
              />
              <StatTile
                label="Success rate"
                value={`${Math.round(analytics.data.successRate * 100)}%`}
                hint={`${analytics.data.completed} done · ${analytics.data.failed} failed`}
                chart={<Sparkline tone="text-success" values={series.map((bucket) => bucket.completed)} />}
              />
              <StatTile
                label="Downloaded"
                value={formatBytes(analytics.data.bytes)}
                hint={`Window: ${analytics.data.range}`}
                chart={<Sparkline tone="text-chart-2" values={series.map((bucket) => bucket.bytes)} />}
              />
              <StatTile
                label="Worker time"
                value={formatElapsed(analytics.data.totalMs)}
                hint={`${analytics.data.cancelled} cancelled`}
              />
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Throughput</CardTitle>
              </CardHeader>
              <CardContent>
                <TrendChart
                  points={series.map((bucket) => ({
                    label: new Date(bucket.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                    value: bucket.bytes,
                  }))}
                  format={formatBytes}
                />
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">By media type</CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-4">
                  {slices.length === 0 ? (
                    <EmptyState title="No jobs in this window" />
                  ) : (
                    <>
                      <Donut slices={slices} caption="jobs" />
                      <ul className="min-w-0 flex-1 space-y-1 text-xs">
                        {slices.map((slice) => (
                          <li key={slice.key} className="flex items-center gap-2">
                            <span className="size-2 shrink-0 rounded-full" style={{ background: slice.color }} />
                            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">{slice.value}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card className="lg:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Top sources</CardTitle>
                </CardHeader>
                <CardContent>
                  {analytics.data.topSources.length === 0 ? (
                    <EmptyState icon={<HardDrive className="size-6" aria-hidden />} title="Nothing recorded yet" />
                  ) : (
                    <ul className="divide-y">
                      {analytics.data.topSources.map((source) => (
                        <li key={source.source} className="flex items-center gap-3 py-2 text-sm">
                          <span className="min-w-0 flex-1 truncate font-medium">{source.source}</span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {source.jobs} jobs · {source.completed} done · {source.failed} failed ·{" "}
                            {formatBytes(source.bytes)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>

            {analytics.data.truncated ? (
              <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                The window holds more rows than the query reads ({formatCount(analytics.data.sampled)} sampled), so
                these numbers cover part of it. Better a stated sample than a quiet average of half the data.
              </p>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
