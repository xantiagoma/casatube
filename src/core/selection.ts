/**
 * Selection: what to download, in provider-neutral terms.
 *
 * Every function here is **pure** — no network, no disk, no subprocess. Given a
 * `MediaInfo` and `Preferences`, it produces a `DownloadPlan`. That is what
 * makes it testable, and this is the one module that has to be right: it decides
 * what lands in the library.
 *
 * 🔴 This module exists to not reproduce HomeTube's three bugs (PLAN §4.1):
 *
 * 1. **Wrong language tags.** HomeTube writes `por` (Portuguese) and `pan`
 *    (Punjabi) onto tracks that are English and Spanish. Here the tag is derived
 *    from the track's own `language` and from nothing else. An unrecognised
 *    language becomes `und` — never a guess.
 * 2. **Audio and subtitles from one list.** They are two independent settings
 *    (R7). `selectAudioTracks` never looks at `subtitleLanguages`, and
 *    `selectSubtitles` never looks at `audioLanguages` or `originalOnly`.
 * 3. **"Nothing matched, so include everything."** That fallback is exactly how
 *    Portuguese and Punjabi got into the file: ~20 AI-dubbed tracks, none
 *    matching, all included. The fallback here is the track marked original —
 *    and if there is none, a single best track. Never all.
 */
import { Result } from "better-result";
import { FormatUnavailable } from "./errors";
import filenamify from "filenamify";
import type {
  AudioTrack,
  DownloadPlan,
  MediaInfo,
  Preferences,
  SubtitleTrack,
  VideoFormat,
} from "./types";

// --- Video codecs -----------------------------------------------------------

/**
 * Preferred video codecs, best first.
 *
 * At equal resolution, H.264 wins. The file ends up on a media server, and AV1
 * forces a transcode on any client without hardware support — which is most of
 * them, and every machine without a GPU. A smaller AV1 file that plays back at
 * 3 fps is not the better download.
 *
 * Anything not listed ranks last, behind everything known.
 */
export const VIDEO_CODEC_PREFERENCE = ["h264", "vp9", "hevc", "av1"] as const;

export type PreferredVideoCodec = (typeof VIDEO_CODEC_PREFERENCE)[number];

/** Codec strings arrive as `avc1.640028`, `vp09.00.40.08`, `av01.0.08M.08`… */
const CODEC_FAMILIES: ReadonlyArray<readonly [RegExp, PreferredVideoCodec]> = [
  [/^(?:avc[13]|h\.?264|x264)/i, "h264"],
  [/^vp0?9/i, "vp9"],
  [/^(?:hev1|hvc1|hevc|h\.?265|x265)/i, "hevc"],
  [/^av0?1/i, "av1"],
];

/** The codec family of a raw codec string, or `unknown` if unrecognised. */
export function videoCodecFamily(codec: string | undefined): PreferredVideoCodec | "unknown" {
  if (!codec) return "unknown";
  const trimmed = codec.trim();
  for (const [pattern, family] of CODEC_FAMILIES) {
    if (pattern.test(trimmed)) return family;
  }
  return "unknown";
}

function codecRank(codec: string | undefined): number {
  const family = videoCodecFamily(codec);
  const index = VIDEO_CODEC_PREFERENCE.indexOf(family as PreferredVideoCodec);
  return index === -1 ? VIDEO_CODEC_PREFERENCE.length : index;
}

// --- Language tags ----------------------------------------------------------

/** Returned when the language is missing or unrecognised. Never a guess. */
export const UNKNOWN_LANGUAGE = "und";

/**
 * ISO 639-1 → ISO 639-2/B. Bibliographic, because that is what Matroska and the
 * media servers reading it expect: `ger` not `deu`, `fre` not `fra`.
 *
 * 📌 Note `pt → por` and `pa → pan`. Both mappings are correct; HomeTube's bug
 * is not the table, it is applying tags to the wrong tracks.
 */
