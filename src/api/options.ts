/**
 * What a probe *means* for the form: the choices that actually exist.
 *
 * 🔴 The fault this fixes: the form asked for a resolution, an audio language
 * and a subtitle language before it knew what the video had, so it offered 4K
 * for a 720p video, no way to see which audio track is the original, and no
 * way to tell an authored subtitle from a machine-generated one.
 *
 * ## Why this is derived on the server
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * 1. **R3** — the browser observes. The options are a reading of the media, not
 *    a decision taken in the tab.
 * 2. **The preselection has to match what the worker will do.** It is computed
 *    by calling `core/selection` itself — the same functions `analyze` runs, on
 *    the same input — so "checked by default" is not an imitation of the
 *    selection logic that can drift from it. It *is* the selection logic.
 *
 * ## Grouped by language, not one row per track
 *
 * `Preferences` names **languages** (`audioLanguages`, `subtitleLanguages`), not
 * track ids. Offering a row per track would let the user pick something the
 * request cannot express — two English audio streams, or the automatic captions
 * for a language that also has authored ones, which `selectSubtitles` would
 * override anyway. One row per language tag is exactly the granularity the
 * contract can carry, so what is chosen is what arrives.
 */
import {
  codecMaxHeight,
  codecOrder,
  requestedCodec,
  selectAudioTracks,
  selectSubtitles,
  selectVideoFormat,
  toLanguageTag,
  UNKNOWN_LANGUAGE,
  videoCodecFamily,
  videoCodecNotice,
} from "../core/selection";
import { DEFAULT_PREFERENCES, VIDEO_CODEC_PREFERENCES, VIDEO_CODECS } from "../core/types";
import type {
  AudioTrack,
  MediaInfo,
  Preferences,
  SubtitleTrack,
  VideoCodec,
  VideoCodecPreference,
  VideoFormat,
} from "../core/types";

/**
 * One codec at one resolution — the best stream of that family at that height.
 *
 * 🔴 Why the resolution list is not flat: 1080p is not one thing. It exists as
 * H.264 *and* as AV01, at very different sizes, and which one arrives decides
 * whether a media server without a GPU direct-plays the file or transcodes it.
 * A single row per height hid both facts, which is exactly how a preference
 * nobody could see ended up making the choice.
 */
export interface CodecVariant {
  formatId: string;
  /** As the provider stated it: `avc1.640028`, `av01.0.08M.08`… */
  codec?: string;
  codecFamily: string;
  fps?: number;
  approxBytes?: number;
  bytesEstimated?: boolean;
}

/**
 * 🔴 What one codec choice yields **at one resolution** — the answer to "if I
 * pick 2160p and H.264, what actually lands on disk?".
 *
 * ⚠️ Every one of these is `selectVideoFormat` called with that height as the
 * ceiling and that codec as the preference: the same function the worker runs.
 *
 * It is computed for all six choices, at every height, because **the probe
 * happens once**. Preferences travel in the request but the query is keyed by
 * the URL alone (one probe per URL — PLAN §4.3), so moving the codec radio must
 * not need a second look at the source. The alternative was for the browser to
 * work out "the best height at or below the ceiling that has this codec" for
 * itself — the selection rule reimplemented in the one place it can drift.
 */
export interface CodecOutcome {
  formatId: string;
  codec?: string;
  codecFamily: string;
  height: number | null;
  fps?: number;
  approxBytes?: number;
  bytesEstimated?: boolean;
  /**
   * False when this is not what was asked for: the codec caps the resolution
   * below this row, or the media has none of it and another one is standing in.
   * The `caveat` on the matching {@link CodecOption} is the sentence for it.
   */
  exact: boolean;
}

