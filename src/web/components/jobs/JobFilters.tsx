/**
 * The controls that decide which jobs are on screen and in what order — one
 * copy, used by both the Queue and Downloads.
 *
 * 🔴 Every one of them is **controlled from the URL**. Nothing here holds state:
 * a value comes in as a prop and a change goes back out as a callback that
 * writes a search param. That is what makes "the biggest failed downloads,
 * oldest first, matching 'zoo'" a link somebody can be sent, and what makes a
 * reload land on the same view (PLAN §8).
 *
 * ⚠️ The direction control never says "ascending". Ranks ascend; what a person
 * wants to know is whether High is at the top — so the button says *Highest
 * first*, and `job-order.ts` owns the mapping so the two screens cannot label
 * the same toggle differently.
 */
import { ArrowDownWideNarrow, ArrowUpNarrowWide, FolderCheck, FileX2, Search, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  FILE_FILTERS,
  JOB_SORTS,
  QUEUE_FILTERS,
  type FileFilter,
  type JobSort,
  type QueueFilter,
  type SortOrder,
} from "../../search-params";
import { SORT_LOOK, directionLabel, type FileState } from "./job-order";

/** Sort key and direction, as two controls that read as one sentence. */
export function SortControl({
  sort,
  order,
  onChange,
}: {
  sort: JobSort;
  order: SortOrder;
  onChange(next: { sort?: JobSort; order?: SortOrder }): void;
}) {
  const Arrow = order === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  return (
    <div className="flex items-center gap-2">
      <Select value={sort} onValueChange={(next) => onChange({ sort: next as JobSort })}>
        <SelectTrigger className="w-[9.5rem]" aria-label="Sort by">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {JOB_SORTS.map((key) => (
            <SelectItem key={key} value={key}>
              {SORT_LOOK[key].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant="outline"
        className="gap-1.5"
        // The accessible name carries the *meaning*, not the direction: a screen
        // reader saying "descending" is as unhelpful as a label saying it.
        aria-label={`Order: ${directionLabel(sort, order)}. Reverse it.`}
        onClick={() => onChange({ order: order === "asc" ? "desc" : "asc" })}
      >
        <Arrow aria-hidden />
        <span className="hidden text-xs font-medium sm:inline">{directionLabel(sort, order)}</span>
      </Button>
    </div>
  );
}

const STATUS_LABEL: Record<QueueFilter, string> = {
  all: "All statuses",
  waiting: "Waiting",
  running: "Running",
  done: "Completed",
  failed: "Failed or cancelled",
};

export function StatusFilter({ value, onChange }: { value: QueueFilter; onChange(next: QueueFilter): void }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as QueueFilter)}>
      <SelectTrigger className="w-[11rem]" aria-label="Filter by status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {QUEUE_FILTERS.map((key) => (
          <SelectItem key={key} value={key}>
            {STATUS_LABEL[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Free text.
 *
 * ⚠️ Uncontrolled-looking but controlled: the value is the search param, so the
 * back button walks through searches and a reload keeps the one you typed.
 */
export function SearchBox({
  value,
  onChange,
  label,
  className,
}: {
  value: string;
  onChange(next: string): void;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("relative min-w-44 flex-1", className)}>
      <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        value={value}
        placeholder={`${label}…`}
        aria-label={label}
        className="pl-8"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const FILE_FILTER_LABEL: Record<FileFilter, string> = {
  any: "Any file state",
  filed: "In the library",
  trashed: "In the trash",
  none: "No file recorded",
};

/**
 * @param unavailable The trash listing could not be read, so every state is
 * `unknown` and filtering by one would hide everything. Disabled and said out
 * loud beats a control that silently empties the table.
 */
export function FileFilterControl({
  value,
  onChange,
  unavailable = false,
}: {
  value: FileFilter;
  onChange(next: FileFilter): void;
  unavailable?: boolean;
}) {
  const control = (
    <Select value={value} onValueChange={(next) => onChange(next as FileFilter)} disabled={unavailable}>
      <SelectTrigger className="w-[11rem]" aria-label="Filter by file state">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FILE_FILTERS.map((key) => (
          <SelectItem key={key} value={key}>
            {FILE_FILTER_LABEL[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (!unavailable) return control;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{control}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        The library's trash could not be read, so nothing can be said about the files. The downloads themselves are
        unaffected — they live on the server.
      </TooltipContent>
    </Tooltip>
  );
}

const FILE_LOOK: Record<
  Exclude<FileState, "unknown">,
  { label: string; icon: typeof FolderCheck; className: string; hint: string }
> = {
  filed: {
    label: "Filed",
    icon: FolderCheck,
    className: "bg-muted text-muted-foreground ring-border",
    // 🔴 The wording is careful on purpose. Nothing here has looked at the disk.
    hint: "CasaTube moved it into the library and it is not in the trash. Whether it is still on disk is not checked — a file deleted outside CasaTube still reads as filed.",
  },
  trashed: {
    label: "In trash",
    icon: Trash2,
    className: "bg-warning/15 text-warning ring-warning/30",
    hint: "Deleted from the library, but only as far as the trash. The Library screen can put it back.",
  },
  none: {
    label: "No file",
    icon: FileX2,
    className: "bg-destructive/12 text-destructive ring-destructive/25",
    hint: "The job finished without recording where the file went. There is nothing to open, and nothing to restore.",
  },
};

/**
 * What became of the download, on the row.
 *
 * Renders nothing for `unknown` — a job that has not finished has no file yet,
 * and a badge that says "unknown" on every running row is noise, not
 * information.
 */
export function FileStateBadge({ state }: { state: FileState }) {
  if (state === "unknown") return null;
  const look = FILE_LOOK[state];
  const Icon = look.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap",
            look.className,
          )}
        >
          <Icon className="size-3" aria-hidden />
          {look.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{look.hint}</TooltipContent>
    </Tooltip>
  );
}
