/**
 * Quick Download: paste, look, then queue.
 *
 * 🔴 The order matters and it is the point of the screen. PLAN §15 wants the
 * title and the size seen **before** 800 MB, not after — so `Analyze` is a
 * separate, explicit step, and it spends the source's patience once per URL
 * rather than once per keystroke (PLAN §4.3).
 *
 * 🔴 **Analyzing opens a panel; it does not grow the card.** What comes back
 * from a real YouTube video is six codecs, a resolution list, dozens of audio
 * dubs and over a hundred and fifty subtitle languages. Rendered inline that
 * pushed the queue, the storage bar and the analytics off the screen, so the
 * dashboard stopped being a dashboard the moment anyone used it. The panel is
 * `AnalysisDrawer` — a sheet on a phone, a side dialog on a desktop.
 *
 * 🔴 **The steps in the panel are in the order the decision is actually made**,
 * and each step's *policy* comes before the list that policy governs:
 *
 * | # | Step        | Policy first…                | …then the list          |
 * |---|-------------|------------------------------|-------------------------|
 * | 1 | Video       | codec preference             | resolution ceiling      |
 * | 2 | Audio       | original only / choose       | audio languages         |
 * | 3 | Subtitles   | which languages              | embed or sidecar        |
 * | 4 | Extras      | SponsorBlock                 | —                       |
 * | 5 | Destination | folder                       | priority                |
 *
 * The old form had "Original audio only" *below* the audio list it disabled,
 * and "Embed subtitles" two cards away from the subtitles — which is how a form
 * ends up reading like a list of fields instead of a decision.
 *
 * 🔴 **Plugins are shown after the five steps and are not numbered**, because
 * nothing there is a decision *yet*: `POST /api/jobs` takes no plugin field, so
 * the per-download override PLAN §5 asks for has nothing behind it and a switch
 * would move without changing anything. What the panel can honestly do — say
 * which plugins claim this URL, what each would do to it, and which are
 * actually on — it does. `PluginNotice.tsx` carries the full note.
 *
 * 🔴 R3: nothing here downloads. `Add to queue` is one POST; the response is a
 * row that already survives this tab closing, and every visible change after
 * that comes back from the server through the stream.
 *
 * ⚠️ Both outcomes of the POST are successes. `duplicate` means the server
 * already has this URL at this exact configuration and declined to fetch it
 * again — the form says so instead of pretending something was queued, and
 * offers the re-download that is the usual reason for asking twice.
 *
 * ⚠️ **One probe per URL, still.** Nothing in this file re-probes: every
 * per-codec answer already arrived with the first one (`byCodec`), so moving a
 * radio is a lookup. See `docs/DISCOVERIES.md`.
 */
