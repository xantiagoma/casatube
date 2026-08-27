/**
 * The tests that stand between us and HomeTube's three bugs.
 *
 * The fixture is a realistic YouTube video: ~20 AI-dubbed audio tracks in one
 * group, exactly one of them marked original. That shape is the one that broke
 * HomeTube, so it is the one the tests are written against.
 */
import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  buildDownloadPlan,
  buildLanguageTags,
  cleanTitle,
  codecMaxHeight,
  codecOrder,
  EFFICIENT_CODEC_PREFERENCE,
  FALLBACK_OUTPUT_NAME,
  selectAudioTracks,
  selectSubtitles,
  selectVideoFormat,
  toLanguageTag,
  toOutputName,
  UNKNOWN_LANGUAGE,
  videoCodecFamily,
  videoCodecNotice,
  VIDEO_CODEC_PREFERENCE,
} from "./selection";
import { DEFAULT_PREFERENCES } from "./types";
import type {
  AudioTrack,
  MediaInfo,
  Preferences,
  SubtitleTrack,
  VideoFormat,
} from "./types";

// --- Fixture ----------------------------------------------------------------

const VIDEO_FORMATS: VideoFormat[] = [
  { id: "401", height: 2160, width: 3840, fps: 30, codec: "av01.0.12M.08", bitrate: 17_000 },
  { id: "313", height: 2160, width: 3840, fps: 30, codec: "vp09.00.50.08", bitrate: 20_000 },
  { id: "399", height: 1080, width: 1920, fps: 30, codec: "av01.0.08M.08", bitrate: 2_200 },
  { id: "248", height: 1080, width: 1920, fps: 30, codec: "vp09.00.40.08", bitrate: 2_800 },
  { id: "137", height: 1080, width: 1920, fps: 30, codec: "avc1.640028", bitrate: 4_400 },
  { id: "398", height: 720, width: 1280, fps: 30, codec: "av01.0.05M.08", bitrate: 1_100 },
  { id: "247", height: 720, width: 1280, fps: 30, codec: "vp09.00.31.08", bitrate: 1_400 },
  { id: "136", height: 720, width: 1280, fps: 30, codec: "avc1.4d401f", bitrate: 2_300 },
  { id: "135", height: 480, width: 854, fps: 30, codec: "avc1.4d401e", bitrate: 1_100 },
  { id: "160", height: 144, width: 256, fps: 15, codec: "avc1.4d400c", bitrate: 110 },
];

/** The original, plus the twenty dubs YouTube attaches to a video like this. */
const DUBBED_LANGUAGES = [
  "es-US", "es-419", "pt-BR", "hi", "id", "fr-FR", "de-DE", "it-IT", "ja",
  "ko", "pl", "ru", "th", "tr", "vi", "nl", "sv", "uk", "ar", "bn",
];

const AUDIO_TRACKS: AudioTrack[] = [
  { id: "140-0", language: "en-US", isOriginal: true, bitrate: 129, codec: "mp4a.40.2" },
  ...DUBBED_LANGUAGES.map((language, index) => ({
    id: `140-${index + 1}`,
    language,
    isOriginal: false,
    bitrate: 128,
    codec: "mp4a.40.2",
  })),
];

const SUBTITLES: SubtitleTrack[] = [
  { id: "sub-en", language: "en", automatic: false, format: "vtt" },
  { id: "sub-en-auto", language: "en", automatic: true, format: "vtt" },
  { id: "sub-es", language: "es-419", automatic: false, format: "vtt" },
  { id: "sub-ja", language: "ja", automatic: false, format: "vtt" },
  { id: "sub-de-auto", language: "de", automatic: true, format: "vtt" },
];

const INFO: MediaInfo = {
  externalId: "dQw4w9WgXcQ",
  title: "How the Panama Canal Works",
  duration: 913,
  uploader: "Practical Engineering",
  source: "youtube",
  videoFormats: VIDEO_FORMATS,
  audioTracks: AUDIO_TRACKS,
  subtitles: SUBTITLES,
};

const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function prefs(overrides: Partial<Preferences> = {}): Preferences {
  return { ...DEFAULT_PREFERENCES, ...overrides };
}

function tagsOf(tracks: ReadonlyArray<{ language: string }>): string[] {
  return tracks.map((t) => toLanguageTag(t.language));
}

