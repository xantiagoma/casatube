/**
 * The small shared pieces: a status pill, a priority marker, a progress bar, a
 * stat tile, and the two states every panel needs (empty, and broken).
 *
 * They live together because they are the vocabulary the screens are written
 * in — a status that looks one way in the queue and another on the dashboard
 * is the bug this file exists to make impossible.
 */
import type { ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Inbox, Minus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { JobStatus, Priority } from "../../../core/types";
import { statusLook, type Tone } from "../status";
import { formatCount } from "../../data/format";

const TONE_CLASS: Record<Tone, string> = {
  idle: "bg-muted text-muted-foreground ring-border",
  busy: "bg-info/12 text-info ring-info/25",
  ok: "bg-success/12 text-success ring-success/25",
  warn: "bg-warning/15 text-warning ring-warning/30",
  danger: "bg-destructive/12 text-destructive ring-destructive/25",
};

export function StatusPill({ status, className }: { status: JobStatus; className?: string }) {
  const look = statusLook(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
        TONE_CLASS[look.tone],
        className,
      )}
    >
      {look.tone === "busy" && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {look.label}
    </span>
  );
}

const PRIORITY_LOOK: Record<Priority, { label: string; className: string; icon: typeof ArrowUp }> = {
  high: { label: "High", className: "text-destructive", icon: ArrowUp },
  normal: { label: "Normal", className: "text-muted-foreground", icon: Minus },
  low: { label: "Low", className: "text-primary", icon: ArrowDown },
};

export function PriorityMark({ priority }: { priority: Priority }) {
  const look = PRIORITY_LOOK[priority] ?? PRIORITY_LOOK.normal;
  const Icon = look.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", look.className)}>
      <Icon className="size-3" aria-hidden />
      {look.label}
    </span>
  );
}

/**
 * The bar.
 *
 * ⚠️ `indeterminate` is not decoration: a job that is analysing has no
 * percentage yet, and a bar sitting at 0% says "nothing is happening" when
 * something is. The striped animation is the honest rendering of "working,
 * amount unknown".
 */
export function ProgressBar({
  percent,
  tone = "info",
  indeterminate = false,
  className,
}: {
  percent: number;
  tone?: "info" | "primary" | "success" | "destructive" | "warning";
  indeterminate?: boolean;
  className?: string;
}) {
  const fill = {
    info: "bg-info",
    primary: "bg-primary",
    success: "bg-success",
    destructive: "bg-destructive",
    warning: "bg-warning",
  }[tone];

  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      {indeterminate ? (
        <div className={cn("h-full w-1/3 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full", fill)} />
      ) : (
        <div
          className={cn("h-full rounded-full transition-[width] duration-500 ease-out", fill)}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      )}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  chart,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  chart?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 py-4", className)}>
      <CardContent className="px-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        {chart ? <div className="mt-2">{chart}</div> : null}
      </CardContent>
    </Card>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="text-muted-foreground">{icon ?? <Inbox className="size-6" aria-hidden />}</div>
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-md text-xs text-muted-foreground">{hint}</p> : null}
      {action}
    </div>
  );
}

/**
 * A failure, rendered where it happened.
 *
 * ⚠️ Deliberately not a page-wide error: the library going away must not take
 * the queue with it, and on a home server that is the normal Tuesday.
 */
export function ErrorState({ error, retry, what }: { error: Error | null; retry?: () => void; what: string }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertTriangle className="size-4" aria-hidden />
        {what} could not be loaded.
      </p>
      <p className="text-xs text-muted-foreground">{error?.message ?? "The server did not say why."}</p>
      {retry ? (
        <button
          type="button"
          onClick={retry}
          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Storage, as the design draws it: a capacity line and a used bar. */
/**
 * "You are looking at part of the answer" — or nothing, when you are not.
 *
 * 🔴 The line this exists to prevent is the one that was never written: a table
 * capped at two hundred rows said "200" and nothing else, so "the largest
 * failed download" and "the largest of the latest two hundred" looked the same
 * on screen. The server sorts and counts now, so the top of the list is
 * genuinely the top — what remains is that the *rest* is not reachable by
 * scrolling, and that has to be said rather than left to be discovered.
 */
/**
 * Which slice of the list this is, and the way to the next one.
 *
 * 🔴 It used to be a note: "showing 200 of 3,412 — narrow the search to reach
 * the rest". The server always took `offset`; nothing on screen sent one, so
 * row 201 was reachable only by already knowing what to search for.
 */
export function Pager({
  shown,
  total,
  limit,
  page,
  noun,
  onPage,
}: {
  /** Rows actually on screen, after any filter the browser applies. */
  shown: number;
  /** What the server says the filter matches, over the whole table. */
  total: number;
  /** The page size that was asked for. */
  limit: number;
  /** 1-based. */
  page: number;
  noun: string;
  onPage(page: number): void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1 && page <= 1) return null;
  const first = (page - 1) * limit + 1;
  const last = Math.min(total, page * limit);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {first > total ? `Nothing on page ${page}` : `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)} ${noun}`}
        {shown < Math.max(0, last - first + 1) ? ` · ${formatCount(shown)} shown after the file filter` : ""}
      </span>
      <span className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-3.5" aria-hidden />
          Previous
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      </span>
    </div>
  );
}

export function UsageBar({ usedPercent }: { usedPercent: number }) {
  const tone = usedPercent >= 90 ? "bg-destructive" : usedPercent >= 75 ? "bg-warning" : "bg-primary";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }} />
    </div>
  );
}
