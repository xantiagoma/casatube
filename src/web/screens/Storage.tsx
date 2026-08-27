/**
 * Storage and analytics — the two numbers a home server actually runs out of.
 *
 * ⚠️ The two disks matter **separately**. When the library is gone the file
 * stays in the temp directory, so a library that has been down for a week shows
 * up here as a *temp* disk filling — and that is the number that predicts
 * trouble, not the one on the card everybody looks at.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { HardDrive, TriangleAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { StatsRange } from "../../core/stats";
import type { DiskPayload } from "../../api/stats";
import { Donut, Sparkline, TrendChart } from "../components/charts/Sparkline";
import { EmptyState, ErrorState, StatTile, UsageBar } from "../components/common/Bits";
import { PageHeader } from "../components/layout/AppShell";
import { formatBytes, formatCount, formatElapsed } from "../data/format";
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

export function Storage() {
  const { range } = useSearch({ from: "/storage" });
  const navigate = useNavigate({ from: "/storage" });
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
          <Select value={range} onValueChange={(next) => void navigate({ search: { range: next as StatsRange }, resetScroll: false })}>
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
