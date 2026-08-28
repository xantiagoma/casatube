/**
 * SubRip → WebVTT, against the shapes real files have.
 *
 * Every case here is one a browser refuses silently: no track appears, nothing
 * is logged, and the only symptom is a subtitle menu that is empty. That makes
 * these cheap to get wrong and expensive to notice, which is the argument for
 * testing a forty-line function this closely.
 */
import { describe, expect, test } from "bun:test";

import { srtToVtt, subtitleLanguageTag, SERVABLE_SUBTITLE_FORMATS } from "./subtitles";

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:04,000",
  "Hola, ¿qué tal?",
  "",
  "2",
  "00:01:02,500 --> 00:01:05,250",
  "Bien, gracias.",
  "",
].join("\n");

describe("srtToVtt", () => {
  test("🔴 puts WEBVTT first, or the browser rejects the file in silence", () => {
    expect(srtToVtt(SRT).startsWith("WEBVTT\n")).toBe(true);
  });

  test("🔴 the comma becomes a dot in timestamps and nowhere else", () => {
    // "Hola, ¿qué tal?" must survive. A subtitle that says "well, no" becoming
    // "well. no" is the kind of corruption nobody reports as a bug.
    const vtt = srtToVtt(SRT);
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.000");
    expect(vtt).toContain("00:01:02.500 --> 00:01:05.250");
    expect(vtt).toContain("Hola, ¿qué tal?");
    expect(vtt).toContain("Bien, gracias.");
  });

  test("🔴 CRLF is normalised, because a stray \\r breaks the cue", () => {
    const vtt = srtToVtt(SRT.replace(/\n/g, "\r\n"));
    expect(vtt).not.toContain("\r");
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.000");
  });

  test("🔴 a BOM is removed — the WEBVTT check is exact", () => {
    const vtt = srtToVtt(`﻿${SRT}`);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).not.toContain("﻿");
  });

  test("a file that is already WebVTT is not given a second header", () => {
    // A `.srt` extension on a VTT file is common enough to be worth surviving.
    const already = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhola\n";
    expect(srtToVtt(already)).toBe(already);
    expect(srtToVtt(`﻿${already}`)).toBe(already);
    expect([...srtToVtt(already).matchAll(/WEBVTT/g)]).toHaveLength(1);
  });

  test("single-digit hours and short milliseconds still convert", () => {
    const odd = "1\n0:00:01,50 --> 0:00:04,5\ntexto\n";
    const vtt = srtToVtt(odd);
    expect(vtt).toContain("0:00:01.50 --> 0:00:04.5");
  });

  test("cue numbers are kept — WebVTT reads them as identifiers", () => {
    expect(srtToVtt(SRT)).toContain("\n1\n");
  });
});

describe("subtitleLanguageTag", () => {
  test("🔴 refuses a tag it cannot vouch for, rather than guessing", () => {
    // `srclang` is what a browser matches against the viewer's preference. A
    // wrong tag offers Spanish and plays Japanese, which is worse than no tag.
    expect(subtitleLanguageTag("en")).toBe("en");
    expect(subtitleLanguageTag("es-419")).toBe("es-419");
    expect(subtitleLanguageTag("pt-BR")).toBe("pt-BR");
    expect(subtitleLanguageTag(null)).toBeUndefined();
    expect(subtitleLanguageTag("")).toBeUndefined();
    expect(subtitleLanguageTag("español")).toBeUndefined();
    expect(subtitleLanguageTag("2")).toBeUndefined();
  });
});

describe("SERVABLE_SUBTITLE_FORMATS", () => {
  test("🔴 ASS and SSA are deliberately absent", () => {
    // They carry positioning, fonts and drawing commands WebVTT cannot express,
    // so a converted one is a worse subtitle wearing the same name. They stay
    // downloadable; they are not offered as a track.
    expect([...SERVABLE_SUBTITLE_FORMATS].sort()).toEqual(["srt", "vtt"]);
  });
});
