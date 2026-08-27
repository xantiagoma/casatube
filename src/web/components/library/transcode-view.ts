/**
 * Conversions, as pure functions over the rows the server sends.
 *
 * 🔴 They live apart from the components for the reason `jobs/job-order.ts`
 * does: there is no DOM harness in this repo, so anything written inside a
 * component is logic nothing checks. The three sentences this feature exists to
 * get right — *it re-encodes*, *one at a time*, *the original is never touched*
 * — are decided here and rendered there.
 *
 * ⚠️ Everything here reads the server's own vocabulary. It never invents a cost
 * or a concurrency number: `cost` comes off the preset, `concurrency` off
 * `/presets`, and a rejection's wording off the response. What is computed here
 * is only what the server has no view of — the *order of the rows on screen*
 * and how many jobs stand in front of this one.
 */
import type { TranscodeRow, TranscodeStatus } from "../../../core/transcode";
import type { Tone } from "../status";

/**
 * ⚠️ **`row.status` is a `string`, not `TranscodeStatus`.** The column is a
 * plain `text()` with no `$type<>()`, so every lookup here has to survive a
 * value this build has never heard of — a server mid-upgrade writing a new
 * state, or a row from an older one. Every table below is therefore keyed on
 * `string` with a fallback, rather than exhaustively on the union, which would
 * type-check and then render `undefined` on the one row that matters.
 */

// --- How a row looks --------------------------------------------------------

interface TranscodeLook {
  label: string;
  tone: Tone;
}

const LOOKS: Record<TranscodeStatus, TranscodeLook> & Record<string, TranscodeLook | undefined> = {
  // "Waiting" rather than "Queued": the whole point of the copy around it is
  // that a queued conversion is *not* stuck, it is behind another one.
  queued: { label: "Waiting", tone: "idle" },
  running: { label: "Converting", tone: "busy" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "idle" },
};

export function transcodeLook(status: string): TranscodeLook {
  return LOOKS[status] ?? { label: status, tone: "idle" };
}

export function isActiveTranscode(row: TranscodeRow): boolean {
  return row.status === "queued" || row.status === "running";
}

export function activeTranscodes(jobs: readonly TranscodeRow[]): TranscodeRow[] {
  return jobs.filter(isActiveTranscode);
}

/** Can this row still be stopped? Cancelling anything else is a no-op the server absorbs. */
export function isCancellable(row: TranscodeRow): boolean {
  return isActiveTranscode(row);
}

// --- Order ------------------------------------------------------------------

const PHASE: Record<TranscodeStatus, number> & Record<string, number | undefined> = {
  running: 0,
  queued: 1,
  failed: 2,
  done: 3,
  cancelled: 4,
};

/**
 * Screen order: what is happening, then what is about to, then what happened.
 *
 * ⚠️ The **waiting** rows are oldest-first and everything else newest-first,
 * and the difference is deliberate. Among the queued, oldest-first *is the
 * order they will run in* — the server claims `status = queued` by
 * `createdAt asc` — so showing them any other way would draw a queue that
 * disagrees with the machine. Among the finished, the newest is the one being
 * looked for.
 *
 * The order is total (ties break on `id`), so a poll landing between two rows
 * with the same timestamp cannot shuffle them.
 */
export function sortTranscodes(jobs: readonly TranscodeRow[]): TranscodeRow[] {
  // `toSorted`, not `[...].sort()`: the input is the React Query cache entry,
  // and sorting it in place would reorder the array every other reader holds.
  return jobs.toSorted((a, b) => {
    const phase = (PHASE[a.status] ?? 9) - (PHASE[b.status] ?? 9);
    if (phase !== 0) return phase;
    const direction = a.status === "queued" ? 1 : -1;
    const at = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (Number.isFinite(at) && at !== 0) return at * direction;
    return a.id < b.id ? -direction : a.id > b.id ? direction : 0;
  });
}

/**
 * How many conversions will run before this one.
 *
 * 🔴 This is the number that makes `concurrency: 1` legible. Five rows all
 * reading "Waiting" look like five things that have stopped; "2 ahead of this
 * one" is the same fact as a queue.
 *
 * ⚠️ It counts the running job as one ahead, and it counts **waiting rows
 * only** — a failed row between them is not in anybody's way.
 *
 * ⚠️ Approximate in exactly one case, and it is not worth being exact about: a
 * row that has failed once waits out a backoff (`notBefore`) before it is
 * eligible again, so a later row can overtake it. Saying "2 ahead" when it
 * turns out to be 1 is a smaller failure than the alternative, which is to
 * describe the retry mechanism in a queue position.
 */
