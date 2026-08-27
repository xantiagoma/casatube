/**
 * What is running right now, derived from the queue snapshot.
 *
 * Pure and separate from the component on purpose. This is the part with rules
 * in it — which jobs count as *running*, which stage they are in, what the bar
 * should read — and rules are worth testing without a DOM. The `.tsx` next to
 * it takes this and draws it.
 *
 * 🔴 **Derived, never subscribed.** The data is the same `QueueSnapshot` the
 * SSE stream already pushes into the React Query cache (`data/stream.ts`), so
 * the indicator costs no request, no second stream and no poll of its own. It
 * simply reads the entry the queue screens already read. Anything else would
 * mean a header widget quietly opening a second connection on every screen.
 */
import type { Job, StageName } from "../../../core/types";
import { jobTitle, progressOf, RUNNING } from "../jobs/job-view";
import { statusLook } from "../status";

/**
 * The stage, in as few words as fit in a 20rem card.
 *
 * ⚠️ Deliberately shorter than `StageTrack`'s labels, which have a whole row to
 * themselves. "Post-process (ffmpeg)" wraps to two lines here and pushes the
 * progress bar off the card; "Merging" does not. Same six stages, a different
 * amount of room, so a different set of words rather than a shared one that
 * fits neither.
 */
const STAGE_LABEL: Record<StageName, string> = {
  validate: "Checking the link",
  analyze: "Reading formats",
  download: "Downloading",
  postprocess: "Merging",
  metadata: "Tagging",
  move: "Moving to library",
};

export interface ActiveJobView {
  id: string;
  /** Sort key. Kept on the view so the ordering rule stays in this file. */
  createdAt: string;
  title: string;
  /** What is happening, in a few words. */
  stage: string;
  percent: number;
  /** ⚠️ True while the job is working and has reported no bytes yet. */
  indeterminate: boolean;
  speed: number | null;
  eta: number | null;
  doneBytes: number | null;
  totalBytes: number | null;
}

export interface ActivitySummary {
  running: ActiveJobView[];
  /** Waiting for a slot. Context, not activity — see the note below. */
  queued: number;
  /**
   * The single number the trigger shows.
   *
   * ⚠️ Running jobs only. A queue of forty with nothing being worked on is not
   * "40 downloads in progress", and a badge that said so would be the same lie
   * as a progress bar at 100% during a merge.
   */
  count: number;
  /** With exactly one job running, its percentage — otherwise `null`. */
  soloPercent: number | null;
}

const RUNNING_SET = new Set<string>(RUNNING);

/**
 * The stage a job is in, preferring the pipeline record over the status word.
 *
 * `status` is one word for six stages: "processing" covers both the ffmpeg
 * merge and the metadata pass, and those look identical from outside while
 * behaving nothing alike (PLAN §6). The stage record distinguishes them, so it
 * is asked first; the status is the fallback for a job whose stages have not
 * been written yet.
 */
function stageOf(job: Job): string {
  const running = job.stages.find((stage) => stage.status === "running");
  if (running) return STAGE_LABEL[running.name] ?? statusLook(job.status).label;
  return statusLook(job.status).label;
}

export function summariseActivity(jobs: Job[] | undefined): ActivitySummary {
  const running: ActiveJobView[] = [];
  let queued = 0;

  for (const job of jobs ?? []) {
    if (job.status === "queued" && !job.paused) {
      queued += 1;
      continue;
    }
    if (!RUNNING_SET.has(job.status)) continue;

    const { percent, indeterminate } = progressOf(job);
    running.push({
      id: job.id,
      createdAt: job.createdAt,
      title: jobTitle(job),
      stage: stageOf(job),
      percent,
      indeterminate,
      speed: job.speed,
      eta: job.eta,
      doneBytes: job.doneBytes,
      totalBytes: job.totalBytes,
    });
  }

  // Oldest first, by `createdAt` rather than by progress. The worker takes one
  // job at a time, so this is almost always a list of one — and when a hand-off
  // makes it two, a fixed order is worth more than a clever one: a list that
  // re-sorts itself every time one percentage overtakes another is unreadable
  // on a card this small.
  running.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id)));

  return {
    running,
    queued,
    count: running.length,
    soloPercent: running.length === 1 && !running[0]!.indeterminate ? running[0]!.percent : null,
  };
}