// --- 🔴 Bug 1: language tags ------------------------------------------------

describe("toLanguageTag", () => {
  test("regional codes lose the region and keep the language", () => {
    expect(toLanguageTag("en-US")).toBe("eng");
    expect(toLanguageTag("es-US")).toBe("spa");
    expect(toLanguageTag("es-419")).toBe("spa");
    expect(toLanguageTag("pt-BR")).toBe("por");
    expect(toLanguageTag("zh-Hans")).toBe("chi");
    expect(toLanguageTag("en_GB")).toBe("eng");
  });

  test("uses the bibliographic code, which is what containers expect", () => {
    expect(toLanguageTag("de")).toBe("ger");
    expect(toLanguageTag("fr")).toBe("fre");
    expect(toLanguageTag("nl")).toBe("dut");
    expect(toLanguageTag("el")).toBe("gre");
    // Already three letters, but terminology rather than bibliographic.
    expect(toLanguageTag("deu")).toBe("ger");
    expect(toLanguageTag("fra")).toBe("fre");
    expect(toLanguageTag("zho")).toBe("chi");
  });

  test("three-letter tags the source already gave us pass through", () => {
    expect(toLanguageTag("eng")).toBe("eng");
    expect(toLanguageTag("spa")).toBe("spa");
    expect(toLanguageTag("und")).toBe("und");
  });

  test("yt-dlp's -orig suffix is a region-ish subtag, not a language", () => {
    expect(toLanguageTag("en-orig")).toBe("eng");
  });

  test("unknown is und, never a guess", () => {
    expect(toLanguageTag(undefined)).toBe(UNKNOWN_LANGUAGE);
    expect(toLanguageTag(null)).toBe(UNKNOWN_LANGUAGE);
    expect(toLanguageTag("")).toBe(UNKNOWN_LANGUAGE);
    expect(toLanguageTag("   ")).toBe(UNKNOWN_LANGUAGE);
    expect(toLanguageTag("qq")).toBe(UNKNOWN_LANGUAGE);
    expect(toLanguageTag("Klingon")).toBe(UNKNOWN_LANGUAGE);
  });

  test("por and pan are correct mappings — for Portuguese and Punjabi", () => {
    // 🔴 The two tags HomeTube wrote onto English and Spanish tracks. The table
    // is not the bug; putting these on the wrong tracks is.
    expect(toLanguageTag("pt")).toBe("por");
    expect(toLanguageTag("pa")).toBe("pan");
    expect(toLanguageTag("en")).not.toBe("por");
    expect(toLanguageTag("es")).not.toBe("pan");
  });

  test("case does not matter", () => {
    expect(toLanguageTag("EN-us")).toBe("eng");
    expect(toLanguageTag("PT-BR")).toBe("por");
  });
});

describe("buildLanguageTags", () => {
  test("maps every selected track id to its own language", () => {
    const audio = [AUDIO_TRACKS[0]!, AUDIO_TRACKS[1]!, AUDIO_TRACKS[3]!];
    const subtitles = [SUBTITLES[0]!, SUBTITLES[2]!];
    expect(buildLanguageTags(audio, subtitles)).toEqual({
      "140-0": "eng",
      "140-1": "spa",
      "140-3": "por",
      "sub-en": "eng",
      "sub-es": "spa",
    });
  });

  test("a track with an unknown language is tagged und, not skipped", () => {
    const audio: AudioTrack[] = [{ id: "a1", language: "", isOriginal: true }];
    expect(buildLanguageTags(audio, [])).toEqual({ a1: "und" });
  });

  test("covers exactly the selected tracks, not the whole source", () => {
    const plan = buildDownloadPlan(URL, INFO, prefs({ originalOnly: true }));
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;
    expect(Object.keys(plan.value.languageTags).sort()).toEqual(["140-0", "sub-en"]);
  });
});

// --- 🔴 Bug 3: the fallback that included everything ------------------------

