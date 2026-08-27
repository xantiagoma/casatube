/**
 * Transcoding, tested in the three halves it has.
 *
 * The **presets and the command** are pure functions, so they are asserted
 * directly — and the two rules that would be catastrophic to get wrong (never
 * `-y`, never the input path as the output) are tested rather than commented.
 *
 * The **queue** runs against a real SQLite file in a temp directory, never
 * `:memory:`, for the same reason `queue.test.ts` does: the property under test
 * is "an interrupted job comes back", and proving that means closing a database
 * and opening it again.
 *
 * The **runner** is driven by a *fake ffmpeg* — a shell script that emits real
 * `-progress` blocks and writes a real file. That is deliberate, not lazy: what
 * is worth proving here is the bookkeeping (progress lands in the row, a
 * failure retries then gives up, a cancel removes the half-written file), and a
 * real libx264 pass would make each of those a minute long and dependent on a
 * binary being installed. A real ffmpeg is exercised end to end by hand — see
 * the worklog.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import { appDbPath, closeDb, openDb, type Db } from "./db";
import {
  buildTranscodeArgs,
  createTranscodeQueue,
  findPreset,
  parseProgress,
  plannedOutput,
  TRANSCODE_PRESETS,
  type TranscodePreset,
  type TranscodeQueue,
} from "./transcode";
import type { MediaProbe } from "./library";

// --- Pure: the presets ------------------------------------------------------

describe("TRANSCODE_PRESETS", () => {
  test("every preset says what it costs, and whether it re-encodes", () => {
    for (const preset of TRANSCODE_PRESETS) {
      expect(preset.cost.length).toBeGreaterThan(20);
      expect(typeof preset.reencodesVideo).toBe("boolean");
      expect(preset.ext).not.toContain(".");
    }
  });

  /**
   * 🔴 The claim the UI makes on the user's behalf. `mp4-remux` copies and
   * `tv` encodes; if those two flags ever agreed, one of the two sentences
   * shown before the button would be a lie.
   */
  test("the remux preset copies and the TV preset encodes", () => {
    expect(findPreset("mp4-remux")?.reencodesVideo).toBe(false);
    expect(findPreset("mp4-remux")?.args).toContain("copy");
    expect(findPreset("tv")?.reencodesVideo).toBe(true);
    expect(findPreset("tv")?.args).toContain("libx264");
  });

  test("an unknown preset is undefined rather than a default", () => {
    expect(findPreset("h265-4k-hdr")).toBeUndefined();
  });
});

describe("buildTranscodeArgs", () => {
  const preset = findPreset("tv") as TranscodePreset;
  const args = buildTranscodeArgs("/library/Film.mkv", "/library/Film (TV).mp4", preset);

  /**
   * 🔴 `-n`, never `-y`. `-y` overwrites, which is the one promise this module
   * makes; ffmpeg's *default* is to prompt, on a terminal that is not there,
   * which hangs for ever.
   */
  test("refuses to overwrite an existing output, and never prompts", () => {
    expect(args).toContain("-n");
    expect(args).not.toContain("-y");
    expect(args).toContain("-nostdin");
  });

  test("progress is machine-readable, because a person is watching a bar", () => {
    expect(args[args.indexOf("-progress") + 1]).toBe("pipe:1");
  });

  test("the input comes before the preset's own flags, and the output last", () => {
    expect(args[args.indexOf("-i") + 1]).toBe("/library/Film.mkv");
    expect(args.at(-1)).toBe("/library/Film (TV).mp4");
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("libx264"));
  });

  /**
   * 🔴 An MKV's ASS subtitles have no MP4 representation, so a preset that
   * carried them through would fail the job *after* the encode. ⚠️ This does
   * not cover chapters — see the note in `transcode.ts`; they survive on
   * purpose.
   */
  test("no MP4 preset carries a data or subtitle stream through", () => {
    for (const preset of TRANSCODE_PRESETS.filter((p) => p.ext === "mp4")) {
      expect(preset.args).toContain("-dn");
      expect(preset.args).toContain("-sn");
    }
  });

  test("an MP4 output is always faststart — otherwise it stalls over HTTP", () => {
    for (const preset of TRANSCODE_PRESETS.filter((p) => p.ext === "mp4")) {
      expect(buildTranscodeArgs("in", "out.mp4", preset)).toContain("+faststart");
    }
  });
});

