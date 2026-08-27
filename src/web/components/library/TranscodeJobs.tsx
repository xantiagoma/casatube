/**
 * The conversions: what is running, what is waiting, and what came of the rest.
 *
 * 🔴 **The waiting rows are the reason this screen exists in this shape.** One
 * ffmpeg runs at a time (`core/transcode.ts` refuses to make that a number
 * anyone can raise), so a batch of five is four rows that will sit there saying
 * "Waiting" for hours. Rendered as a bare status that reads as *broken*; with
 * the position in the queue and one sentence saying why, it reads as a queue.
 *
 * 🔴 **Cancelling the running job is worded as what it costs**: the encode so
 * far is thrown away and the half-written output is deleted. The original is
 * never involved — it has not been touched at any point.
 *
 * ⚠️ Progress here is a poll, not a stream. See `data/transcode.ts`.
 */
import { useState } from "react";
import { CircleSlash, FileVideo2, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { TranscodeRow } from "../../../core/transcode";
import { formatBytes, formatDateTime, formatDuration } from "../../data/format";
import { useCancelTranscode, useTranscodePresets, useTranscodes } from "../../data/transcode";
import { EmptyState, ErrorState, ProgressBar } from "../common/Bits";
import type { Tone } from "../status";
import {
  concurrencyLine,
  fileNameOf,
  isCancellable,
  queuePositionLabel,
  sortTranscodes,
  transcodeLook,
  transcodeProgress,
  transcodesAhead,
} from "./transcode-view";

const TONE_CLASS: Record<Tone, string> = {
  idle: "bg-muted text-muted-foreground ring-border",
  busy: "bg-primary/10 text-primary ring-primary/25",
  ok: "bg-success/12 text-success ring-success/25",
  warn: "bg-warning/15 text-warning ring-warning/30",
  danger: "bg-destructive/12 text-destructive ring-destructive/25",
};

function TranscodePill({ row }: { row: TranscodeRow }) {
  const look = transcodeLook(row.status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
        TONE_CLASS[look.tone],
      )}
    >
      {look.tone === "busy" ? <span className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
      {look.label}
    </span>
  );
}

/**
 * Roughly how long is left, at the rate it has managed so far.
 *
 * ⚠️ Worded as an estimate and withheld until there is something to estimate
 * from. An encode's rate is not constant — a title card encodes far faster than
 * an action scene — so this is a scale ("minutes" or "hours"), not a promise,
 * and it is exactly the question a person watching the bar is asking.
 */
function remainingLabel(row: TranscodeRow, now: number): string | null {
  if (row.status !== "running" || row.startedAt === null || row.progress < 5) return null;
  const started = Date.parse(row.startedAt);
  if (!Number.isFinite(started)) return null;
  const elapsed = (now - started) / 1000;
  if (elapsed <= 0) return null;
  const remaining = (elapsed / row.progress) * (100 - row.progress);
  return `about ${formatDuration(remaining)} left at this rate`;
}

function TranscodeJobRow({
  row,
  jobs,
  presetLabel,
  compact = false,
}: {
  row: TranscodeRow;
  jobs: readonly TranscodeRow[];
  presetLabel: string;
  compact?: boolean;
}) {
  const cancel = useCancelTranscode();
  const [confirming, setConfirming] = useState(false);
  const { percent, indeterminate } = transcodeProgress(row);
  const ahead = transcodesAhead(jobs, row.id);
  const remaining = remainingLabel(row, Date.now());

  return (
    <li className="space-y-2 py-3">
      <div className="flex items-start gap-3">
        <FileVideo2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{fileNameOf(row.outputPath)}</p>
          {/* 🔴 Both paths, always. This is where "it never overwrites the
              original" stops being a claim and becomes something visible: two
              different filenames, side by side. */}
          <p className="truncate text-xs text-muted-foreground">
            {presetLabel} · from {fileNameOf(row.sourcePath)}
            {row.replaceOriginal ? " · the original goes to the trash once the copy is verified" : ""}
          </p>
        </div>
        <TranscodePill row={row} />
        {isCancellable(row) ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={row.status === "running" ? "Stop this conversion" : "Remove from the queue"}
            disabled={cancel.isPending}
            onClick={() => (row.status === "running" ? setConfirming(true) : cancel.mutate(row.id))}
          >
            {row.status === "running" ? <X className="size-4" aria-hidden /> : <CircleSlash className="size-4" aria-hidden />}
          </Button>
        ) : null}
      </div>

      {row.status === "running" ? (
        <div className="space-y-1">
          <ProgressBar percent={percent} indeterminate={indeterminate} />
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
            <span>
              {indeterminate
                ? row.durationSeconds === null
                  ? "working — this file has no duration to measure against"
                  : "starting…"
                : `${percent}%`}
            </span>
            {row.durationSeconds !== null ? <span>· of {formatDuration(row.durationSeconds)}</span> : null}
            {remaining ? <span>· {remaining}</span> : null}
          </p>
        </div>
      ) : null}

      {row.status === "queued" ? (
        <p className="text-xs text-muted-foreground">
          {queuePositionLabel(ahead)}
          {row.attempts > 0 ? ` · retrying after a failure (attempt ${row.attempts + 1} of ${row.maxAttempts})` : ""}
        </p>
      ) : null}

      {row.status === "done" ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatBytes(row.outputBytes)} written
          {row.sourceBytes !== null ? ` · the original was ${formatBytes(row.sourceBytes)}` : ""}
          {row.finishedAt !== null ? ` · ${formatDateTime(row.finishedAt)}` : ""}
        </p>
      ) : null}

      {row.status === "failed" && row.error !== null ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {row.error}
          {/* ⚠️ Said out loud, because a failed conversion is the moment someone
              worries about their file. Nothing is ever written over the source,
              so a failure costs time and nothing else. */}
          <span className="mt-1 block text-muted-foreground">
            The original is untouched, and the half-written copy was removed.
          </span>
        </p>
      ) : null}

      {/* The last thing the runner said. Present on every terminal row and on
          the running one — it is where "the original was moved to .trash/"
          and "the copy is fine but the original could not be moved" show up. */}
      {!compact && row.log.length > 0 ? (
        <p className="truncate text-xs text-muted-foreground/80">{row.log[row.log.length - 1]}</p>
      ) : null}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop this conversion?</DialogTitle>
            <DialogDescription>
              ffmpeg is killed and the partly written {fileNameOf(row.outputPath)} is deleted — the {percent}% done so
              far is lost and starting again starts from the beginning. <strong>{fileNameOf(row.sourcePath)} is not
              touched</strong>; it never was.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep converting
            </Button>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(row.id, { onSuccess: () => setConfirming(false) })}
            >
              Stop it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** Preset ids are what the rows carry; the labels live on `/presets`. */