export function transcodesAhead(jobs: readonly TranscodeRow[], id: string): number {
  const row = jobs.find((job) => job.id === id);
  if (row === undefined || row.status !== "queued") return 0;
  const mine = Date.parse(row.createdAt);
  let ahead = 0;
  for (const job of jobs) {
    if (job.id === id) continue;
    if (job.status === "running") ahead += 1;
    else if (job.status === "queued" && Date.parse(job.createdAt) < mine) ahead += 1;
  }
  return ahead;
}

/** "Next in line" / "2 ahead of it" — the queue position, in words. */
export function queuePositionLabel(ahead: number): string {
  if (ahead <= 0) return "Next in line";
  return ahead === 1 ? "1 conversion ahead of it" : `${ahead} conversions ahead of it`;
}

/**
 * The one line that explains a screen full of "Waiting".
 *
 * 🔴 `concurrency` is the server's number, passed in rather than assumed —
 * `/presets` sends it precisely so this sentence is not a guess. It is 1 today
 * and the wording still has to survive it not being.
 */
export function concurrencyLine(jobs: readonly TranscodeRow[], concurrency: number): string | null {
  const waiting = jobs.filter((job) => job.status === "queued").length;
  const running = jobs.filter((job) => job.status === "running").length;
  if (waiting === 0 && running === 0) return null;
  const limit =
    concurrency === 1
      ? "One conversion runs at a time"
      : `Up to ${concurrency} conversions run at a time`;
  if (waiting === 0) return `${limit}. Nothing else is waiting.`;
  const rest =
    waiting === 1 ? "the other one is waiting its turn" : `the other ${waiting} are waiting their turn`;
  return `${limit}, so ${rest} — not stuck.`;
}

// --- Progress ---------------------------------------------------------------

/**
 * What the bar should show.
 *
 * ⚠️ **`indeterminate` is not decoration.** `core/transcode.ts` computes the
 * percentage against the probed duration and reports `null` when the file has
 * none — a stream with no duration, an unprobeable source — and `progress`
 * then stays at 0 for the whole encode. A bar frozen at 0% says "nothing is
 * happening" about a job using the entire machine.
 *
 * ⚠️ 99 is the runner's ceiling while ffmpeg is alive: 100 belongs to the
 * moment the file is closed on disk. Nothing here rounds that up.
 */
export function transcodeProgress(row: TranscodeRow): { percent: number; indeterminate: boolean } {
  if (row.status === "done") return { percent: 100, indeterminate: false };
  if (row.status !== "running") return { percent: row.progress, indeterminate: false };
  // Running, and the denominator was never known: ffmpeg is working, the
  // fraction is not knowable. Also true for the first seconds of every job,
  // before the first progress block arrives.
  return { percent: row.progress, indeterminate: row.durationSeconds === null || row.progress === 0 };
}

/** `Videos/Film (TV).mp4` → `Film (TV).mp4`. */
export function fileNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The conversions that concern one library file, newest first. */
export function transcodesForPath(jobs: readonly TranscodeRow[], path: string): TranscodeRow[] {
  return sortTranscodes(jobs.filter((job) => job.sourcePath === path));
}

/**
 * Whether this file already has a conversion in flight.
 *
 * ⚠️ The server refuses a second one (`"… is already queued for conversion"`),
 * so this is not the guard — it is what lets the button say so *before* it is
 * pressed instead of returning a rejection afterwards.
 */
export function hasActiveTranscode(jobs: readonly TranscodeRow[], path: string): boolean {
  return jobs.some((job) => job.sourcePath === path && isActiveTranscode(job));
}

// --- What came back from a batch --------------------------------------------

export interface TranscodeOutcomeSummary {
  queued: number;
  rejected: number;
  /** A whole-sentence headline. `null` when nothing was asked for. */
  headline: string;
}

/**
 * What to say after pressing the button.
 *
 * 🔴 **A batch that half-worked is the normal outcome**, not an error: point
 * this at a folder and some of it is already MP4, already queued, or gone. The
 * headline therefore always names *both* numbers when both exist — a dialog
 * that reports only the successes is how a file silently does not get
 * converted.
 */
export function summariseOutcome(outcome: {
  queued: readonly unknown[];
  rejected: readonly unknown[];
}): TranscodeOutcomeSummary {
  const queued = outcome.queued.length;
  const rejected = outcome.rejected.length;
  const files = (n: number): string => `${n} file${n === 1 ? "" : "s"}`;

  if (queued === 0 && rejected === 0) return { queued, rejected, headline: "Nothing was queued." };
  if (queued === 0) return { queued, rejected, headline: `Nothing was queued — ${files(rejected)} could not be.` };
  if (rejected === 0) {
    return { queued, rejected, headline: queued === 1 ? "Queued for conversion." : `${files(queued)} queued for conversion.` };
  }
  return { queued, rejected, headline: `${files(queued)} queued; ${rejected} could not be — see below.` };
}