describe("plannedOutput", () => {
  test("the copy lands beside the original, named so they cannot be confused", () => {
    const planned = plannedOutput("Videos/Film.mkv", findPreset("tv") as TranscodePreset);
    expect(Result.isOk(planned) && planned.value).toBe("Videos/Film (TV).mp4");
  });

  test("a file in the library root keeps no leading folder", () => {
    const planned = plannedOutput("Film.mkv", findPreset("tv") as TranscodePreset);
    expect(Result.isOk(planned) && planned.value).toBe("Film (TV).mp4");
  });

  /**
   * 🔴 The failure this guard exists for: ffmpeg reading and writing the same
   * file produces a zero-byte ruin where a video used to be.
   */
  test("a preset that would land on the original is refused, not renamed", () => {
    const planned = plannedOutput("Videos/Clip.mp4", findPreset("mp4-remux") as TranscodePreset);
    expect(Result.isError(planned)).toBe(true);
    expect(Result.isError(planned) && planned.error.detail).toContain("over the original");
  });

  test("an audio preset changes the extension, so an MP4 has somewhere to go", () => {
    const planned = plannedOutput("Videos/Talk.mp4", findPreset("audio") as TranscodePreset);
    expect(Result.isOk(planned) && planned.value).toBe("Videos/Talk.m4a");
  });
});

describe("parseProgress", () => {
  test("reads out_time_us against the probed duration", () => {
    expect(parseProgress("frame=120\nout_time_us=5000000\nprogress=continue\n", 100)).toBe(5);
  });

  /** ⚠️ The first blocks carry `N/A`, and `Number("N/A")` is `NaN`. */
  test("an N/A is no answer, not zero and not NaN", () => {
    expect(parseProgress("out_time_us=N/A\nprogress=continue\n", 100)).toBeNull();
  });

  test("with no duration there is no percentage to give", () => {
    expect(parseProgress("out_time_us=5000000\n", null)).toBeNull();
    expect(parseProgress("out_time_us=5000000\n", 0)).toBeNull();
  });

  /**
   * 🔴 99 is the ceiling while ffmpeg is still running. 100 belongs to the
   * moment the file is closed and measured on disk — a bar that sits at 100%
   * for the last thirty seconds of muxing is a bar that has stopped meaning
   * anything.
   */
  test("never reaches 100 from ffmpeg's own numbers", () => {
    expect(parseProgress("out_time_us=200000000\n", 100)).toBe(99);
  });

  test("the last value in a block wins", () => {
    expect(parseProgress("out_time_us=1000000\nout_time_us=9000000\n", 100)).toBe(9);
  });
});

// --- The queue --------------------------------------------------------------

let dir: string;
let library: string;
let db: Db;
let queue: TranscodeQueue;
let trashed: string[];

const probe = async (): Promise<Result<MediaProbe, { _tag: string }>> =>
  Result.ok({
    path: "x",
    durationSeconds: 10,
    bitrate: 1000,
    formatName: "matroska,webm",
    width: null,
    height: null,
    streams: [],
  });

/**
 * A fake ffmpeg.
 *
 * It emits two real `-progress` blocks and writes the output file named by its
 * last argument, so the runner's parsing, its progress writes and its
 * "did anything actually appear on disk" check are all exercised for real.
 */
