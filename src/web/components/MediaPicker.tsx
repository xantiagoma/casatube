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
 * Presentation only: it receives options and a selection, and calls back. The
 * grouping, the ordering and the preselection are all decided on the server
 * (`api/options.ts`), which is what keeps them identical to what the worker
 * will do with the job.
 */
import type { AudioOption, MediaOptions, ResolutionOption, SubtitleOption } from "../../api/options";
import { formatBytes } from "../data/format";

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

function resolutionLabel(option: ResolutionOption): string {
  const parts = [`${option.height}p`];
  if (option.fps && option.fps >= 50) parts.push(`${Math.round(option.fps)} fps`);
  if (option.codecFamily !== "unknown") parts.push(option.codecFamily.toUpperCase());
  // ⚠️ Video only: at this resolution the audio is a separate stream, so the
  // finished file is a few percent larger. Hence "≈", and hence saying so.
  if (option.approxBytes) parts.push(`≈ ${formatBytes(option.approxBytes)}`);
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
 * 🔴 Authored subtitles and machine captions are not the same offer, and the
 * old form showed them as one line of comma-separated codes.
 */
function subtitleBadges(option: SubtitleOption): { text: string; tone?: "ok" | "warn" }[] {
  return [
    option.hasManual
      ? { text: "manual", tone: "ok" as const }
      : { text: "auto-generated", tone: "warn" as const },
    ...(option.hasManual && option.hasAutomatic ? [{ text: "+ auto" }] : []),
    { text: option.tag },
  ];
}

interface RowProps {
  id: string;
  label: string;
  detail?: string;
  badges?: { text: string; tone?: "ok" | "warn" }[];
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onToggle(): void;
}

function OptionRow({ id, label, detail, badges, checked, disabled, hint, onToggle }: RowProps): React.JSX.Element {
  return (
    <label className={`option${disabled ? " disabled" : ""}`}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span className="option-body">
        <span className="option-label">
          {label}
          {badges?.map((badge) => (
            <span key={badge.text} className={`tag ${badge.tone ?? ""}`}>
              {badge.text}
            </span>
          ))}
        </span>
        {detail ? <span className="hint">{detail}</span> : null}
        {hint ? <span className="hint">{hint}</span> : null}
      </span>
    </label>
  );
}

function ResolutionField({ options, value, onChange }: {
  options: ResolutionOption[];
  value: number;
  onChange(height: number): void;
}): React.JSX.Element {
  if (options.length === 0) {
    return (
      <div>
        <span className="field-title">Resolution</span>
        <p className="hint">This source has no video streams — it will be downloaded as audio.</p>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="resolution">
        Resolution
        <span className="hint">
          The best format at or below this — only what this video actually has. Sizes are approximate and
          count the video stream only.
        </span>
      </label>
      <select id="resolution" value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {/* The current value can be a ceiling no format reaches — a video whose
            every stream is above it. Keeping it in the list stops the select
            from silently showing someone else's choice. */}
        {options.every((option) => option.height !== value) && <option value={value}>{value}p (nothing matches)</option>}
        {options.map((option) => (
          <option key={option.height} value={option.height}>
            {resolutionLabel(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

function AudioField({ options, choices, onChange }: Props): React.JSX.Element {
  // While "original only" is on, the list shows *what that means* rather than
  // going blank: the original row is ticked and the whole list is read-only.
  const selected = new Set(
    choices.originalOnly
      ? options.audio.flatMap((option) => (option.isOriginal ? [option.tag] : []))
      : choices.audioTags,
  );

  return (
    <fieldset className="field">
      <legend>
        Audio tracks
        <span className="hint">
          {choices.originalOnly
            ? "Showing what “original audio only” selects. Turn it off to choose."
            : "Pick one or more languages. Independent of subtitles."}
        </span>
      </legend>

      {options.audio.length === 0 ? (
        <p className="hint">This source reports no separate audio tracks.</p>
      ) : (
        <div className="option-list">
          {options.audio.map((option) => (
            <OptionRow
              key={option.tag + option.language}
              id={`audio-${option.tag}-${option.language}`}
              label={option.language}
              detail={audioDetail(option)}
              badges={[
                ...(option.isOriginal ? [{ text: "original", tone: "ok" as const }] : []),
                { text: option.tag },
              ]}
              checked={selected.has(option.tag)}
              disabled={choices.originalOnly || !option.selectable}
              hint={option.selectable ? undefined : "The source did not say what language this is."}
              onToggle={() => onChange({ audioTags: toggle(choices.audioTags, option.tag) })}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

function SubtitleField({ options, choices, onChange }: Props): React.JSX.Element {
  const selected = new Set(choices.subtitleTags);

  return (
    <fieldset className="field">
      <legend>
        Subtitles
        <span className="hint">
          Independent of the audio (R7). Authored subtitles are preferred when a language has both.
        </span>
      </legend>

      {options.subtitles.length === 0 ? (
        <p className="hint">This source has no subtitles.</p>
      ) : (
        <div className="option-list">
          {options.subtitles.map((option) => (
            <OptionRow
              key={option.tag + option.language}
              id={`sub-${option.tag}-${option.language}`}
              label={option.language}
              badges={subtitleBadges(option)}
              checked={selected.has(option.tag)}
              disabled={!option.selectable}
              hint={option.selectable ? undefined : "The source did not say what language this is."}
              onToggle={() => onChange({ subtitleTags: toggle(choices.subtitleTags, option.tag) })}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function MediaPicker({ options, choices, onChange }: Props): React.JSX.Element {
  return (
    <div className="picker">
      <ResolutionField
        options={options.resolutions}
        value={choices.maxResolution}
        onChange={(height) => onChange({ maxResolution: height })}
      />
      {options.formatsWithoutHeight > 0 && (
        <p className="hint">
          {options.formatsWithoutHeight} format(s) came without a resolution. They are only used if nothing
          else fits.
        </p>
      )}
      <AudioField options={options} choices={choices} onChange={onChange} />
      <SubtitleField options={options} choices={choices} onChange={onChange} />
    </div>
  );
}
