/**
 * The video half of the choices this particular video offers — drawn from the
 * probe, never from a hard-coded list.
 *
 * 🔴 The fault it exists to fix: the form used to ask for a resolution, an
 * audio language and a subtitle language *before knowing what the video had*.
 * It offered 4K for a 720p video, gave no way to see which audio track is the
 * original — the thing "original only" actually means — and treated authored
 * subtitles and machine-generated captions as the same offer.
 *
 * 🔴 **Codec is asked before resolution, and that is the ordering decision.**
 * The codec preference changes what *every* row underneath would download: the
 * 2160p row says "not in the chosen codec" and falls back to 1440p under H.264,
 * and shows a different size. Asked afterwards, it silently rewrites a list the
 * reader has already scrolled past. Asked first, the list they read is the list
 * they get. Same rule as audio: the policy, then the thing the policy governs.
 *
 * Presentation only: it receives options and a selection and calls back. The
 * grouping, the ordering and the preselection are all decided on the server
 * (`api/options.ts`), which is what keeps them identical to what the worker
 * will do with the job.
 */
import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CodecOption, MediaOptions, ResolutionOption } from "../../../api/options";
import type { VideoCodecPreference } from "../../../core/types";
import { formatBytes } from "../../data/format";
import type { Choices } from "./choices";
import { ChoiceCard } from "./OptionBits";

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
        return (
          <ChoiceCard
            key={option.value}
            selected={option.value === value}
            onSelect={() => onChange(option.value)}
            label={copy.label}
            implication={copy.implication}
            dimmed={!option.available}
            /* The badge is the short form of the server's `caveat`: how far this
               choice reaches on this video, or that it does not exist here at
               all. The sentence itself is shown once, below, when the current
               pair is actually the one that cannot be delivered — saying it on
               every row *and* in the warning reads as two different problems. */
            badges={[
              ...(option.maxHeight !== null && option.available ? [{ text: `up to ${option.maxHeight}p` }] : []),
              ...(!option.available ? [{ text: "not in this video", tone: "warn" as const }] : []),
            ]}
          />
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

  const known = options.some((option) => option.resolution === value);

  return (
    <div role="radiogroup" aria-label="Maximum resolution" className="space-y-1">
      {!known && (
        <p className="pb-1 text-xs text-warning">
          The ceiling is {value}p and nothing here reaches it. The best available will be used.
        </p>
      )}
      {options.map((option) => {
        const selected = option.resolution === value;
        // 🔴 What this row would really download with the codec now chosen —
        // computed on the server by the selector itself, one entry per choice,
        // so moving the codec radio never needs a second probe.
        const outcome = option.byCodec[videoCodec];
        return (
          <button
            key={option.resolution}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.resolution)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
              selected ? "border-primary/50 bg-primary/5" : "hover:bg-accent/40",
            )}
          >
            <span
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full border",
                selected ? "border-primary bg-primary" : "border-muted-foreground/40",
              )}
            >
              {selected && <span className="size-1.5 rounded-full bg-primary-foreground" aria-hidden />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{option.resolution}p</span>
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
                  → {outcome.resolution}p {outcome.codecFamily === "unknown" ? "" : outcome.codecFamily.toUpperCase()}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The sentence for the pair that was asked for and does not exist.
 *
 * ⚠️ It is a *lookup*, not a second copy of the selection logic: whether the
 * chosen codec exists at the chosen height is `codecAvailable`, computed on the
 * server, and the words are the server's `caveat`. The browser only decides
 * whether to show it — which is the whole of R3.
 */
export function codecWarning(options: MediaOptions, choices: Choices): string | null {
  const codec = options.codecs.find((option) => option.value === choices.videoCodec);
  if (!codec?.caveat) return null;
  if (!codec.available) return codec.caveat;
  const row = options.resolutions.find((option) => option.resolution === choices.maxResolution);
  return row && !row.byCodec[choices.videoCodec].exact ? codec.caveat : null;
}

/**
 * Step one: what the picture should be.
 *
 * Codec, then the resolution ceiling — see the header of this file for why that
 * order and not the other one.
 */
export function VideoPicker({
  options,
  choices,
  onChange,
}: {
  options: MediaOptions;
  choices: Choices;
  onChange(next: Partial<Choices>): void;
}) {
  const warning = codecWarning(options, choices);

  return (
    <div className="space-y-4">
      {options.codecs.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Codec preference</p>
          <p className="-mt-1 text-xs text-muted-foreground">
            A preference, not a filter. Named codecs keep the codec and give up resolution — never the other way
            round, and never without saying so.
          </p>
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
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Resolution ceiling</p>
        <p className="-mt-1 text-xs text-muted-foreground">
          The best format at or below this — only what this video actually has. Sizes count the video stream only,
          in the codec chosen above.
        </p>
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
      </div>
    </div>
  );
}