const ISO_639_1_TO_2B: Readonly<Record<string, string>> = {
  aa: "aar", ab: "abk", ae: "ave", af: "afr", ak: "aka", am: "amh", an: "arg",
  ar: "ara", as: "asm", av: "ava", ay: "aym", az: "aze", ba: "bak", be: "bel",
  bg: "bul", bh: "bih", bi: "bis", bm: "bam", bn: "ben", bo: "tib", br: "bre",
  bs: "bos", ca: "cat", ce: "che", ch: "cha", co: "cos", cr: "cre", cs: "cze",
  cu: "chu", cv: "chv", cy: "wel", da: "dan", de: "ger", dv: "div", dz: "dzo",
  ee: "ewe", el: "gre", en: "eng", eo: "epo", es: "spa", et: "est", eu: "baq",
  fa: "per", ff: "ful", fi: "fin", fj: "fij", fo: "fao", fr: "fre", fy: "fry",
  ga: "gle", gd: "gla", gl: "glg", gn: "grn", gu: "guj", gv: "glv", ha: "hau",
  he: "heb", hi: "hin", ho: "hmo", hr: "hrv", ht: "hat", hu: "hun", hy: "arm",
  hz: "her", ia: "ina", id: "ind", ie: "ile", ig: "ibo", ii: "iii", ik: "ipk",
  io: "ido", is: "ice", it: "ita", iu: "iku", ja: "jpn", jv: "jav", ka: "geo",
  kg: "kon", ki: "kik", kj: "kua", kk: "kaz", kl: "kal", km: "khm", kn: "kan",
  ko: "kor", kr: "kau", ks: "kas", ku: "kur", kv: "kom", kw: "cor", ky: "kir",
  la: "lat", lb: "ltz", lg: "lug", li: "lim", ln: "lin", lo: "lao", lt: "lit",
  lu: "lub", lv: "lav", mg: "mlg", mh: "mah", mi: "mao", mk: "mac", ml: "mal",
  mn: "mon", mr: "mar", ms: "may", mt: "mlt", my: "bur", na: "nau", nb: "nob",
  nd: "nde", ne: "nep", ng: "ndo", nl: "dut", nn: "nno", no: "nor", nr: "nbl",
  nv: "nav", ny: "nya", oc: "oci", oj: "oji", om: "orm", or: "ori", os: "oss",
  pa: "pan", pi: "pli", pl: "pol", ps: "pus", pt: "por", qu: "que", rm: "roh",
  rn: "run", ro: "rum", ru: "rus", rw: "kin", sa: "san", sc: "srd", sd: "snd",
  se: "sme", sg: "sag", si: "sin", sk: "slo", sl: "slv", sm: "smo", sn: "sna",
  so: "som", sq: "alb", sr: "srp", ss: "ssw", st: "sot", su: "sun", sv: "swe",
  sw: "swa", ta: "tam", te: "tel", tg: "tgk", th: "tha", ti: "tir", tk: "tuk",
  tl: "tgl", tn: "tsn", to: "ton", tr: "tur", ts: "tso", tt: "tat", tw: "twi",
  ty: "tah", ug: "uig", uk: "ukr", ur: "urd", uz: "uzb", ve: "ven", vi: "vie",
  vo: "vol", wa: "wln", wo: "wol", xh: "xho", yi: "yid", yo: "yor", za: "zha",
  zh: "chi", zu: "zul",
};

/** ISO 639-2/T → 639-2/B, for the twenty codes where the two differ. */
const ISO_639_2_T_TO_B: Readonly<Record<string, string>> = {
  bod: "tib", ces: "cze", cym: "wel", deu: "ger", ell: "gre", eus: "baq",
  fas: "per", fra: "fre", hye: "arm", isl: "ice", kat: "geo", mkd: "mac",
  mri: "mao", msa: "may", mya: "bur", nld: "dut", ron: "rum", slk: "slo",
  sqi: "alb", zho: "chi",
};

