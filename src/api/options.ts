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
  selectAudioTracks,
  selectSubtitles,
  selectVideoFormat,
  toLanguageTag,
  UNKNOWN_LANGUAGE,
  videoCodecFamily,
} from "../core/selection";
import type { AudioTrack, MediaInfo, Preferences, SubtitleTrack, VideoFormat } from "../core/types";

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

function resolutionOptions(formats: readonly VideoFormat[], duration: number | undefined): ResolutionOption[] {
  const heights = new Set<number>();
  for (const format of formats) {
    if (typeof format.height === "number" && format.height > 0) heights.add(format.height);
  }

  const options: ResolutionOption[] = [];
  for (const height of [...heights].sort((a, b) => b - a)) {
    // Asking the real selector with this height as the ceiling, rather than
    // sorting by hand: the row then describes the format that would actually be
    // downloaded, codec preference and all.
    const chosen = selectVideoFormat(formats, height);
    if (!chosen || chosen.height !== height) continue;
    const estimated = chosen.approxBytes ?? estimateBytes(chosen.bitrate, duration);
    options.push({
      height,
      formatId: chosen.id,
      ...(chosen.codec !== undefined ? { codec: chosen.codec } : {}),
      codecFamily: videoCodecFamily(chosen.codec),
      ...(chosen.fps !== undefined ? { fps: chosen.fps } : {}),
      ...(estimated !== undefined ? { approxBytes: estimated } : {}),
      ...(chosen.approxBytes === undefined && estimated !== undefined ? { bytesEstimated: true } : {}),
    });
  }
  return options;
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

export function mediaOptions(info: MediaInfo): MediaOptions {
  return {
    resolutions: resolutionOptions(info.videoFormats, info.duration),
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
  const video = selectVideoFormat(info.videoFormats, preferences.maxResolution);

  return {
    originalOnly: preferences.originalOnly,
    maxResolution: video?.height ?? preferences.maxResolution,
    audioLanguages: requestableTags(selectAudioTracks(info.audioTracks, preferences)),
    subtitleLanguages: requestableTags(selectSubtitles(info.subtitles, preferences)),
  };
}