export interface ResolutionOption {
  height: number;
  /** The format that would be picked with this height as the ceiling. */
  formatId: string;
  /** As the provider stated it: `avc1.640028`, `vp09.00.40.08`… */
  codec?: string;
  /** `h264` | `vp9` | `hevc` | `av1` | `unknown` — the comparable form. */
  codecFamily: string;
  fps?: number;
  /**
   * ⚠️ **The video stream only.** At 1080p the audio is a separate file, so the
   * finished download is this plus a few percent. Labelled as approximate in
   * the UI for that reason — a number that is quietly wrong is worse than one
   * that admits it.
   */
  approxBytes?: number;
  /**
   * True when the size was computed from bitrate × duration rather than
   * reported by the provider.
   *
   * 📌 Not a detail: YouTube's `-J` output carries a bitrate for every format
   * and a size for almost none of them, so without this the size column would
   * be empty exactly where it is most wanted. Both numbers are approximations;
   * this one says which kind.
   */
  bytesEstimated?: boolean;
  /**
   * Every codec this height exists in, best-of-family, ranked by the current
   * preference. Always at least one. A fact about the video rather than about
   * the request — 1080p is H.264 *and* AV01 whoever is asking.
   */
  variants: CodecVariant[];
  /**
   * What each of the six codec choices yields with this height as the ceiling.
   *
   * ⚠️ The row is always listed, even when the chosen codec cannot reach it.
   * Hiding 2160p because H.264 stops at 1080p would be the same silence in a
   * new place: the resolution exists, it is the *combination* that does not,
   * and only one of those two is worth saying out loud.
   */
  byCodec: Record<VideoCodecPreference, CodecOutcome>;
}

/**
 * What one codec choice means for *this* video.
 *
 * 🔴 The honest half of a preselected preference: choosing H.264 on a video
 * whose 4K is AV1-only has a consequence, and the person choosing has to be
 * able to read it **before** the download, not deduce it from the file
 * afterwards. `caveat` is that sentence, written by `core/selection` — the same
 * function that produces the probe's warning, so the form and the API can never
 * word the same fact two different ways.
 */
export interface CodecOption {
  value: VideoCodecPreference;
  /** False only for a named codec this video does not carry at all. */
  available: boolean;
  /** The highest resolution this choice reaches here. */
  maxHeight: number | null;
  /** How many formats it covers — 0 when unavailable. */
  formatCount: number;
  /** What it costs on this video, or `null` when it costs nothing. */
  caveat: string | null;
}

export interface AudioOption {
  /** ISO 639-2/B — what goes into the container, and what the request carries. */
  tag: string;
  /** As the provider stated it: `en-US`, `es-419`. The first of the group. */
  language: string;
  /** Every raw language string that folded into this tag. */
  variants: string[];
  /** 🔴 The thing the old form could not show: which one "original only" means. */
  isOriginal: boolean;
  bitrate?: number;
  codec?: string;
  approxBytes?: number;
  trackCount: number;
  /**
   * False when the source did not label the language. Such a track cannot be
   * *asked for* — a request names languages — so the row is shown and disabled
   * rather than quietly omitted.
   */
  selectable: boolean;
}

export interface SubtitleOption {
  tag: string;
  language: string;
  /** Authored by a person. */
  hasManual: boolean;
  /** Machine-generated captions. */
  hasAutomatic: boolean;
  selectable: boolean;
}

export interface MediaOptions {
  resolutions: ResolutionOption[];
  /** The six codec choices, each measured against this video. */
  codecs: CodecOption[];
  audio: AudioOption[];
  subtitles: SubtitleOption[];
  /**
   * Formats whose height the provider never reported. They are still
   * downloadable — `selectVideoFormat` falls back to them — but they cannot be
   * offered as a resolution, and silently dropping them would make the list
   * look shorter than the truth.
   */
  formatsWithoutHeight: number;
}

/** What the form should start with: what the selection logic would choose. */
export interface Suggestion {
  originalOnly: boolean;
  /** The best height at or below the ceiling — the ceiling itself if none fits. */
  maxResolution: number;
  /** Preselected, not imposed: whatever the caller's preferences carry. */
  videoCodec: VideoCodecPreference;
  /** The family that would actually be downloaded — which is not always the one above. */
  videoCodecFamily: string;
  audioLanguages: string[];
  subtitleLanguages: string[];
}

/**
 * The requestable language tags of some tracks, de-duplicated and in order.
 *
 * `und` is dropped: it cannot be expressed as a request, so preselecting it
 * would show a tick the server then ignores.
 */
