/**
 * Sources: the playlists and channels the scheduler watches.
 *
 * 🔴 **Adding one is the only call in the app that talks to the network before
 * it answers.** The server enumerates the source and records its back catalogue
 * as *seen* before the row is safe, because a source with no history is one
 * scheduler tick away from queueing eight hundred videos. So this form is slow
 * on purpose, it can fail with the provider's own error, and it says which is
 * happening.
 *
 * 🔴 Leaving "download existing items" at zero means **nothing from the past is
 * downloaded**. That is the safe default and the form never quietly changes it:
 * asking for the back catalogue is an explicit number, capped by the server.
 *
 * ⚠️ **The API has no notion of a source *kind*.** The Playlists / Subscriptions
 * tabs are a display filter derived from the URL, and they are labelled as one
 * — nothing here invents a field the server does not store.
 */
import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Loader2, Plus, RefreshCw, Rss, Trash2, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_PREFERENCES, type Source } from "../../core/types";
import { EmptyState, ErrorState } from "../components/common/Bits";
import { DestinationPicker } from "../components/jobs/DestinationPicker";
import { PageHeader } from "../components/layout/AppShell";
import { formatDateTime, formatInterval, formatRelative, hostOf } from "../data/format";
import { useJobDefaults } from "../data/queries";
import { useAddSource, useCheckSource, useRemoveSource, useSources, useUpdateSource } from "../data/sources";
import { SOURCE_KINDS, type SourceKind } from "../search-params";

/** Derived from the URL, for display only — the server stores no such field. */
function kindOf(source: Source): "playlists" | "subscriptions" {
  const url = source.url.toLowerCase();
  return url.includes("list=") || url.includes("/playlist") || url.includes("/sets/")
    ? "playlists"
    : "subscriptions";
}

const INTERVALS = [60, 180, 360, 720, 1440, 4320, 10080];

