/**
 * The library: what is actually on disk, and the one screen that can remove it.
 *
 * 🔴 **Delete is a move, and it says so.** PLAN §18 settles that a deletion
 * renames into `.trash/` inside the library and keeps a retention window, so
 * the button is worded as reversible and the trash is a tab on this screen
 * rather than a hidden feature. The only irreversible action — emptying the
 * trash — is the only one worded as final.
 *
 * ⚠️ The library is usually a network mount. A failure here is rendered in
 * place and takes nothing else with it.
 */
import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowDownUp,
  Download,
  Film,
  Folder,
  FolderOpen,
  Grid2x2,
  List,
  Music,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDockedPanels } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { LibraryItem } from "../../core/library";
import { Donut } from "../components/charts/Sparkline";
import { EmptyState, ErrorState, UsageBar } from "../components/common/Bits";
import { PageHeader } from "../components/layout/AppShell";
import { MediaPreview } from "../components/media/MediaPreview";
import { formatBytes, formatDateTime, formatDuration, splitPath } from "../data/format";
import {
  canPlayHlsNatively,
  isBrowserPlayable,
  libraryFileUrl,
  libraryHlsUrl,
  normaliseExt,
  useEmptyTrash,
  useLibrary,
  useLibraryItem,
  useRestore,
  useTrash,
  useTrashItem,
} from "../data/library";
import { useDestinations } from "../data/queries";
import { useStorage } from "../data/stats";
import type { LibrarySearch } from "../search-params";

const AUDIO_EXT = new Set(["mp3", "m4a", "opus", "flac", "ogg", "wav", "aac"]);

function kindOf(item: LibraryItem): "video" | "audio" {
  return AUDIO_EXT.has(item.ext.toLowerCase().replace(/^\./, "")) ? "audio" : "video";
}

/**
 * The URL a `<video>` can play, or `null` when the browser cannot play this
 * container at all.
 *
 * Three answers, not two. A container the browser opens is served straight
 * from `GET /api/library/file`, ranges and all. Anything else — an MKV holding
 * perfectly ordinary H.264, which Chrome refuses on the container alone — goes
 * through `GET /api/library/hls/index.m3u8`, where the server copies the video
 * into HLS segments on demand.
 *
 * 🔴 `null` is now about **this browser**, not the file. The HLS route works
 * for every one of these; playing its output without `hls.js` is a thing only
 * Safari and iOS can do, and that is where this is watched. On a desktop Chrome
 * the panel says so and offers the download — see `unplayableHint` below.
 */
function playableUrl(item: LibraryItem): string | null {
  if (isBrowserPlayable(item.ext)) return libraryFileUrl(item.path);
  // An MKV, or anything else no browser opens: the server remuxes it to HLS on
  // demand — the video copied, not re-encoded. Safari plays that natively and
  // everything else goes through `hls.js`, so this no longer returns null for
  // a browser: only for a file nothing can play.
  return libraryHlsUrl(item.path);
}

/** Why there is no player, said in terms of the thing that is actually wrong. */
function unplayableReason(item: LibraryItem): string {
  const ext = normaliseExt(item.ext).toUpperCase();
  return `${ext || "This container"} plays here over HLS, which this browser cannot do on its own — open CasaTube in Safari, or download the file.`;
}

function ItemCard({
  item,
  selected,
  onOpen,
}: {
  item: LibraryItem;
  selected: boolean;
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors hover:border-primary/40",
        selected && "border-primary ring-1 ring-primary/30",
      )}
    >
      <span className="relative grid aspect-video w-full place-items-center bg-muted text-muted-foreground">
        {kindOf(item) === "audio" ? <Music className="size-7" aria-hidden /> : <Film className="size-7" aria-hidden />}
        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white uppercase">
          {item.ext.replace(/^\./, "")}
        </span>
      </span>
      <span className="min-w-0 p-2.5">
        <span className="block truncate text-sm font-medium">{item.name}</span>
        <span className="mt-0.5 flex items-center justify-between text-xs text-muted-foreground">
          <span className="truncate">{item.folder === "" ? "library root" : item.folder}</span>
          <span className="shrink-0 pl-2 tabular-nums">{formatBytes(item.size)}</span>
        </span>
      </span>
    </button>
  );
}