describe("selectAudioTracks", () => {
  test("originalOnly keeps exactly one track: the original", () => {
    const audio = selectAudioTracks(AUDIO_TRACKS, prefs({ originalOnly: true }));
    expect(audio).toHaveLength(1);
    expect(audio[0]!.id).toBe("140-0");
    expect(audio[0]!.isOriginal).toBe(true);
    expect(toLanguageTag(audio[0]!.language)).toBe("eng");
  });

  test("originalOnly wins over a matching language list", () => {
    const audio = selectAudioTracks(
      AUDIO_TRACKS,
      prefs({ originalOnly: true, audioLanguages: ["es", "pt", "fr"] }),
    );
    expect(audio).toHaveLength(1);
    expect(audio[0]!.id).toBe("140-0");
  });

  test("originalOnly with nothing marked original falls to a single track", () => {
    const unmarked = AUDIO_TRACKS.map((t) => ({ ...t, isOriginal: false }));
    const audio = selectAudioTracks(unmarked, prefs({ originalOnly: true }));
    expect(audio).toHaveLength(1);
  });

  test("matching preferences are honoured, in the order asked", () => {
    const audio = selectAudioTracks(
      AUDIO_TRACKS,
      prefs({ originalOnly: false, audioLanguages: ["es", "en", "ja"] }),
    );
    expect(tagsOf(audio)).toEqual(["spa", "eng", "jpn"]);
  });

  test("one track per language even when the source has two Spanish dubs", () => {
    // es-US and es-419 both tag as spa; two identically-labelled tracks in the
    // container is a worse outcome than dropping one.
    const audio = selectAudioTracks(
      AUDIO_TRACKS,
      prefs({ originalOnly: false, audioLanguages: ["es"] }),
    );
    expect(audio).toHaveLength(1);
    expect(toLanguageTag(audio[0]!.language)).toBe("spa");
  });

  test("🔴 no match falls back to the original — NOT to every language", () => {
    // Catalan and Basque: the source has neither.
    const audio = selectAudioTracks(
      AUDIO_TRACKS,
      prefs({ originalOnly: false, audioLanguages: ["ca", "eu"] }),
    );

    expect(audio).toHaveLength(1);
    expect(audio[0]!.id).toBe("140-0");
    expect(audio[0]!.isOriginal).toBe(true);

    // The explicit assertion this module exists for: nothing unasked-for got in.
    const tags = tagsOf(audio);
    expect(tags).toEqual(["eng"]);
    expect(tags).not.toContain("por"); // Portuguese — HomeTube shipped this
    expect(tags).not.toContain("pan"); // Punjabi — and this
    for (const language of DUBBED_LANGUAGES) {
      expect(tags).not.toContain(toLanguageTag(language));
    }
    expect(audio.length).toBeLessThan(AUDIO_TRACKS.length);
  });

  test("🔴 no match and no original still yields exactly one track", () => {
    const unmarked = AUDIO_TRACKS.map((t) => ({ ...t, isOriginal: false }));
    const audio = selectAudioTracks(
      unmarked,
      prefs({ originalOnly: false, audioLanguages: ["ca"] }),
    );
    expect(audio).toHaveLength(1);
    expect(audio[0]!.bitrate).toBe(129); // the best one available
  });

  test("an empty language list is no preference, not a request for all", () => {
    const audio = selectAudioTracks(
      AUDIO_TRACKS,
      prefs({ originalOnly: false, audioLanguages: [] }),
    );
    expect(audio).toHaveLength(1);
    expect(audio[0]!.isOriginal).toBe(true);
  });

  test("unrecognised preference codes do not become a match for anything", () => {
    const audio = selectAudioTracks(
      AUDIO_TRACKS,
      prefs({ originalOnly: false, audioLanguages: ["qq", "Klingon"] }),
    );
    expect(audio).toHaveLength(1);
    expect(audio[0]!.isOriginal).toBe(true);
  });

  test("a source with no audio at all yields no audio, not an invented track", () => {
    expect(selectAudioTracks([], prefs({ originalOnly: true }))).toEqual([]);
  });

  test("among same-language tracks the original beats the fatter dub", () => {
    const tracks: AudioTrack[] = [
      { id: "dub", language: "en", isOriginal: false, bitrate: 256 },
      { id: "orig", language: "en-US", isOriginal: true, bitrate: 128 },
    ];
    const audio = selectAudioTracks(tracks, prefs({ originalOnly: false, audioLanguages: ["en"] }));
    expect(audio.map((t) => t.id)).toEqual(["orig"]);
  });
});

// --- 🔴 Bug 2 / R7: audio and subtitles are independent ---------------------