function usePresetLabels(): (id: string) => string {
  const presets = useTranscodePresets();
  const list = presets.data?.presets ?? [];
  return (id: string) => list.find((preset) => preset.id === id)?.label ?? id;
}

/**
 * The whole list, as the Conversions tab draws it.
 */
export function TranscodeJobsCard({ enabled = true }: { enabled?: boolean }) {
  const listing = useTranscodes(enabled);
  const presets = useTranscodePresets(enabled);
  const cancel = useCancelTranscode();
  const labelOf = usePresetLabels();

  if (listing.isPending) return <Skeleton className="h-48 w-full" />;
  if (listing.isError) {
    return <ErrorState error={listing.error} what="The conversions" retry={() => void listing.refetch()} />;
  }

  const jobs = listing.data.jobs;
  const rows = sortTranscodes(jobs);
  const line = concurrencyLine(jobs, presets.data?.concurrency ?? 1);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div>
          <CardTitle className="text-base">Conversions</CardTitle>
          <p className="text-xs text-muted-foreground">
            {/* 🔴 The standing explanation, whether or not anything is running:
                this is the expensive corner of CasaTube and the screen says so
                before anybody has to find out. */}
            Converting re-encodes the video — unlike playing a file, which only repacks it. It is the slowest thing
            CasaTube does and it runs on the same machine as everything else.
          </p>
          {line ? <p className="mt-1 text-xs font-medium text-primary">{line}</p> : null}
        </div>
        {rows.length > 0 ? (
          <CardAction>
            <span className="text-xs text-muted-foreground tabular-nums">
              {rows.length} {rows.length === 1 ? "conversion" : "conversions"}
            </span>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing has been converted"
            hint="Pick a file in the library and choose Convert. Use it for something that will not play on the device you want it on — not as a habit."
            icon={<FileVideo2 className="size-6" aria-hidden />}
          />
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <TranscodeJobRow key={row.id} row={row} jobs={jobs} presetLabel={labelOf(row.preset)} />
            ))}
          </ul>
        )}
        {cancel.isError ? <p className="mt-2 text-xs text-destructive">{cancel.error.message}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The same rows, filtered to one file, for the detail panel.
 *
 * ⚠️ Renders nothing at all when this file has no conversions — the panel is
 * long already, and an empty "Conversions" heading on every file is noise.
 */
export function FileTranscodes({ rows, jobs }: { rows: TranscodeRow[]; jobs: readonly TranscodeRow[] }) {
  const labelOf = usePresetLabels();
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium">Conversions of this file</p>
      <ul className="divide-y rounded-md border px-2">
        {rows.map((row) => (
          <TranscodeJobRow key={row.id} row={row} jobs={jobs} presetLabel={labelOf(row.preset)} compact />
        ))}
      </ul>
    </div>
  );
}

/** A spinner-sized marker for the tab, so a running encode is visible from elsewhere. */
export function ConvertingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary tabular-nums">
      <Loader2 className="size-2.5 animate-spin" aria-hidden />
      {count}
    </span>
  );
}
