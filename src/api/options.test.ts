/**
 * The options a probe turns into — the data behind "show me what exists".
 *
 * These are pure functions over a `MediaInfo`, so the tests are the shapes
 * themselves: a 720p video must not be offered 4K, the original audio track has
 * to be identifiable, and authored subtitles have to be distinguishable from
 * machine-generated ones. Each of those is a thing the old form could not say.
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_PREFERENCES, type MediaInfo, type Preferences } from "../core/types";
import { mediaOptions, suggestFor } from "./options";

function media(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    externalId: "abc",
    title: "A talk",
    source: "test",
    videoFormats: [],
    audioTracks: [],
    subtitles: [],
    ...overrides,
  };
}

const prefs = (overrides: Partial<Preferences> = {}): Preferences => ({ ...DEFAULT_PREFERENCES, ...overrides });

describe("resolutions", () => {
  test("only the heights the video actually has, best first", () => {
    const options = mediaOptions(
      media({
        videoFormats: [
          { id: "a", height: 720, codec: "avc1.4d401f", approxBytes: 100 },
          { id: "b", height: 360, codec: "avc1.42001e" },
          { id: "c", height: 720, codec: "av01.0.08M.08" },
        ],
      }),
    ).resolutions;

    // 🔴 The complaint that started this: no 4K on a 720p video.
    expect(options.map((option) => option.height)).toEqual([720, 360]);
    // At equal height, the codec the selector prefers — H.264 over AV1.
    expect(options[0]?.formatId).toBe("a");
    expect(options[0]?.codecFamily).toBe("h264");
    expect(options[0]?.approxBytes).toBe(100);
  });

  test("a size the provider withheld is estimated, and says that it was", () => {
    // YouTube reports a bitrate for every format and a size for almost none, so
    // without this the size column would be empty exactly where it is wanted.
    const options = mediaOptions(
      media({ duration: 100, videoFormats: [{ id: "a", height: 720, bitrate: 800 }] }),
    ).resolutions;
    expect(options[0]?.approxBytes).toBe(10_000_000);
    expect(options[0]?.bytesEstimated).toBe(true);
  });

  test("a reported size is used as reported", () => {
    const options = mediaOptions(
      media({ duration: 100, videoFormats: [{ id: "a", height: 720, bitrate: 800, approxBytes: 123 }] }),
    ).resolutions;
    expect(options[0]?.approxBytes).toBe(123);
    expect(options[0]?.bytesEstimated).toBeUndefined();
  });

  test("no duration means no invented number", () => {
    const options = mediaOptions(media({ videoFormats: [{ id: "a", height: 720, bitrate: 800 }] })).resolutions;
    expect(options[0]?.approxBytes).toBeUndefined();
  });

  test("formats with no reported height are counted, not silently dropped", () => {
    const options = mediaOptions(
      media({ videoFormats: [{ id: "a", height: 480 }, { id: "b" }] }),
    );
    expect(options.resolutions.map((option) => option.height)).toEqual([480]);
    expect(options.formatsWithoutHeight).toBe(1);
  });

  test("an audio-only source offers no resolutions and does not fail", () => {
    expect(mediaOptions(media()).resolutions).toEqual([]);
  });
});

describe("audio", () => {
  test("one row per language, with the original marked", () => {
    const options = mediaOptions(
      media({
        audioTracks: [
          { id: "1", language: "es-419", isOriginal: false, bitrate: 128 },
          { id: "2", language: "en-US", isOriginal: true, bitrate: 128, codec: "opus" },
          { id: "3", language: "en", isOriginal: false, bitrate: 256, codec: "mp4a" },
        ],
      }),
    ).audio;

    // Two tags out of three tracks: `en-US` and `en` are one language.
    expect(options.map((option) => option.tag)).toEqual(["eng", "spa"]);
    const english = options[0]!;
    // 🔴 The point of the row: "original only" now names something visible.
    expect(english.isOriginal).toBe(true);
    expect(english.trackCount).toBe(2);
    expect(english.variants).toEqual(["en-US", "en"]);
    // Described by its best stream, which is the one that would be taken.
    expect(english.bitrate).toBe(256);
    expect(english.codec).toBe("mp4a");
  });

  test("an unlabelled track is shown but cannot be requested", () => {
    const options = mediaOptions(
      media({ audioTracks: [{ id: "1", language: "", isOriginal: true }] }),
    ).audio;
    expect(options).toHaveLength(1);
    expect(options[0]?.tag).toBe("und");
    expect(options[0]?.selectable).toBe(false);
  });

  test("two unknown languages stay two rows", () => {
    const options = mediaOptions(
      media({
        audioTracks: [
          { id: "1", language: "klingon", isOriginal: false },
          { id: "2", language: "elvish", isOriginal: false },
        ],
      }),
    ).audio;
    expect(options).toHaveLength(2);
  });
});

describe("subtitles", () => {
  test("authored and automatic are told apart, authored first", () => {
    const options = mediaOptions(
      media({
        subtitles: [
          { id: "auto-fr", language: "fr", automatic: true },
          { id: "en", language: "en", automatic: false },
          { id: "auto-en", language: "en", automatic: true },
        ],
      }),
    ).subtitles;

    expect(options.map((option) => option.tag)).toEqual(["eng", "fre"]);
    expect(options[0]).toMatchObject({ tag: "eng", hasManual: true, hasAutomatic: true });
    expect(options[1]).toMatchObject({ tag: "fre", hasManual: false, hasAutomatic: true });
  });
});

describe("the suggestion", () => {
  const info = media({
    videoFormats: [
      { id: "4k", height: 2160 },
      { id: "hd", height: 1080 },
      { id: "sd", height: 480 },
    ],
    audioTracks: [
      { id: "1", language: "en", isOriginal: true },
      { id: "2", language: "es", isOriginal: false },
    ],
    subtitles: [
      { id: "s-en", language: "en", automatic: false },
      { id: "s-es", language: "es", automatic: true },
    ],
  });

  test("starts at the best resolution under the ceiling, not at the ceiling", () => {
    expect(suggestFor(info, prefs({ maxResolution: 1080 })).maxResolution).toBe(1080);
    expect(suggestFor(info, prefs({ maxResolution: 720 })).maxResolution).toBe(480);
  });

  test("preselects the original audio track", () => {
    expect(suggestFor(info, prefs()).audioLanguages).toEqual(["eng"]);
  });

  test("🔴 R7: subtitles are suggested independently of the audio", () => {
    const suggestion = suggestFor(
      info,
      prefs({ originalOnly: true, audioLanguages: [], subtitleLanguages: ["es"] }),
    );
    expect(suggestion.audioLanguages).toEqual(["eng"]);
    // Spanish subtitles with English audio — the case HomeTube cannot express.
    expect(suggestion.subtitleLanguages).toEqual(["spa"]);
  });

  test("asks for nothing that is not there", () => {
    const suggestion = suggestFor(info, prefs({ subtitleLanguages: ["de"] }));
    expect(suggestion.subtitleLanguages).toEqual([]);
  });

  test("a ceiling below every format still answers with a number", () => {
    // `selectVideoFormat` finds nothing; the form has to show *something*, and
    // the honest something is the ceiling the user asked for.
    expect(suggestFor(info, prefs({ maxResolution: 144 })).maxResolution).toBe(144);
  });
});
