/**
 * Sidecar subtitles, as a browser will accept them.
 *
 * The download writes whatever the source offered — YouTube hands out WebVTT,
 * plenty of other sites hand out SubRip — and a `<track>` element takes **only**
 * WebVTT. So a `.srt` beside a video is a subtitle nobody can watch until it is
 * converted, which is why this file exists.
 *
 * 🔴 Text in, text out, and nothing else. No filesystem, no ffmpeg, no
 * streaming: a subtitle for a two-hour film is a few hundred kilobytes, so the
 * whole thing fits in memory comfortably, and a pure function is one that can
 * be tested against the shapes real files actually have.
 */

/** What a browser will load in a `<track>`. */
export const VTT_MEDIA_TYPE = "text/vtt; charset=utf-8";

/**
 * Formats that can be served, and how.
 *
 * ⚠️ `ass` and `ssa` are **not** here, and leaving them out is the honest
 * answer rather than an omission. They carry positioning, fonts and drawing
 * commands that WebVTT has no way to express, so a converted one is not the
 * subtitle that was downloaded — it is a worse subtitle wearing its name. They
 * stay downloadable; they are not offered as a track.
 */
export const SERVABLE_SUBTITLE_FORMATS: ReadonlySet<string> = new Set(["vtt", "srt"]);

/** ⚠️ Exactly a SubRip timestamp. A comma inside dialogue must not be touched. */
const SRT_TIMESTAMP = /(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g;

/**
 * SubRip → WebVTT.
 *
 * The differences that matter are small and all of them are load-bearing:
 *
 * 1. **`WEBVTT` on the first line.** Without it the browser rejects the file
 *    outright, and the failure is silent — no track, no error, no console line.
 * 2. **`,` → `.` in timestamps**, and *only* in timestamps. A subtitle that
 *    says "well, no" would otherwise become "well. no".
 * 3. **CRLF → LF**, because a stray `\r` at the end of a timestamp line makes
 *    the cue unparseable.
 * 4. **The BOM goes.** A file starting `﻿WEBVTT` is not a file starting
 *    `WEBVTT`, and the check is exact.
 *
 * A file that already says `WEBVTT` is returned with its line endings and BOM
 * cleaned and nothing else changed — a `.srt` extension on a VTT file is common
 * enough to be worth surviving.
 */
export function srtToVtt(source: string): string {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (text.trimStart().startsWith("WEBVTT")) return text;
  return `WEBVTT\n\n${text.replace(SRT_TIMESTAMP, "$1.$2").trimStart()}`;
}

/**
 * A language tag a `<track srclang>` will take, from a sidecar's filename part.
 *
 * ⚠️ Returns `undefined` rather than a guess. `srclang` is what a browser uses
 * to decide which track to show when the viewer has a language preference, and
 * a wrong tag there is worse than none: it offers Spanish subtitles to someone
 * who asked for Spanish and shows them Japanese.
 */
export function subtitleLanguageTag(language: string | null | undefined): string | undefined {
  if (!language) return undefined;
  const trimmed = language.trim();
  // BCP-47 as far as a browser cares: letters, then optional -subtags.
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(trimmed) ? trimmed : undefined;
}
