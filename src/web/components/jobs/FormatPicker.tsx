/**
 * The choices this particular video offers — drawn from the probe, never from a
 * hard-coded list.
 *
 * 🔴 The fault it exists to fix: the form used to ask for a resolution, an
 * audio language and a subtitle language *before knowing what the video had*.
 * It offered 4K for a 720p video, gave no way to see which audio track is the
 * original — the thing "original only" actually means — and treated authored
 * subtitles and machine-generated captions as the same offer.
 *
 * ⚠️ **Audio and subtitles are two lists and stay two lists (R7).** Neither
 * reads the other's state. That is the requirement HomeTube breaks, and the
 * reason "English audio, Spanish subtitles" is expressible here.
 *
 * Presentation only: it receives options and a selection and calls back. The
 * grouping, the ordering and the preselection are all decided on the server
 * (`api/options.ts`), which is what keeps them identical to what the worker
 * will do with the job.
 */
import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AudioOption, MediaOptions, ResolutionOption, SubtitleOption } from "../../../api/options";
import { formatBytes } from "../../data/format";

export interface Choices {
  maxResolution: number;
  originalOnly: boolean;
  /** ISO 639-2/B tags, as the options report them. */
  audioTags: string[];
  /** ⚠️ Never derived from `audioTags` — R7. */
  subtitleTags: string[];
}

interface Props {
  options: MediaOptions;
  choices: Choices;
  onChange(next: Partial<Choices>): void;
}

/** Add or remove one tag, without touching the other list. */
function toggle(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((value) => value !== tag) : [...tags, tag];
}

function resolutionDetail(option: ResolutionOption): string {
  const parts: string[] = [];
  if (option.fps && option.fps >= 50) parts.push(`${Math.round(option.fps)} fps`);
  if (option.codecFamily !== "unknown") parts.push(option.codecFamily.toUpperCase());
  return parts.join(" · ");
}

function audioDetail(option: AudioOption): string {
  const parts: string[] = [];
  if (option.variants.length > 1) parts.push(option.variants.join(", "));
  else if (option.variants[0] && option.variants[0] !== option.tag) parts.push(option.variants[0]);
  if (option.codec) parts.push(option.codec);
  if (option.bitrate) parts.push(`${Math.round(option.bitrate)} kbps`);
  if (option.trackCount > 1) parts.push(`${option.trackCount} streams`);
  return parts.join(" · ");
}

