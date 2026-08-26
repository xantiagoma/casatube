/**
 * Paste a URL, get a job.
 *
 * Three rules shape this form:
 *
 * 🔴 **R7 — audio and subtitle languages are independent.** They are two
 * separate fields and neither is ever derived from the other. HomeTube couples
 * them, which is why asking for English audio silently changes which subtitles
 * you get (PLAN §4.1). Two inputs is the fix, and it has to stay two inputs.
 *
 * ⚠️ **Preview is separate from queueing.** It costs a round trip to the source
 * and spends the IP budget (PLAN §4.3), so it fires on a deliberate act — the
 * button, or an actual paste — and never per keystroke. And it is never a
 * precondition of queueing: a slow source must not be able to stop a job from
 * being recorded.
 *
 * The only `useState` here is what the user has typed. Pending, error and
 * result all come from the mutation and the query — the form owns the form, the
 * data layer owns everything else.
 */
import { useState, type ClipboardEvent, type FormEvent } from "react";

import { DEFAULT_PREFERENCES, type Preferences } from "../../core/types";
import { failureOf } from "../data/client";
import { formatDuration } from "../data/format";
import { useEnqueue, useProbe } from "../data/queries";

/** `en, es-419  pt-BR` → `["en","es-419","pt-BR"]`. Commas or spaces, either way. */
function parseLanguages(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360] as const;

function messageOf(error: Error | null): string | null {
  if (!error) return null;
  return failureOf(error)?.message ?? error.message;
}

export function AddJobForm(): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [originalOnly, setOriginalOnly] = useState(DEFAULT_PREFERENCES.originalOnly);
  const [audioLanguages, setAudioLanguages] = useState(() => DEFAULT_PREFERENCES.audioLanguages.join(", "));
  const [subtitleLanguages, setSubtitleLanguages] = useState(() => DEFAULT_PREFERENCES.subtitleLanguages.join(", "));
  const [maxResolution, setMaxResolution] = useState(DEFAULT_PREFERENCES.maxResolution);
  const [sponsorblock, setSponsorblock] = useState(DEFAULT_PREFERENCES.sponsorblock);
  const [embedSubtitles, setEmbedSubtitles] = useState(DEFAULT_PREFERENCES.embedSubtitles);

  const enqueue = useEnqueue();
  // Disabled until asked. The key carries the URL, so editing the field drops
  // the old preview rather than leaving a stale title beside a different video.
  const preview = useProbe(url);
  const info = preview.data?.info ?? null;

  const preferences = (): Preferences => ({
    originalOnly,
    audioLanguages: parseLanguages(audioLanguages),
    // Never touched by the audio fields. See the header.
    subtitleLanguages: parseLanguages(subtitleLanguages),
    maxResolution,
    sponsorblock,
    embedSubtitles,
  });

  const send = (force: boolean): void => {
    enqueue.mutate(
      {
        url,
        destination,
        preferences: preferences(),
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
   * the field is left to update and the refetch is queued behind it.
   */
  const onPaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = event.clipboardData.getData("text").trim();
    if (pasted === "") return;
    setUrl(pasted);
    event.preventDefault();
    queueMicrotask(() => void preview.refetch());
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

        <div>
          <label htmlFor="destination">
            Destination folder
            <span className="hint">Inside the library. Leave empty for the library root.</span>
          </label>
          <input
            id="destination"
            type="text"
            placeholder="youtube/talks"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="resolution">Maximum resolution</label>
          <select
            id="resolution"
            value={maxResolution}
            onChange={(event) => setMaxResolution(Number(event.target.value))}
          >
            {RESOLUTIONS.map((height) => (
              <option key={height} value={height}>
                {height}p
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="audio">
            Audio languages
            <span className="hint">
              {originalOnly ? "Ignored while “original only” is on." : "Comma separated, e.g. en, es-419"}
            </span>
          </label>
          <input
            id="audio"
            type="text"
            placeholder="en, es"
            value={audioLanguages}
            disabled={originalOnly}
            onChange={(event) => setAudioLanguages(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="subs">
            Subtitle languages
            <span className="hint">Independent of the audio. Empty means none.</span>
          </label>
          <input
            id="subs"
            type="text"
            placeholder="en, es"
            value={subtitleLanguages}
            onChange={(event) => setSubtitleLanguages(event.target.value)}
          />
        </div>
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <label className="check">
          <input type="checkbox" checked={originalOnly} onChange={(e) => setOriginalOnly(e.target.checked)} />
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

      <div className="actions">
        <button type="submit" className="primary" disabled={busy || url.trim() === ""}>
          {enqueue.isPending ? "Queueing…" : "Download"}
        </button>
        <button type="button" disabled={busy || url.trim() === ""} onClick={() => void preview.refetch()}>
          {preview.isFetching ? "Looking…" : "Preview first"}
        </button>
      </div>

      {enqueueError && <div className="note error">{enqueueError}</div>}
      {previewError && <div className="note error">{previewError}</div>}

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
              <dt>Audio</dt>
              <dd>
                {info.audioTracks.length === 0
                  ? "—"
                  : [
                      ...new Set(
                        info.audioTracks.map((track) => `${track.language}${track.isOriginal ? " (original)" : ""}`),
                      ),
                    ].join(", ")}
              </dd>
              <dt>Subtitles</dt>
              <dd>
                {info.subtitles.length === 0
                  ? "—"
                  : [...new Set(info.subtitles.map((track) => track.language))].join(", ")}
              </dd>
            </dl>
          </div>
        </div>
      )}
    </form>
  );
}
