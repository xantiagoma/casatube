/**
 * Optional transcoding: saving a library file in another format, on purpose.
 *
 * ## Why this exists at all, next to `core/hls.ts`
 *
 * `core/hls.ts` remuxes — it moves an existing bitstream into a container a
 * browser opens, `-c:v copy`, a few percent of one core, and it refuses
 * anything that cannot be copied. That covers *watching*. It does not cover the
 * other case: a file that only exists in a codec something you own cannot
 * decode — an AV1 download and a television from 2018 — where the picture has
 * to be **made again**.
 *
 * 🔴 **So this module does the thing the rest of CasaTube refuses to do, and it
 * is opt-in for exactly that reason.** A `libx264` pass is four cores for the
 * length of the film, on the machine that also runs Home Assistant, Zigbee and
 * the NFS export the recordings live on. Hence, without exception:
 *
 * | | |
 * |---|---|
 * | **One at a time** | `TranscodeRunner` runs a single ffmpeg, ever. A batch is a queue, not a fan-out |
 * | **Never in an HTTP request** | `POST` enqueues and returns; the work outlives the browser, the tab and the process |
 * | **Never over the original** | The output is a new file beside it. `replaceOriginal` moves the original to `.trash/` *after* success, and even that is reversible |
 * | **Presets, not flags** | {@link TRANSCODE_PRESETS}. A route that took ffmpeg arguments would be a route that runs arbitrary ffmpeg |
 * | **The cost is stated** | Every preset carries `cost`, in words, for whatever is about to show a confirm dialog |
 *
 * ## What it inherits by being a queue
 *
 * Progress (ffmpeg's own `-progress`, against the probed duration), retries
 * (`maxAttempts` with a backoff written as `notBefore`), cancellation (the
 * process is killed and the half-written output removed) and survival across a
 * restart (`recoverOnStart` returns anything that was `running` to `queued`) —
 * the same four properties the download queue has, for the same reason: they
 * are properties of the *table*, not of the process that happens to be up.
 */
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { Result } from "better-result";
import { rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type { Db } from "./db";
import { transcodes } from "./schema";
import { NotFound, TranscodeRejected } from "./errors";
import { resolveInRoot, type MediaProbe } from "./library";
import type { MountUnavailable, PathOutsideRoot, Timeout } from "./errors";

// --- Presets ----------------------------------------------------------------

export type TranscodeStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TranscodePreset {
  id: string;
  /** What to put on a button. */
  label: string;
  /** What it produces, in one sentence, for someone choosing between them. */
  description: string;
  /** What it costs, in one sentence. ⚠️ Shown before the job is created, not after. */
  cost: string;
  /** Extension of the file it writes, without the dot. */
  ext: string;
  /** Appended to the base name, so the original and the copy are told apart on sight. */
  suffix: string;
  /**
   * 🔴 Whether the *video* is decoded and encoded again. `false` means this
   * preset is a remux or an audio-only pass and is nearly free; `true` means
   * hours of CPU and a picture that is, by definition, worse than the input.
   */
  reencodesVideo: boolean;
  /** ffmpeg arguments between the input and the output. */
  args: readonly string[];
}

/**
 * The presets, in the order a person would consider them.
 *
 * 🔴 **Named outcomes, not flags.** "Compatible with a TV" is a thing somebody
 * wants; `-c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p` is the
 * answer to it, and the second is not a question anyone asks. It also keeps the
 * API from being a remote ffmpeg: the route takes an id off this list, so the
 * only commands that can run are the ones written here.
 *
 * ⚠️ **`-crf`, not `-b:v`.** A target bitrate on a 73-minute film either wastes
 * space on the still shots or falls apart in the action; constant quality
 * spends bits where they are needed. 20 is visually transparent for h264 at
 * these resolutions; 23 is the "small enough to carry around" tier.
 *
 * ⚠️ `+faststart` on every MP4. Without it the `moov` lands at the *end*, which
 * is the classic reason a file plays from disk and stalls over HTTP.
 */
export const TRANSCODE_PRESETS: readonly TranscodePreset[] = [
  {
    id: "tv",
    label: "Compatible with a TV",
    description:
      "H.264 High and AAC stereo in an MP4 — the combination every television, phone and browser made in the last decade decodes in hardware.",
    cost: "Re-encodes the video. Expect roughly the length of the film on a busy machine, and a file of a similar size.",
    ext: "mp4",
    suffix: " (TV)",
    reencodesVideo: true,
    args: [
      "-map", "0:v:0?", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ac", "2",
      "-movflags", "+faststart",
    ],
  },
  {
    id: "small",
    label: "Smaller, for a phone",
    description:
      "The same H.264 and AAC, capped at 720p and a lower quality target — for carrying a film on a device with no room.",
    cost: "Re-encodes the video, and throws picture away to do it. As slow as the TV preset and not reversible from the copy.",
    ext: "mp4",
    suffix: " (small)",
    reencodesVideo: true,
    args: [
      "-map", "0:v:0?", "-map", "0:a?",
      // ⚠️ `-2` on the width, not `-1`: H.264 needs even dimensions and an odd
      // one fails the encode outright rather than rounding.
      "-vf", "scale='min(1280,iw)':-2",
      "-c:v", "libx264", "-preset", "medium", "-crf", "23",
      "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-movflags", "+faststart",
    ],
  },
  {
    id: "audio",
    label: "Audio only",
    description: "The soundtrack as an M4A, with the video dropped — a lecture or a set that never needed a picture.",
    cost: "Cheap: nothing is decoded but the audio. Minutes, not hours.",
    ext: "m4a",
    suffix: "",
    reencodesVideo: false,
    args: ["-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"],
  },
  {
    /**
     * 📌 The one preset that is *not* a re-encode, and it earns its place: an
     * MKV of H.264 and AAC is a container problem, not a codec problem, and
     * spending an hour of libx264 on it would be the wrong answer given loudly.
     * It fails honestly when the streams cannot be copied — see `runOne`.
     */
    id: "mp4-remux",
    label: "Repack as MP4 (no re-encode)",
    description:
      "Moves the existing video and audio into an MP4 untouched. Only works when what is inside is already H.264 or H.265 with AAC, MP3 or AC-3.",
    cost: "Nearly free — the streams are copied, not encoded. Seconds to a couple of minutes.",
    ext: "mp4",
    suffix: "",
    reencodesVideo: false,
    args: ["-map", "0:v:0?", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart"],
  },
] as const;

export function findPreset(id: string): TranscodePreset | undefined {
  return TRANSCODE_PRESETS.find((preset) => preset.id === id);
}

/**
 * The ffmpeg command, whole.
 *
 * Pure, so every preset can be asserted on without a media file — and so the
 * two rules that matter can be tested rather than hoped for: the input is never
 * overwritten (`-n`) and progress is machine-readable.
 *
 * ⚠️ **`-n`, not `-y`.** ffmpeg's default when the output exists is to *ask*,
 * on a terminal that is not there, which hangs for ever. `-y` would silently
 * overwrite, which is the one thing this module promises not to do. `-n` fails
 * fast, and the queue has already refused a colliding name before we get here.
 */
export function buildTranscodeArgs(input: string, output: string, preset: TranscodePreset): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-n",
    // Machine-readable progress on stdout; the human version on stderr would
    // have to be scraped out of a carriage-return-rewritten status line.
    "-progress", "pipe:1",
    "-nostats",
    "-i", input,
    ...preset.args,
    output,
  ];
}