function DetailPanel({ path, onClose }: { path: string; onClose(): void }) {
  const detail = useLibraryItem(path, true);
  const trash = useTrashItem();
  const [confirming, setConfirming] = useState(false);

  if (detail.isPending) return <div className="p-4"><Skeleton className="h-64 w-full" /></div>;
  if (detail.isError) {
    return (
      <div className="p-4">
        <ErrorState error={detail.error} what="This item" retry={() => void detail.refetch()} />
      </div>
    );
  }

  const { item, probe } = detail.data;
  const src = playableUrl(item);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 border-b p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{item.name}</p>
          <p className="truncate text-xs text-muted-foreground">{item.folder === "" ? "library root" : item.folder}</p>
        </div>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={onClose} aria-label="Close details">
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <MediaPreview
          src={src}
          title={item.name}
          duration={probe?.durationSeconds ?? null}
          kind={kindOf(item)}
          unplayableHint={src ? undefined : unplayableReason(item)}
          hls={src?.includes("/hls/") ?? false}
        />

        <dl className="divide-y text-xs">
          {[
            ["File path", item.path],
            ["Format", item.ext.replace(/^\./, "").toUpperCase()],
            ["Size", formatBytes(item.size)],
            ["Modified", formatDateTime(item.modifiedAt)],
            ["Duration", probe ? formatDuration(probe.durationSeconds) : "—"],
            ["Bitrate", probe?.bitrate ? `${Math.round(probe.bitrate / 1000)} kbps` : "—"],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>

        {probe && probe.streams.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-medium">Streams</p>
            <ul className="space-y-1">
              {probe.streams.map((stream) => (
                <li key={stream.index} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
                  <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                    {stream.kind}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate">
                    {[stream.language, stream.codec, stream.width ? `${stream.width}×${stream.height}` : null]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </span>
                  {stream.isDefault ? <span className="shrink-0 text-[10px] text-muted-foreground">default</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {item.subtitles.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-medium">Sidecar subtitles</p>
            <ul className="space-y-1">
              {item.subtitles.map((subtitle) => (
                <li key={subtitle.path} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs">
                  <span className="min-w-0 truncate">{subtitle.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {subtitle.language ?? "?"}
                    {subtitle.forced ? " · forced" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {detail.data.probeError ? (
          <p className="text-xs text-muted-foreground">
            The file could not be probed ({detail.data.probeError}); everything except the stream details is still
            accurate.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-t p-3">
        {/* An anchor, not a button with an onClick: `download` on a same-origin
            link is the browser's own save, so it survives a navigation, shows
            in the download manager and needs no JavaScript at all. The server
            sends `Content-Disposition: attachment`, which is what names the
            file when the anchor's own hint is ignored. */}
        <Button asChild variant="outline" size="sm" className="flex-1 gap-1.5">
          <a href={libraryFileUrl(item.path, { download: true })} download={item.name}>
            <Download className="size-3.5" aria-hidden />
            Download
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1 gap-1.5 text-destructive hover:text-destructive"
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-3.5" aria-hidden />
          Move to trash
        </Button>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to trash?</DialogTitle>
            <DialogDescription>
              {item.name} and its sidecar subtitles move to <code>.trash/</code> inside the library. Nothing is
              erased — you can restore it from the Trash tab, and it is only removed for good when the trash is
              emptied.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={trash.isPending}
              onClick={() =>
                trash.mutate(item.path, {
                  onSuccess: () => {
                    setConfirming(false);
                    onClose();
                  },
                })
              }
            >
              Move to trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TrashView() {
  const trash = useTrash();
  const restore = useRestore();
  const empty = useEmptyTrash();
  const [confirming, setConfirming] = useState(false);

  if (trash.isPending) return <Skeleton className="h-48 w-full" />;
  if (trash.isError) return <ErrorState error={trash.error} what="The trash" retry={() => void trash.refetch()} />;

  const { entries, retentionDays, bytes } = trash.data;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div>
          <CardTitle className="text-base">Trash</CardTitle>
          <p className="text-xs text-muted-foreground">
            {entries.length} item{entries.length === 1 ? "" : "s"} · {formatBytes(bytes)} · kept for {retentionDays}{" "}
            day{retentionDays === 1 ? "" : "s"}
          </p>
        </div>
        <CardAction><Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive hover:text-destructive"
          disabled={entries.length === 0}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-3.5" aria-hidden />
          Empty trash
        </Button></CardAction>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <EmptyState title="The trash is empty" hint="Deleted items land here first and can be restored." />
        ) : (
          <ul className="divide-y">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2.5">
                <Trash2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{entry.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {entry.path} · deleted {formatDateTime(entry.deletedAt)} · {formatBytes(entry.size)}
                    {entry.orphan ? " · journal entry missing" : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(entry.id)}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
        {restore.isError ? <p className="mt-2 text-xs text-destructive">{restore.error.message}</p> : null}
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Empty the trash?</DialogTitle>
            <DialogDescription>
              This is the only action here that cannot be undone. {entries.length} item
              {entries.length === 1 ? "" : "s"} ({formatBytes(bytes)}) will be removed from disk for good.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={empty.isPending}
              onClick={() => empty.mutate(0, { onSuccess: () => setConfirming(false) })}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function LibraryScreen() {
  const search = useSearch({ from: "/library" });
  const navigate = useNavigate({ from: "/library" });
  const docked = useDockedPanels();

  const listing = useLibrary({
    ...(search.folder ? { folder: search.folder } : {}),
    ...(search.q ? { q: search.q } : {}),
    sort: search.sort,
    order: search.order,
    limit: 200,
  });
  const folders = useDestinations();
  const storage = useStorage();

  const items = listing.data?.items ?? [];
  const update = (patch: Partial<LibrarySearch>) => void navigate({ search: (current) => ({ ...current, ...patch }) });

  const byExt = new Map<string, number>();
  for (const item of items) {
    const ext = item.ext.replace(/^\./, "").toLowerCase() || "other";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const slices = [...byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, value], index) => ({
      key,
      label: key.toUpperCase(),
      value,
      color: `var(--chart-${index + 1})`,
    }));

  const detail = search.item ? <DetailPanel path={search.item} onClose={() => update({ item: undefined })} /> : null;

  return (
    <>
      <PageHeader
        title="Library"
        description="What is on disk. Deleting moves to the trash first — it is reversible."
        actions={
          <Tabs value={search.trash ? "trash" : "media"} onValueChange={(next) => update({ trash: next === "trash" })}>
            <TabsList>
              <TabsTrigger value="media">Media</TabsTrigger>
              <TabsTrigger value="trash">Trash</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {search.trash ? (
        <TrashView />
      ) : (
        /*
         * ⚠️ `28rem`, not the `22rem` this started at, and the reference design
         * is why: its detail panel is a good quarter of the canvas. The old
         * column left the player 284 px of control bar for 360 px of controls,
         * and playback speed, PiP and **fullscreen** were the three that fell
         * off the end — the widest layout in the app was the one with no
         * fullscreen button. The grid drops to three columns here so the cards
         * do not pay for it; see `MediaPreview` for the half of the fix that
         * holds at any width.
         */
        <div className="grid gap-4 xl:grid-cols-[13rem_minmax(0,1fr)] 2xl:grid-cols-[13rem_minmax(0,1fr)_28rem]">
          <aside className="min-w-0 space-y-4">
            <Card className="p-0">
              <CardHeader className="px-3 pt-3 pb-2">
                <CardTitle className="text-sm">Folders</CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-3">
                <ul className="space-y-0.5">
                  <li>
                    <button
                      type="button"
                      onClick={() => update({ folder: undefined })}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        search.folder === undefined ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                      )}
                    >
                      <FolderOpen className="size-4 shrink-0" aria-hidden />
                      <span className="truncate">All media</span>
                    </button>
                  </li>
                  {(folders.data?.folders ?? []).map((folder) => (
                    <li key={folder.path}>
                      <button
                        type="button"
                        onClick={() => update({ folder: folder.path })}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                          search.folder === folder.path ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                        )}
                        style={{ paddingLeft: `${0.5 + folder.depth * 0.6}rem` }}
                      >
                        <Folder className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{splitPath(folder.path).name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {folders.isError ? (
                  <p className="px-2 pt-2 text-xs text-muted-foreground">
                    The folder list is unavailable; search still works.
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {storage.data?.library.available ? (
              <Card className="p-0">
                <CardHeader className="px-3 pt-3 pb-2">
                  <CardTitle className="text-sm">Storage</CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3">
                  <UsageBar usedPercent={storage.data.library.usedPercent} />
                  <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                    {formatBytes(storage.data.library.usedBytes)} of {formatBytes(storage.data.library.totalBytes)}
                  </p>
                </CardContent>
              </Card>
            ) : null}
          </aside>

          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-48 flex-1">
                <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={search.q ?? ""}
                  placeholder="Search library…"
                  aria-label="Search library"
                  className="pl-8"
                  onChange={(event) => update({ q: event.target.value === "" ? undefined : event.target.value })}
                />
              </div>

              <Select value={search.sort} onValueChange={(next) => update({ sort: next as LibrarySearch["sort"] })}>
                <SelectTrigger className="w-36" aria-label="Sort by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="modified">Date added</SelectItem>
                  <SelectItem value="name">Name</SelectItem>
                  <SelectItem value="size">Size</SelectItem>
                </SelectContent>
              </Select>

              <Button
                variant="outline"
                size="icon"
                aria-label={`Sort ${search.order === "asc" ? "ascending" : "descending"}`}
                onClick={() => update({ order: search.order === "asc" ? "desc" : "asc" })}
              >
                <ArrowDownUp className="size-4" aria-hidden />
              </Button>

              <div className="flex overflow-hidden rounded-md border">
                <Button
                  variant={search.view === "grid" ? "secondary" : "ghost"}
                  size="icon"
                  className="rounded-none"
                  aria-label="Grid view"
                  onClick={() => update({ view: "grid" })}
                >
                  <Grid2x2 className="size-4" aria-hidden />
                </Button>
                <Button
                  variant={search.view === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="rounded-none"
                  aria-label="List view"
                  onClick={() => update({ view: "list" })}
                >
                  <List className="size-4" aria-hidden />
                </Button>
              </div>
            </div>

            {listing.isPending ? (
              <Skeleton className="h-64 w-full" />
            ) : listing.isError ? (
              <ErrorState error={listing.error} what="The library" retry={() => void listing.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState
                title="Nothing here yet"
                hint="Finished downloads land in the library. If you expected files, check that the mount is up."
              />
            ) : search.view === "grid" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-3">
                {items.map((item) => (
                  <ItemCard
                    key={item.path}
                    item={item}
                    selected={search.item === item.path}
                    onOpen={() => update({ item: search.item === item.path ? undefined : item.path })}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="px-0 py-1">
                  <ul className="divide-y">
                    {items.map((item) => (
                      <li key={item.path}>
                        <button
                          type="button"
                          onClick={() => update({ item: search.item === item.path ? undefined : item.path })}
                          className={cn(
                            "flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/40",
                            search.item === item.path && "bg-primary/5",
                          )}
                        >
                          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] uppercase">
                            {item.ext.replace(/^\./, "")}
                          </Badge>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{item.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {item.folder === "" ? "library root" : item.folder}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {formatBytes(item.size)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {listing.data ? (
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  Showing {items.length} of {listing.data.matched} match
                  {listing.data.matched === 1 ? "" : "es"}
                  {listing.data.truncated ? " — the scan was capped" : ""}
                </span>
                {slices.length > 0 ? (
                  <span className="flex items-center gap-3">
                    <Donut slices={slices} size={64} />
                    <span className="flex flex-wrap gap-2">
                      {slices.map((slice) => (
                        <span key={slice.key} className="flex items-center gap-1">
                          <span className="size-2 rounded-full" style={{ background: slice.color }} />
                          {slice.label} {slice.value}
                        </span>
                      ))}
                    </span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {docked ? (
            <aside className="min-w-0">
              <Card className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-hidden p-0">
                {detail ?? (
                  <div className="p-6">
                    <EmptyState title="Details" hint="Pick an item to see its streams, subtitles and path." />
                  </div>
                )}
              </Card>
            </aside>
          ) : null}
        </div>
      )}

      <Sheet
        open={!docked && !search.trash && search.item !== undefined}
        onOpenChange={(open) => {
          if (!open) update({ item: undefined });
        }}
      >
        {/* 🔴 `showCloseButton={false}`: the panel inside has its own close, and
            the sheet's would sit on top of it — two X's a finger apart, which is
            how it looked on the iPad. The panel's is the one that stays, because
            it is the same control the docked panel shows on a wide screen.

            ⚠️ `sm:max-w-lg` (32rem) rather than the old `md` (28rem). It beats
            `SheetContent`'s own `sm:max-w-sm` because `cn` is `twMerge`, which
            resolves same-variant conflicts by last-wins — this is *not* the
            `sm:max-w-lg` vs `max-w-3xl` trap in DISCOVERIES, where the two
            classes are different variants and twMerge leaves both standing. */}
        <SheetContent side="right" className="w-full p-0 sm:max-w-lg" showCloseButton={false}>
          <SheetTitle className="sr-only">Item details</SheetTitle>
          {detail}
        </SheetContent>
      </Sheet>
    </>
  );
}
