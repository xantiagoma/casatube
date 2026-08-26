/**
 * Quick Download: paste, look, then queue.
 *
 * 🔴 The order matters and it is the point of the screen. PLAN §15 wants the
 * title and the size seen **before** 800 MB, not after — so `Analyze` is a
 * separate, explicit step, and it spends the source's patience once per URL
 * rather than once per keystroke (PLAN §4.3).
 *
 * 🔴 R3: nothing here downloads. `Add to queue` is one POST; the response is a
 * row that already survives this tab closing, and every visible change after
 * that comes back from the server through the stream.
 *
 * ⚠️ Both outcomes of the POST are successes. `duplicate` means the server
 * already has this URL at this exact configuration and declined to fetch it
 * again — the form says so instead of pretending something was queued, and
 * offers the re-download that is the usual reason for asking twice.
 */
import { useState } from "react";
import { CircleCheck, Info, Loader2, Search, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { DEFAULT_PREFERENCES, type Preferences, type Priority } from "../../../core/types";
import { formatBytes, formatDuration, hostOf } from "../../data/format";
import { useLocalPref } from "../../data/prefs";
import { useEnqueue, useJobDefaults, useProbe } from "../../data/queries";
import { MediaPreview } from "../media/MediaPreview";
import { DestinationPicker } from "./DestinationPicker";
import { FormatPicker, type Choices } from "./FormatPicker";

function choicesFrom(preferences: Preferences): Choices {
  return {
    maxResolution: preferences.maxResolution,
    originalOnly: preferences.originalOnly,
    audioTags: preferences.audioLanguages,
    subtitleTags: preferences.subtitleLanguages,
  };
}

function preferencesFrom(base: Preferences, choices: Choices): Preferences {
  return {
    ...base,
    maxResolution: choices.maxResolution,
    originalOnly: choices.originalOnly,
    audioLanguages: choices.audioTags,
    subtitleLanguages: choices.subtitleTags,
  };
}

/**
 * What is about to be queued, before it is.
 *
 * PLAN §15: the title and the size are checked *before* 800 MB, not after. The
 * size shown follows the chosen resolution, because the number that matters is
 * the one for the option currently selected — not the biggest the video has.
 */
function PreviewCard({
  analyzed,
  url,
  height,
}: {
  analyzed: NonNullable<ReturnType<typeof useProbe>["data"]>;
  url: string;
  height: number;
}) {
  const chosen = analyzed.options.resolutions.find((option) => option.height === height);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Preview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <MediaPreview
          poster={analyzed.info.thumbnail}
          title={analyzed.info.title}
          duration={analyzed.info.duration}
          kind={analyzed.options.resolutions.length === 0 ? "audio" : "video"}
          unplayableHint="Preview only — the source hands out no playable URL."
        />
        <div>
          <p className="text-sm font-semibold">{analyzed.info.title}</p>
          <p className="text-xs text-muted-foreground">
            {[analyzed.info.uploader, analyzed.info.source, hostOf(url)].filter(Boolean).join(" · ")}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Provider</dt>
          <dd className="text-right font-medium">{analyzed.provider}</dd>
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="text-right font-medium tabular-nums">{formatDuration(analyzed.info.duration)}</dd>
          <dt className="text-muted-foreground">Formats</dt>
          <dd className="text-right font-medium tabular-nums">{analyzed.info.videoFormats.length}</dd>
          <dt className="text-muted-foreground">Size (est.)</dt>
          <dd className="text-right font-medium tabular-nums">
            {chosen?.approxBytes ? `${chosen.bytesEstimated ? "≈ " : ""}${formatBytes(chosen.approxBytes)}` : "—"}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Where it lands, how urgently, and the three switches the plan exposes. */
function OptionsCard(props: {
  destination: string;
  onDestination(next: string): void;
  priority: Priority;
  onPriority(next: Priority): void;
  originalOnly: boolean;
  onOriginalOnly(next: boolean): void;
  embedSubtitles: boolean;
  onEmbedSubtitles(next: boolean): void;
  sponsorblock: boolean;
  onSponsorblock(next: boolean): void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Download options</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <DestinationPicker value={props.destination} onChange={props.onDestination} />
          <div className="space-y-1.5">
            <Label htmlFor="priority">Priority</Label>
            <Select value={props.priority} onValueChange={(next) => props.onPriority(next as Priority)}>
              <SelectTrigger id="priority" className="w-full">
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

        <div className="space-y-3">
          <label className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium">Original audio only</span>
              <span className="block text-xs text-muted-foreground">
                Exactly one track: the one the source marks as original.
              </span>
            </span>
            <Switch checked={props.originalOnly} onCheckedChange={props.onOriginalOnly} />
          </label>

          <label className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium">Embed subtitles</span>
              <span className="block text-xs text-muted-foreground">
                Off writes sidecar files, which every media server reads and you can replace later.
              </span>
            </span>
            <Switch checked={props.embedSubtitles} onCheckedChange={props.onEmbedSubtitles} />
          </label>

          <label className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium">SponsorBlock</span>
              <span className="block text-xs text-muted-foreground">Skip sponsored segments where known.</span>
            </span>
            <Switch checked={props.sponsorblock} onCheckedChange={props.onSponsorblock} />
          </label>
        </div>
      </CardContent>
    </Card>
  );
}

export function DownloadForm({ className }: { className?: string }) {
  const defaults = useJobDefaults();
  const [destination, setDestination] = useLocalPref("destination", "");
  const [priority, setPriority] = useState<Priority>("normal");
  const [url, setUrl] = useState("");

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
  const [toggles, setToggles] = useState<{ sponsorblock?: boolean; embedSubtitles?: boolean }>({});

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
        originalOnly: analyzed.suggested.originalOnly,
        audioTags: analyzed.suggested.audioLanguages,
        subtitleTags: analyzed.suggested.subtitleLanguages,
      }
    : choicesFrom(base);

  const choices: Choices = { ...suggested, ...edits };
  const sponsorblock = toggles.sponsorblock ?? base.sponsorblock;
  const embedSubtitles = toggles.embedSubtitles ?? base.embedSubtitles;

  const preferences: Preferences = {
    ...preferencesFrom(base, choices),
    sponsorblock,
    embedSubtitles,
  };

  const setChoices = (next: Partial<Choices>) => setEdits((current) => ({ ...current, ...next }));
  const outcome = enqueue.data;

  function submit(force = false) {
    const info = analyzed?.info;
    enqueue.mutate({
      url,
      destination,
      preferences,
      priority,
      force,
      ...(info?.title ? { title: info.title } : {}),
      ...(info?.thumbnail ? { thumbnail: info.thumbnail } : {}),
      ...(info?.duration ? { duration: info.duration } : {}),
      ...(info?.source ? { source: info.source } : {}),
    });
  }

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
              if (url.trim() !== "") void probe.refetch();
            }}
          >
            <Input
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                // A new URL means a new suggestion; anything chosen for the old
                // one is not an opinion about this one.
                setEdits({});
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
        </CardContent>
      </Card>

      {analyzed ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <PreviewCard analyzed={analyzed} url={url} height={choices.maxResolution} />
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Format &amp; Quality</CardTitle>
            </CardHeader>
            <CardContent>
              <FormatPicker options={analyzed.options} choices={choices} onChange={setChoices} />
            </CardContent>
          </Card>
        </div>
      ) : null}

      <OptionsCard
        destination={destination}
        onDestination={setDestination}
        priority={priority}
        onPriority={setPriority}
        originalOnly={choices.originalOnly}
        onOriginalOnly={(next) => setChoices({ originalOnly: next })}
        embedSubtitles={embedSubtitles}
        onEmbedSubtitles={(next) => setToggles((current) => ({ ...current, embedSubtitles: next }))}
        sponsorblock={sponsorblock}
        onSponsorblock={(next) => setToggles((current) => ({ ...current, sponsorblock: next }))}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          disabled={url.trim() === "" || enqueue.isPending}
          onClick={() => submit(false)}
          className="min-w-40"
        >
          {enqueue.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Add to queue
        </Button>
        {!analyzed && url.trim() !== "" ? (
          <p className="text-xs text-muted-foreground">
            Queueing without analyzing is fine — the worker analyzes it anyway.
          </p>
        ) : null}
      </div>

      {enqueue.isError ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {enqueue.error.message}
        </p>
      ) : null}

      {outcome ? (
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
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Nothing was fetched again. {outcome.job.outputFile ?? outcome.job.url}
                </p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => submit(true)}>
                  Download it again anyway
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
