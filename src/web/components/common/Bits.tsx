/**
 * The small shared pieces: a status pill, a priority marker, a progress bar, a
 * stat tile, and the two states every panel needs (empty, and broken).
 *
 * They live together because they are the vocabulary the screens are written
 * in — a status that looks one way in the queue and another on the dashboard
 * is the bug this file exists to make impossible.
 */
import type { ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Inbox, Minus } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { JobStatus, Priority } from "../../../core/types";
import { statusLook, type Tone } from "../status";

const TONE_CLASS: Record<Tone, string> = {
  idle: "bg-muted text-muted-foreground ring-border",
  busy: "bg-primary/10 text-primary ring-primary/25",
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
  tone = "primary",
  indeterminate = false,
  className,
}: {
  percent: number;
  tone?: "primary" | "success" | "destructive" | "warning";
  indeterminate?: boolean;
  className?: string;
}) {
  const fill = {
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
export function UsageBar({ usedPercent }: { usedPercent: number }) {
  const tone = usedPercent >= 90 ? "bg-destructive" : usedPercent >= 75 ? "bg-warning" : "bg-primary";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }} />
    </div>
  );
}