describe("selectSubtitles", () => {
  test("subtitles follow subtitleLanguages, in the order asked", () => {
    const subtitles = selectSubtitles(SUBTITLES, prefs({ subtitleLanguages: ["es", "en"] }));
    expect(subtitles.map((s) => s.id)).toEqual(["sub-es", "sub-en"]);
  });

  test("authored subtitles beat automatic ones for the same language", () => {
    const subtitles = selectSubtitles(SUBTITLES, prefs({ subtitleLanguages: ["en"] }));
    expect(subtitles.map((s) => s.id)).toEqual(["sub-en"]);
    expect(subtitles[0]!.automatic).toBe(false);
  });

  test("a language that only has automatic captions still gets them", () => {
    const subtitles = selectSubtitles(SUBTITLES, prefs({ subtitleLanguages: ["de"] }));
    expect(subtitles.map((s) => s.id)).toEqual(["sub-de-auto"]);
  });

  test("🔴 no match means no subtitles — never every language in the source", () => {
    const subtitles = selectSubtitles(SUBTITLES, prefs({ subtitleLanguages: ["ca", "pt"] }));
    expect(subtitles).toEqual([]);
  });

  test("an empty list means no subtitles", () => {
    expect(selectSubtitles(SUBTITLES, prefs({ subtitleLanguages: [] }))).toEqual([]);
  });

  test("R7: original audio only, subtitles in English and Spanish", () => {
    const plan = buildDownloadPlan(
      URL,
      INFO,
      prefs({ originalOnly: true, subtitleLanguages: ["en", "es"] }),
    );
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;

    expect(plan.value.audio).toHaveLength(1);
    expect(plan.value.audio[0]!.isOriginal).toBe(true);
    expect(tagsOf(plan.value.subtitles)).toEqual(["eng", "spa"]);
  });

  test("R7, the other way: several audio languages and no subtitles at all", () => {
    const plan = buildDownloadPlan(
      URL,
      INFO,
      prefs({ originalOnly: false, audioLanguages: ["es", "ja"], subtitleLanguages: [] }),
    );
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;

    expect(tagsOf(plan.value.audio)).toEqual(["spa", "jpn"]);
    expect(plan.value.subtitles).toEqual([]);
  });

  test("R7: subtitle languages never leak into the audio selection", () => {
    const plan = buildDownloadPlan(
      URL,
      INFO,
      prefs({ originalOnly: true, subtitleLanguages: ["pt", "ja", "de"] }),
    );
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;

    expect(tagsOf(plan.value.audio)).toEqual(["eng"]);
    expect(tagsOf(plan.value.subtitles)).toEqual(["jpn", "ger"]);
  });
});

// --- Video format -----------------------------------------------------------

describe("videoCodecFamily", () => {
  test("recognises what providers actually report", () => {
    expect(videoCodecFamily("avc1.640028")).toBe("h264");
    expect(videoCodecFamily("h264")).toBe("h264");
    expect(videoCodecFamily("vp09.00.40.08")).toBe("vp9");
    expect(videoCodecFamily("vp9")).toBe("vp9");
    expect(videoCodecFamily("av01.0.08M.08")).toBe("av1");
    expect(videoCodecFamily("hev1.1.6.L120.90")).toBe("hevc");
    expect(videoCodecFamily(undefined)).toBe("unknown");
    expect(videoCodecFamily("theora")).toBe("unknown");
  });

  test("H.264 is preferred over AV1", () => {
    expect(VIDEO_CODEC_PREFERENCE.indexOf("h264"))
      .toBeLessThan(VIDEO_CODEC_PREFERENCE.indexOf("av1"));
  });
});

