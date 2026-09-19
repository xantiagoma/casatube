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
    expect(options.map((option) => option.resolution)).toEqual([720, 360]);
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
    expect(options.resolutions.map((option) => option.resolution)).toEqual([480]);
    expect(options.formatsWithoutHeight).toBe(1);
  });

  test("an audio-only source offers no resolutions and does not fail", () => {
    expect(mediaOptions(media()).resolutions).toEqual([]);
  });
});

describe("codecs", () => {
  // A YouTube-shaped video: 4K exists, but not in H.264.
  const info = media({
    duration: 100,
    videoFormats: [
      { id: "401", height: 2160, codec: "av01.0.12M.08", bitrate: 17_000 },
      { id: "313", height: 2160, codec: "vp09.00.50.08", bitrate: 20_000 },
      { id: "399", height: 1080, codec: "av01.0.08M.08", bitrate: 2_200 },
      { id: "137", height: 1080, codec: "avc1.640028", bitrate: 4_400 },
    ],
  });

  test("🔴 one resolution, several codecs, and the sizes that differ", () => {
    const hd = mediaOptions(info).resolutions.find((option) => option.resolution === 1080)!;

    // The thing a single row per height could not show: 1080p is two offers.
    expect(hd.variants.map((variant) => variant.codecFamily)).toEqual(["h264", "av1"]);
    const [h264, av1] = hd.variants;
    expect(h264!.formatId).toBe("137");
    expect(av1!.formatId).toBe("399");
    expect(av1!.approxBytes).toBeLessThan(h264!.approxBytes!);
    // Preselected by `auto`, which is H.264 — and the row's own line says so.
    expect(hd.formatId).toBe("137");
    expect(hd.byCodec.auto).toMatchObject({ formatId: "137", resolution: 1080, exact: true });
    expect(hd.byCodec.av1).toMatchObject({ formatId: "399", resolution: 1080, exact: true });
  });

  test("the preselection follows videoCodec", () => {
    const hd = mediaOptions(info, prefs({ videoCodec: "efficient" })).resolutions.find(
      (option) => option.resolution === 1080,
    )!;
    expect(hd.formatId).toBe("399");
    expect(hd.codecFamily).toBe("av1");
  });

  test("every choice is measured against this video, with its cost in words", () => {
    const codecs = mediaOptions(info).codecs;
    const by = (value: string) => codecs.find((codec) => codec.value === value)!;

    expect(codecs.map((codec) => codec.value)).toEqual(["auto", "efficient", "h264", "vp9", "hevc", "av1"]);
    expect(by("auto").caveat).toBeNull();
    expect(by("efficient").caveat).toBeNull();
    expect(by("av1")).toMatchObject({ available: true, maxHeight: 2160, caveat: null });

    // 🔴 The one that matters: H.264 is offered, and what it costs is written
    // next to it before anyone picks it.
    expect(by("h264")).toMatchObject({ available: true, maxHeight: 1080 });
    expect(by("h264").caveat).toContain("1080p");
    expect(by("h264").caveat).toContain("2160p");

    // Not there at all, and said so rather than left to be discovered.
    expect(by("hevc")).toMatchObject({ available: false, maxHeight: null, formatCount: 0 });
    expect(by("hevc").caveat).toContain("no HEVC");
  });

  test("🔴 a resolution the named codec cannot reach is flagged, never removed", () => {
    const resolutions = mediaOptions(info, prefs({ videoCodec: "h264" })).resolutions;

    // 2160p is still on the list: the resolution exists, the *combination* does
    // not, and dropping the row would hide the choice instead of explaining it.
    expect(resolutions.map((option) => option.resolution)).toEqual([2160, 1080]);
    const uhd = resolutions[0]!;
    expect(uhd.variants.map((variant) => variant.codecFamily)).toEqual(["vp9", "av1"]);

    // 🔴 Picking 2160p with H.264 is answered, not silently reinterpreted: what
    // arrives is 1080p H.264, and `exact: false` is the flag that says so.
    expect(uhd.byCodec.h264).toMatchObject({
      resolution: 1080,
      formatId: "137",
      codecFamily: "h264",
      exact: false,
    });
    // The same row, asked with no codec opinion, is exactly 2160p.
    expect(uhd.byCodec.auto).toMatchObject({ resolution: 2160, exact: true });
    // And a codec the video does not carry at all: the stand-in is named.
    expect(uhd.byCodec.hevc).toMatchObject({ resolution: 2160, codecFamily: "vp9", exact: false });

    const hd = resolutions[1]!;
    expect(hd.byCodec.h264).toMatchObject({ resolution: 1080, formatId: "137", exact: true });
    expect(hd.formatId).toBe("137");
  });

  test("every choice is answered at every height, so moving the radio needs no second probe", () => {
    // ⚠️ One probe per URL (PLAN §4.3): the codec radio cannot cost a network
    // call, so the answers for all six choices ship with the first one.
    for (const row of mediaOptions(info).resolutions) {
      expect(Object.keys(row.byCodec).sort()).toEqual(
        ["auto", "av1", "efficient", "h264", "hevc", "vp9"],
      );
    }
  });

  test("the caveat is a fact about the video, so lowering the ceiling does not hide it", () => {
    const codecs = mediaOptions(info, prefs({ maxResolution: 720 })).codecs;
    expect(codecs.find((codec) => codec.value === "h264")!.caveat).toContain("1080p");
  });

  test("an audio-only source offers the choices and no video to spend them on", () => {
    const codecs = mediaOptions(media()).codecs;
    expect(codecs).toHaveLength(6);
    expect(codecs.every((codec) => codec.caveat === null)).toBe(true);
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

  test("carries the codec preference through, and what it lands on", () => {
    const suggestion = suggestFor(info, prefs());
    expect(suggestion.videoCodec).toBe("auto");
    expect(suggestFor(info, prefs({ videoCodec: "av1" })).videoCodec).toBe("av1");
    // The fixture's formats carry no codec at all, so the honest answer is that.
    expect(suggestion.videoCodecFamily).toBe("unknown");
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
