/**
 * The library's controls: search, order, view — and selection.
 *
 * Lifted out of `screens/Library.tsx` when the selection bar pushed that screen
 * past the size at which anyone can read it. It owns no state: every value
 * comes down as a prop and every change goes back up, because the filters live
 * in the URL and the selection lives in the screen (see `LibraryScreen` for why
 * that difference is deliberate).
 */
import { ArrowDownUp, Grid2x2, List, ListChecks, Search, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LibrarySearch } from "../../search-params";

export function LibraryToolbar({
  search,
  onSearch,
  selecting,
  selected,
  visible,
  onToggleSelecting,
  onSelectAll,
  onClearSelection,
  onConvertSelected,
}: {
  search: LibrarySearch;
  onSearch(patch: Partial<LibrarySearch>): void;
  selecting: boolean;
  /** How many are ticked. */
  selected: number;
  /** How many rows are on screen — what "select all" would take. */
  visible: number;
  onToggleSelecting(): void;
  onSelectAll(): void;
  onClearSelection(): void;
  onConvertSelected(): void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search.q ?? ""}
            placeholder="Search library…"
            aria-label="Search library"
            className="pl-8"
            onChange={(event) => onSearch({ q: event.target.value === "" ? undefined : event.target.value })}
          />
        </div>

        <Select value={search.sort} onValueChange={(next) => onSearch({ sort: next as LibrarySearch["sort"] })}>
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
          onClick={() => onSearch({ order: search.order === "asc" ? "desc" : "asc" })}
        >
          <ArrowDownUp className="size-4" aria-hidden />
        </Button>

        <div className="flex overflow-hidden rounded-md border">
          <Button
            variant={search.view === "grid" ? "secondary" : "ghost"}
            size="icon"
            className="rounded-none"
            aria-label="Grid view"
            onClick={() => onSearch({ view: "grid" })}
          >
            <Grid2x2 className="size-4" aria-hidden />
          </Button>
          <Button
            variant={search.view === "list" ? "secondary" : "ghost"}
            size="icon"
            className="rounded-none"
            aria-label="List view"
            onClick={() => onSearch({ view: "list" })}
          >
            <List className="size-4" aria-hidden />
          </Button>
        </div>

        {/* An explicit mode rather than a tick that appears on hover: there is
            no hover on the iPad this is used from, and a control that only
            exists under a pointer is a control that does not exist there. */}
        <Button
          variant={selecting ? "secondary" : "outline"}
          size="sm"
          className="gap-1.5"
          aria-pressed={selecting}
          onClick={onToggleSelecting}
        >
          <ListChecks className="size-4" aria-hidden />
          {selecting ? "Done" : "Select"}
        </Button>
      </div>

      {selecting ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2.5">
          <span className="text-sm font-medium tabular-nums">{selected} selected</span>
          <Button variant="ghost" size="sm" onClick={onSelectAll} disabled={visible === 0 || selected === visible}>
            Select all {visible}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClearSelection} disabled={selected === 0}>
            Clear
          </Button>
          <span className="flex-1" />
          {/* 🔴 One button, and it opens the same dialog the single-file path
              opens — same presets, same cost sentence, same warning about the
              original. A batch differs only in how many rows come back, which
              is exactly what `POST /api/transcode` already models. */}
          <Button size="sm" className="gap-1.5" disabled={selected === 0} onClick={onConvertSelected}>
            <Wand2 className="size-4" aria-hidden />
            {selected <= 1 ? "Convert…" : `Convert ${selected} files…`}
          </Button>
        </div>
      ) : null}
    </>
  );
}