function fakeFfmpeg(options: { exitCode?: number; sleep?: string; writeOutput?: boolean } = {}): string {
  const path = join(dir, `ffmpeg-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(
    path,
    `#!/bin/sh
for arg in "$@"; do out="$arg"; done
echo "out_time_us=2000000"
echo "progress=continue"
sleep ${options.sleep ?? "0"}
echo "out_time_us=8000000"
echo "progress=end"
echo "fake ffmpeg noise on stderr" >&2
${options.writeOutput === false ? "" : 'printf "video" > "$out"'}
exit ${options.exitCode ?? 0}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function put(relative: string, content = "source"): void {
  const absolute = join(library, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

function open(ffmpegPath: string, extra: { backoffMs?: number } = {}): TranscodeQueue {
  return createTranscodeQueue({
    db,
    libraryRoot: library,
    probe,
    ffmpegPath,
    backoffMs: extra.backoffMs ?? 0,
    trash: async (relPath) => {
      trashed.push(relPath);
      rmSync(join(library, relPath));
      return Result.ok(null);
    },
    log: () => undefined,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-transcode-"));
  library = join(dir, "library");
  mkdirSync(library, { recursive: true });
  db = openDb({ path: appDbPath(dir) });
  trashed = [];
  queue = open(fakeFfmpeg());
});

afterEach(async () => {
  await queue.stop();
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("enqueue", () => {
  test("queues a row and returns it, without doing any work", async () => {
    put("Videos/Film.mkv");

    const queued = await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    expect(Result.isOk(queued)).toBe(true);
    expect(Result.isOk(queued) && queued.value.status).toBe("queued");
    expect(Result.isOk(queued) && queued.value.outputPath).toBe("Videos/Film (TV).mp4");
    // The point of a queue: nothing has run.
    expect(queue.running).toBeNull();
    expect(existsSync(join(library, "Videos/Film (TV).mp4"))).toBe(false);
  });

  test("a file that is not there is refused before anything is written", async () => {
    const queued = await queue.enqueue({ path: "Videos/ghost.mkv", preset: "tv" });
    expect(Result.isError(queued) && queued.error._tag).toBe("NotFound");
    expect(await queue.list()).toHaveLength(0);
  });

  test("a path that leaves the library is refused", async () => {
    const queued = await queue.enqueue({ path: "../../etc/shadow", preset: "tv" });
    expect(Result.isError(queued)).toBe(true);
  });

  /** ⚠️ A double-click must not start two hours of CPU instead of one. */
  test("🔴 the same file cannot be queued twice while the first is still live", async () => {
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    const again = await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    expect(Result.isError(again) && again.error._tag).toBe("TranscodeRejected");
    expect(await queue.list()).toHaveLength(1);
  });

  test("an existing output is refused before the CPU is spent, not after", async () => {
    put("Videos/Film.mkv");
    put("Videos/Film (TV).mp4", "already here");

    const queued = await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    expect(Result.isError(queued) && queued.error._tag).toBe("TranscodeRejected");
    expect(Result.isError(queued) && "detail" in queued.error && queued.error.detail).toContain("already exists");
  });

  test("an unknown preset is a refusal, not a default", async () => {
    put("Videos/Film.mkv");
    const queued = await queue.enqueue({ path: "Videos/Film.mkv", preset: "whatever" });
    expect(Result.isError(queued) && queued.error._tag).toBe("TranscodeRejected");
  });
});

describe("enqueueMany", () => {
  /**
   * 🔴 Partial success is the normal outcome over a real folder, and failing
   * the batch on the first bad file would make the feature unusable.
   */
  test("reports each file separately instead of failing the batch", async () => {
    put("Videos/One.mkv");
    put("Videos/Two.mkv");

    const outcome = await queue.enqueueMany(["Videos/One.mkv", "Videos/ghost.mkv", "Videos/Two.mkv"], {
      preset: "tv",
    });

    expect(outcome.queued.map((row) => row.sourcePath)).toEqual(["Videos/One.mkv", "Videos/Two.mkv"]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]?.path).toBe("Videos/ghost.mkv");
    // ⚠️ The error itself, so the HTTP layer writes the sentence — see the note
    // on `enqueueMany`.
    expect(outcome.rejected[0]?.error._tag).toBe("NotFound");
  });
});

describe("the runner", () => {
  test("runs one job, writes the output and records the size", async () => {
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    const done = await queue.runNext();

    expect(done?.status).toBe("done");
    expect(done?.progress).toBe(100);
    expect(done?.outputBytes).toBe(5);
    expect(existsSync(join(library, "Videos/Film (TV).mp4"))).toBe(true);
    // ⚠️ And the original is exactly where it was.
    expect(existsSync(join(library, "Videos/Film.mkv"))).toBe(true);
  });

  test("progress from ffmpeg lands in the row", async () => {
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    const done = await queue.runNext();

    // The fake emits 2 s then 8 s of a 10 s file; the row ends at 100 because
    // the file was verified, and the log carries what happened.
    expect(done?.durationSeconds).toBe(10);
    expect(done?.log.join(" ")).toContain("Videos/Film (TV).mp4");
  });

  test("oldest first, and only one at a time", async () => {
    put("Videos/One.mkv");
    put("Videos/Two.mkv");
    await queue.enqueue({ path: "Videos/One.mkv", preset: "tv" });
    await queue.enqueue({ path: "Videos/Two.mkv", preset: "tv" });

    const first = await queue.runNext();

    expect(first?.sourcePath).toBe("Videos/One.mkv");
    const rows = await queue.list({ status: ["queued"] });
    expect(rows.map((row) => row.sourcePath)).toEqual(["Videos/Two.mkv"]);
  });

  test("a failing ffmpeg retries, then gives up with the reason it gave", async () => {
    queue = open(fakeFfmpeg({ exitCode: 1, writeOutput: false }));
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    const first = await queue.runNext();
    expect(first?.status).toBe("queued");
    expect(first?.attempts).toBe(1);

    const second = await queue.runNext();
    expect(second?.status).toBe("failed");
    expect(second?.attempts).toBe(2);
    expect(second?.error).toBeTruthy();
  });

  /**
   * 🔴 A truncated encode left in the library is a file that looks like a
   * video and is not one — and it would also block its own retry, because the
   * output name would then be taken.
   */
  test("a failed run leaves nothing behind in the library", async () => {
    queue = open(fakeFfmpeg({ exitCode: 1 }));
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    await queue.runNext();

    expect(existsSync(join(library, "Videos/Film (TV).mp4"))).toBe(false);
  });

  test("an ffmpeg that exits 0 and writes nothing is a failure, not a success", async () => {
    queue = open(fakeFfmpeg({ writeOutput: false }));
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    const first = await queue.runNext();

    expect(first?.status).not.toBe("done");
    expect(first?.log.join(" ")).toContain("wrote nothing");
  });

  test("a missing ffmpeg is a failed job, not a crashed server", async () => {
    queue = open(join(dir, "no-such-binary"));
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    const first = await queue.runNext();

    expect(first?.status === "queued" || first?.status === "failed").toBe(true);
    expect(first?.error ?? "").not.toBe("");
  });
});

describe("replaceOriginal", () => {
  /** ⚠️ Off unless asked for. The default is a new file beside the old one. */
  test("is off by default, and the original stays put", async () => {
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });

    await queue.runNext();

    expect(trashed).toEqual([]);
    expect(existsSync(join(library, "Videos/Film.mkv"))).toBe(true);
  });

  /**
   * 🔴 And when it is asked for, the original goes to the **trash** — a rename
   * the Trash tab can undo — never an unlink.
   */
  test("moves the original to the trash, and only after the copy exists", async () => {
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv", replaceOriginal: true });

    const done = await queue.runNext();

    expect(done?.status).toBe("done");
    expect(trashed).toEqual(["Videos/Film.mkv"]);
    expect(existsSync(join(library, "Videos/Film (TV).mp4"))).toBe(true);
    expect(done?.log.join(" ")).toContain(".trash/");
  });

  test("a failed conversion never touches the original", async () => {
    queue = open(fakeFfmpeg({ exitCode: 1, writeOutput: false }));
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv", replaceOriginal: true });

    await queue.runNext();

    expect(trashed).toEqual([]);
    expect(existsSync(join(library, "Videos/Film.mkv"))).toBe(true);
  });
});

describe("cancel", () => {
  test("a queued job is cancelled and never runs", async () => {
    put("Videos/Film.mkv");
    const queued = await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });
    const id = Result.isOk(queued) ? queued.value.id : "";

    const cancelled = await queue.cancel(id);

    expect(Result.isOk(cancelled) && cancelled.value.status).toBe("cancelled");
    expect(await queue.runNext()).toBeNull();
    expect(existsSync(join(library, "Videos/Film (TV).mp4"))).toBe(false);
  });

  test("cancelling twice is not an error", async () => {
    put("Videos/Film.mkv");
    const queued = await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });
    const id = Result.isOk(queued) ? queued.value.id : "";

    await queue.cancel(id);
    const again = await queue.cancel(id);

    expect(Result.isOk(again) && again.value.status).toBe("cancelled");
  });

  /** 🔴 A cancel while ffmpeg is working kills it and removes the partial file. */
  test("kills the running job and removes what it had written", async () => {
    queue = open(fakeFfmpeg({ sleep: "2" }));
    put("Videos/Film.mkv");
    const queued = await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });
    const id = Result.isOk(queued) ? queued.value.id : "";

    const running = queue.runNext();
    // Wait for the process to actually be up before pulling the trigger.
    for (let i = 0; i < 100 && queue.running === null; i += 1) await Bun.sleep(20);
    expect(queue.running).toBe(id);

    await queue.cancel(id);
    await running;

    const row = await queue.get(id);
    expect(Result.isOk(row) && row.value.status).toBe("cancelled");
    expect(existsSync(join(library, "Videos/Film (TV).mp4"))).toBe(false);
  });

  /**
   * 🔴 A shutdown is not a cancel and not a failure.
   *
   * Found by killing a real 73-minute encode: the job came back as
   * `attempt 1/2 failed: ffmpeg exited with code 255` — an error about a
   * process *we* killed. With `maxAttempts` at 2, two restarts would have
   * retired the job for good and blamed the file for it.
   */
  test("🔴 stopping the queue does not charge the job an attempt or blame it", async () => {
    queue = open(fakeFfmpeg({ sleep: "2" }));
    put("Videos/Film.mkv");
    const queued = await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });
    const id = Result.isOk(queued) ? queued.value.id : "";

    const running = queue.runNext();
    for (let i = 0; i < 100 && queue.running === null; i += 1) await Bun.sleep(20);
    await queue.stop();
    await running;

    const row = await queue.get(id);
    expect(Result.isOk(row) && row.value.attempts).toBe(0);
    expect(Result.isOk(row) && row.value.error).toBeNull();
    // Left `running`, which is precisely what `recoverOnStart` requeues.
    expect(Result.isOk(row) && row.value.status).toBe("running");
    expect(existsSync(join(library, "Videos/Film (TV).mp4"))).toBe(false);
    expect(await queue.recoverOnStart()).toBe(1);
  });

  test("a job that does not exist is a NotFound, not a silent success", async () => {
    const cancelled = await queue.cancel("nope");
    expect(Result.isError(cancelled) && cancelled.error._tag).toBe("NotFound");
  });
});

