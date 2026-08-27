/**
 * Tests for the yt-dlp provider.
 *
 * The process is injected everywhere except the last block, so the whole suite
 * runs with no network and no binary. The last block is the honesty check: it
 * runs the real `yt-dlp -J` against a real video, because a fake spawner can
 * only ever prove that we parse what we think yt-dlp prints.
 */
import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFetchArgs,
  buildFormatSelector,
  buildLanguageMetadataArgs,
  buildListArgs,
  buildProbeArgs,
  classifyError,
  createYtdlpProvider,
  parseDownloadLine,
  parseFilePathLine,
  parsePostProcessLine,
  isMediaFile,
  ProgressAccumulator,
  translateInfo,
  translateListing,
  type SpawnOutcome,
  type SpawnRequest,
  type Spawner,
} from "./ytdlp";
import type {
  AudioTrack,
  DownloadPlan,
  ProgressUpdate,
  ProviderContext,
  VideoFormat,
} from "../core/types";

// --- Fakes ------------------------------------------------------------------

interface FakeRun {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
}

function fakeSpawner(run: FakeRun): { spawn: Spawner; calls: SpawnRequest[] } {
  const calls: SpawnRequest[] = [];
  const spawn: Spawner = async (req): Promise<SpawnOutcome> => {
    calls.push(req);
    for (const line of run.stdout ?? []) req.onStdout(line);
    for (const line of run.stderr ?? []) req.onStderr(line);
    return { exitCode: run.exitCode ?? 0 };
  };
  return { spawn, calls };
}

function fakeContext(workDir: string): ProviderContext & { updates: ProgressUpdate[]; lines: string[] } {
  const updates: ProgressUpdate[] = [];
  const lines: string[] = [];
  return {
    workDir,
    signal: new AbortController().signal,
    onProgress: (p) => updates.push(p),
    log: (l) => lines.push(l),
    updates,
    lines,
  };
}

const videoFormat: VideoFormat = { id: "137", width: 1920, height: 1080, codec: "avc1" };
const englishAudio: AudioTrack = { id: "140-en", language: "en-US", isOriginal: true };
const spanishAudio: AudioTrack = { id: "140-es", language: "es-419", isOriginal: false };

function plan(overrides: Partial<DownloadPlan> = {}): DownloadPlan {
  return {
    url: "https://www.youtube.com/watch?v=abc",
    video: videoFormat,
    audio: [englishAudio],
    subtitles: [],
    languageTags: { "140-en": "eng" },
    sponsorblock: false,
    subtitleMode: "sidecar",
    outputName: "A Video",
    ...overrides,
  };
}

// A trimmed but faithful `yt-dlp -J`. Every field here was copied from the
// output of the real binary (2026.08.19) on a video with 22 dubbed tracks.
const probeJson = {
  id: "zRtGL0-5rg4",
  title: "Last To Leave Grocery Store, Wins $250,000",
  duration: 2577,
  thumbnail: "https://i.ytimg.com/vi/zRtGL0-5rg4/hq.jpg",
  uploader: "MrBeast",
  channel: "MrBeast",
  extractor: "youtube",
  extractor_key: "Youtube",
  formats: [
    // Storyboard: neither video nor audio, must not appear anywhere.
    { format_id: "sb3", ext: "mhtml", protocol: "mhtml", vcodec: "none", acodec: "none" },
    {
      format_id: "137",
      ext: "mp4",
      vcodec: "avc1.640028",
      acodec: "none",
      width: 1920,
      height: 1080,
      fps: 30,
      vbr: 4406.6,
      tbr: 4406.6,
      filesize: 123456789,
    },
    // Progressive: has both, so it belongs with the video formats only.
    {
      format_id: "18",
      ext: "mp4",
      vcodec: "avc1.42001E",
      acodec: "mp4a.40.2",
      width: 640,
      height: 360,
      tbr: 611.5,
      filesize_approx: 9999,
    },
    {
      format_id: "139-21",
      ext: "m4a",
      vcodec: "none",
      acodec: "mp4a.40.5",
      abr: 48.786,
      language: "en-US",
      language_preference: 10,
      format_note: "English (US) original (default), low",
    },
    {
      format_id: "139-16",
      ext: "m4a",
      vcodec: "none",
      acodec: "mp4a.40.5",
      abr: 48.785,
      language: "es-419",
      language_preference: -1,
      format_note: "Spanish (Latin America), low",
    },
  ],
  subtitles: { en: [{ ext: "json3" }, { ext: "vtt" }], "es-419": [{ ext: "vtt" }] },
  automatic_captions: { en: [{ ext: "vtt" }] },
};

// --- Progress: two pipes ----------------------------------------------------