describe("selectVideoFormat", () => {
  test("maxResolution is a ceiling, and the best below it wins", () => {
    expect(selectVideoFormat(VIDEO_FORMATS, 1080)!.height).toBe(1080);
    expect(selectVideoFormat(VIDEO_FORMATS, 720)!.height).toBe(720);
    expect(selectVideoFormat(VIDEO_FORMATS, 2160)!.height).toBe(2160);
  });

  test("a ceiling between two rungs picks the rung below it", () => {
    expect(selectVideoFormat(VIDEO_FORMATS, 900)!.height).toBe(720);
  });

  test("🎯 at equal resolution H.264 beats AV1, even though AV1 is smaller", () => {
    // The whole point: this file lands on a media server, and AV1 forces a
    // transcode on hardware that has no decoder for it.
    expect(selectVideoFormat(VIDEO_FORMATS, 1080)!.id).toBe("137"); // avc1
    expect(selectVideoFormat(VIDEO_FORMATS, 720)!.id).toBe("136"); // avc1
  });

  test("falls to the next codec when H.264 does not reach that resolution", () => {
    // YouTube tops out at 1080p for avc1: 4K is vp9 or av1 only.
    const chosen = selectVideoFormat(VIDEO_FORMATS, 2160)!;
    expect(chosen.id).toBe("313");
    expect(videoCodecFamily(chosen.codec)).toBe("vp9");
  });

  test("higher fps breaks a tie between identical formats", () => {
    const formats: VideoFormat[] = [
      { id: "a", height: 1080, codec: "avc1.640028", fps: 30, bitrate: 4000 },
      { id: "b", height: 1080, codec: "avc1.640028", fps: 60, bitrate: 4000 },
    ];
    expect(selectVideoFormat(formats, 1080)!.id).toBe("b");
  });

  test("nothing fits under the ceiling", () => {
    expect(selectVideoFormat(VIDEO_FORMATS, 100)).toBeUndefined();
  });

  test("formats without a reported height are a last resort, not a first choice", () => {
    const formats: VideoFormat[] = [
      { id: "unknown-height", codec: "avc1.640028" },
      { id: "480p", height: 480, codec: "av01.0.05M.08" },
    ];
    expect(selectVideoFormat(formats, 1080)!.id).toBe("480p");
    expect(selectVideoFormat(formats, 240)!.id).toBe("unknown-height");
  });
});

// --- 🔴 The codec, chosen rather than imposed --------------------------------
//
// The trade-off is real and the answer depends on where the file is watched:
// AV1 is smaller and transcodes on a server with no GPU; H.264 direct-plays.
// So the old hard-coded order stays as `auto`, and the other two shapes exist.

describe("codecOrder", () => {
  test("auto is the historical order, H.264 first", () => {
    expect(codecOrder("auto")).toEqual(VIDEO_CODEC_PREFERENCE);
  });

  test("efficient turns it around: AV1 and VP9 first, H.264 last", () => {
    expect(codecOrder("efficient")).toEqual(EFFICIENT_CODEC_PREFERENCE);
    expect(codecOrder("efficient")[0]).toBe("av1");
    expect(codecOrder("efficient").at(-1)).toBe("h264");
  });

  test("a named codec leads, and the rest keep the default order behind it", () => {
    expect(codecOrder("hevc")).toEqual(["hevc", "h264", "vp9", "av1"]);
  });

  test("⚠️ a job stored before this field existed reads as auto, not as a crash", () => {
    // `preferences` is a JSON column. An old row simply has no `videoCodec`.
    expect(codecOrder(undefined)).toEqual(VIDEO_CODEC_PREFERENCE);
  });
});

describe("selectVideoFormat with a codec preference", () => {
  test("auto is exactly what the function did before: H.264 at 1080p", () => {
    expect(selectVideoFormat(VIDEO_FORMATS, 1080, "auto")!.id).toBe("137");
    expect(selectVideoFormat(VIDEO_FORMATS, 1080)!.id).toBe("137");
  });

  test("efficient takes AV1 at the same resolution — smaller, and it may transcode", () => {
    const chosen = selectVideoFormat(VIDEO_FORMATS, 1080, "efficient")!;
    expect(chosen.id).toBe("399");
    expect(videoCodecFamily(chosen.codec)).toBe("av1");
    // Same pixels, less than half the bitrate. That is the whole trade.
    expect(chosen.bitrate).toBeLessThan(selectVideoFormat(VIDEO_FORMATS, 1080, "auto")!.bitrate!);
  });

  test("a named codec is honoured at every rung it reaches", () => {
    expect(selectVideoFormat(VIDEO_FORMATS, 1080, "vp9")!.id).toBe("248");
    expect(selectVideoFormat(VIDEO_FORMATS, 720, "av1")!.id).toBe("398");
    expect(selectVideoFormat(VIDEO_FORMATS, 2160, "av1")!.id).toBe("401");
  });

  test("the codec never buys quality: height still comes first", () => {
    // `efficient` prefers AV1, but not enough to give up 1080p for 720p AV1.
    expect(selectVideoFormat(VIDEO_FORMATS, 1080, "efficient")!.height).toBe(1080);
  });

  test("🎯 H.264 at 4K: the resolution gives way, not the codec", () => {
    // YouTube's AVC1 stops at 1080p. Someone who names H.264 wants a file that
    // direct-plays; handing them 4K AV1 answers a question they did not ask.
    const chosen = selectVideoFormat(VIDEO_FORMATS, 2160, "h264")!;
    expect(videoCodecFamily(chosen.codec)).toBe("h264");
    expect(chosen.height).toBe(1080);
    expect(chosen.id).toBe("137");
  });

  test("a codec the media does not have at all falls back rather than failing", () => {
    // A job must not die over a preference — but see the notice below: this is
    // the one case that is reported as a substitution.
    const chosen = selectVideoFormat(VIDEO_FORMATS, 2160, "hevc")!;
    expect(chosen.height).toBe(2160);
    expect(videoCodecFamily(chosen.codec)).toBe("vp9");
  });

  test("the ceiling still excludes everything when it is below every format", () => {
    expect(selectVideoFormat(VIDEO_FORMATS, 100, "h264")).toBeUndefined();
    expect(selectVideoFormat(VIDEO_FORMATS, 100, "efficient")).toBeUndefined();
  });
});

