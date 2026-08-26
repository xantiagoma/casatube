/**
 * Paste a URL, see what the video actually has, get a job.
 *
 * 🔴 **The fault this form was rebuilt to fix**: it asked for a resolution, an
 * audio language, a subtitle language and a destination folder *before showing
 * any of the options*. A fixed list offered 4K for a 720p video; "original
 * audio only" named a track nobody could see; automatic captions were
 * indistinguishable from authored subtitles; and the destination was a text box
 * that never said which folders exist. Four versions of one mistake: asking for
 * a decision without showing the choices.
 *
 * Three rules still shape it:
 *
 * 🔴 **R7 — audio and subtitle languages are independent.** Two lists, neither
 * derived from the other, all the way down to the request. HomeTube couples
 * them, which is why asking for English audio silently changes the subtitles
 * (PLAN §4.1).
 *
 * ⚠️ **Preview is separate from queueing.** It costs a round trip to the source
 * and spends the IP budget (PLAN §4.3), so it fires on a deliberate act — the
 * button, or an actual paste — and never per keystroke. And it is **never a
 * precondition of queueing**: when the probe fails, the form says so and the
 * Download button still works, because the server reads the media again in
 * `analyze`. Not being able to look must not stop you downloading.
 *
 * The only `useState` here is what the user has chosen. Pending, error and
 * result all come from the mutation and the queries — the form owns the form,
 * the data layer owns everything else.
 */
import { useState, type ClipboardEvent, type FormEvent } from "react";

import { DEFAULT_PREFERENCES, type Preferences } from "../../core/types";
import { failureOf } from "../data/client";
import { formatDuration } from "../data/format";
import { useEnqueue, useProbe } from "../data/queries";
import { DestinationPicker } from "./DestinationPicker";
import { MediaPicker, type Choices } from "./MediaPicker";

/** `en, es-419  pt-BR` → `["en","es-419","pt-BR"]`. Commas or spaces, either way. */
function parseLanguages(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * The usual ceilings, used **only** when there is no probe to ask.
 *
 * ⚠️ Not a menu of what the video has — that is exactly the thing this form
 * stopped pretending to know. It is a ceiling for a job queued blind, and it is
 * labelled as one.
 */
const FALLBACK_RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360] as const;

const INITIAL_CHOICES: Choices = {
  maxResolution: DEFAULT_PREFERENCES.maxResolution,
  originalOnly: DEFAULT_PREFERENCES.originalOnly,
  audioTags: DEFAULT_PREFERENCES.audioLanguages,
  subtitleTags: DEFAULT_PREFERENCES.subtitleLanguages,
};

function messageOf(error: Error | null): string | null {
  if (!error) return null;
  return failureOf(error)?.message ?? error.message;
}

/**
 * A comma-separated language field, for when there is nothing to pick from.
 *
 * It keeps the raw text locally because the parsed list cannot represent
 * half-typed input: round-tripping `en, ` through `parseLanguages` and back
 * would delete the comma under the cursor. It is only ever mounted while there
 * are no options, so there is no second source of truth left to drift.
 */
function LanguageField({ id, label, hint, tags, onChange }: {
  id: string;
  label: string;
  hint: string;
  tags: string[];
  onChange(next: string[]): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => tags.join(", "));

  return (
    <div>
      <label htmlFor={id}>
        {label}
        <span className="hint">{hint}</span>
      </label>
      <input
        id={id}
        type="text"
        placeholder="en, es"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(parseLanguages(event.target.value));
        }}
      />
    </div>
  );
}