/**
 * A track's language, as the three-letter tag that goes into the container.
 *
 * 🔴 The whole point of this module. Input is whatever the provider gave us —
 * `en`, `en-US`, `es-419`, `pt-BR`, `zh-Hans`, `en-orig`, `eng`, `deu` — and the
 * output is ISO 639-2/B. Anything unrecognised is `und`, never a guess.
 *
 * The region is dropped: `es-419` and `es-US` are both `spa`. A container tag
 * has no room for it, and treating them as different languages would put two
 * "Spanish" tracks in the file.
 */
export function toLanguageTag(language: string | undefined | null): string {
  if (!language) return UNKNOWN_LANGUAGE;
  // `en-US`, `en_US`, `zh-Hans-CN`, and yt-dlp's `en-orig` all reduce to `en`.
  const primary = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (primary.length === 2) return ISO_639_1_TO_2B[primary] ?? UNKNOWN_LANGUAGE;
  if (/^[a-z]{3}$/.test(primary)) {
    // Already a three-letter tag: normalise T→B, otherwise pass it through.
    // Passing through is not guessing — it is what the provider stated.
    return ISO_639_2_T_TO_B[primary] ?? primary;
  }
  return UNKNOWN_LANGUAGE;
}

/** Preference codes as language tags, de-duplicated, order preserved. */
function wantedTags(languages: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const language of languages) {
    const tag = toLanguageTag(language);
    if (tag === UNKNOWN_LANGUAGE || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Track id → language tag, for the muxer.
 *
 * Explicit, per track, and passed on. The tag is never inferred downstream from
 * track order or format id — that inference is where HomeTube goes wrong.
 */
export function buildLanguageTags(
  audio: readonly AudioTrack[],
  subtitles: readonly SubtitleTrack[],
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const track of audio) tags[track.id] = toLanguageTag(track.language);
  for (const track of subtitles) tags[track.id] = toLanguageTag(track.language);
  return tags;
}

// --- Picking ----------------------------------------------------------------

function pickBest<T>(items: readonly T[], compare: (a: T, b: T) => number): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (best === undefined || compare(item, best) < 0) best = item;
  }
  return best;
}

/** Lower is better. */
function compareVideo(a: VideoFormat, b: VideoFormat): number {
  const heightA = a.height ?? 0;
  const heightB = b.height ?? 0;
  if (heightA !== heightB) return heightB - heightA;
  const codecA = codecRank(a.codec);
  const codecB = codecRank(b.codec);
  if (codecA !== codecB) return codecA - codecB;
  const fpsA = a.fps ?? 0;
  const fpsB = b.fps ?? 0;
  if (fpsA !== fpsB) return fpsB - fpsA;
  const bitrateA = a.bitrate ?? 0;
  const bitrateB = b.bitrate ?? 0;
  if (bitrateA !== bitrateB) return bitrateB - bitrateA;
  return a.id.localeCompare(b.id);
}

/** Lower is better: the original track first, then the fattest. */
function compareAudio(a: AudioTrack, b: AudioTrack): number {
  if (a.isOriginal !== b.isOriginal) return a.isOriginal ? -1 : 1;
  const bitrateA = a.bitrate ?? 0;
  const bitrateB = b.bitrate ?? 0;
  if (bitrateA !== bitrateB) return bitrateB - bitrateA;
  return a.id.localeCompare(b.id);
}

/** Lower is better: authored subtitles before machine-generated ones. */
function compareSubtitle(a: SubtitleTrack, b: SubtitleTrack): number {
  if (a.automatic !== b.automatic) return a.automatic ? 1 : -1;
  return a.id.localeCompare(b.id);
}

// --- Video ------------------------------------------------------------------

/**
 * The best format at or below `maxResolution`.
 *
 * `maxResolution` is a ceiling, not a target. Formats whose height the provider
 * did not report are used only when nothing with a known height fits — we cannot
 * verify them against the ceiling, so they are the last resort rather than the
 * first choice.
 *
 * Returns `undefined` when there is no usable format: the caller decides whether
 * that is "audio-only source" or "your ceiling excluded everything".
 */