function ResolutionList({
  options,
  value,
  onChange,
}: {
  options: ResolutionOption[];
  value: number;
  onChange(height: number): void;
}) {
  if (options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This source has no video streams — it will be downloaded as audio.
      </p>
    );
  }

  const known = options.some((option) => option.height === value);

  return (
    <div role="radiogroup" aria-label="Maximum resolution" className="space-y-1">
      {!known && (
        <p className="pb-1 text-xs text-warning">
          The ceiling is {value}p and nothing here reaches it. The best available will be used.
        </p>
      )}
      {options.map((option) => {
        const selected = option.height === value;
        return (
          <button
            key={option.height}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.height)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
              selected ? "border-primary/50 bg-primary/5" : "hover:bg-accent/40",
            )}
          >
            <span
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full border",
                selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
              )}
            >
              {selected && <Check className="size-2.5" aria-hidden />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{option.height}p</span>
              {resolutionDetail(option) ? (
                <span className="block text-xs text-muted-foreground">{resolutionDetail(option)}</span>
              ) : null}
            </span>
            {/* ⚠️ Video only, and often an estimate from the bitrate: the
                finished file is a few percent larger once audio is muxed in.
                Hence the "≈", and hence saying which kind of number it is. */}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {option.approxBytes ? `${option.bytesEstimated ? "≈ " : ""}${formatBytes(option.approxBytes)}` : "—"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function TrackRow({
  id,
  label,
  detail,
  badges,
  checked,
  disabled,
  hint,
  onToggle,
}: {
  id: string;
  label: string;
  detail?: string;
  badges?: { text: string; tone?: "ok" | "warn" }[];
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onToggle(): void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors",
        disabled ? "opacity-60" : "cursor-pointer hover:bg-accent/40",
        checked && !disabled && "border-primary/50 bg-primary/5",
      )}
    >
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{label}</span>
          {badges?.map((badge) => (
            <Badge
              key={badge.text}
              variant="secondary"
              className={cn(
                "px-1.5 py-0 text-[10px] font-medium",
                badge.tone === "ok" && "bg-success/12 text-success",
                badge.tone === "warn" && "bg-warning/15 text-warning",
              )}
            >
              {badge.text}
            </Badge>
          ))}
        </span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

function subtitleBadges(option: SubtitleOption): { text: string; tone?: "ok" | "warn" }[] {
  return [
    option.hasManual ? { text: "manual", tone: "ok" as const } : { text: "auto-generated", tone: "warn" as const },
    ...(option.hasManual && option.hasAutomatic ? [{ text: "+ auto" }] : []),
    { text: option.tag },
  ];
}

export function FormatPicker({ options, choices, onChange }: Props) {
  // While "original only" is on, the audio list shows *what that means* rather
  // than going blank: the original row is ticked and the list is read-only.
  const audioSelected = new Set(
    choices.originalOnly
      ? options.audio.flatMap((option) => (option.isOriginal ? [option.tag] : []))
      : choices.audioTags,
  );
  const subtitleSelected = new Set(choices.subtitleTags);

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div>
          <Label>Resolution</Label>
          <p className="text-xs text-muted-foreground">
            The best format at or below this — only what this video actually has. Sizes count the video stream
            only.
          </p>
        </div>
        <ResolutionList
          options={options.resolutions}
          value={choices.maxResolution}
          onChange={(height) => onChange({ maxResolution: height })}
        />
        {options.formatsWithoutHeight > 0 && (
          <p className="text-xs text-muted-foreground">
            {options.formatsWithoutHeight} format(s) came without a resolution. They are only used if nothing else
            fits.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <div>
          <Label>Audio tracks</Label>
          <p className="text-xs text-muted-foreground">
            {choices.originalOnly
              ? "Showing what “original audio only” selects. Turn it off to choose."
              : "Pick one or more languages. Independent of subtitles (R7)."}
          </p>
        </div>
        {options.audio.length === 0 ? (
          <p className="text-sm text-muted-foreground">This source reports no separate audio tracks.</p>
        ) : (
          <div className="space-y-1">
            {options.audio.map((option) => (
              <TrackRow
                key={`${option.tag}-${option.language}`}
                id={`audio-${option.tag}-${option.language}`}
                label={option.language}
                detail={audioDetail(option)}
                badges={[
                  ...(option.isOriginal ? [{ text: "original", tone: "ok" as const }] : []),
                  { text: option.tag },
                ]}
                checked={audioSelected.has(option.tag)}
                disabled={choices.originalOnly || !option.selectable}
                hint={option.selectable ? undefined : "The source did not say what language this is."}
                onToggle={() => onChange({ audioTags: toggle(choices.audioTags, option.tag) })}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div>
          <Label>Subtitles</Label>
          <p className="text-xs text-muted-foreground">
            Independent of the audio (R7). Authored subtitles win when a language has both.
          </p>
        </div>
        {options.subtitles.length === 0 ? (
          <p className="text-sm text-muted-foreground">This source has no subtitles.</p>
        ) : (
          <div className="space-y-1">
            {options.subtitles.map((option) => (
              <TrackRow
                key={`${option.tag}-${option.language}`}
                id={`sub-${option.tag}-${option.language}`}
                label={option.language}
                badges={subtitleBadges(option)}
                checked={subtitleSelected.has(option.tag)}
                disabled={!option.selectable}
                hint={option.selectable ? undefined : "The source did not say what language this is."}
                onToggle={() => onChange({ subtitleTags: toggle(choices.subtitleTags, option.tag) })}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
