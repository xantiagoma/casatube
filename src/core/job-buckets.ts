/**
 * The four buckets the Downloads tabs are made of — the rule, defined once.
 *
 * It used to live in `src/web/components/jobs/job-view.ts`, which was correct
 * while the browser did the filtering. It cannot stay there now that the server
 * filters too: a rule expressed twice is a rule that drifts, and the drift here
 * would be close to invisible — a tab whose count came from one definition and
 * whose rows came from the other.
 *
 * 🔴 **This file imports nothing but types, and that is load-bearing.** The SQL
 * half lives in `job-buckets-query.ts` because it needs `./schema`, and a
 * browser module that reaches a schema import drags `bun:sqlite` into the
 * client bundle — which type-checks perfectly and then fails to build, leaving
 * every route answering 200 with a blank page (`docs/DISCOVERIES.md`). The
 * Downloads screen imports *this* file.
 *
 * ⚠️ The two halves are not obviously the same rule and nothing makes them
 * agree. `job-buckets.test.ts` runs one corpus through both and asserts they
 * produce the same partition; that test is what makes the split safe.
 */
import { ACTIVE_STATUSES, type Job, type JobStatus } from "./types";

export const JOB_BUCKETS = ["active", "completed", "failed", "scheduled"] as const;

export type JobBucket = (typeof JOB_BUCKETS)[number];

/** `cancelled` sits with `failed`: both mean "it did not happen". */
export const FAILED_STATUSES: readonly JobStatus[] = ["failed", "cancelled"] as const;

/** Everything that has not reached an end. A terminal row can never be `scheduled`. */
export const UNFINISHED_STATUSES: readonly JobStatus[] = [
  ...ACTIVE_STATUSES,
  "queued",
  "waiting-for-destination",
] as const;

/**
 * Which bucket a job is in.
 *
 * 🔴 `notBefore` in the future is a job waiting out its retry backoff — the
 * column exists so that the wait survives a restart. It is *scheduled*, not
 * stuck, and showing it as active is how a queue looks broken while it is
 * behaving exactly as designed. A paused job is scheduled for the same reason:
 * it is waiting on a decision rather than on the worker.
 *
 * `now` is a parameter so a test can place a job on either side of the line
 * without waiting, and so one screen render cannot classify two jobs against
 * two different readings of the clock.
 */
export function bucketOf(job: Job, now: number = Date.now()): JobBucket {
  if (job.status === "done") return "completed";
  if (FAILED_STATUSES.includes(job.status)) return "failed";
  if (job.notBefore && Date.parse(job.notBefore) > now) return "scheduled";
  if (job.paused) return "scheduled";
  return "active";
}
