/**
 * The six stages of the pipeline.
 *
 * 🔴 PLAN §6: a job is a pipeline, not a status. A single word —
 * "downloading" — cannot say that the download finished and ffmpeg is now
 * merging, which is exactly the moment a progress bar sitting at 100% looks
 * like a hang. Showing all six makes the difference visible without reading a
 * log, and it is why the inspector in the reference design has a Tasks tab at
 * all.
 *
 * Two renderings of the same six facts: `StageTrack` is the compact strip for a
 * table row, `StagePipeline` the numbered list the inspector shows.
 */
import { Check, CircleDashed, Loader2, SkipForward, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { STAGE_ORDER, type Stage, type StageName, type StageStatus } from "../../../core/types";

const LABEL: Record<StageName, string> = {
  validate: "Validate & extract",
  analyze: "Analyze content",
  download: "Download media",
  postprocess: "Post-process (ffmpeg)",
  metadata: "Embed metadata",
  move: "Upload / move",
};

const PIP: Record<StageStatus, string> = {
  pending: "bg-muted-foreground/25",
  running: "bg-info animate-pulse",
  done: "bg-success",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/40",
};

function stagesByName(stages: Stage[]): Map<StageName, Stage> {
  return new Map(stages.map((stage) => [stage.name, stage]));
}

export function StageTrack({ stages, className }: { stages: Stage[]; className?: string }) {
  const byName = stagesByName(stages);
  return (
    // `role="group"` is not decoration: a bare <div> may not carry an
    // aria-label, so without a role the label is dropped and the six pips reach
    // a screen reader as six unexplained words.
    <div className={cn("flex items-center gap-1", className)} role="group" aria-label="Pipeline stages">
      {STAGE_ORDER.map((name) => {
        // A job created before a stage existed simply has no record for it;
        // `pending` is the honest reading of that, not an error.
        const stage = byName.get(name);
        const status = stage?.status ?? "pending";
        return (
          <span
            key={name}
            title={stage?.error ?? `${LABEL[name]}: ${status}`}
            className={cn("h-1.5 flex-1 rounded-full", PIP[status])}
          />
        );
      })}
    </div>
  );
}

const ICON: Record<StageStatus, typeof Check> = {
  pending: CircleDashed,
  running: Loader2,
  done: Check,
  failed: X,
  skipped: SkipForward,
};

const TEXT: Record<StageStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-info",
  done: "text-success",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

const WORD: Record<StageStatus, string> = {
  pending: "Pending",
  running: "In progress",
  done: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

export function StagePipeline({ stages }: { stages: Stage[] }) {
  const byName = stagesByName(stages);
  return (
    <ol className="divide-y rounded-lg border">
      {STAGE_ORDER.map((name, index) => {
        const stage = byName.get(name);
        const status = stage?.status ?? "pending";
        const Icon = ICON[status];
        return (
          <li key={name} className="flex items-center gap-3 px-3 py-2.5">
            <span
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-md border text-[11px] font-semibold tabular-nums",
                status === "running" && "border-info/40 bg-info/10 text-info",
                status === "done" && "border-success/40 bg-success/10 text-success",
                status === "failed" && "border-destructive/40 bg-destructive/10 text-destructive",
                (status === "pending" || status === "skipped") && "text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("truncate text-sm", status === "pending" ? "text-muted-foreground" : "font-medium")}>
                {LABEL[name]}
              </p>
              {stage?.error ? <p className="truncate text-xs text-destructive">{stage.error}</p> : null}
            </div>
            <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", TEXT[status])}>
              {WORD[status]}
              <Icon className={cn("size-3.5", status === "running" && "animate-spin")} aria-hidden />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