function requestableTags(tracks: readonly { language: string }[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    const tag = toLanguageTag(track.language);
    if (tag === UNKNOWN_LANGUAGE || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** Bitrate is kbps, as every provider reports it. */
function estimateBytes(bitrate: number | undefined, duration: number | undefined): number | undefined {
  if (!bitrate || !duration || bitrate <= 0 || duration <= 0) return undefined;
  return Math.round((bitrate * 1000 * duration) / 8);
}

/** The row for one format, shared by the resolution and its codec variants. */
function describe(format: VideoFormat, duration: number | undefined) {
  const estimated = format.approxBytes ?? estimateBytes(format.bitrate, duration);
  return {
    formatId: format.id,
    ...(format.codec !== undefined ? { codec: format.codec } : {}),
    codecFamily: videoCodecFamily(format.codec),
    ...(format.fps !== undefined ? { fps: format.fps } : {}),
    ...(estimated !== undefined ? { approxBytes: estimated } : {}),
    ...(format.approxBytes === undefined && estimated !== undefined ? { bytesEstimated: true } : {}),
  };
}

function resolutionOptions(
  formats: readonly VideoFormat[],
  duration: number | undefined,
  videoCodec: VideoCodecPreference,
): ResolutionOption[] {
  const heights = new Set<number>();
  for (const format of formats) {
    if (typeof format.height === "number" && format.height > 0) heights.add(format.height);
  }

  const order = codecOrder(videoCodec);
  const rank = (family: string) => {
    const index = order.indexOf(family as (typeof order)[number]);
    return index === -1 ? order.length : index;
  };

  const options: ResolutionOption[] = [];
  for (const height of [...heights].sort((a, b) => b - a)) {
    // One variant per codec family, each described by its best stream — the one
    // the selector would take if that codec were the one asked for.
    const byFamily = new Map<string, VideoFormat>();
    for (const format of formats) {
      if (format.height !== height) continue;
      const family = videoCodecFamily(format.codec);
      const best = byFamily.get(family);
      if (!best || (format.bitrate ?? 0) > (best.bitrate ?? 0)) byFamily.set(family, format);
    }
    if (byFamily.size === 0) continue;

    const variants: CodecVariant[] = [...byFamily.entries()]
      .sort(([a, fa], [b, fb]) => rank(a) - rank(b) || (fb.bitrate ?? 0) - (fa.bitrate ?? 0))
      .map(([, format]) => describe(format, duration));

    // The ceiling rule, asked of the real selector once per choice. With a named
    // codec it can answer with a *lower* height, and that answer is the file.
    const byCodec = Object.fromEntries(
      VIDEO_CODEC_PREFERENCES.map((preference) => {
        const actual = selectVideoFormat(formats, height, preference)!;
        const wanted = requestedCodec(preference);
        return [
          preference,
          {
            ...describe(actual, duration),
            height: actual.height ?? null,
            exact:
              actual.height === height &&
              (wanted === undefined || videoCodecFamily(actual.codec) === wanted),
          },
        ];
      }),
    ) as Record<VideoCodecPreference, CodecOutcome>;

    // The row's own line describes the preselection — what the preferences this
    // probe carried would take at this height.
    const { height: _h, exact: _e, ...lead } = byCodec[videoCodec] ?? byCodec.auto;
    options.push({ height, ...lead, variants, byCodec });
  }
  return options;
}

/**
 * Each codec choice, measured against this video.
 *
 * `auto` and `efficient` are always available — they are orders, and an order
 * always lands somewhere. A named codec can be missing entirely, and saying so
 * *in the list of choices* is cheaper than letting someone pick it and find out
 * from the caveat afterwards.
 */
function codecOptions(
  formats: readonly VideoFormat[],
  preferences: Preferences,
): CodecOption[] {
  const overallMax = formats.reduce<number | null>(
    (best, format) =>
      typeof format.height === "number" && (best === null || format.height > best) ? format.height : best,
    null,
  );

  return VIDEO_CODEC_PREFERENCES.map((value): CodecOption => {
    const named = (VIDEO_CODECS as readonly string[]).includes(value) ? (value as VideoCodec) : undefined;
    if (!named) {
      return { value, available: true, maxHeight: overallMax, formatCount: formats.length, caveat: null };
    }

    const formatCount = formats.filter((format) => videoCodecFamily(format.codec) === named).length;
    // ⚠️ Measured at the video's own ceiling, not at the one currently chosen:
    // "H.264 stops at 1080p here" is a fact about the video, and it must not
    // appear and vanish as the resolution radio moves.
    const notice = videoCodecNotice(formats, {
      maxResolution: overallMax ?? preferences.maxResolution,
      videoCodec: named,
    });

    return {
      value,
      available: formatCount > 0,
      maxHeight: codecMaxHeight(formats, named),
      formatCount,
      caveat: notice?.message ?? null,
    };
  });
}

function audioOptions(tracks: readonly AudioTrack[]): AudioOption[] {
  const groups = new Map<string, AudioOption>();

  for (const track of tracks) {
    const tag = toLanguageTag(track.language);
    // Unlabelled tracks are grouped by what the provider said instead, so two
    // different unknown languages do not merge into one row.
    const key = tag === UNKNOWN_LANGUAGE ? `und:${track.language}` : tag;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        tag,
        language: track.language,
        variants: [track.language],
        isOriginal: track.isOriginal,
        ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
        ...(track.codec !== undefined ? { codec: track.codec } : {}),
        ...(track.approxBytes !== undefined ? { approxBytes: track.approxBytes } : {}),
        trackCount: 1,
        selectable: tag !== UNKNOWN_LANGUAGE,
      });
      continue;
    }

    existing.trackCount += 1;
    existing.isOriginal ||= track.isOriginal;
    if (!existing.variants.includes(track.language)) existing.variants.push(track.language);
    // The group is described by its best stream, because that is the one
    // `selectAudioTracks` would take for this language.
    if ((track.bitrate ?? 0) > (existing.bitrate ?? 0)) {
      if (track.bitrate !== undefined) existing.bitrate = track.bitrate;
      if (track.codec !== undefined) existing.codec = track.codec;
      if (track.approxBytes !== undefined) existing.approxBytes = track.approxBytes;
    }
  }

  // Original first — it is the default and the one people look for — then by
  // tag, so the order does not shuffle between probes of the same video.
  return [...groups.values()].sort((a, b) => {
    if (a.isOriginal !== b.isOriginal) return a.isOriginal ? -1 : 1;
    return a.tag.localeCompare(b.tag) || a.language.localeCompare(b.language);
  });
}