describe("progress lines", () => {
  test("parses a real download line off stdout", () => {
    const parsed = parseDownloadLine(
      "CT-DL|downloading|64512|117526|NA|1824650.79|3|139|jNQXAC9IVRw.f139.m4a",
    );
    expect(parsed).toEqual({
      status: "downloading",
      key: "jNQXAC9IVRw.f139.m4a",
      doneBytes: 64512,
      totalBytes: 117526,
      speed: 1824650.79,
      eta: 3,
      filename: "jNQXAC9IVRw.f139.m4a",
    });
  });

  test("NA becomes undefined, and total falls back to the estimate", () => {
    const parsed = parseDownloadLine("CT-DL|downloading|1024|NA|500000|NA|NA|248|v.webm");
    expect(parsed?.totalBytes).toBe(500000);
    expect(parsed?.speed).toBeUndefined();
    expect(parsed?.eta).toBeUndefined();
  });

  test("a filename containing the separator survives, because it is last", () => {
    const parsed = parseDownloadLine("CT-DL|downloading|10|20|NA|NA|NA|140|we|ird.m4a");
    expect(parsed?.filename).toBe("we|ird.m4a");
    expect(parsed?.key).toBe("we|ird.m4a");
  });

  test("parses postprocess lines and ignores anything else", () => {
    expect(parsePostProcessLine("CT-PP|started|Merger")).toEqual({
      status: "started",
      postprocessor: "Merger",
    });
    expect(parsePostProcessLine("CT-DL|downloading|1|2|NA|NA|NA|1|a")).toBeNull();
    expect(parseDownloadLine("CT-PP|started|Merger")).toBeNull();
    expect(parseFilePathLine("CT-FILE|/tmp/x/A Video.mkv")).toBe("/tmp/x/A Video.mkv");
    expect(parseFilePathLine("[download] Destination: x")).toBeNull();
  });
});

describe("ProgressAccumulator", () => {
  test("sums across files instead of restarting at 0% on each one", () => {
    const acc = new ProgressAccumulator();
    const feed = (line: string) => acc.update(parseDownloadLine(line)!)!;

    // File 1: the video, 1000 bytes.
    feed("CT-DL|downloading|500|1000|NA|100|5|137|v.mp4");
    const afterVideo = feed("CT-DL|finished|1000|1000|NA|100|NA|137|v.mp4");
    expect(afterVideo.percent).toBe(100);

    // File 2: the first audio track. THE TRAP: yt-dlp restarts at 0 bytes here.
    const audioStart = feed("CT-DL|downloading|0|200|NA|100|2|140-en|a.m4a");
    expect(audioStart.doneBytes).toBe(1000);
    expect(audioStart.totalBytes).toBe(1200);
    // Not 0%. That is the whole point.
    expect(audioStart.percent).toBeCloseTo(83.33, 1);

    const audioDone = feed("CT-DL|finished|200|200|NA|100|NA|140-en|a.m4a");
    expect(audioDone.doneBytes).toBe(1200);
    expect(audioDone.percent).toBe(100);

    // File 3: a second language. Still no reset.
    const second = feed("CT-DL|downloading|0|200|NA|100|2|140-es|b.m4a");
    expect(second.percent).toBeCloseTo(85.71, 1);
    expect(acc.fileCount()).toBe(3);
  });

  test("never reports a decreasing byte count over a whole 3-file run", () => {
    const acc = new ProgressAccumulator();
    const lines = [
      "CT-DL|downloading|250|1000|NA|100|8|137|v.mp4",
      "CT-DL|downloading|750|1000|NA|100|3|137|v.mp4",
      "CT-DL|finished|1000|1000|NA|100|NA|137|v.mp4",
      "CT-DL|downloading|100|200|NA|100|1|140-en|a.m4a",
      "CT-DL|finished|200|200|NA|100|NA|140-en|a.m4a",
      "CT-DL|downloading|100|200|NA|100|1|140-es|b.m4a",
      "CT-DL|finished|200|200|NA|100|NA|140-es|b.m4a",
    ];
    let previous = -1;
    for (const line of lines) {
      const update = acc.update(parseDownloadLine(line)!)!;
      expect(update.doneBytes!).toBeGreaterThanOrEqual(previous);
      previous = update.doneBytes!;
    }
    expect(previous).toBe(1400);
  });

  test("eta is recomputed against everything left, not just this file", () => {
    const acc = new ProgressAccumulator();
    acc.update(parseDownloadLine("CT-DL|finished|1000|1000|NA|100|NA|137|v.mp4")!);
    // yt-dlp says eta=2 for this file; 200 bytes remain overall at 100 B/s.
    const update = acc.update(parseDownloadLine("CT-DL|downloading|0|200|NA|100|2|140-en|a.m4a")!)!;
    expect(update.eta).toBe(2);
    const slower = acc.update(parseDownloadLine("CT-DL|downloading|0|200|NA|10|2|140-en|a.m4a")!)!;
    expect(slower.eta).toBe(20);
  });

  test("the subtitle file yt-dlp downloads FIRST does not put the bar at 100%", () => {
    // Verified against the real binary: with --write-subs the .vtt arrives
    // before the video and reports format_id NA. Counting it would show a
    // finished download before a single video byte had moved.
    const acc = new ProgressAccumulator();
    expect(acc.update(parseDownloadLine("CT-DL|downloading|440|NA|NA|NA|NA|NA|/w/zoo.en.vtt")!)).toBeNull();
    expect(acc.update(parseDownloadLine("CT-DL|finished|440|440|NA|2075|NA|NA|/w/zoo.en.vtt")!)).toBeNull();
    expect(acc.fileCount()).toBe(0);

    const first = acc.update(parseDownloadLine("CT-DL|downloading|1024|195278|NA|900|0|160|/w/zoo.mp4")!)!;
    expect(first.percent).toBeCloseTo(0.52, 1);
    expect(first.totalBytes).toBe(195278);
  });

  test("isMediaFile keeps media and rejects sidecars", () => {
    expect(isMediaFile("/w/zoo.mp4")).toBe(true);
    expect(isMediaFile("/w/zoo.f139.m4a")).toBe(true);
    expect(isMediaFile(undefined)).toBe(true);
    expect(isMediaFile("/w/zoo.en.vtt")).toBe(false);
    expect(isMediaFile("/w/zoo.es-419.SRT")).toBe(false);
    // ⚠️ The thumbnail arrives first, like subtitles do. Counted in the byte
    // budget it would drive the bar to 100% before the video began.
    expect(isMediaFile("/w/zoo.jpg")).toBe(false);
    expect(isMediaFile("/w/zoo.webp")).toBe(false);
  });

  test("two files that share a format id are still counted separately", () => {
    // yt-dlp reports format_id NA for anything that is not a media format, so
    // the filename is what identifies a file.
    const acc = new ProgressAccumulator();
    acc.update(parseDownloadLine("CT-DL|finished|100|100|NA|10|NA|NA|/w/a.mp4")!);
    acc.update(parseDownloadLine("CT-DL|finished|300|300|NA|10|NA|NA|/w/b.mp4")!);
    expect(acc.fileCount()).toBe(2);
    expect(acc.snapshot()).toEqual({ doneBytes: 400, totalBytes: 400 });
  });
});