describe("codecMaxHeight", () => {
  test("how high each codec reaches in this video", () => {
    expect(codecMaxHeight(VIDEO_FORMATS, "h264")).toBe(1080);
    expect(codecMaxHeight(VIDEO_FORMATS, "av1")).toBe(2160);
    expect(codecMaxHeight(VIDEO_FORMATS, "hevc")).toBeNull();
  });
});

// --- 🔴 Saying it, instead of substituting in silence ------------------------

describe("videoCodecNotice", () => {
  test("🎯 “H.264 at 4K” is answered out loud, not with another codec", () => {
    const notice = videoCodecNotice(VIDEO_FORMATS, { maxResolution: 2160, videoCodec: "h264" })!;
    expect(notice).not.toBeNull();
    expect(notice.kind).toBe("resolution-capped");
    expect(notice.requested).toBe("h264");
    expect(notice.requestedHeight).toBe(2160);
    expect(notice.resolvedHeight).toBe(1080);
    expect(notice.resolvedCodec).toBe("h264");
    // The sentence the form shows: what is missing, and what arrives instead.
    expect(notice.message).toContain("H.264");
    expect(notice.message).toContain("1080p");
    expect(notice.message).toContain("2160p");
    expect(notice.message).toContain("AV1");
    expect(notice.message).toContain("VP9");
  });

  test("the codec is missing entirely: the substitution is named", () => {
    const notice = videoCodecNotice(VIDEO_FORMATS, { maxResolution: 2160, videoCodec: "hevc" })!;
    expect(notice.kind).toBe("codec-unavailable");
    expect(notice.resolvedCodec).toBe("vp9");
    expect(notice.resolvedHeight).toBe(2160);
    expect(notice.message).toContain("no HEVC");
    expect(notice.message).toContain("VP9");
  });

  test("nothing to confess when the codec is there at the chosen ceiling", () => {
    expect(videoCodecNotice(VIDEO_FORMATS, { maxResolution: 1080, videoCodec: "h264" })).toBeNull();
    expect(videoCodecNotice(VIDEO_FORMATS, { maxResolution: 720, videoCodec: "h264" })).toBeNull();
    expect(videoCodecNotice(VIDEO_FORMATS, { maxResolution: 2160, videoCodec: "av1" })).toBeNull();
  });

  test("auto and efficient never warn — they are orders, so they cannot be denied", () => {
    expect(videoCodecNotice(VIDEO_FORMATS, { maxResolution: 2160, videoCodec: "auto" })).toBeNull();
    expect(videoCodecNotice(VIDEO_FORMATS, { maxResolution: 2160, videoCodec: "efficient" })).toBeNull();
  });

  test("a ceiling below every format is FormatUnavailable's story, not the codec's", () => {
    expect(videoCodecNotice(VIDEO_FORMATS, { maxResolution: 100, videoCodec: "h264" })).toBeNull();
  });

  test("an audio-only source has no codec complaint", () => {
    expect(videoCodecNotice([], { maxResolution: 1080, videoCodec: "h264" })).toBeNull();
  });
});

// --- Output name ------------------------------------------------------------

