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
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  FileQuestion,
  FileX2,
  FolderCheck,
  HelpCircle,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

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
import { SORT_LOOK, directionLabel, type FileState, type FileStateReason, type ResolvedFileState } from "./job-order";

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
  present: "On disk",
  missing: "File is gone",
  trashed: "In the trash",
  none: "No file recorded",
  unknown: "Could not check",
};

/**
 * The file-state filter, with a re-check beside it.
 *
 * 🔴 The button is not a convenience. This filter's answers come from a disk
 * check that deliberately does **not** poll — a file does not vanish while you
 * watch it, it is gone when you come back — so the only honest way to offer
 * "check again" is to offer it. It also carries *when* the answer was taken,
 * because a file state is a snapshot and a snapshot ages.
 */
export function FileFilterControl({
  value,
  onChange,
  onRecheck,
  checking = false,
  checkedAt,
  elapsedMs,
  unavailable = false,
}: {
  value: FileFilter;
  onChange(next: FileFilter): void;
  onRecheck?: (() => void) | undefined;
  checking?: boolean;
  /** ISO-8601, from the server's answer. */
  checkedAt?: string | undefined;
  /** What the check cost. Shown because it is the honest label on a disk read. */
  elapsedMs?: number | undefined;
  /**
   * No check has succeeded, so every state is `unknown` and filtering by one
   * would empty the table. Disabled and said out loud beats a control that
   * silently hides everything.
   */
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

  const recheck =
    onRecheck === undefined ? null : (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-9 shrink-0"
            disabled={checking}
            onClick={onRecheck}
            aria-label="Check the files on disk again"
          >
            <RefreshCw className={cn("size-4", checking && "animate-spin")} aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {checkedAt
            ? `Look at the disk again. Last checked at ${new Date(checkedAt).toLocaleTimeString()}${
                elapsedMs === undefined ? "" : ` — ${elapsedMs} ms`
              }.`
            : "Look at the disk again."}
        </TooltipContent>
      </Tooltip>
    );

  if (!unavailable) {
    return (
      <div className="flex items-center gap-2">
        {control}
        {recheck}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{control}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          The files on disk could not be checked, so nothing can be said about them. The downloads themselves are
          unaffected — they live on the server.
        </TooltipContent>
      </Tooltip>
      {recheck}
    </div>
  );
}

/**
 * Why a state could not be established, in a sentence.
 *
 * 🔴 The server writes the specific one (`detail`), and this is the fallback
 * that keeps the badge honest when there is none. Each of these is a *different*
 * situation, and collapsing them into "unknown" is what would make the badge
 * useless: "the NAS is not mounted" is actionable and "the check has not run
 * yet" is not.
 */
const UNKNOWN_HINT: Record<FileStateReason, string> = {
  "not-checked": "The files have not been checked yet.",
  "not-finished": "The download has not finished, so there is no file to look for yet.",
  "mount-unavailable":
    "The library could not be reached, so nothing can be said about this file. It is almost certainly still there.",
  "library-empty":
    "The library answered and is completely empty, which is what an unmounted network share looks like. Nothing is claimed about this file.",
  "timed-out": "The library did not answer in time. Nothing is claimed about this file.",
  unreadable: "This path could not be read. Nothing is claimed about the file.",
  "outside-library": "The recorded path is not inside the library, so it cannot be checked.",
  "trash-unreadable":
    "The file is not at its recorded path, and the trash could not be read to say whether CasaTube is what moved it.",
};

const FILE_LOOK: Record<
  Exclude<FileState, "unknown">,
  { label: string; icon: typeof FolderCheck; className: string; hint: string }
> = {
  present: {
    label: "On disk",
    icon: FolderCheck,
    className: "bg-success/12 text-success ring-success/25",
    // 🔴 The wording changed with the meaning. It used to say "Filed", which
    // claimed only that CasaTube once moved a file here; this one is a fact
    // about the disk as of the last check.
    hint: "The file was there when the library was last checked.",
  },
  missing: {
    label: "File gone",
    icon: FileX2,
    className: "bg-destructive/12 text-destructive ring-destructive/25",
    hint: "The library answered and there is no file at the recorded path — it was removed outside CasaTube, or moved. The download can be repeated from the details panel.",
  },
  trashed: {
    label: "In trash",
    icon: Trash2,
    className: "bg-warning/15 text-warning ring-warning/30",
    hint: "Deleted from the library, but only as far as the trash. The Library screen can put it back.",
  },
  none: {
    label: "No file",
    icon: FileQuestion,
    className: "bg-muted text-muted-foreground ring-border",
    hint: "The job finished without recording where the file went. There is nothing to open, and nothing to restore.",
  },
};

/**
 * What became of the download, on the row.
 *
 * ⚠️ **Two kinds of silence, and they are not the same.** A job that has not
 * finished, and a row the check has not reached yet, draw *nothing* — a badge
 * on every running row is noise. Everything else that is `unknown` draws a
 * visible mark that says so, because a library that cannot be read is exactly
 * the situation where a blank badge would be read as "fine".
 */
export function FileStateBadge({ state }: { state: ResolvedFileState }) {
  if (state.state === "unknown") {
    const reason = state.reason ?? "not-checked";
    if (reason === "not-finished" || reason === "not-checked") return null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground ring-1 ring-border ring-inset">
            <HelpCircle className="size-3" aria-hidden />
            Not checked
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{state.detail ?? UNKNOWN_HINT[reason]}</TooltipContent>
      </Tooltip>
    );
  }

  const look = FILE_LOOK[state.state];
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

/** The sentence for an `unknown`, for anywhere that wants prose rather than a pill. */
export function unknownReasonText(state: ResolvedFileState): string {
  return state.detail ?? UNKNOWN_HINT[state.reason ?? "not-checked"];
}