function AddSourceCard() {
  const defaults = useJobDefaults();
  const add = useAddSource();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(360);
  const [backfill, setBackfill] = useState(0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add a source</CardTitle>
        <p className="text-sm text-muted-foreground">
          A playlist or a channel. Its existing items are recorded as seen, so only new uploads are queued.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="source-url">URL</Label>
            <Input
              id="source-url"
              value={url}
              inputMode="url"
              placeholder="https://…"
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="source-name">Name (optional)</Label>
            <Input
              id="source-name"
              value={name}
              placeholder="Taken from the source if left empty"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DestinationPicker id="source-destination" value={destination} onChange={setDestination} />
          <div className="space-y-1.5">
            <Label htmlFor="source-interval">Check every</Label>
            <Select value={String(intervalMinutes)} onValueChange={(next) => setIntervalMinutes(Number(next))}>
              <SelectTrigger id="source-interval" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {formatInterval(minutes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Hourly is the floor: polling spends the same budget the downloads come out of.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="source-backfill">Download existing items</Label>
          <Input
            id="source-backfill"
            type="number"
            min={0}
            max={50}
            value={backfill}
            onChange={(event) => setBackfill(Math.max(0, Math.min(50, Number(event.target.value) || 0)))}
            className="w-28"
          />
          <p className="text-xs text-muted-foreground">
            Zero — the default — queues nothing from the past. Any other number is a cap, and the server
            enforces its own maximum of 50.
          </p>
        </div>

        <Button
          className="gap-1.5"
          disabled={url.trim() === "" || add.isPending}
          onClick={() =>
            add.mutate(
              {
                url: url.trim(),
                destination,
                intervalMinutes,
                preferences: defaults.data?.resolved ?? DEFAULT_PREFERENCES,
                ...(name.trim() !== "" ? { name: name.trim() } : {}),
                ...(backfill > 0 ? { includeExisting: { limit: backfill } } : {}),
              },
              {
                onSuccess: () => {
                  setUrl("");
                  setName("");
                  setBackfill(0);
                },
              },
            )
          }
        >
          {add.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          {add.isPending ? "Checking the source…" : "Add source"}
        </Button>

        {add.isError ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {add.error.message}
              <span className="mt-1 block text-xs text-muted-foreground">
                Nothing was created — a source whose catalogue could not be read is not safe to schedule.
              </span>
            </span>
          </p>
        ) : null}

        {add.data ? (
          <p className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success">
            Added “{add.data.source.name}”. {add.data.discovered} item(s) found, {add.data.seeded} recorded as
            seen, {add.data.enqueued.length} queued{add.data.capped ? " (capped)" : ""}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SourceRow({ source }: { source: Source }) {
  const check = useCheckSource();
  const update = useUpdateSource();
  const remove = useRemoveSource();

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <Rss className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          {source.name}
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] capitalize">
            {kindOf(source)}
          </Badge>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {hostOf(source.url)} · every {formatInterval(source.intervalMinutes)} ·{" "}
          {source.destination === "" ? "library root" : source.destination}
        </p>
        <p className="text-xs text-muted-foreground">
          {source.lastCheckedAt ? `Last checked ${formatRelative(source.lastCheckedAt)}` : "Never checked"}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Select
          value={String(source.intervalMinutes)}
          onValueChange={(next) => update.mutate({ id: source.id, patch: { intervalMinutes: Number(next) } })}
        >
          <SelectTrigger className="h-8 w-28 text-xs" aria-label={`Interval for ${source.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVALS.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {formatInterval(minutes)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          disabled={check.isPending}
          onClick={() => check.mutate(source.id)}
        >
          <RefreshCw className={check.isPending ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
          Check now
        </Button>

        <Switch
          checked={source.enabled}
          aria-label={`${source.name} enabled`}
          onCheckedChange={(next) => update.mutate({ id: source.id, patch: { enabled: next } })}
        />

        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${source.name}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate(source.id)}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>

      {check.data ? (
        <p className="w-full text-xs text-muted-foreground">
          Checked {formatDateTime(check.data.checkedAt)} — {check.data.discovered} found, {check.data.fresh} new,{" "}
          {check.data.enqueued.length} queued
          {check.data.heldBack > 0 ? `, ${check.data.heldBack} held back` : ""}
          {check.data.skipped ? " (source is disabled)" : ""}.
        </p>
      ) : null}
      {check.isError ? <p className="w-full text-xs text-destructive">{check.error.message}</p> : null}
    </li>
  );
}

export function Sources() {
  const search = useSearch({ from: "/sources" });
  const navigate = useNavigate({ from: "/sources" });
  const sources = useSources();

  const all = sources.data?.sources ?? [];
  const shown = search.kind === "all" ? all : all.filter((source) => kindOf(source) === search.kind);

  return (
    <>
      <PageHeader
        title="Sources"
        description="Playlists and channels the scheduler watches for new uploads."
        actions={
          <Tabs
            value={search.kind}
            onValueChange={(next) => void navigate({ search: (current) => ({ ...current, kind: next as SourceKind }), resetScroll: false })}
          >
            <TabsList>
              {SOURCE_KINDS.map((kind) => (
                <TabsTrigger key={kind} value={kind} className="capitalize">
                  {kind}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />

      <div className="space-y-4">
        <AddSourceCard />

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Watching <span className="text-sm font-normal text-muted-foreground tabular-nums">({shown.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sources.isPending ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : sources.isError ? (
              <ErrorState error={sources.error} what="Sources" retry={() => void sources.refetch()} />
            ) : shown.length === 0 ? (
              <EmptyState
                icon={<Rss className="size-6" aria-hidden />}
                title={all.length === 0 ? "No sources yet" : "Nothing in this group"}
                hint={
                  all.length === 0
                    ? "Add a playlist or a channel above. New uploads are queued automatically; the back catalogue is not."
                    : "The grouping is derived from the URL — try “All”."
                }
              />
            ) : (
              <ul className="divide-y">
                {shown.map((source) => (
                  <SourceRow key={source.id} source={source} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