test("fetch reads BOTH pipes: download on stdout, postprocess on stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "casatube-"));
  try {
    const file = join(dir, "A Video.mkv");
    await writeFile(file, "x");
    const { spawn } = fakeSpawner({
      stdout: [
        "CT-DL|downloading|500|1000|NA|100|5|137|v.mp4",
        "CT-DL|finished|1000|1000|NA|100|NA|137|v.mp4",
        `CT-FILE|${file}`,
      ],
      // If this pipe were not read, the merge would look like a hang and the
      // job would sit at "downloading" until it timed out.
      stderr: ["CT-PP|started|Merger", "CT-PP|finished|Merger"],
    });
    const provider = createYtdlpProvider({ spawn, binary: "yt-dlp" });
    const ctx = fakeContext(dir);

    const result = await provider.fetch(plan(), ctx);

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value.file).toBe(file);
    expect(ctx.lines).toContain("postprocess Merger: started");
    expect(ctx.lines).toContain("postprocess Merger: finished");
    // Two download updates plus one per postprocess line.
    expect(ctx.updates.length).toBe(4);
    expect(ctx.updates.at(-1)?.percent).toBe(100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sidecar subtitle files are reported, other files are not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "casatube-"));
  try {
    const file = join(dir, "A Video.mkv");
    await writeFile(file, "x");
    await writeFile(join(dir, "A Video.en.vtt"), "x");
    await writeFile(join(dir, "A Video.es-419.srt"), "x");
    await writeFile(join(dir, "A Video.jpg"), "x");
    await writeFile(join(dir, "Another Video.en.vtt"), "x");
    const { spawn } = fakeSpawner({ stdout: [`CT-FILE|${file}`] });
    const provider = createYtdlpProvider({ spawn });

    const result = await provider.fetch(plan(), fakeContext(dir));

    expect(Result.isOk(result) && result.value.subtitleFiles).toEqual([
      join(dir, "A Video.en.vtt"),
      join(dir, "A Video.es-419.srt"),
    ]);
    // The image is a sidecar too, but not a subtitle: it travels in its own
    // field, because the worker gives it a different name at the far end.
    expect(Result.isOk(result) && result.value.thumbnailFile).toBe(join(dir, "A Video.jpg"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the thumbnail is found whatever format it arrived in, JPEG preferred", async () => {
  const dir = await mkdtemp(join(tmpdir(), "casatube-"));
  try {
    const file = join(dir, "A Video.mkv");
    await writeFile(file, "x");
    // What a machine without ffmpeg leaves behind: the original, unconverted.
    await writeFile(join(dir, "A Video.webp"), "x");
    const { spawn } = fakeSpawner({ stdout: [`CT-FILE|${file}`] });

    const onlyWebp = await createYtdlpProvider({ spawn }).fetch(plan(), fakeContext(dir));
    expect(Result.isOk(onlyWebp) && onlyWebp.value.thumbnailFile).toBe(join(dir, "A Video.webp"));

    await writeFile(join(dir, "A Video.jpg"), "x");
    const both = await createYtdlpProvider({ spawn: fakeSpawner({ stdout: [`CT-FILE|${file}`] }).spawn }).fetch(
      plan(),
      fakeContext(dir),
    );
    expect(Result.isOk(both) && both.value.thumbnailFile).toBe(join(dir, "A Video.jpg"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no thumbnail is not a failure — the video is what matters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "casatube-"));
  try {
    const file = join(dir, "A Video.mkv");
    await writeFile(file, "x");
    const { spawn } = fakeSpawner({ stdout: [`CT-FILE|${file}`] });

    const result = await createYtdlpProvider({ spawn }).fetch(plan(), fakeContext(dir));

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value.thumbnailFile).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exit 0 with a file that was never written is a failure, not a success", async () => {
  // Real behaviour: with formats to merge and no ffmpeg, yt-dlp exits 0, prints
  // only a warning, and names an output path it never created.
  const dir = await mkdtemp(join(tmpdir(), "casatube-"));
  try {
    const { spawn } = fakeSpawner({
      stdout: [`CT-FILE|${join(dir, "A Video.mkv")}`],
      stderr: ["WARNING: You have requested merging of multiple formats but ffmpeg is not installed. The formats won't be merged"],
      exitCode: 0,
    });
    const provider = createYtdlpProvider({ spawn });
    const ctx = fakeContext(dir);

    const result = await provider.fetch(plan(), ctx);

    expect(Result.isError(result)).toBe(true);
    expect(Result.isError(result) && result.error._tag).toBe("ProbeFailed");
    // The warning is not swallowed: --no-warnings is deliberately absent.
    expect(ctx.lines.some((l) => l.includes("ffmpeg is not installed"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Translation into the neutral vocabulary --------------------------------

describe("translateInfo", () => {
  const media = (() => {
    const result = translateInfo(probeJson, "https://www.youtube.com/watch?v=zRtGL0-5rg4");
    if (Result.isError(result)) throw new Error("fixture should translate");
    return result.value;
  })();

  test("carries the item's identity across", () => {
    expect(media.externalId).toBe("zRtGL0-5rg4");
    expect(media.title).toBe("Last To Leave Grocery Store, Wins $250,000");
    expect(media.duration).toBe(2577);
    expect(media.uploader).toBe("MrBeast");
    expect(media.source).toBe("youtube");
  });

  test("video formats: storyboards out, progressive in, bytes and codec kept", () => {
    expect(media.videoFormats.map((f) => f.id).sort()).toEqual(["137", "18"]);
    const hd = media.videoFormats.find((f) => f.id === "137")!;
    expect(hd).toEqual({
      id: "137",
      width: 1920,
      height: 1080,
      fps: 30,
      codec: "avc1.640028",
      bitrate: 4406.6,
      approxBytes: 123456789,
    });
    expect(media.videoFormats.find((f) => f.id === "18")?.approxBytes).toBe(9999);
  });

  test("audio tracks keep yt-dlp's language string exactly as given", () => {
    // ⚠️ Not normalised here. `es-419` must still be `es-419` when it reaches
    // selection.ts — narrowing it to `spa` in the provider throws the region
    // away before anyone can use it.
    expect(media.audioTracks.map((t) => t.language)).toEqual(["en-US", "es-419"]);
  });

  test("isOriginal comes from format_note, not from the language code", () => {
    const english = media.audioTracks.find((t) => t.id === "139-21")!;
    const spanish = media.audioTracks.find((t) => t.id === "139-16")!;
    expect(english.isOriginal).toBe(true);
    expect(spanish.isOriginal).toBe(false);
    expect(english.codec).toBe("mp4a.40.5");
    expect(english.bitrate).toBeCloseTo(48.786, 3);
  });

  test("the progressive format is not also offered as an audio track", () => {
    expect(media.audioTracks.map((t) => t.id)).not.toContain("18");
  });

  test("subtitles: manual and automatic are distinguishable and never collide", () => {
    const ids = media.subtitles.map((s) => s.id);
    expect(ids).toEqual(["subs:en", "subs:es-419", "auto:en"]);
    const manualEn = media.subtitles.find((s) => s.id === "subs:en")!;
    expect(manualEn.automatic).toBe(false);
    expect(manualEn.language).toBe("en");
    // json3 comes first in yt-dlp's list; vtt is the one worth asking for.
    expect(manualEn.format).toBe("vtt");
    expect(media.subtitles.find((s) => s.id === "auto:en")?.automatic).toBe(true);
  });

  test("a single-language video has its one soundtrack marked original", () => {
    // Nothing in format_note says "original" — YouTube only says it when there
    // is something to distinguish. With one language there is no other
    // candidate, so selection's `originalOnly` still has an answer.
    const result = translateInfo(
      {
        id: "jNQXAC9IVRw",
        title: "Me at the zoo",
        extractor: "youtube",
        formats: [
          { format_id: "139", vcodec: "none", acodec: "mp4a.40.5", abr: 49.14, format_note: "low" },
          { format_id: "251", vcodec: "none", acodec: "opus", abr: 106, format_note: "medium" },
        ],
      },
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    );
    const tracks = Result.isOk(result) ? result.value.audioTracks : [];
    expect(tracks.map((t) => t.isOriginal)).toEqual([true, true]);
    expect(tracks.map((t) => t.language)).toEqual(["und", "und"]);
  });

  test("several languages and no marker means nothing is original — never all", () => {
    const result = translateInfo(
      {
        id: "x",
        extractor: "generic",
        formats: [
          { format_id: "a", vcodec: "none", acodec: "opus", language: "pt" },
          { format_id: "b", vcodec: "none", acodec: "opus", language: "pa" },
        ],
      },
      "https://example.com/x",
    );
    const tracks = Result.isOk(result) ? result.value.audioTracks : [];
    expect(tracks.every((t) => !t.isOriginal)).toBe(true);
  });

  test("JSON with no id is a typed failure, not a half-built MediaInfo", () => {
    const result = translateInfo({ title: "nameless" }, "https://example.com/x");
    expect(Result.isError(result) && result.error._tag).toBe("ProbeFailed");
  });
});

describe("translateListing", () => {
  test("flattens a playlist into discovered items with ISO dates", () => {
    const items = translateListing({
      _type: "playlist",
      id: "PL123",
      entries: [
        {
          id: "Vh4O04Bpovw",
          url: "https://www.youtube.com/watch?v=Vh4O04Bpovw",
          title: "I Explored A $200,000,000 Forgotten Space Colony",
          timestamp: 1755000000,
        },
        { id: "abc", url: "https://www.youtube.com/watch?v=abc", title: "x", upload_date: "20260101" },
        // No url: cannot be queued, so it is not offered.
        { id: "nourl", title: "orphan" },
      ],
    });
    expect(items.map((i) => i.externalId)).toEqual(["Vh4O04Bpovw", "abc"]);
    expect(items[0]?.publishedAt).toBe(new Date(1755000000 * 1000).toISOString());
    expect(items[1]?.publishedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("a channel is a playlist of playlists, and still flattens", () => {
    const items = translateListing({
      _type: "playlist",
      id: "UCchannel",
      entries: [
        { _type: "playlist", id: "UCvideos", entries: [{ id: "v1", url: "u1", title: "t1" }] },
        { _type: "playlist", id: "UCshorts", entries: [{ id: "v2", url: "u2", title: "t2" }] },
      ],
    });
    expect(items.map((i) => i.externalId)).toEqual(["v1", "v2"]);
  });
});

// --- Error mapping ----------------------------------------------------------
//
// Every message below is verbatim from yt-dlp 2026.08.19, captured on
// 2026-08-26 (the video ids are in the comments), except where marked.

describe("classifyError", () => {
  const url = "https://www.youtube.com/watch?v=x";
  const tagOf = (stderr: string, wanted?: string) =>
    classifyError(wanted ? { stderr, url, wanted } : { stderr, url })._tag;

  test("bot check is Blocked, not AuthRequired", () => {
    // The bot check carries the same "Use --cookies..." hint as a real auth
    // failure, so it has to be recognised first or it reads as "just log in".
    expect(
      tagOf(
        "ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
      ),
    ).toBe("Blocked");
  });

  test("removed and unavailable videos are Blocked", () => {
    // 6SJNVb0GnPI
    expect(
      tagOf(
        "ERROR: [youtube] 6SJNVb0GnPI: This video has been removed for violating YouTube's policy on hate speech. Learn more about combating hate speech in your country.",
      ),
    ).toBe("Blocked");
    // aaaaaaaaaaa, both wordings — the same URL produced each of them on the
    // same binary within minutes, depending on which player client answered.
    expect(tagOf("ERROR: [youtube] aaaaaaaaaaa: Video unavailable")).toBe("Blocked");
    expect(tagOf("ERROR: [youtube] aaaaaaaaaaa: This video is unavailable")).toBe("Blocked");
    // sJL6WA-aGkQ
    expect(
      tagOf(
        "ERROR: [youtube] sJL6WA-aGkQ: The uploader has not made this video available in your country\nThis video is available in Japan.",
      ),
    ).toBe("Blocked");
  });

  test("throttling is RateLimited, and the hour-long one says so", () => {
    // networking/exceptions.py:63 formats `HTTP Error {status}: {reason}`.
    expect(tagOf("ERROR: unable to download video data: HTTP Error 429: Too Many Requests")).toBe(
      "RateLimited",
    );
    // _video.py:4070.
    const hour = classifyError({
      stderr:
        "ERROR: [youtube] x: This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.",
      url,
    });
    expect(hour._tag).toBe("RateLimited");
    expect(hour._tag === "RateLimited" && hour.retryAfterMs).toBe(3_600_000);
  });

  test("age-restricted and members-only need a session", () => {
    // Tq92D6wQ1mg
    expect(
      tagOf(
        "ERROR: [youtube] Tq92D6wQ1mg: Sign in to confirm your age. Use --cookies-from-browser or --cookies for the authentication.",
      ),
    ).toBe("AuthRequired");
    // yZIXLfi8CZQ
    expect(
      tagOf(
        "ERROR: [youtube] yZIXLfi8CZQ: Please sign in. Use --cookies-from-browser or --cookies for the authentication.",
      ),
    ).toBe("AuthRequired");
    // YouTube's own wording, forwarded verbatim by _video.py:4053-4066.
    expect(
      tagOf(
        "ERROR: [youtube] x: Join this channel to get access to members-only content like this video, and other exclusive perks.",
      ),
    ).toBe("AuthRequired");
  });

  test("a missing format is FormatUnavailable and remembers what was asked for", () => {
    // YoutubeDL.py:3089.
    const err = classifyError({
      stderr:
        "ERROR: [youtube] jNQXAC9IVRw: Requested format is not available. Use --list-formats for a list of available formats",
      url,
      wanted: "137+140-en",
    });
    expect(err._tag).toBe("FormatUnavailable");
    expect(err._tag === "FormatUnavailable" && err.wanted).toBe("137+140-en");
    // The same problem from the other side: nothing downloadable was offered.
    expect(tagOf("ERROR: [youtube] jNQXAC9IVRw: No video formats found!")).toBe(
      "FormatUnavailable",
    );
  });

  test("anything unrecognised is ProbeFailed, with the message kept", () => {
    const err = classifyError({
      stderr: "ERROR: [generic] Unable to download webpage: HTTP Error 404: Not Found",
      url,
    });
    expect(err._tag).toBe("ProbeFailed");
    expect(err._tag === "ProbeFailed" && err.detail).toContain("HTTP Error 404");
  });

  test("the cookie how-to boilerplate is stripped out of the detail", () => {
    const err = classifyError({
      stderr:
        "ERROR: [youtube] x: Something odd happened. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ  for how to manually pass cookies",
      url,
    });
    expect(err._tag === "ProbeFailed" && err.detail).toBe("[youtube] x: Something odd happened.");
  });
});

test("a non-zero exit is mapped, and the URL travels with the error", async () => {
  const { spawn } = fakeSpawner({
    stderr: ["ERROR: [youtube] x: Sign in to confirm your age. Use --cookies for the authentication."],
    exitCode: 1,
  });
  const provider = createYtdlpProvider({ spawn });
  const result = await provider.probe(
    "https://www.youtube.com/watch?v=x",
    new AbortController().signal,
  );
  expect(Result.isError(result)).toBe(true);
  expect(Result.isError(result) && result.error._tag).toBe("AuthRequired");
  expect(Result.isError(result) && result.error.url).toBe("https://www.youtube.com/watch?v=x");
});

// --- Command lines ----------------------------------------------------------

describe("argv", () => {
  test("--color never, and never --color no", () => {
    // `--color no` exits 2 with `"no" is not a valid color policy` — a message
    // that never says the word "option".
    for (const args of [
      buildProbeArgs("u"),
      buildListArgs("u"),
      buildFetchArgs(plan(), "/tmp/w"),
    ]) {
      expect(args).toContain("--color");
      expect(args[args.indexOf("--color") + 1]).toBe("never");
      expect(args).not.toContain("no");
    }
  });

  test("probe asks for one item, not the playlist it happens to be in", () => {
    const args = buildProbeArgs("https://www.youtube.com/watch?v=x&list=PL1", { binary: "yt-dlp" });
    expect(args[0]).toBe("yt-dlp");
    expect(args).toContain("-J");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--ignore-config");
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=x&list=PL1");
  });

  test("list is flat, and can be capped", () => {
    expect(buildListArgs("u")).toContain("--flat-playlist");
    const capped = buildListArgs("u", { maxListItems: 50 });
    expect(capped[capped.indexOf("--playlist-end") + 1]).toBe("50");
  });

  test("fetch takes structured progress from both prefixes, and no PTY", () => {
    const args = buildFetchArgs(plan(), "/tmp/w");
    const templates = args.filter((_, i) => args[i - 1] === "--progress-template");
    expect(templates.some((t) => t.startsWith("download:CT-DL|"))).toBe(true);
    expect(templates.some((t) => t.startsWith("postprocess:CT-PP|"))).toBe(true);
    // -q is what moves postprocess progress to stderr (YoutubeDL.py:664), and
    // --no-simulate is what stops --print from turning the run into a dry run.
    expect(args).toContain("-q");
    expect(args).toContain("--progress");
    expect(args).toContain("--no-simulate");
    expect(args).toContain("--newline");
    // Warnings carry real information; they are logged, not suppressed.
    expect(args).not.toContain("--no-warnings");
  });

  test("the thumbnail is written as a sidecar, and converted to JPEG", () => {
    // The provider's picture beats a frame taken out of the middle of the file,
    // and `Name.jpg` beside `Name.mkv` is what media servers already read.
    // ⚠️ The conversion is the load-bearing half: YouTube serves WebP, which
    // several media servers ignore entirely.
    const args = buildFetchArgs(plan(), "/tmp/w");
    expect(args).toContain("--write-thumbnail");
    expect(args[args.indexOf("--convert-thumbnails") + 1]).toBe("jpg");
    // Not embedded: a sidecar is readable by anything, an embedded cover is not.
    expect(args).not.toContain("--embed-thumbnail");
  });

  test("a literal % in a title does not become a template field", () => {
    const args = buildFetchArgs(plan({ outputName: "100% Real" }), "/tmp/w");
    expect(args[args.indexOf("-o") + 1]).toBe("100%% Real.%(ext)s");
  });

  test("more than one audio track needs --audio-multistreams", () => {
    expect(buildFetchArgs(plan(), "/tmp/w")).not.toContain("--audio-multistreams");
    expect(
      buildFetchArgs(plan({ audio: [englishAudio, spanishAudio] }), "/tmp/w"),
    ).toContain("--audio-multistreams");
  });

  test("the format selector is video then audio, in plan order", () => {
    expect(buildFormatSelector(plan({ audio: [englishAudio, spanishAudio] }))).toBe(
      "137+140-en+140-es",
    );
  });

  test("language tags are written onto the merged streams explicitly", () => {
    // FFmpegMergerPP merges with `-c copy` and `-map` only — it writes no
    // language metadata whatsoever. This is the fix for the por/pan bug.
    const args = buildLanguageMetadataArgs(
      plan({
        audio: [englishAudio, spanishAudio],
        languageTags: { "140-en": "eng", "140-es": "spa" },
      }),
    );
    expect(args).toEqual([
      "--postprocessor-args",
      "Merger+ffmpeg_o:-metadata:s:a:0 language=eng -metadata:s:a:1 language=spa",
    ]);
  });

  test("a track missing from languageTags falls back to its own language", () => {
    const args = buildLanguageMetadataArgs(plan({ audio: [spanishAudio], languageTags: {} }));
    expect(args[1]).toBe("Merger+ffmpeg_o:-metadata:s:a:0 language=es-419");
  });

  test("no audio means no merge, so no metadata arguments", () => {
    expect(buildLanguageMetadataArgs(plan({ audio: [] }))).toEqual([]);
  });

  test("subtitles: manual and automatic ask for different flags", () => {
    const both = buildFetchArgs(
      plan({
        subtitles: [
          { id: "subs:en", language: "en", automatic: false },
          { id: "auto:es-419", language: "es-419", automatic: true },
        ],
      }),
      "/tmp/w",
    );
    expect(both).toContain("--write-subs");
    expect(both).toContain("--write-auto-subs");
    expect(both[both.indexOf("--sub-langs") + 1]).toBe("en,es-419");

    const manualOnly = buildFetchArgs(
      plan({ subtitles: [{ id: "subs:en", language: "en", automatic: false }] }),
      "/tmp/w",
    );
    expect(manualOnly).toContain("--write-subs");
    expect(manualOnly).not.toContain("--write-auto-subs");
  });

  test("sponsorblock removes ads and keeps the rest as chapters", () => {
    expect(buildFetchArgs(plan(), "/tmp/w")).not.toContain("--sponsorblock-remove");
    const on = buildFetchArgs(plan({ sponsorblock: true }), "/tmp/w");
    expect(on[on.indexOf("--sponsorblock-remove") + 1]).toBe("sponsor,selfpromo,interaction");
    expect(on[on.indexOf("--sponsorblock-mark") + 1]).toBe("all");
  });

  test("a cookie jar is passed as a path and never as its contents", () => {
    const args = buildProbeArgs("u", { cookiesFile: "/data/cookies.txt" });
    expect(args[args.indexOf("--cookies") + 1]).toBe("/data/cookies.txt");
  });
});

test("supports() answers for everything — it is the fallback provider", () => {
  const provider = createYtdlpProvider({ spawn: fakeSpawner({}).spawn });
  for (const url of [
    "https://www.youtube.com/watch?v=x",
    "https://vimeo.com/123",
    "https://some.site.example/video/1",
    "not even a url",
  ]) {
    expect(provider.supports(url)).toBe(true);
  }
});

// --- The real binary --------------------------------------------------------
//
// Everything above proves we parse what we believe yt-dlp prints. This proves
// what it actually prints. Skip it with CASATUBE_LIVE=0 (no network), and it
// skips itself when the binary is missing or too old to extract YouTube.

const LIVE_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // "Me at the zoo", 19s
const MINIMUM_YTDLP = "2025.01.01";

async function liveSkipReason(): Promise<string | null> {
  if (process.env.CASATUBE_LIVE === "0") return "CASATUBE_LIVE=0";

  const binary = process.env.YTDLP_BIN || "yt-dlp";
  let version: string;
  try {
    const proc = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "ignore" });
    version = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0) return `${binary} --version failed`;
  } catch {
    return `${binary} is not on PATH`;
  }
  if (version < MINIMUM_YTDLP) {
    // 2024.07.09 still runs, and still parses — it just cannot get formats out
    // of YouTube any more ("No video formats found!"). Running the check
    // against it would prove nothing about our translation.
    return `${binary} is ${version}; needs >= ${MINIMUM_YTDLP} to extract YouTube`;
  }

  try {
    await fetch("https://www.youtube.com/", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return "youtube.com is unreachable";
  }
  return null;
}

const skipReason = await liveSkipReason();
if (skipReason) {
  console.warn(`[ytdlp.test] live probe skipped: ${skipReason}`);
}

describe.skipIf(skipReason !== null)("live yt-dlp", () => {
  test(
    "probe of a real video produces a coherent MediaInfo",
    async () => {
      const provider = createYtdlpProvider();
      const result = await provider.probe(LIVE_URL, AbortSignal.timeout(120_000));

      if (Result.isError(result)) {
        throw new Error(`probe failed: ${result.error._tag} ${JSON.stringify(result.error)}`);
      }
      const media = result.value;

      expect(media.externalId).toBe("jNQXAC9IVRw");
      expect(media.title).toBe("Me at the zoo");
      expect(media.source).toBe("youtube");
      expect(media.duration).toBeGreaterThan(15);
      expect(media.duration).toBeLessThan(30);
      expect(media.uploader).toBeTruthy();

      // Formats came through as video and audio, and nothing is a storyboard.
      expect(media.videoFormats.length).toBeGreaterThan(3);
      expect(media.audioTracks.length).toBeGreaterThan(2);
      for (const f of media.videoFormats) {
        expect(f.id).toBeTruthy();
        expect(f.codec ?? "").not.toBe("none");
      }
      expect(media.videoFormats.some((f) => (f.height ?? 0) >= 144)).toBe(true);
      for (const t of media.audioTracks) {
        expect(t.id).toBeTruthy();
        expect(t.language.length).toBeGreaterThan(0);
      }

      // This video has one soundtrack, so exactly that soundtrack is original.
      // Never "all languages" and never "none" — PLAN §4.1.
      const originals = media.audioTracks.filter((t) => t.isOriginal);
      expect(originals.length).toBe(media.audioTracks.length);
      expect(new Set(media.audioTracks.map((t) => t.language)).size).toBe(1);

      // Manual and automatic captions both present and distinguishable.
      expect(media.subtitles.some((s) => !s.automatic)).toBe(true);
      expect(media.subtitles.some((s) => s.automatic)).toBe(true);
      expect(new Set(media.subtitles.map((s) => s.id)).size).toBe(media.subtitles.length);

      // Nothing above the provider may see a yt-dlp flag.
      expect(JSON.stringify(media)).not.toContain("--");
    },
    180_000,
  );

  test(
    "a video that is gone maps to Blocked",
    async () => {
      const provider = createYtdlpProvider();
      const result = await provider.probe(
        "https://www.youtube.com/watch?v=aaaaaaaaaaa",
        AbortSignal.timeout(120_000),
      );
      expect(Result.isError(result)).toBe(true);
      expect(Result.isError(result) && result.error._tag).toBe("Blocked");
    },
    180_000,
  );

  test(
    "an age-restricted video maps to AuthRequired",
    async () => {
      const provider = createYtdlpProvider();
      const result = await provider.probe(
        "https://www.youtube.com/watch?v=Tq92D6wQ1mg",
        AbortSignal.timeout(120_000),
      );
      expect(Result.isError(result)).toBe(true);
      expect(Result.isError(result) && result.error._tag).toBe("AuthRequired");
    },
    180_000,
  );

  test(
    "a real fetch lands a real file, with a monotonic bar",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "casatube-live-"));
      try {
        const provider = createYtdlpProvider();
        const ctx = fakeContext(dir);
        // 144p, video-only, ~190 KB, plus one subtitle sidecar. No merge, so
        // this works on a machine without ffmpeg.
        const livePlan = plan({
          url: LIVE_URL,
          video: { id: "160", height: 144 },
          audio: [],
          languageTags: {},
          subtitles: [{ id: "subs:en", language: "en", automatic: false }],
          // A literal % in the title: it must not be read as a template field.
          outputName: "Me at the zoo (100% real)",
        });

        const result = await provider.fetch(livePlan, {
          ...ctx,
          signal: AbortSignal.timeout(150_000),
        });

        if (Result.isError(result)) {
          throw new Error(`fetch failed: ${result.error._tag} ${JSON.stringify(result.error)}`);
        }
        expect(result.value.file).toBe(join(dir, "Me at the zoo (100% real).mp4"));
        expect(await Bun.file(result.value.file).exists()).toBe(true);
        expect(result.value.subtitleFiles).toEqual([
          join(dir, "Me at the zoo (100% real).en.vtt"),
        ]);

        // The bar only ever went forward, and it did not start at 100% because
        // the subtitle file happened to arrive first.
        const percents = ctx.updates.map((u) => u.percent ?? 0);
        expect(percents.length).toBeGreaterThan(3);
        expect(percents[0]!).toBeLessThan(50);
        expect(percents.at(-1)).toBe(100);
        for (let i = 1; i < percents.length; i++) {
          expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test(
    "list of a real playlist yields discovered items",
    async () => {
      const provider = createYtdlpProvider({ maxListItems: 3 });
      const result = await provider.list!(
        "https://www.youtube.com/playlist?list=PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb",
        AbortSignal.timeout(120_000),
      );
      if (Result.isError(result)) {
        throw new Error(`list failed: ${result.error._tag}`);
      }
      expect(result.value.length).toBe(3);
      for (const item of result.value) {
        expect(item.externalId).toBeTruthy();
        expect(item.url).toStartWith("http");
        expect(item.title.length).toBeGreaterThan(0);
      }
    },
    180_000,
  );
});

// --- Regressions from real use (2026-08-26) ---------------------------------

test("enables a JavaScript runtime: without one YouTube deciphering degrades", () => {
  const args = buildFetchArgs(plan(), "/tmp/work", {});
  const i = args.indexOf("--js-runtimes");
  expect(i).toBeGreaterThan(-1);
  expect(args[i + 1]).toMatch(/^bun:/);
});

test("🔴 a failed subtitle must not take the video down with it", () => {
  // Observed live: yt-dlp fetches subtitles first, so a 429 on a 440-byte .vtt
  // aborted the whole job at 0% and the video was never attempted.
  const args = buildFetchArgs(
    plan({ subtitles: [{ id: "subs:en", language: "en", automatic: false }] }),
    "/tmp/work",
    {},
  );
  expect(args).toContain("--write-subs");
  expect(args).toContain("--no-abort-on-error");
});

test("no subtitles requested means no reason to soften error handling", () => {
  const args = buildFetchArgs(plan({ subtitles: [] }), "/tmp/work", {});
  expect(args).not.toContain("--no-abort-on-error");
});
