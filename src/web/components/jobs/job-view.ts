/**
 * Job facts, in the words a person uses.
 *
 * These are pure functions over a `Job` rather than methods on it: the row, the
 * inspector and the dashboard all need the same sentence, and three copies of
 * "1080p · MP4" is how two of them end up disagreeing about what was actually
 * downloaded.
 */
import type { Job, JobStatus } from "../../../core/types";
import { splitPath } from "../../data/format";
import { resolutionOf } from "../../../core/resolution";

/** What the plan says will be produced — never a guess when the plan is absent. */
export function formatLabel(job: Job): string {
  const plan = job.plan;
  if (!plan) return "—";
  const parts: string[] = [];
  // The same rule the form and the ceiling use: a 1920×800 film is 1080p here
  // too, not the "800p" this column used to say beside a form that said 1080p.
  const resolution = plan.video ? resolutionOf(plan.video) : null;
  if (resolution) parts.push(`${resolution}p`);
  else if (plan.audio.length > 0) parts.push("audio");
  const codec = plan.video?.codec ?? plan.audio[0]?.codec;
  if (codec) parts.push(codec.split(".")[0]!.toUpperCase());
  if (plan.subtitles.length > 0) parts.push(`${plan.subtitles.length} sub`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** A title if there is one, and something legible if there is not. */
export function jobTitle(job: Job): string {
  if (job.title && job.title.trim() !== "") return job.title;
  if (job.outputFile) return splitPath(job.outputFile).name;
  return readableUrl(job.url);
}

/**
 * A link as a person would say it, for a job that has no title yet — before
 * analysis there is nothing else to show. `youtube.com/watch?v=R6MlUcmOul8`
 * rather than `https://www.youtube.com/watch?v=R6MlUcmOul8`.
 */
export function readableUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

/** The bar's percentage, and whether it is knowable yet. */
export function progressOf(job: Job): { percent: number; indeterminate: boolean } {
  if (job.status === "done") return { percent: 100, indeterminate: false };
  if (job.status === "queued" || job.status === "cancelled") return { percent: 0, indeterminate: false };
  const known = job.progress > 0;
  return { percent: job.progress, indeterminate: !known && job.status !== "failed" };
}

export const WAITING: readonly JobStatus[] = ["queued", "waiting-for-destination"] as const;
export const RUNNING: readonly JobStatus[] = ["analyzing", "downloading", "processing", "moving"] as const;

/**
 * The buckets the Downloads tabs are made of.
 *
 * ⚠️ **Re-exported, not defined here.** The server filters and counts by bucket
 * now, so the rule lives in `core/job-buckets.ts` beside the SQL that has to
 * mean the same thing — with a test that runs both over one corpus. A second
 * copy here would be a tab whose count and whose rows came from different
 * definitions of the same word.
 */
export { bucketOf } from "../../../core/job-buckets";