export function selectVideoFormat(
  formats: readonly VideoFormat[],
  maxResolution: number,
): VideoFormat | undefined {
  const withKnownHeight = formats.filter((f) => typeof f.height === "number");
  const withinCeiling = withKnownHeight.filter((f) => (f.height ?? 0) <= maxResolution);
  const pool = withinCeiling.length > 0
    ? withinCeiling
    : formats.filter((f) => typeof f.height !== "number");
  return pickBest(pool, compareVideo);
}

// --- Audio ------------------------------------------------------------------

/**
 * The safe fallback: the original track, or — failing that — one single track.
 *
 * 🔴 Never "all of them". A YouTube video routinely carries ~20 AI-dubbed audio
 * tracks; including them because none matched is how Portuguese and Punjabi
 * ended up in HomeTube's output.
 */
function fallbackAudio(tracks: readonly AudioTrack[]): AudioTrack[] {
  const best = pickBest(tracks, compareAudio);
  return best ? [best] : [];
}

/**
 * Which audio tracks to keep.
 *
 * ⚠️ Reads `originalOnly` and `audioLanguages` and nothing else. Subtitles are a
 * separate decision (R7) and this function must never learn about them.
 *
 * - `originalOnly` → exactly one track, whenever the source has any at all.
 * - Otherwise, one track per requested language, in the order requested, so the
 *   first preference becomes the default track in the container.
 * - Nothing matched → the fallback above. Never every language.
 * - No audio tracks at all → empty. A silent video is not a failure.
 */
export function selectAudioTracks(
  tracks: readonly AudioTrack[],
  preferences: Preferences,
): AudioTrack[] {
  if (tracks.length === 0) return [];
  if (preferences.originalOnly) return fallbackAudio(tracks);

  const wanted = wantedTags(preferences.audioLanguages);
  if (wanted.length === 0) return fallbackAudio(tracks);

  const selected: AudioTrack[] = [];
  for (const tag of wanted) {
    // One track per language: several tracks of the same language would give
    // the media server two identically-labelled options.
    const best = pickBest(
      tracks.filter((t) => toLanguageTag(t.language) === tag),
      compareAudio,
    );
    if (best) selected.push(best);
  }

  return selected.length > 0 ? selected : fallbackAudio(tracks);
}

// --- Subtitles --------------------------------------------------------------

/**
 * Which subtitle tracks to keep.
 *
 * ⚠️ Reads `subtitleLanguages` and nothing else — not `audioLanguages`, not
 * `originalOnly` (R7). "Original audio only, subtitles in English and Spanish"
 * has to be expressible, and it is exactly this independence that expresses it.
 *
 * Nothing matched → **none**. Subtitles are optional, so the honest answer to
 * "you asked for Spanish and there is no Spanish" is an empty list — not every
 * language in the source, and not a guess at what you meant.
 *
 * Authored subtitles beat machine-generated ones for the same language; a
 * language that only has automatic captions still gets them.
 */
export function selectSubtitles(
  subtitles: readonly SubtitleTrack[],
  preferences: Preferences,
): SubtitleTrack[] {
  const wanted = wantedTags(preferences.subtitleLanguages);
  const selected: SubtitleTrack[] = [];
  for (const tag of wanted) {
    const best = pickBest(
      subtitles.filter((s) => toLanguageTag(s.language) === tag),
      compareSubtitle,
    );
    if (best) selected.push(best);
  }
  return selected;
}

// --- Output name ------------------------------------------------------------

/** Used when a title cleans down to nothing and there is no id to fall back on. */
export const FALLBACK_OUTPUT_NAME = "untitled";

/**
 * Systems allow 255, `filenamify` defaults to 100, and we keep that: the name
 * still has to take an extension and, on collision, a suffix.
 * ⚠️ Counted in characters, not bytes — 100 CJK characters are 300 UTF-8 bytes.
 */
export const MAX_OUTPUT_NAME_LENGTH = 100;

