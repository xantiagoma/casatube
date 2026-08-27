/**
 * "Convert this file" — the only place in CasaTube that asks for CPU.
 *
 * 🔴 **Three things this dialog must say, because the server enforces them and
 * a person pressing the button has to understand why.** Each one is rendered
 * from the server's own answer rather than from a sentence written here:
 *
 * 1. **It re-encodes, and that is expensive** — unlike playback, which remuxes
 *    (`core/hls.ts`: the video bitstream is *copied*, a few percent of one
 *    core). The cost sentence comes off the preset (`preset.cost`) and the
 *    batch warning off the `POST` response.
 * 2. **One at a time** — `concurrency`, sent by `/presets` for this purpose,
 *    plus how many conversions are already waiting, so a queue never reads as
 *    a stall.
 * 3. **The original is never overwritten** — a new file is written beside it.
 *    `replaceOriginal` is offered, off, and worded as what it does: the
 *    original is moved to `.trash/` *after* the copy is verified, and it is
 *    restorable from the Trash tab.
 *
 * 🔴 **No ffmpeg flag appears anywhere in this file.** The route takes a preset
 * id off a fixed list precisely so that the set of commands that can run is the
 * set written in `core/transcode.ts`; a "custom arguments" box here would undo
 * that in one text input.
 */
import { useState } from "react";
import { AlertTriangle, Clock, FileVideo2, Info, Loader2, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  useStartTranscode,
  useTranscodePresets,
  useTranscodes,
  type TranscodeOutcome,
  type TranscodePresetInfo,
} from "../../data/transcode";
import { ErrorState } from "../common/Bits";
import { fileNameOf, summariseOutcome } from "./transcode-view";

/** How many filenames are listed before the rest become a count. */
const NAMES_SHOWN = 6;

function PresetOption({
  preset,
  selected,
  onSelect,
}: {
  preset: TranscodePresetInfo;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        // `items-start` and a real minimum height: this is read on an iPad, and
        // a two-sentence option squeezed into a 32 px row is a row nobody reads.
        "flex w-full flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:border-primary/40 hover:bg-accent/40",
      )}
    >
      <span className="flex w-full flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{preset.label}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] uppercase">
          .{preset.ext}
        </Badge>
        {/* 🔴 The badge is the fast version of the cost sentence below it: the
            expensive presets and the cheap ones are told apart at a glance,
            from the server's own `reencodesVideo` flag. */}
        {preset.reencodesVideo ? (
          <Badge className="gap-1 bg-warning/15 px-1.5 py-0 text-[10px] text-warning ring-1 ring-warning/30 ring-inset">
            <AlertTriangle className="size-3" aria-hidden />
            Re-encodes the video
          </Badge>
        ) : (
          <Badge className="bg-success/12 px-1.5 py-0 text-[10px] text-success ring-1 ring-success/25 ring-inset">
            Copies the streams
          </Badge>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{preset.description}</span>
      {/* The server's own sentence about what this costs, verbatim. */}
      <span className={cn("text-xs font-medium", preset.reencodesVideo ? "text-warning" : "text-muted-foreground")}>
        {preset.cost}
      </span>
    </button>
  );
}