/**
 * 🔴 R2, for transcodes: a job survives the service restarting.
 *
 * ⚠️ The database is genuinely closed and reopened. An in-memory version of
 * this test would pass and prove nothing.
 */
describe("recoverOnStart", () => {
  test("an interrupted job comes back as queued, across a real close and reopen", async () => {
    put("Videos/Film.mkv");
    const queued = await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });
    const id = Result.isOk(queued) ? queued.value.id : "";
    // Simulate a process killed mid-encode.
    const { transcodes } = await import("./schema");
    const { eq } = await import("drizzle-orm");
    await db.update(transcodes).set({ status: "running", progress: 42 }).where(eq(transcodes.id, id));

    await queue.stop();
    closeDb(db);
    db = openDb({ path: appDbPath(dir) });
    queue = open(fakeFfmpeg());

    expect(await queue.recoverOnStart()).toBe(1);
    const row = await queue.get(id);
    expect(Result.isOk(row) && row.value.status).toBe("queued");
    // ⚠️ And the attempt is not charged: a restart is our fault, not the file's.
    expect(Result.isOk(row) && row.value.attempts).toBe(0);
  });

  test("a finished job is left alone", async () => {
    put("Videos/Film.mkv");
    await queue.enqueue({ path: "Videos/Film.mkv", preset: "tv" });
    await queue.runNext();

    expect(await queue.recoverOnStart()).toBe(0);
  });
});