/**
 * Where the copy goes: beside the original, named so the two cannot be confused.
 *
 * 🔴 **Never the input path.** A preset whose extension matches the source
 * (an MP4 re-encoded to MP4) would otherwise resolve to the file it is reading,
 * and ffmpeg reading and writing one file produces a zero-byte ruin. The suffix
 * is what keeps them apart, and the one preset with no suffix — `mp4-remux` —
 * cannot collide, because a file that is already `.mp4` has nothing to remux to.
 */
export function plannedOutput(sourceRelPath: string, preset: TranscodePreset): Result<string, TranscodeRejected> {
  const folder = dirname(sourceRelPath);
  const name = basename(sourceRelPath);
  const ext = extname(name);
  const base = ext === "" ? name : name.slice(0, -ext.length);
  const target = `${base}${preset.suffix}.${preset.ext}`;
  const relative = folder === "." || folder === "" ? target : `${folder}/${target}`;

  if (relative === sourceRelPath) {
    return Result.err(
      new TranscodeRejected({
        path: sourceRelPath,
        detail: `"${preset.label}" would write over the original, because the file is already ${preset.ext.toUpperCase()}. Nothing was queued.`,
      }),
    );
  }
  return Result.ok(relative);
}

// --- Progress ---------------------------------------------------------------