describe("cleanTitle", () => {
  test("strips channel marks", () => {
    expect(cleanTitle("【full】How the Panama Canal Works")).toBe("How the Panama Canal Works");
    expect(cleanTitle("How the Panama Canal Works【4K】")).toBe("How the Panama Canal Works");
    expect(cleanTitle("【公式】【MV】Song Title")).toBe("Song Title");
  });

  test("strips emoji, including sequences and flags", () => {
    expect(cleanTitle("🔥 INSANE build 🔥")).toBe("INSANE build");
    expect(cleanTitle("Family 👨‍👩‍👧 vlog")).toBe("Family vlog");
    expect(cleanTitle("Trip to 🇯🇵 Japan")).toBe("Trip to Japan");
    expect(cleanTitle("Ranking every phone 📱1️⃣")).toBe("Ranking every phone 1");
  });

  test("keeps 「」and『』— the real title is usually inside them", () => {
    expect(cleanTitle("【公式】「夜に駆ける」Music Video")).toBe("「夜に駆ける」Music Video");
    expect(cleanTitle("『鬼滅の刃』第一話")).toBe("『鬼滅の刃』第一話");
  });

  test("does not eat digits — \\p{Emoji} would have", () => {
    expect(cleanTitle("Top 10 gadgets of 2026 #3 is wild")).toBe("Top 10 gadgets of 2026 #3 is wild");
  });

  test("collapses the whitespace and separators left behind", () => {
    expect(cleanTitle("Episode 12 — 【sub】")).toBe("Episode 12");
    expect(cleanTitle("  Spaced    out  ")).toBe("Spaced out");
    expect(cleanTitle("| Leading pipe")).toBe("Leading pipe");
  });

  test("an all-emoji title cleans down to nothing", () => {
    expect(cleanTitle("🔥🔥🔥")).toBe("");
  });
});

