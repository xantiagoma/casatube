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
import { Check, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type {
  AudioOption,
  CodecOption,
  MediaOptions,
  ResolutionOption,
  SubtitleOption,
} from "../../../api/options";
import type { VideoCodecPreference } from "../../../core/types";
import { formatBytes } from "../../data/format";

export interface Choices {
  maxResolution: number;
  /**
   * 🔴 Preselected, not imposed. The old build showed the codec and gave no way
   * to change it, which made a decision about someone else's television.
   */
  videoCodec: VideoCodecPreference;
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
  // The codec only goes here when this height has exactly one — otherwise the
  // per-codec chips below say it, and saying it twice reads as two facts.
  if (option.variants.length === 1 && option.codecFamily !== "unknown") {
    parts.push(option.codecFamily.toUpperCase());
  }
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

/**
 * What each choice means, in one line.
 *
 * ⚠️ These are the *general* trade-offs and they are static on purpose. What a
 * choice costs on **this** video — "no H.264 above 1080p here" — is not in this
 * table: it comes from the server as `caveat`, because it is a reading of the
 * media rather than a fact about codecs, and R3 keeps readings on the server.
 */
const CODEC_COPY: Record<VideoCodecPreference, { label: string; implication: string }> = {
  auto: { label: "Auto", implication: "H.264 first — direct play on most TVs." },
  efficient: { label: "Efficient", implication: "AV1/VP9 first — smaller files, may transcode." },
  h264: { label: "H.264", implication: "Direct play on most TVs; the largest files." },
  vp9: { label: "VP9", implication: "Smaller than H.264; widely supported." },
  hevc: { label: "HEVC", implication: "Small, but decoders are uneven." },
  av1: { label: "AV1", implication: "Smallest files, may transcode without a GPU." },
};

function CodecList({
  options,
  value,
  onChange,
}: {
  options: CodecOption[];
  value: VideoCodecPreference;
  onChange(next: VideoCodecPreference): void;
}) {
  return (
    <div role="radiogroup" aria-label="Video codec" className="grid gap-1 sm:grid-cols-2">
      {options.map((option) => {
        const copy = CODEC_COPY[option.value];
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
              selected ? "border-primary/50 bg-primary/5" : "hover:bg-accent/40",
              !option.available && !selected && "opacity-60",
            )}
          >
            <span
              className={cn(
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
              )}
            >
              {selected && <Check className="size-2.5" aria-hidden />}
            </span>
            <span className="min-w-0 flex-1">
              {/* The badge is the short form of the server's `caveat`: how far
                  this choice reaches on this video, or that it does not exist
                  here at all. The sentence itself is shown once, below, when the
                  current pair is actually the one that cannot be delivered —
                  saying it on every row *and* in the warning reads as two
                  different problems. */}
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{copy.label}</span>
                {option.maxHeight !== null && option.available ? (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
                    up to {option.maxHeight}p
                  </Badge>
                ) : null}
                {!option.available ? (
                  <Badge variant="secondary" className="bg-warning/15 px-1.5 py-0 text-[10px] font-medium text-warning">
                    not in this video
                  </Badge>
                ) : null}
              </span>
              <span className="block text-xs text-muted-foreground">{copy.implication}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ResolutionList({
  options,
  value,
  videoCodec,
  onChange,
}: {
  options: ResolutionOption[];
  value: number;
  videoCodec: VideoCodecPreference;
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
        // 🔴 What this row would really download with the codec now chosen —
        // computed on the server by the selector itself, one entry per choice,
        // so moving the codec radio never needs a second probe.
        const outcome = option.byCodec[videoCodec];
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
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{option.height}p</span>
                {/* 🔴 The combination that does not exist, said on the row that
                    offers it — rather than by quietly dropping the row. */}
                {!outcome.exact && (
                  <span className="text-[10px] font-medium text-warning">not in the chosen codec</span>
                )}
              </span>
              {resolutionDetail(option) ? (
                <span className="block text-xs text-muted-foreground">{resolutionDetail(option)}</span>
              ) : null}
              {/* 🔴 1080p is not one thing: it exists in H.264 *and* in AV01, at
                  very different sizes, and which one arrives decides whether the
                  media server plays it or transcodes it. */}
              {option.variants.length > 1 && (
                <span className="mt-1 flex flex-wrap gap-1">
                  {option.variants.map((variant) => (
                    <span
                      key={variant.formatId}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px] tabular-nums",
                        outcome.exact && variant.formatId === outcome.formatId
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-transparent bg-muted text-muted-foreground",
                      )}
                    >
                      {variant.codecFamily === "unknown" ? "other" : variant.codecFamily.toUpperCase()}
                      {variant.approxBytes
                        ? ` · ${variant.bytesEstimated ? "≈ " : ""}${formatBytes(variant.approxBytes)}`
                        : ""}
                    </span>
                  ))}
                </span>
              )}
            </span>
            {/* ⚠️ Video only, and often an estimate from the bitrate: the
                finished file is a few percent larger once audio is muxed in.
                Hence the "≈", and hence saying which kind of number it is.
                When the codec caps this row, the size shown is the one that
                would really arrive — a number for a file nobody will get is
                worse than no number. */}
            <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {outcome.approxBytes
                ? `${outcome.bytesEstimated ? "≈ " : ""}${formatBytes(outcome.approxBytes)}`
                : "—"}
              {!outcome.exact ? (
                <span className="block text-warning">
                  → {outcome.height}p{" "}
                  {outcome.codecFamily === "unknown" ? "" : outcome.codecFamily.toUpperCase()}
                </span>
              ) : null}
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

/**
 * The sentence for the pair that was asked for and does not exist.
 *
 * ⚠️ It is a *lookup*, not a second copy of the selection logic: whether the
 * chosen codec exists at the chosen height is `codecAvailable`, computed on the
 * server, and the words are the server's `caveat`. The browser only decides
 * whether to show it — which is the whole of R3.
 */
function codecWarning(options: MediaOptions, choices: Choices): string | null {
  const codec = options.codecs.find((option) => option.value === choices.videoCodec);
  if (!codec?.caveat) return null;
  if (!codec.available) return codec.caveat;
  const row = options.resolutions.find((option) => option.height === choices.maxResolution);
  return row && !row.byCodec[choices.videoCodec].exact ? codec.caveat : null;
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
  const warning = codecWarning(options, choices);

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
          videoCodec={choices.videoCodec}
          onChange={(height) => onChange({ maxResolution: height })}
        />
        {options.formatsWithoutHeight > 0 && (
          <p className="text-xs text-muted-foreground">
            {options.formatsWithoutHeight} format(s) came without a resolution. They are only used if nothing else
            fits.
          </p>
        )}
      </section>

      {options.codecs.length > 0 && (
        <section className="space-y-2">
          <div>
            <Label>Video codec</Label>
            <p className="text-xs text-muted-foreground">
              A preference, not a filter. Named codecs keep the codec and give up resolution — never the other way
              round, and never without saying so.
            </p>
          </div>
          <CodecList
            options={options.codecs}
            value={choices.videoCodec}
            onChange={(next) => onChange({ videoCodec: next })}
          />
          {warning ? (
            <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{warning}</span>
            </p>
          ) : null}
        </section>
      )}

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