/**
 * ffmpeg's `-progress` output, which arrives as `key=value` lines in blocks
 * ending with `progress=continue` or `progress=end`.
 *
 * ⚠️ `out_time_us` is **microseconds**, and it is `N/A` for the first block or
 * two before any frame is written. Reading it as a number without checking is
 * how a progress bar starts at `NaN%`.
 */
export function parseProgress(chunk: string, durationSeconds: number | null): number | null {
  let microseconds: number | null = null;
  for (const line of chunk.split("\n")) {
    const [key, value] = line.split("=", 2);
    if (key?.trim() !== "out_time_us" || value === undefined) continue;
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) microseconds = parsed;
  }
  if (microseconds === null || durationSeconds === null || durationSeconds <= 0) return null;
  const percent = Math.floor((microseconds / 1_000_000 / durationSeconds) * 100);
  // 99 is the ceiling while it is still running: 100 belongs to the moment the
  // file is closed and on disk, not to the moment ffmpeg says it read the end.
  return Math.max(0, Math.min(99, percent));
}

// --- The queue --------------------------------------------------------------

export type TranscodeRow = typeof transcodes.$inferSelect;

export type TranscodeError = TranscodeRejected | NotFound | PathOutsideRoot | MountUnavailable | Timeout;

export interface TranscodeRequest {
  /** Library-relative path of the file to convert. */
  path: string;
  preset: string;
  /** ⚠️ Opt-in, and even then the original only goes to the trash. */
  replaceOriginal?: boolean;
}

export interface TranscodeOptions {
  db: Db;
  libraryRoot: string;
  /** Injected for the same reason `core/hls` injects it: one ffprobe path, one parser. */
  probe(relPath: string): Promise<Result<MediaProbe, { _tag: string; message?: string }>>;
  /**
   * Called after a job finishes successfully, with the source path — so the
   * original can be moved to the trash when `replaceOriginal` was asked for.
   * Injected rather than imported so this module never has to own the trash
   * journal, and so a test can watch it being called.
   */
  trash?(relPath: string): Promise<Result<unknown, unknown>>;
  ffmpegPath?: string;
  /** How long a failed attempt waits before it is eligible again. */
  backoffMs?: number;
  pollMs?: number;
  now?(): Date;
  log?(line: string): void;
}

/** The most log lines kept per job. ffmpeg is chatty and the row is read by a list endpoint. */
const MAX_LOG_LINES = 60;

const ACTIVE: readonly TranscodeStatus[] = ["queued", "running"];

const iso = (at: Date) => at.toISOString();