describe("toOutputName", () => {
  test("a normal title survives intact", () => {
    expect(toOutputName("How the Panama Canal Works")).toBe("How the Panama Canal Works");
  });

  test("path separators cannot escape into the name", () => {
    expect(toOutputName("AC/DC live at Donington")).toBe("AC-DC live at Donington");
    expect(toOutputName("../../etc/passwd")).not.toContain("/");
    expect(toOutputName("C:\\Users\\santi")).not.toContain("\\");
  });

  test("Windows reserved names are defused — the naive version leaves them", () => {
    expect(toOutputName("CON")).not.toBe("CON");
    expect(toOutputName("NUL")).not.toBe("NUL");
    expect(toOutputName("AUX")).not.toBe("AUX");
  });

  test("no trailing dots or spaces — Windows and SMB drop them silently", () => {
    expect(toOutputName("Episode 1...")).not.toMatch(/[. ]$/);
    expect(toOutputName("Trailing space ")).toBe("Trailing space");
  });

  test("length is capped", () => {
    const long = "a".repeat(400);
    expect(toOutputName(long).length).toBeLessThanOrEqual(100);
  });

  test("cleaning happens before the filename rules", () => {
    expect(toOutputName("【full】Ocean 🌊 Documentary")).toBe("Ocean Documentary");
  });

  test("falls back to the provider id when the title cleans to nothing", () => {
    expect(toOutputName("🔥🔥🔥", "dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(toOutputName("", "dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  test("falls back to a literal when there is nothing at all", () => {
    expect(toOutputName("", "")).toBe(FALLBACK_OUTPUT_NAME);
    expect(toOutputName("   ")).toBe(FALLBACK_OUTPUT_NAME);
  });

  test("never returns an empty string", () => {
    for (const title of ["", "   ", "...", "🔥", "///", "【x】"]) {
      expect(toOutputName(title).length).toBeGreaterThan(0);
    }
  });
});

// --- The plan ---------------------------------------------------------------

describe("buildDownloadPlan", () => {
  test("the default preferences on a realistic video", () => {
    const plan = buildDownloadPlan(URL, INFO, DEFAULT_PREFERENCES);
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;

    expect(plan.value.url).toBe(URL);
    expect(plan.value.video?.id).toBe("137"); // 1080p H.264
    expect(plan.value.audio).toHaveLength(1); // originalOnly
    expect(plan.value.subtitles.map((s) => s.id)).toEqual(["sub-en"]);
    expect(plan.value.languageTags).toEqual({ "140-0": "eng", "sub-en": "eng" });
    expect(plan.value.sponsorblock).toBe(true);
    expect(plan.value.outputName).toBe("How the Panama Canal Works");
  });

  test("sponsorblock is carried through, not decided here", () => {
    const plan = buildDownloadPlan(URL, INFO, prefs({ sponsorblock: false }));
    expect(Result.isOk(plan) && plan.value.sponsorblock).toBe(false);
  });

  test("maxResolution is respected", () => {
    const plan = buildDownloadPlan(URL, INFO, prefs({ maxResolution: 480 }));
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;
    expect(plan.value.video?.height).toBe(480);
  });

  test("a ceiling below every format is FormatUnavailable, not a silent upgrade", () => {
    const plan = buildDownloadPlan(URL, INFO, prefs({ maxResolution: 100 }));
    expect(Result.isError(plan)).toBe(true);
    if (!Result.isError(plan)) return;
    expect(plan.error._tag).toBe("FormatUnavailable");
    expect(plan.error.url).toBe(URL);
    expect(plan.error.wanted).toContain("100p");
  });

  test("a source with no video formats is an audio-only plan, not a failure", () => {
    const audioOnly: MediaInfo = { ...INFO, videoFormats: [] };
    const plan = buildDownloadPlan(URL, audioOnly, DEFAULT_PREFERENCES);
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;
    expect(plan.value.video).toBeNull();
    expect(plan.value.audio).toHaveLength(1);
  });

  test("🔴 the full HomeTube scenario: 21 tracks, no preference matches", () => {
    const plan = buildDownloadPlan(
      URL,
      INFO,
      prefs({
        originalOnly: false,
        audioLanguages: ["ca", "eu", "gl"],
        subtitleLanguages: ["ca"],
      }),
    );
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;

    // One audio track, no subtitles, and no invented languages anywhere.
    expect(plan.value.audio).toHaveLength(1);
    expect(plan.value.subtitles).toEqual([]);
    expect(Object.values(plan.value.languageTags)).toEqual(["eng"]);
    expect(Object.values(plan.value.languageTags)).not.toContain("por");
    expect(Object.values(plan.value.languageTags)).not.toContain("pan");
  });

  test("the codec preference reaches the plan", () => {
    const efficient = buildDownloadPlan(URL, INFO, prefs({ videoCodec: "efficient" }));
    expect(Result.isOk(efficient) && efficient.value.video?.id).toBe("399"); // 1080p AV1

    const named = buildDownloadPlan(URL, INFO, prefs({ videoCodec: "vp9" }));
    expect(Result.isOk(named) && named.value.video?.id).toBe("248"); // 1080p VP9
  });

  test("🎯 H.264 with a 4K ceiling plans 1080p H.264, and the notice explains why", () => {
    const preferences = prefs({ maxResolution: 2160, videoCodec: "h264" });
    const plan = buildDownloadPlan(URL, INFO, preferences);
    expect(Result.isOk(plan)).toBe(true);
    if (!Result.isOk(plan)) return;
    expect(plan.value.video?.id).toBe("137");
    expect(videoCodecFamily(plan.value.video?.codec)).toBe("h264");
    // The plan is not allowed to be the only record of that decision.
    expect(videoCodecNotice(INFO.videoFormats, preferences)?.kind).toBe("resolution-capped");
  });

  test("the default is unchanged: auto, which is H.264 first", () => {
    expect(DEFAULT_PREFERENCES.videoCodec).toBe("auto");
    const plan = buildDownloadPlan(URL, INFO, DEFAULT_PREFERENCES);
    expect(Result.isOk(plan) && plan.value.video?.id).toBe("137");
  });

  test("the plan is pure: the same input gives the same plan", () => {
    const a = buildDownloadPlan(URL, INFO, DEFAULT_PREFERENCES);
    const b = buildDownloadPlan(URL, INFO, DEFAULT_PREFERENCES);
    expect(Result.isOk(a)).toBe(true);
    expect(Result.isOk(b)).toBe(true);
    if (!Result.isOk(a) || !Result.isOk(b)) return;
    expect(a.value).toEqual(b.value);
  });

  test("the input is not mutated", () => {
    const snapshot = structuredClone(INFO);
    buildDownloadPlan(URL, INFO, prefs({ originalOnly: false, audioLanguages: ["es", "ja"] }));
    expect(INFO).toEqual(snapshot);
  });
});