/** Channel branding: `【full】`, `【4K】`, `【公式】`. */
const CHANNEL_MARK = /【[^】]*】/gu;

/**
 * Emoji, and only emoji.
 *
 * ⚠️ Deliberately `Extended_Pictographic` rather than `\p{Emoji}`: the latter
 * matches the ASCII digits, `#` and `*`, and would eat the `2026` out of
 * "Top 10 of 2026".
 *
 * `「」『』` are **not** touched — in Japanese and Chinese titles the real title
 * is usually inside them.
 */
const EMOJI =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D\u20E3]/gu;

/** Separators left dangling once a mark or an emoji is removed. */
const EDGE_SEPARATORS = /^[\s\-–—|/\\:;,·•~]+|[\s\-–—|/\\:;,·•~]+$/gu;

/**
 * A title with the noise taken out — still a title, not yet a filename.
 *
 * Removes channel marks and emoji, collapses the whitespace they leave behind,
 * and trims separators stranded at the edges. Everything else is left alone:
 * this is not the place to second-guess what the uploader called their video.
 */
export function cleanTitle(title: string): string {
  return title
    .normalize("NFC")
    .replace(CHANNEL_MARK, " ")
    .replace(EMOJI, " ")
    .replace(/\s+/gu, " ")
    .replace(EDGE_SEPARATORS, "")
    .trim();
}

/**
 * A safe filename stem — no extension.
 *
 * The cleaning above, then `filenamify`. Not hand-rolled: the naive version
 * leaves Windows reserved names (`CON`, `NUL`, `AUX`) intact, leaves trailing
 * dots and spaces that Windows and SMB silently drop, and ignores length. This
 * file ends up on a network share; those all matter.
 *
 * Falls back to `fallback` (the provider's id) when the title cleans down to
 * nothing — an all-emoji title does — and to `untitled` when even that is empty.
 */
export function toOutputName(title: string, fallback = ""): string {
  const cleaned = cleanTitle(title);
  const base = cleaned.length > 0 ? cleaned : cleanTitle(fallback);
  const safe = filenamify(base.length > 0 ? base : FALLBACK_OUTPUT_NAME, {
    replacement: "-",
    maxLength: MAX_OUTPUT_NAME_LENGTH,
  });
  return safe.length > 0 ? safe : FALLBACK_OUTPUT_NAME;
}

// --- The plan ---------------------------------------------------------------

/** The only way this can fail: the ceiling excluded every available format. */
export type SelectionError = FormatUnavailable;

/**
 * `MediaInfo` + `Preferences` → `DownloadPlan`. PLAN §10's `selectFormats`.
 *
 * The url is passed in rather than read from `MediaInfo`, which carries only the
 * provider's `externalId`; `DownloadPlan` needs the url the job was created with.
 *
 * Fails with `FormatUnavailable` when the source has video formats but every one
 * of them is above `maxResolution`. A source with *no* video formats is not a
 * failure — it is an audio-only download, and `video` is `null`.
 */
export function buildDownloadPlan(
  url: string,
  info: MediaInfo,
  preferences: Preferences,
): Result<DownloadPlan, SelectionError> {
  let video: VideoFormat | null = null;
  if (info.videoFormats.length > 0) {
    const chosen = selectVideoFormat(info.videoFormats, preferences.maxResolution);
    if (!chosen) {
      return Result.err(
        new FormatUnavailable({ url, wanted: `video at or below ${preferences.maxResolution}p` }),
      );
    }
    video = chosen;
  }

  // ⚠️ Two independent calls, two independent preference lists (R7).
  const audio = selectAudioTracks(info.audioTracks, preferences);
  const subtitles = selectSubtitles(info.subtitles, preferences);

  return Result.ok({
    url,
    video,
    audio,
    subtitles,
    languageTags: buildLanguageTags(audio, subtitles),
    sponsorblock: preferences.sponsorblock,
    subtitleMode: preferences.embedSubtitles ? "embed" : "sidecar",
    outputName: toOutputName(info.title, info.externalId),
  });
}