function shortId(at: Date): string {
  const stamp = iso(at).replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface TranscodeQueue {
  /**
   * Queue one file. Returns the row.
   *
   * ⚠️ Refuses rather than duplicating when the same file is already queued or
   * running: a double-click on a button that starts an hour of CPU must not
   * start two of them.
   */
  enqueue(request: TranscodeRequest): Promise<Result<TranscodeRow, TranscodeError>>;
  /**
   * Queue several, and report each one's answer separately.
   *
   * 🔴 **Partial success is the normal outcome**, not an error: a batch over a
   * folder will contain a file that is already an MP4, one that is already
   * queued and one that is fine. Failing the whole batch on the first of those
   * would make the feature unusable on any real directory.
   */
  enqueueMany(paths: readonly string[], request: Omit<TranscodeRequest, "path">): Promise<{
    queued: TranscodeRow[];
    rejected: { path: string; reason: string }[];
  }>;
  list(filter?: { status?: TranscodeStatus[]; limit?: number }): Promise<TranscodeRow[]>;
  get(id: string): Promise<Result<TranscodeRow, NotFound>>;
  /** Cancel a queued job, or kill the one that is running. */
  cancel(id: string): Promise<Result<TranscodeRow, TranscodeError>>;
  /** Anything a dead process was holding goes back to `queued`. Returns how many. */
  recoverOnStart(): Promise<number>;
  /** The polling loop. One job at a time, for ever, until `stop()`. */
  start(): void;
  stop(): Promise<void>;
  /** Run at most one job now, and answer with it. Public so a test can skip the loop. */
  runNext(): Promise<TranscodeRow | null>;
  readonly running: string | null;
}

export function createTranscodeQueue(options: TranscodeOptions): TranscodeQueue {
  const { db, libraryRoot } = options;
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const backoffMs = options.backoffMs ?? 30_000;
  const pollMs = options.pollMs ?? 2_000;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));

  /**
   * 🔴 The whole concurrency control, and it is one variable on purpose.
   *
   * `maxConcurrent` was considered and refused. There is no number above one
   * that is correct here: the second encode does not make the first finish
   * sooner, it makes Home Assistant miss its polling window. If this ever needs
   * to be two, it needs to be two on a different machine.
   */
  let active: { id: string; proc: ReturnType<typeof Bun.spawn>; cancelled: boolean } | null = null;
  let looping = false;
  let loop: Promise<void> | null = null;

  async function patch(id: string, values: Partial<TranscodeRow>, appendLog: string[] = []): Promise<void> {
    const current = appendLog.length === 0 ? null : (await db.select().from(transcodes).where(eq(transcodes.id, id)).limit(1))[0];
    const merged =
      current === null || current === undefined
        ? values
        : { ...values, log: [...current.log, ...appendLog].slice(-MAX_LOG_LINES) };
    await db.update(transcodes).set({ ...merged, updatedAt: iso(now()) }).where(eq(transcodes.id, id));
  }

  async function rowOf(id: string): Promise<Result<TranscodeRow, NotFound>> {
    const found = await db.select().from(transcodes).where(eq(transcodes.id, id)).limit(1);
    const row = found[0];
    return row === undefined ? Result.err(new NotFound({ what: "transcode", id })) : Result.ok(row);
  }

  async function enqueue(request: TranscodeRequest): Promise<Result<TranscodeRow, TranscodeError>> {
    const preset = findPreset(request.preset);
    if (preset === undefined) {
      return Result.err(
        new TranscodeRejected({ path: request.path, detail: `There is no preset called "${request.preset}".` }),
      );
    }

    // 🔴 Both halves of the path check the library routes run: the string, and
    // the resolved path. A transcode hands a path to `ffmpeg -i`, which reads
    // whatever it is given.
    const source = resolveInRoot(libraryRoot, request.path);
    if (Result.isError(source)) return source;

    const stats = await stat(source.value).catch(() => null);
    if (stats === null || !stats.isFile()) {
      return Result.err(new NotFound({ what: "library file", id: request.path }));
    }

    const planned = plannedOutput(request.path, preset);
    if (Result.isError(planned)) return planned;

    const output = resolveInRoot(libraryRoot, planned.value);
    if (Result.isError(output)) return output;

    // ⚠️ Refused here rather than at the end of an hour of encoding. `-n` would
    // catch it too, but only after the CPU had been spent.
    if (await stat(output.value).then(() => true, () => false)) {
      return Result.err(
        new TranscodeRejected({
          path: request.path,
          detail: `${planned.value} already exists. Move or rename it first — CasaTube does not overwrite files in the library.`,
        }),
      );
    }

    const already = await db
      .select()
      .from(transcodes)
      .where(and(eq(transcodes.sourcePath, request.path), inArray(transcodes.status, [...ACTIVE])))
      .limit(1);
    if (already[0] !== undefined) {
      return Result.err(
        new TranscodeRejected({
          path: request.path,
          detail: `${request.path} is already queued for conversion. One at a time, on purpose.`,
        }),
      );
    }

    const at = now();
    const row: TranscodeRow = {
      id: shortId(at),
      sourcePath: request.path,
      outputPath: planned.value,
      preset: preset.id,
      status: "queued",
      progress: 0,
      attempts: 0,
      maxAttempts: 2,
      notBefore: null,
      replaceOriginal: request.replaceOriginal === true,
      durationSeconds: null,
      sourceBytes: stats.size,
      outputBytes: null,
      error: null,
      log: [`queued ${preset.label} → ${planned.value}`],
      createdAt: iso(at),
      startedAt: null,
      finishedAt: null,
      updatedAt: iso(at),
    };
    await db.insert(transcodes).values(row);
    return Result.ok(row);
  }

  async function enqueueMany(
    paths: readonly string[],
    request: Omit<TranscodeRequest, "path">,
  ): Promise<{ queued: TranscodeRow[]; rejected: { path: string; reason: string }[] }> {
    const queued: TranscodeRow[] = [];
    const rejected: { path: string; reason: string }[] = [];
    for (const path of paths) {
      const one = await enqueue({ ...request, path });
      if (Result.isError(one)) rejected.push({ path, reason: one.error.message });
      else queued.push(one.value);
    }
    return { queued, rejected };
  }

  async function list(filter: { status?: TranscodeStatus[]; limit?: number } = {}): Promise<TranscodeRow[]> {
    const where = filter.status === undefined ? undefined : inArray(transcodes.status, filter.status);
    const query = db.select().from(transcodes);
    return await (where === undefined ? query : query.where(where))
      .orderBy(desc(transcodes.createdAt))
      .limit(filter.limit ?? 100);
  }

  async function cancel(id: string): Promise<Result<TranscodeRow, TranscodeError>> {
    const found = await rowOf(id);
    if (Result.isError(found)) return found;
    const row = found.value;
    if (row.status !== "queued" && row.status !== "running") return Result.ok(row);

    if (active?.id === id) {
      // Marked before the kill so the runner can tell "cancelled" from "ffmpeg
      // fell over", which are the same exit code and very different sentences.
      active.cancelled = true;
      try {
        active.proc.kill();
      } catch {
        // Already gone; the runner will notice on exit either way.
      }
    }
    await patch(id, { status: "cancelled", finishedAt: iso(now()) }, ["cancelled"]);
    return await rowOf(id) as Result<TranscodeRow, TranscodeError>;
  }

  async function recoverOnStart(): Promise<number> {
    const requeued = await db
      .update(transcodes)
      .set({ status: "queued", progress: 0, startedAt: null, updatedAt: iso(now()) })
      .where(eq(transcodes.status, "running"))
      .returning({ id: transcodes.id });
    // ⚠️ Deliberately **not** an incremented attempt. A restart is our fault,
    // not the file's, and charging the job for it is how a long encode dies
    // after two deploys — see the mirror of this decision in `queue.ts`.
    if (requeued.length > 0) log(`[transcode] requeued ${requeued.length} interrupted job(s)`);
    return requeued.length;
  }

  /** The next job whose turn it is: oldest first, skipping anything in backoff. */
  async function claimNext(): Promise<TranscodeRow | null> {
    const at = iso(now());
    const found = await db
      .select()
      .from(transcodes)
      .where(
        and(eq(transcodes.status, "queued"), or(isNull(transcodes.notBefore), lte(transcodes.notBefore, at))),
      )
      .orderBy(asc(transcodes.createdAt))
      .limit(1);
    return found[0] ?? null;
  }

  async function runNext(): Promise<TranscodeRow | null> {
    if (active !== null) return null;
    const next = await claimNext();
    if (next === null) return null;
    await runOne(next);
    return (await rowOf(next.id).then((r) => (Result.isError(r) ? null : r.value))) ?? null;
  }

  async function runOne(row: TranscodeRow): Promise<void> {
    const preset = findPreset(row.preset);
    if (preset === undefined) {
      await patch(row.id, { status: "failed", error: `Unknown preset "${row.preset}".`, finishedAt: iso(now()) });
      return;
    }

    const source = resolveInRoot(libraryRoot, row.sourcePath);
    const output = resolveInRoot(libraryRoot, row.outputPath);
    if (Result.isError(source) || Result.isError(output)) {
      await patch(row.id, { status: "failed", error: "The path left the library root.", finishedAt: iso(now()) });
      return;
    }

    // Probed here rather than at enqueue time: it is the denominator for
    // progress and nothing before this moment needs it, and a probe at enqueue
    // would open every file in a batch the instant the button was pressed.
    const probed = await options.probe(row.sourcePath);
    const probedDuration = Result.isError(probed) ? null : probed.value.durationSeconds;
    const duration = probedDuration === null || !Number.isFinite(probedDuration) ? null : Math.round(probedDuration);

    await patch(
      row.id,
      { status: "running", startedAt: iso(now()), progress: 0, error: null, durationSeconds: duration },
      [`ffmpeg ${preset.id}: ${row.sourcePath} → ${row.outputPath}`],
    );

    const args = buildTranscodeArgs(source.value, output.value, preset);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([ffmpegPath, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (cause) {
      await failed(row, `ffmpeg could not be started: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    active = { id: row.id, proc, cancelled: false };

    // ⚠️ Both pipes are drained. A process whose stderr fills its pipe buffer
    // stops writing and then stops working, and a two-hour encode produces far
    // more than a pipe buffer of ffmpeg chatter.
    const tail: string[] = [];
    const readStderr = (async () => {
      const text = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      for (const line of text.split("\n")) if (line.trim() !== "") tail.push(line.trim());
    })();

    const readProgress = (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let last = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const percent = parseProgress(decoder.decode(value, { stream: true }), duration);
        // Written only when the number changes: an encode emits a progress
        // block roughly every half second, and a row updated that often is a
        // write per frame for nothing.
        if (percent !== null && percent !== last) {
          last = percent;
          await patch(row.id, { progress: percent });
        }
      }
    })();

    const code = await proc.exited;
    await Promise.allSettled([readProgress, readStderr]);
    const cancelled = active?.cancelled === true;
    active = null;

    if (cancelled) {
      await rm(output.value, { force: true }).catch(() => undefined);
      await patch(row.id, { status: "cancelled", finishedAt: iso(now()) }, ["cancelled; the partial file was removed"]);
      return;
    }

    if (code !== 0) {
      // 🔴 The half-written output goes. Leaving it would put a file in the
      // library that looks like a video and is a truncated encode — and the
      // retry would then refuse to run because "the output already exists".
      await rm(output.value, { force: true }).catch(() => undefined);
      await failed(row, ffmpegReason(tail, code), tail.slice(-8));
      return;
    }

    const written = await stat(output.value).catch(() => null);
    if (written === null || written.size === 0) {
      await rm(output.value, { force: true }).catch(() => undefined);
      await failed(row, "ffmpeg reported success and wrote nothing.", tail.slice(-8));
      return;
    }

    if (row.replaceOriginal && options.trash !== undefined) {
      // ⚠️ Only ever after a verified output, and only ever into `.trash/`.
      const moved = await options.trash(row.sourcePath);
      if (Result.isError(moved)) {
        await patch(row.id, { status: "done", progress: 100, outputBytes: written.size, finishedAt: iso(now()) }, [
          "the copy is fine, but the original could not be moved to the trash — it is still there",
        ]);
        return;
      }
      await patch(row.id, { status: "done", progress: 100, outputBytes: written.size, finishedAt: iso(now()) }, [
        "the original was moved to .trash/ — restore it from the Trash tab if the copy is wrong",
      ]);
      return;
    }

    await patch(row.id, { status: "done", progress: 100, outputBytes: written.size, finishedAt: iso(now()) }, [
      `wrote ${row.outputPath} (${written.size} bytes)`,
    ]);
  }

  async function failed(row: TranscodeRow, reason: string, extra: string[] = []): Promise<void> {
    const attempts = row.attempts + 1;
    const exhausted = attempts >= row.maxAttempts;
    await patch(
      row.id,
      {
        attempts,
        status: exhausted ? "failed" : "queued",
        error: reason,
        progress: 0,
        ...(exhausted ? { finishedAt: iso(now()) } : { notBefore: iso(new Date(now().getTime() + backoffMs)) }),
      },
      [`attempt ${attempts}/${row.maxAttempts} failed: ${reason}`, ...extra],
    );
  }

  /**
   * One sentence out of ffmpeg's last words.
   *
   * ⚠️ The useful line is rarely the last one — ffmpeg finishes with a
   * statistics dump — so the first line that reads like an error wins, and the
   * exit code is the fallback rather than the answer.
   */
  function ffmpegReason(tail: string[], code: number): string {
    const named = tail.find((line) => /error|invalid|unable|not supported|no such|failed/i.test(line));
    return named ?? `ffmpeg exited with code ${code}.`;
  }

  function start(): void {
    if (looping) return;
    looping = true;
    loop = (async () => {
      while (looping) {
        const ran = await runNext().catch((cause: unknown) => {
          log(`[transcode] runner error: ${cause instanceof Error ? cause.message : String(cause)}`);
          return null;
        });
        if (ran === null) await Bun.sleep(pollMs);
      }
    })();
  }

  async function stop(): Promise<void> {
    looping = false;
    if (active !== null) {
      // 🔴 Not marked cancelled: the row stays `running`, and `recoverOnStart`
      // turns it back into `queued` on the next boot. A shutdown must not look
      // to the user like a decision somebody made.
      try {
        active.proc.kill();
      } catch {
        // Already gone.
      }
    }
    await loop?.catch(() => undefined);
    loop = null;
  }

  return {
    enqueue,
    enqueueMany,
    list,
    get: rowOf,
    cancel,
    recoverOnStart,
    start,
    stop,
    runNext,
    get running() {
      return active?.id ?? null;
    },
  };
}