import { useState, type ReactNode } from "react";
import { CircleCheck, Info, Loader2, Search, Settings2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { CodecOutcome } from "../../../api/options";
import { DEFAULT_PREFERENCES, type ConflictPolicy, type Preferences, type Priority } from "../../../core/types";
import { formatBytes, formatDuration, hostOf } from "../../data/format";
import { useLocalPref } from "../../data/prefs";
import {
  useEnqueue,
  useJobDefaults,
  useNameCheck,
  useProbe,
  type EnqueueOutcome,
  type ProbeResult,
} from "../../data/queries";
import { MediaPreview } from "../media/MediaPreview";
import { AnalysisDrawer } from "./AnalysisDrawer";
import type { Choices } from "./choices";
import { DestinationPicker } from "./DestinationPicker";
import { VideoPicker } from "./FormatPicker";
import { Step, SwitchRow } from "./OptionBits";
import { ApplicablePlugins, ApplicablePluginsBadge } from "./PluginNotice";
import { AudioPicker, SubtitlePicker } from "./TrackPickers";

function choicesFrom(preferences: Preferences): Choices {
  return {
    maxResolution: preferences.maxResolution,
    videoCodec: preferences.videoCodec,
    originalOnly: preferences.originalOnly,
    audioTags: preferences.audioLanguages,
    subtitleTags: preferences.subtitleLanguages,
  };
}

function preferencesFrom(base: Preferences, choices: Choices): Preferences {
  return {
    ...base,
    maxResolution: choices.maxResolution,
    videoCodec: choices.videoCodec,
    originalOnly: choices.originalOnly,
    audioLanguages: choices.audioTags,
    subtitleLanguages: choices.subtitleTags,
  };
}

/**
 * 🔴 The row that was clicked is not always the file that arrives: a named
 * codec that cannot reach this height caps it lower. `byCodec` is the server's
 * answer for every choice, so this is a lookup, not the selection rule copied
 * into the browser.
 */
function outcomeFor(analyzed: ProbeResult, choices: Choices): CodecOutcome | undefined {
  return analyzed.options.resolutions.find((option) => option.resolution === choices.maxResolution)
    ?.byCodec[choices.videoCodec];
}

/** What is about to be queued, in one line — the same facts on the card and in the panel. */
function summaryOf(analyzed: ProbeResult, choices: Choices): string {
  const chosen = outcomeFor(analyzed, choices);
  const parts: string[] = [];

  if (analyzed.options.resolutions.length === 0) parts.push("Audio only");
  else if (chosen) {
    parts.push(`${chosen.resolution ?? "?"}p`);
    if (chosen.codecFamily !== "unknown") parts.push(chosen.codecFamily.toUpperCase());
    if (chosen.approxBytes) parts.push(`${chosen.bytesEstimated ? "≈ " : ""}${formatBytes(chosen.approxBytes)}`);
  }

  if (choices.originalOnly) parts.push("original audio");
  else parts.push(`${choices.audioTags.length} audio`);

  parts.push(choices.subtitleTags.length === 1 ? "1 subtitle" : `${choices.subtitleTags.length} subtitles`);
  return parts.join(" · ");
}

/**
 * Where it lands and how soon — the last decision, and the only one that is not
 * about the media.
 *
 * ⚠️ It appears in two places and never both at once: inside the panel when
 * there is an analysis to attach it to, and on the card when there is not —
 * because "queue this URL without looking" is a supported route and it would be
 * absurd for it to be the route with no way to choose a folder. Distinct `id`s
 * so the two `<label for>` pairs cannot cross.
 */
function DestinationAndPriority({
  idPrefix,
  destination,
  onDestination,
  priority,
  onPriority,
}: {
  idPrefix: string;
  destination: string;
  onDestination(next: string): void;
  priority: Priority;
  onPriority(next: Priority): void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <DestinationPicker id={`${idPrefix}-destination`} value={destination} onChange={onDestination} />
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-priority`}>Priority</Label>
        <Select value={priority} onValueChange={(value) => onPriority(value as Priority)}>
          <SelectTrigger id={`${idPrefix}-priority`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * The filename, editable, with the folder checked while you type.
 *
 * 🔴 PLAN §15 asked for the name to be shown *before* 800 MB rather than after,
 * and this is the half that was missing: the name is **editable**, because
 * being told the name is wrong and being unable to change it is half a feature.
 *
 * 🔴 And the collision. The move stage can no longer overwrite anything — a
 * taken name lands `Name (2)` and says so — but "I meant to replace that" and
 * "these are two different videos" are decisions only the person queueing can
 * make. So the answer names the files that are in the way and offers both
 * readings, rather than picking one quietly.
 *
 * ⚠️ The check is **advisory** and the panel never blocks the button. The
 * folder is shared with everything else on the machine and can change between
 * this answer and the move; the move stage checks again, and that check is the
 * one that decides. A form that refused to queue on a stale answer would be
 * wrong more often than the collision it was guarding against.
 */
function OutputName({
  idPrefix,
  destination,
  name,
  suggestion,
  onName,
  conflict,
  onConflict,
}: {
  idPrefix: string;
  destination: string;
  /** What the box holds — already defaulted to the analyzed name by the caller. */
  name: string;
  /** What the server said the title cleans down to, for the "reset" affordance. */
  suggestion: string;
  onName(next: string): void;
  conflict: ConflictPolicy;
  onConflict(next: ConflictPolicy): void;
}) {
  const check = useNameCheck(destination, name, true);
  const answer = check.data;
  const taken = answer?.taken === true;

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-name`}>Save as</Label>
        <div className="flex items-center gap-2">
          <Input
            id={`${idPrefix}-name`}
            value={name}
            onChange={(event) => onName(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="flex-1"
          />
          <span className="shrink-0 text-xs text-muted-foreground">.mkv</span>
        </div>
        {/* ⚠️ The *cleaned* name, when it differs. A slash typed here does not
            become a folder and an emoji does not survive, and finding that out
            from the file on disk afterwards is exactly the surprise this box
            exists to remove. */}
        {answer && answer.name !== name.trim() ? (
          <p className="text-xs text-muted-foreground">
            Saved as <span className="font-mono">{answer.name}</span> — the rest is not usable in a filename.
          </p>
        ) : null}
        {name.trim() !== suggestion ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => onName(suggestion)}
          >
            Use the title: {suggestion}
          </button>
        ) : null}
      </div>

      {check.isError ? (
        <p className="text-xs text-muted-foreground">
          Could not check the folder ({check.error.message}). The download still queues — nothing is ever
          overwritten, so a name already in use becomes “{name} (2)”.
        </p>
      ) : null}

      {taken && answer ? (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <p className="flex items-start gap-1.5 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span>
              <span className="font-medium">That name is already in use</span> in{" "}
              {answer.destination === "" ? "the library root" : answer.destination} —{" "}
              <span className="font-mono">{answer.using.join(", ")}</span>.
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={conflict === "suffix" ? "default" : "outline"}
              onClick={() => onConflict("suffix")}
            >
              Keep both — save as “{answer.suggestion}”
            </Button>
            <Button
              type="button"
              size="sm"
              variant={conflict === "replace" ? "default" : "outline"}
              onClick={() => onConflict("replace")}
            >
              Replace it
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {conflict === "replace"
              ? "The existing file and its subtitles go to .trash, where they stay restorable — nothing is deleted."
              : "Two different videos can clean down to one title, so this is the default. Nothing is ever overwritten."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Queued, or already here. Both are successes and both have to be said. */
function Outcome({ outcome, onForce }: { outcome: EnqueueOutcome; onForce(): void }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm",
        outcome.outcome === "queued"
          ? "border-success/30 bg-success/5 text-success"
          : "border-primary/30 bg-primary/5 text-primary",
      )}
    >
      {outcome.outcome === "queued" ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {outcome.outcome === "queued"
            ? `Queued: ${outcome.job.title ?? outcome.job.url}`
            : "Already downloaded at these exact settings."}
        </p>
        {outcome.outcome === "duplicate" ? (
          <>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              Nothing was fetched again. {outcome.job.outputFile ?? outcome.job.url}
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={onForce}>
              Download it again anyway
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The result of the analysis, small enough to leave the dashboard a dashboard. */
function AnalyzedRow({
  analyzed,
  url,
  summary,
  onOpen,
}: {
  analyzed: ProbeResult;
  url: string;
  summary: string;
  onOpen(): void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
      <div className="w-full shrink-0 sm:w-40">
        <MediaPreview
          poster={analyzed.info.thumbnail}
          title={analyzed.info.title}
          duration={analyzed.info.duration}
          kind={analyzed.options.resolutions.length === 0 ? "audio" : "video"}
          unplayableHint="Preview only — the source hands out no playable URL."
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{analyzed.info.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[analyzed.info.uploader, analyzed.info.source, hostOf(url)].filter(Boolean).join(" · ")}
          {analyzed.info.duration ? ` · ${formatDuration(analyzed.info.duration)}` : ""}
        </p>
        <p className="mt-1.5 truncate text-xs font-medium tabular-nums">{summary}</p>
        {/* Discoverability: the panel is where the detail is, and this is what
            tells someone the panel has something to say about it. */}
        <ApplicablePluginsBadge url={url} />
      </div>
      <Button type="button" variant="outline" onClick={onOpen} className="shrink-0 gap-1.5">
        <Settings2 className="size-4" aria-hidden />
        Options
      </Button>
    </div>
  );
}

export function DownloadForm({ className }: { className?: string }) {
  const defaults = useJobDefaults();
  const [destination, setDestination] = useLocalPref("destination", "");
  const [priority, setPriority] = useState<Priority>("normal");
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);

  /**
   * 🔴 **What the user changed, not what the form shows.**
   *
   * The displayed selection is derived below: the probe's suggestion when there
   * is one, the server's defaults otherwise, with these edits layered on top.
   * Storing the *result* instead would mean copying a server value into state
   * and then keeping the copy in step with an effect — two sources of truth and
   * a race between them, which is exactly what "the browser only observes"
   * rules out.
   *
   * Clearing this on a new URL is therefore the whole of "start from the new
   * suggestion", and it happens in the input's own handler.
   */
  const [edits, setEdits] = useState<Partial<Choices>>({});
  const [toggles, setToggles] = useState<{
    sponsorblock?: boolean;
    embedSubtitles?: boolean;
    automaticSubtitles?: boolean;
  }>({});

  /**
   * Plugins this download opts out of.
   *
   * ⚠️ Local to the form and **not** persisted anywhere: it is a departure from
   * the server-wide default for one download, so remembering it would quietly
   * turn a one-off into a setting. `submit` sends it, `enqueue` stores it on
   * the job, and the job carries it through every retry.
   */
  const [pluginsOff, setPluginsOff] = useState<string[]>([]);

  /**
   * The filename, and what to do if it is taken.
   *
   * `null` means "whatever the analysis suggested" rather than an empty box:
   * the suggestion arrives with the probe, after this state exists, and storing
   * a copy of it would leave the field stale when the URL changes.
   */
  const [outputName, setOutputName] = useState<string | null>(null);
  const [onConflict, setOnConflict] = useState<ConflictPolicy>("suffix");

  const base: Preferences = defaults.data?.resolved ?? DEFAULT_PREFERENCES;

  // Read before `probe` is declared: the query is keyed by the URL alone, so
  // the preferences it sends only shape the suggestion and can be derived from
  // the same values the form is about to render.
  const probe = useProbe(url, base);
  const enqueue = useEnqueue();
  const analyzed = probe.data;

  const suggested: Choices = analyzed
    ? {
        maxResolution: analyzed.suggested.maxResolution,
        videoCodec: analyzed.suggested.videoCodec,
        originalOnly: analyzed.suggested.originalOnly,
        audioTags: analyzed.suggested.audioLanguages,
        subtitleTags: analyzed.suggested.subtitleLanguages,
      }
    : choicesFrom(base);

  const choices: Choices = { ...suggested, ...edits };
  const sponsorblock = toggles.sponsorblock ?? base.sponsorblock;
  const embedSubtitles = toggles.embedSubtitles ?? base.embedSubtitles;
  // ⚠️ `??` against the stored default, never `?? true`: the form must start
  // from what Settings says, not from the code's opinion of it.
  const automaticSubtitles = toggles.automaticSubtitles ?? base.automaticSubtitles;

  const preferences: Preferences = {
    ...preferencesFrom(base, choices),
    sponsorblock,
    embedSubtitles,
    automaticSubtitles,
  };

  const setChoices = (next: Partial<Choices>) => setEdits((current) => ({ ...current, ...next }));

  const suggestedName = analyzed?.outputName ?? "";
  const name = outputName ?? suggestedName;

  function submit(force = false) {
    const info = analyzed?.info;
    enqueue.mutate(
      {
        url,
        destination,
        preferences,
        priority,
        force,
        ...(info?.title ? { title: info.title } : {}),
        ...(info?.thumbnail ? { thumbnail: info.thumbnail } : {}),
        ...(info?.duration ? { duration: info.duration } : {}),
        ...(info?.source ? { source: info.source } : {}),
        ...(pluginsOff.length > 0 ? { pluginsOff } : {}),
        // Only when it is a departure. Sending the suggestion back would pin a
        // name the server derived, so a later fix to the cleaning rules would
        // not reach jobs queued today.
        ...(name !== "" && name !== suggestedName ? { outputName: name } : {}),
        ...(onConflict !== "suffix" ? { onConflict } : {}),
      },
      {
        // 🔴 A queued job is the end of this panel's job: the row is already in
        // the queue behind it, and the confirmation belongs where the queue is.
        // A *duplicate* is not — it has a question attached ("again anyway?"),
        // so the panel stays open to ask it.
        onSuccess: (result) => {
          if (result.outcome === "queued") setOpen(false);
        },
      },
    );
  }

  /**
   * ⚠️ Opening the panel is done here, from the result of the refetch the user
   * asked for — not from an effect watching `probe.data`. An effect would also
   * fire on a cached answer, so re-typing a URL analyzed ten minutes ago would
   * throw a panel at someone who only touched the text field.
   */
  function analyze() {
    if (url.trim() === "") return;
    void probe.refetch().then((result) => {
      if (result.data) setOpen(true);
    });
  }

  /**
   * Whatever the POST had to say — an error or one of its two successes.
   *
   * It is built once and rendered in exactly one of the two places, because the
   * answer belongs next to the button that was pressed and a queue confirmation
   * printed twice is a second thing to understand.
   */
  const feedback = (
    <>
      {enqueue.isError ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {enqueue.error.message}
        </p>
      ) : null}
      {enqueue.data ? <Outcome outcome={enqueue.data} onForce={() => submit(true)} /> : null}
    </>
  );

  const queueButton = (
    <Button
      size="lg"
      disabled={url.trim() === "" || enqueue.isPending}
      onClick={() => submit(false)}
      className="w-full gap-2 sm:w-auto sm:min-w-40"
    >
      {enqueue.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      Add to queue
    </Button>
  );

  return (
    <div className={cn("space-y-4", className)}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quick Download</CardTitle>
          <p className="text-sm text-muted-foreground">Paste a URL to analyze it before anything is queued.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              analyze();
            }}
          >
            <Input
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                // A new URL means a new suggestion; anything chosen for the old
                // one is not an opinion about this one. The plugin exclusions
                // go with it: a different URL may not even be claimed by the
                // plugin that was switched off, and carrying the choice over
                // would silently apply it to a download nobody chose it for.
                setEdits({});
                setPluginsOff([]);
                setOutputName(null);
                setOnConflict("suffix");
                enqueue.reset();
              }}
              placeholder="https://…"
              inputMode="url"
              autoComplete="off"
              aria-label="Media URL"
              className="flex-1"
            />
            <Button type="submit" disabled={url.trim() === "" || probe.isFetching} className="sm:w-32">
              {probe.isFetching ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Analyzing
                </>
              ) : (
                <>
                  <Search className="size-4" aria-hidden />
                  Analyze
                </>
              )}
            </Button>
          </form>

          {probe.isError ? (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {probe.error.message}
                <span className="mt-1 block text-xs text-muted-foreground">
                  Looking is optional. You can still queue this URL — the worker analyzes it again anyway.
                </span>
              </span>
            </p>
          ) : null}

          {analyzed ? (
            <AnalyzedRow
              analyzed={analyzed}
              url={url}
              summary={summaryOf(analyzed, choices)}
              onOpen={() => setOpen(true)}
            />
          ) : null}

          {!analyzed ? (
            <DestinationAndPriority
              idPrefix="card"
              destination={destination}
              onDestination={setDestination}
              priority={priority}
              onPriority={setPriority}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            {queueButton}
            {!analyzed && url.trim() !== "" ? (
              <p className="text-xs text-muted-foreground">
                Queueing without analyzing is fine — the worker analyzes it anyway.
              </p>
            ) : null}
          </div>

          {/* ⚠️ Shown here only while the panel is shut. Whichever surface the
              button was pressed on is the surface the answer has to appear on —
              and two copies of one message reads as two problems. */}
          {!open ? feedback : null}
        </CardContent>
      </Card>

      {analyzed ? (
        <OptionsPanel
          open={open}
          onOpenChange={setOpen}
          analyzed={analyzed}
          url={url}
          choices={choices}
          onChoices={setChoices}
          destination={destination}
          onDestination={setDestination}
          priority={priority}
          onPriority={setPriority}
          pluginsOff={pluginsOff}
          onPluginsOff={setPluginsOff}
          outputName={name}
          suggestedName={suggestedName}
          onOutputName={setOutputName}
          onConflict={onConflict}
          onOnConflict={setOnConflict}
          sponsorblock={sponsorblock}
          onSponsorblock={(next) => setToggles((current) => ({ ...current, sponsorblock: next }))}
          embedSubtitles={embedSubtitles}
          onEmbedSubtitles={(next) => setToggles((current) => ({ ...current, embedSubtitles: next }))}
          automaticSubtitles={automaticSubtitles}
          onAutomaticSubtitles={(next) => setToggles((current) => ({ ...current, automaticSubtitles: next }))}
          footer={
            <div className="space-y-3">
              {feedback}
              {/* ⚠️ Stacked on a phone. Side by side, "≈ 862 MB" is exactly the
                  part of the sentence that gets truncated — the number the whole
                  screen exists to show before 800 MB is committed. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-muted-foreground uppercase">You will get</p>
                  <p className="text-sm font-medium tabular-nums">{summaryOf(analyzed, choices)}</p>
                </div>
                {queueButton}
              </div>
            </div>
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The five steps, in order.
 *
 * Split out so the drawer's contents are one readable list of decisions rather
 * than three hundred lines inside the form's own state.
 */
function OptionsPanel(props: {
  open: boolean;
  onOpenChange(next: boolean): void;
  analyzed: ProbeResult;
  url: string;
  choices: Choices;
  onChoices(next: Partial<Choices>): void;
  destination: string;
  onDestination(next: string): void;
  priority: Priority;
  onPriority(next: Priority): void;
  sponsorblock: boolean;
  onSponsorblock(next: boolean): void;
  embedSubtitles: boolean;
  onEmbedSubtitles(next: boolean): void;
  automaticSubtitles: boolean;
  onAutomaticSubtitles(next: boolean): void;
  /** Plugins this download opts out of — see `PluginNotice`. */
  pluginsOff: readonly string[];
  onPluginsOff(next: string[]): void;
  /** The filename, and the name the analysis suggested for it. */
  outputName: string;
  suggestedName: string;
  onOutputName(next: string): void;
  onConflict: ConflictPolicy;
  onOnConflict(next: ConflictPolicy): void;
  footer: ReactNode;
}) {
  const { analyzed, choices } = props;
  const hasVideo = analyzed.options.resolutions.length > 0 || analyzed.options.codecs.length > 0;

  // The numbering is the reading order, so it has to close up when a source has
  // no video at all rather than starting at two.
  let step = 0;
  const next = () => (step += 1);

  return (
    <AnalysisDrawer
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={analyzed.info.title}
      description={[analyzed.info.uploader, analyzed.provider, hostOf(props.url)].filter(Boolean).join(" · ")}
      footer={props.footer}
    >
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <MediaPreview
            poster={analyzed.info.thumbnail}
            title={analyzed.info.title}
            duration={analyzed.info.duration}
            kind={hasVideo ? "video" : "audio"}
            unplayableHint="Preview only — the source hands out no playable URL."
          />
          <dl className="grid grid-cols-2 content-start gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="text-right font-medium">{analyzed.provider}</dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="text-right font-medium tabular-nums">{formatDuration(analyzed.info.duration)}</dd>
            <dt className="text-muted-foreground">Formats</dt>
            <dd className="text-right font-medium tabular-nums">{analyzed.info.videoFormats.length}</dd>
            <dt className="text-muted-foreground">Audio tracks</dt>
            <dd className="text-right font-medium tabular-nums">{analyzed.options.audio.length}</dd>
            <dt className="text-muted-foreground">Subtitles</dt>
            <dd className="text-right font-medium tabular-nums">{analyzed.options.subtitles.length}</dd>
          </dl>
        </div>

        {hasVideo && (
          <Step index={next()} title="Video" hint="How it should look, and how big that makes it.">
            <VideoPicker options={analyzed.options} choices={choices} onChange={props.onChoices} />
          </Step>
        )}

        <Step index={next()} title="Audio" hint="What you hear. Decided before the languages, because it decides whether there are any.">
          <AudioPicker
            options={analyzed.options.audio}
            originalOnly={choices.originalOnly}
            audioTags={choices.audioTags}
            onChange={props.onChoices}
          />
        </Step>

        <Step index={next()} title="Subtitles" hint="Independent of the audio (R7). Authored subtitles win when a language has both.">
          <SubtitlePicker
            options={analyzed.options.subtitles}
            subtitleTags={choices.subtitleTags}
            embedSubtitles={props.embedSubtitles}
            automaticSubtitles={props.automaticSubtitles}
            onChange={props.onChoices}
            onEmbedSubtitles={props.onEmbedSubtitles}
            onAutomaticSubtitles={props.onAutomaticSubtitles}
          />
        </Step>

        <Step index={next()} title="Extras" hint="What gets cut out on the way in.">
          <SwitchRow
            title="SponsorBlock"
            hint="Skip sponsored segments where the community has marked them."
            checked={props.sponsorblock}
            onChange={props.onSponsorblock}
          />
        </Step>

        <Step index={next()} title="Destination" hint="Where it lands, what it is called, and how soon.">
          <div className="space-y-3">
            <DestinationAndPriority
              idPrefix="panel"
              destination={props.destination}
              onDestination={props.onDestination}
              priority={props.priority}
              onPriority={props.onPriority}
            />
            <OutputName
              idPrefix="panel"
              destination={props.destination}
              name={props.outputName}
              suggestion={props.suggestedName}
              onName={props.onOutputName}
              conflict={props.onConflict}
              onConflict={props.onOnConflict}
            />
          </div>
        </Step>

        {/* Outside the numbered steps, and still deliberately so: the numbers
            are the decisions a download *needs*, and every plugin here has a
            working default. The switch is a departure from it, not a step. */}
        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-semibold">Plugins</h3>
            <p className="text-xs text-muted-foreground">
              What else will touch this download. Read from what each plugin declares — none of them runs to answer
              this.
            </p>
          </div>
          <ApplicablePlugins url={props.url} off={props.pluginsOff} onOff={props.onPluginsOff} />
        </section>
      </div>
    </AnalysisDrawer>
  );
}