export function AddJobForm(): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [choices, setChoices] = useState<Choices>(INITIAL_CHOICES);
  const [sponsorblock, setSponsorblock] = useState(DEFAULT_PREFERENCES.sponsorblock);
  const [embedSubtitles, setEmbedSubtitles] = useState(DEFAULT_PREFERENCES.embedSubtitles);

  const preferences: Preferences = {
    originalOnly: choices.originalOnly,
    // Empty while "original only" is on: the server ignores the list in that
    // case, and sending it anyway would change the fingerprint — and therefore
    // whether this counts as a duplicate — without changing the download.
    audioLanguages: choices.originalOnly ? [] : choices.audioTags,
    // ⚠️ Never touched by the audio fields. See the header (R7).
    subtitleLanguages: choices.subtitleTags,
    maxResolution: choices.maxResolution,
    sponsorblock,
    embedSubtitles,
  };

  const enqueue = useEnqueue();
  // Disabled until asked. The key carries the URL, so editing the field drops
  // the old preview rather than leaving stale options beside a different video.
  const preview = useProbe(url, preferences);
  const info = preview.data?.info ?? null;
  const options = preview.data?.options ?? null;

  const update = (next: Partial<Choices>): void => setChoices((current) => ({ ...current, ...next }));

  /**
   * Probe, then start the form from what the selection logic would choose.
   *
   * The suggestion is applied here rather than in an effect: it is a
   * consequence of an act the user took. An effect watching the query would
   * also fire on a cache hit and overwrite adjustments already made to a
   * preview that had not changed.
   */
  const runProbe = async (): Promise<void> => {
    const result = await preview.refetch();
    const suggested = result.data?.suggested;
    if (!suggested) return;
    update({
      maxResolution: suggested.maxResolution,
      originalOnly: suggested.originalOnly,
      audioTags: suggested.audioLanguages,
      subtitleTags: suggested.subtitleLanguages,
    });
  };

  const send = (force: boolean): void => {
    enqueue.mutate(
      {
        url,
        destination,
        preferences,
        force,
        // Carried over from the preview when there is one, so the row has a
        // title before the worker has looked at it.
        title: info?.title,
        thumbnail: info?.thumbnail,
        duration: info?.duration,
        source: info?.source,
      },
      {
        onSuccess: (result) => {
          // Clearing on `duplicate` would take away the URL the user needs in
          // order to press "download it again anyway".
          if (result.outcome === "queued") setUrl("");
        },
      },
    );
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    send(false);
  };

  /**
   * A paste is a deliberate act — unlike typing — so it is a fair moment to
   * spend one probe. The value has not landed in state yet at this point, so
   * the field is left to update and the probe is queued behind it.
   */
  const onPaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData("text").trim();
    if (pasted === "") return;
    setUrl(pasted);
    event.preventDefault();
    queueMicrotask(() => void runProbe());
  };

  const busy = enqueue.isPending || preview.isFetching;
  const outcome = enqueue.data ?? null;
  const enqueueError = messageOf(enqueue.error);
  const previewError = messageOf(preview.error);

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>Download something</h2>

      <div className="grid">
        <div style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="url">Video URL</label>
          <input
            id="url"
            type="url"
            inputMode="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onPaste={onPaste}
            onChange={(event) => {
              setUrl(event.target.value);
              enqueue.reset();
            }}
            required
          />
        </div>

        <DestinationPicker value={destination} onChange={setDestination} />

        {options === null && (
          <div>
            <label htmlFor="fallback-resolution">
              Maximum resolution
              <span className="hint">A ceiling. Look first to see what this video actually has.</span>
            </label>
            <select
              id="fallback-resolution"
              value={choices.maxResolution}
              onChange={(event) => update({ maxResolution: Number(event.target.value) })}
            >
              {FALLBACK_RESOLUTIONS.map((height) => (
                <option key={height} value={height}>
                  {height}p
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <label className="check">
          <input
            type="checkbox"
            checked={choices.originalOnly}
            onChange={(event) => update({ originalOnly: event.target.checked })}
          />
          <span>
            Original audio only
            <span className="hint">Just the track the source marks as original.</span>
          </span>
        </label>

        <label className="check">
          <input type="checkbox" checked={sponsorblock} onChange={(e) => setSponsorblock(e.target.checked)} />
          <span>
            SponsorBlock
            <span className="hint">Remove sponsor and self-promotion segments.</span>
          </span>
        </label>

        <label className="check">
          <input type="checkbox" checked={embedSubtitles} onChange={(e) => setEmbedSubtitles(e.target.checked)} />
          <span>
            Embed subtitles
            <span className="hint">Off writes them as separate files next to the video.</span>
          </span>
        </label>
      </div>

      {options === null ? (
        <div className="grid" style={{ marginTop: 12 }}>
          {/* Nothing probed yet, so there is nothing to show and nothing to
              pretend: typed codes, and the queue still works. */}
          <LanguageField
            id="audio"
            label="Audio languages"
            hint={
              choices.originalOnly
                ? "Ignored while “original only” is on."
                : "Comma separated, e.g. en, es-419. Look first to pick from a list."
            }
            tags={choices.audioTags}
            onChange={(tags) => update({ audioTags: tags })}
          />
          <LanguageField
            id="subs"
            label="Subtitle languages"
            hint="Independent of the audio. Empty means none."
            tags={choices.subtitleTags}
            onChange={(tags) => update({ subtitleTags: tags })}
          />
        </div>
      ) : (
        <MediaPicker options={options} choices={choices} onChange={update} />
      )}

      <div className="actions">
        <button type="submit" className="primary" disabled={busy || url.trim() === ""}>
          {enqueue.isPending ? "Queueing…" : "Download"}
        </button>
        <button type="button" disabled={busy || url.trim() === ""} onClick={() => void runProbe()}>
          {preview.isFetching ? "Looking…" : options ? "Look again" : "Show what's available"}
        </button>
      </div>

      {enqueueError && <div className="note error">{enqueueError}</div>}

      {/* A failed probe is a warning, not a wall: the server reads the media
          again in `analyze`, so the settings above still queue a real job. */}
      {previewError && (
        <div className="note warn">
          <strong>Could not look at this video.</strong> {previewError} You can still queue it — the server
          reads the formats again when it downloads, using the settings above.
        </div>
      )}

      {/* The two outcomes of `enqueue`, kept visibly apart — that distinction is
          the whole reason the server returns `outcome` instead of just a job. */}
      {outcome?.outcome === "queued" && (
        <div className="note ok">
          Queued. It is now the server&rsquo;s problem — you can close this tab.
        </div>
      )}
      {outcome?.outcome === "duplicate" && (
        <div className="note warn">
          <strong>Already downloaded.</strong> This URL, at exactly these settings, finished on{" "}
          {new Date(outcome.job.createdAt).toLocaleDateString()}
          {outcome.job.outputFile ? (
            <>
              {" as "}
              <code>{outcome.job.outputFile}</code>
            </>
          ) : null}
          .
          <div className="actions">
            <button type="button" className="small" disabled={busy} onClick={() => send(true)}>
              Download it again anyway
            </button>
          </div>
        </div>
      )}

      {info && (
        <div className="preview">
          {info.thumbnail && <img src={info.thumbnail} alt="" />}
          <div style={{ minWidth: 0 }}>
            <strong style={{ overflowWrap: "anywhere" }}>{info.title}</strong>
            <dl>
              <dt>Source</dt>
              <dd>
                {info.source}
                {info.uploader ? ` · ${info.uploader}` : ""}
              </dd>
              <dt>Length</dt>
              <dd>{formatDuration(info.duration)}</dd>
              <dt>Streams</dt>
              <dd>
                {info.videoFormats.length} video · {info.audioTracks.length} audio ·{" "}
                {info.subtitles.length} subtitle
              </dd>
            </dl>
          </div>
        </div>
      )}
    </form>
  );
}