/** The receipt: what was queued, what was not, and the server's warning. */
function Outcome({ outcome, onClose, onSeeQueue }: { outcome: TranscodeOutcome; onClose(): void; onSeeQueue(): void }) {
  const summary = summariseOutcome(outcome);
  return (
    <>
      <div className="space-y-3">
        <p className="text-sm font-medium">{summary.headline}</p>

        {/* ⚠️ The server's warning, not ours. It is the sentence that says the
            machine is busy for as long as this takes and that the rest wait. */}
        {outcome.warning ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{outcome.warning}</span>
          </p>
        ) : null}

        {outcome.queued.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {outcome.queued.map((row: TranscodeRow) => (
              <li key={row.id} className="flex items-start gap-2 rounded-md border p-2">
                <FileVideo2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{fileNameOf(row.outputPath)}</span>
                  {/* 🔴 The proof of the promise: a *new* path, beside the old
                      one, which is still exactly where it was. */}
                  <span className="block truncate text-muted-foreground">
                    a new file beside {fileNameOf(row.sourcePath)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {outcome.rejected.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-medium text-destructive">Not queued</p>
            <ul className="space-y-1 text-xs">
              {outcome.rejected.map((rejection) => (
                <li key={rejection.path} className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
                  <span className="block truncate font-medium">{fileNameOf(rejection.path)}</span>
                  {/* The server's reason, word for word. */}
                  <span className="block text-muted-foreground">{rejection.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onSeeQueue} disabled={outcome.queued.length === 0}>
          Show conversions
        </Button>
      </DialogFooter>
    </>
  );
}

function DialogBody({
  paths,
  onClose,
  onSeeQueue,
}: {
  paths: string[];
  onClose(): void;
  onSeeQueue(): void;
}) {
  const presets = useTranscodePresets();
  const listing = useTranscodes();
  const start = useStartTranscode();
  const [presetId, setPresetId] = useState<string | null>(null);
  const [replaceOriginal, setReplaceOriginal] = useState(false);

  const list = presets.data?.presets ?? [];
  const concurrency = presets.data?.concurrency ?? 1;
  const chosen = list.find((preset) => preset.id === presetId) ?? null;
  const waiting = (listing.data?.jobs ?? []).filter((job) => job.status === "queued" || job.status === "running").length;

  if (start.data) return <Outcome outcome={start.data} onClose={onClose} onSeeQueue={onSeeQueue} />;

  return (
    <>
      <div className="scrollbar-thin -mx-1 max-h-[60vh] space-y-4 overflow-y-auto px-1">
        {/* 1. It re-encodes, and that is not what playback does. */}
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">This makes a new file, frame by frame.</p>
            <p>
              Playing something in CasaTube only repacks it — the video is copied and costs almost nothing. Converting
              decodes and encodes every frame on the machine that also runs everything else in the house, for as long as
              it takes.
            </p>
          </div>
        </div>

        {/* 2. One at a time, and how many are already waiting. */}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {concurrency === 1 ? "One conversion runs at a time." : `Up to ${concurrency} run at a time.`}{" "}
            {waiting === 0
              ? "Nothing else is converting, so this starts straight away."
              : `${waiting} ${waiting === 1 ? "conversion is" : "conversions are"} already queued, so this one starts when they finish.`}
          </span>
        </p>

        {/* 3. The original is not touched. */}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          <span>
            The copy is written <strong>beside</strong> the original, under a new name. Nothing in the library is
            overwritten — if a file of that name already exists, the conversion is refused rather than replacing it.
          </span>
        </p>

        {paths.length > 1 ? (
          <div className="rounded-lg border p-3">
            <p className="text-xs font-medium">
              {paths.length} files, converted one after another
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
              {paths.slice(0, NAMES_SHOWN).map((path) => (
                <li key={path} className="truncate">
                  {fileNameOf(path)}
                </li>
              ))}
              {paths.length > NAMES_SHOWN ? <li>and {paths.length - NAMES_SHOWN} more</li> : null}
            </ul>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs font-medium">What should come out?</p>
          {presets.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : presets.isError ? (
            <ErrorState error={presets.error} what="The conversion presets" retry={() => void presets.refetch()} />
          ) : (
            <div role="radiogroup" aria-label="Conversion preset" className="space-y-2">
              {list.map((preset) => (
                <PresetOption
                  key={preset.id}
                  preset={preset}
                  selected={preset.id === presetId}
                  onSelect={() => setPresetId(preset.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/*
         * 🔴 Off by default, and worded as exactly what the server does. The
         * original is **moved to `.trash/`** and only after the new file has
         * been verified on disk — not deleted, and never before. If the copy
         * fails, or ffmpeg writes nothing, the original is still there.
         */}
        <label
          htmlFor="transcode-replace-original"
          className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3"
        >
          <Checkbox
            id="transcode-replace-original"
            className="mt-0.5"
            checked={replaceOriginal}
            onCheckedChange={(next) => setReplaceOriginal(next === true)}
          />
          <span className="text-xs">
            <span className="block font-medium">Move the original to the trash afterwards</span>
            <span className="mt-0.5 block text-muted-foreground">
              Only after the new file exists on disk and is not empty. The original is <em>moved</em> to{" "}
              <code>.trash/</code> inside the library, never deleted — restore it from the Trash tab if the copy is
              wrong. If the conversion fails or is cancelled, the original is left exactly where it is.
            </span>
          </span>
        </label>

        {replaceOriginal && chosen?.reencodesVideo === true ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              A re-encode throws picture away — the copy cannot be turned back into the original. Keep the original
              until you have watched the result.
            </span>
          </p>
        ) : null}

        {start.isError ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
            {start.error.message}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={start.isPending}>
          Cancel
        </Button>
        <Button
          disabled={chosen === null || start.isPending}
          onClick={() => {
            if (chosen === null) return;
            start.mutate({ paths, preset: chosen.id, replaceOriginal });
          }}
        >
          {start.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {paths.length === 1 ? "Queue the conversion" : `Queue ${paths.length} conversions`}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The shell.
 *
 * ⚠️ The body is **keyed on the files**, so opening the dialog on a different
 * selection starts with a clean form rather than the previous receipt. The key
 * deliberately does not change on success — that is the mistake the plugin
 * editor made, where saving remounted the panel that reported the save.
 */
export function TranscodeDialog({
  paths,
  open,
  onOpenChange,
  onSeeQueue,
}: {
  paths: string[];
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Take the user to the list of conversions — the tab this queue lives on. */
  onSeeQueue(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `sm:max-w-xl`, prefixed: an unprefixed `max-w-*` loses to
          `DialogContent`'s own `sm:max-w-lg` above the `sm` breakpoint — the
          trap in DISCOVERIES.md. */}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{paths.length === 1 ? "Convert this file" : `Convert ${paths.length} files`}</DialogTitle>
          <DialogDescription>
            {paths.length === 1 ? fileNameOf(paths[0] ?? "") : "A new file is written beside each original."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody key={paths.join("|")} paths={paths} onClose={() => onOpenChange(false)} onSeeQueue={onSeeQueue} />
      </DialogContent>
    </Dialog>
  );
}
