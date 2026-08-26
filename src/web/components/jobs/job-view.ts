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

/** What the plan says will be produced — never a guess when the plan is absent. */
export function formatLabel(job: Job): string {
  const plan = job.plan;
  if (!plan) return "—";
  const parts: string[] = [];
  if (plan.video?.height) parts.push(`${plan.video.height}p`);
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
  return job.url;
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

/** The buckets the Downloads tabs are made of. */
export function bucketOf(job: Job): "active" | "completed" | "failed" | "scheduled" {
  if (job.status === "done") return "completed";
  if (job.status === "failed" || job.status === "cancelled") return "failed";
  // 🔴 `notBefore` in the future is a job waiting out its retry backoff — the
  // column exists so the wait survives a restart. It is scheduled, not stuck.
  if (job.notBefore && Date.parse(job.notBefore) > Date.now()) return "scheduled";
  if (job.paused) return "scheduled";
  return "active";
}