function subtitleOptions(subtitles: readonly SubtitleTrack[]): SubtitleOption[] {
  const groups = new Map<string, SubtitleOption>();

  for (const track of subtitles) {
    const tag = toLanguageTag(track.language);
    const key = tag === UNKNOWN_LANGUAGE ? `und:${track.language}` : tag;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        tag,
        language: track.language,
        hasManual: !track.automatic,
        hasAutomatic: track.automatic,
        selectable: tag !== UNKNOWN_LANGUAGE,
      });
      continue;
    }
    existing.hasManual ||= !track.automatic;
    existing.hasAutomatic ||= track.automatic;
  }

  // Authored subtitles first: a language that only has machine captions is a
  // different offer, and the list should not bury the good ones under 80
  // auto-translated variants.
  return [...groups.values()].sort((a, b) => {
    if (a.hasManual !== b.hasManual) return a.hasManual ? -1 : 1;
    return a.tag.localeCompare(b.tag) || a.language.localeCompare(b.language);
  });
}

/**
 * ⚠️ Takes the caller's preferences because the *preselection* depends on them:
 * which codec variant is marked `preferred`, and which format each resolution
 * row describes. The list of choices itself does not — it is the video.
 */
export function mediaOptions(info: MediaInfo, preferences: Preferences = DEFAULT_PREFERENCES): MediaOptions {
  return {
    resolutions: resolutionOptions(info.videoFormats, info.duration, preferences.videoCodec),
    codecs: codecOptions(info.videoFormats, preferences),
    audio: audioOptions(info.audioTracks),
    subtitles: subtitleOptions(info.subtitles),
    formatsWithoutHeight: info.videoFormats.filter((format) => typeof format.height !== "number").length,
  };
}

/**
 * The starting point: what `buildDownloadPlan` would decide for this media.
 *
 * ⚠️ Audio and subtitles are two separate calls with two separate preference
 * lists (R7). Deriving one from the other here would put HomeTube's coupling
 * back in through the front door, one layer up from where it was removed.
 */
export function suggestFor(info: MediaInfo, preferences: Preferences): Suggestion {
  const video = selectVideoFormat(info.videoFormats, preferences.maxResolution, preferences.videoCodec);

  return {
    originalOnly: preferences.originalOnly,
    maxResolution: video?.height ?? preferences.maxResolution,
    videoCodec: preferences.videoCodec ?? "auto",
    videoCodecFamily: videoCodecFamily(video?.codec),
    audioLanguages: requestableTags(selectAudioTracks(info.audioTracks, preferences)),
    subtitleLanguages: requestableTags(selectSubtitles(info.subtitles, preferences)),
  };
}
