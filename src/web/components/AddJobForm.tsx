/**
 * Paste a URL, get a job.
 *
 * Two rules shape this form:
 *
 * 🔴 **R7 — audio and subtitle languages are independent.** They are two
 * separate fields and neither is ever derived from the other. HomeTube couples
 * them, which is why asking for English audio silently changes which subtitles
 * you get (PLAN §4.1). Two inputs is the fix, and it has to stay two inputs.
 *
 * ⚠️ **Preview is optional and separate.** It costs a network round trip to the
 * source and spends the IP budget (PLAN §4.3), so it happens only when asked
 * for — and never as a precondition of queueing, because a slow source must not
 * be able to stop a job from being recorded.
 */
import { useState, type FormEvent } from "react";

import { DEFAULT_PREFERENCES, type Preferences } from "../../core/types";
import { formatDuration } from "../data/format";
import { enqueue, probe, useAction, type EnqueueOutcome, type ProbeResult } from "../data/useQueue";

/** `en, es-419  pt-BR` → `["en","es-419","pt-BR"]`. Commas or spaces, either way. */
function parseLanguages(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360] as const;

export function AddJobForm(): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [originalOnly, setOriginalOnly] = useState(DEFAULT_PREFERENCES.originalOnly);
  const [audioLanguages, setAudioLanguages] = useState(DEFAULT_PREFERENCES.audioLanguages.join(", "));
  const [subtitleLanguages, setSubtitleLanguages] = useState(DEFAULT_PREFERENCES.subtitleLanguages.join(", "));
  const [maxResolution, setMaxResolution] = useState(DEFAULT_PREFERENCES.maxResolution);
  const [sponsorblock, setSponsorblock] = useState(DEFAULT_PREFERENCES.sponsorblock);
  const [embedSubtitles, setEmbedSubtitles] = useState(DEFAULT_PREFERENCES.embedSubtitles);

  const [preview, setPreview] = useState<ProbeResult | null>(null);
  const [outcome, setOutcome] = useState<EnqueueOutcome | null>(null);

  const submit = useAction(enqueue);
  const look = useAction(probe);

  const preferences = (): Preferences => ({
    originalOnly,
    audioLanguages: parseLanguages(audioLanguages),
    // Never touched by the audio fields. See the header.
    subtitleLanguages: parseLanguages(subtitleLanguages),
    maxResolution,
    sponsorblock,
    embedSubtitles,
  });

  const send = async (force: boolean): Promise<void> => {
    const result = await submit.run({
      url,
      destination,
      preferences: preferences(),
      force,
      // Carried over from the preview when there is one, so the row has a title
      // before the worker has looked at it.
      title: preview?.info.title,
      thumbnail: preview?.info.thumbnail,
      duration: preview?.info.duration,
      source: preview?.info.source,
    });
    if (result.ok) {
      setOutcome(result.value);
      if (result.value.outcome === "queued") {
        setUrl("");
        setPreview(null);
      }
    }
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void send(false);
  };

  const onPreview = async (): Promise<void> => {
    setOutcome(null);
    const result = await look.run(url);
    setPreview(result.ok ? result.value : null);
  };

  const busy = submit.pending || look.pending;

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
            onChange={(event) => {
              setUrl(event.target.value);
              setOutcome(null);
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
          {submit.pending ? "Queueing…" : "Download"}
        </button>
        <button type="button" disabled={busy || url.trim() === ""} onClick={() => void onPreview()}>
          {look.pending ? "Looking…" : "Preview first"}
        </button>
      </div>

      {submit.error && <div className="note error">{submit.error.message}</div>}
      {look.error && <div className="note error">{look.error.message}</div>}

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
            <button type="button" className="small" disabled={busy} onClick={() => void send(true)}>
              Download it again anyway
            </button>
          </div>
        </div>
      )}

      {preview && (
        <div className="preview">
          {preview.info.thumbnail && <img src={preview.info.thumbnail} alt="" />}
          <div style={{ minWidth: 0 }}>
            <strong style={{ overflowWrap: "anywhere" }}>{preview.info.title}</strong>
            <dl>
              <dt>Source</dt>
              <dd>
                {preview.info.source}
                {preview.info.uploader ? ` · ${preview.info.uploader}` : ""}
              </dd>
              <dt>Length</dt>
              <dd>{formatDuration(preview.info.duration)}</dd>
              <dt>Audio</dt>
              <dd>
                {preview.info.audioTracks.length === 0
                  ? "—"
                  : [
                      ...new Set(
                        preview.info.audioTracks.map(
                          (track) => `${track.language}${track.isOriginal ? " (original)" : ""}`,
                        ),
                      ),
                    ].join(", ")}
              </dd>
              <dt>Subtitles</dt>
              <dd>
                {preview.info.subtitles.length === 0
                  ? "—"
                  : [...new Set(preview.info.subtitles.map((track) => track.language))].join(", ")}
              </dd>
            </dl>
          </div>
        </div>
      )}
    </form>
  );
}
