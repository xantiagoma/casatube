/**
 * The bucket rule as a WHERE clause — the server's half of `job-buckets.ts`.
 *
 * Separate from the predicate for one reason and it is not tidiness: this file
 * imports `./schema`, and anything the browser reaches must not. Importing a
 * value out of a schema-importing module pulls `bun:sqlite` into the client
 * bundle, which type-checks and then fails to build — every route answering 200
 * with a blank page (`docs/DISCOVERIES.md`). The screens import
 * `job-buckets.ts`; only the queue imports this.
 */
import { and, eq, gt, inArray, isNotNull, not, or, type SQL } from "drizzle-orm";

import { FAILED_STATUSES, UNFINISHED_STATUSES, type JobBucket } from "./job-buckets";
import { jobs } from "./schema";

/**
 * ⚠️ `notBefore` is compared as **text**, which is correct only because every
 * timestamp in this database is a UTC ISO-8601 string of the same shape, so
 * lexicographic order is chronological order. `claimNext` already depends on
 * this; it is written down here because the day someone stores a local time is
 * the day both stop working, quietly.
 */
export function bucketCondition(bucket: JobBucket, now: string = new Date().toISOString()): SQL {
  const scheduled = or(
    and(isNotNull(jobs.notBefore), gt(jobs.notBefore, now)),
    eq(jobs.paused, true),
  ) as SQL;

  switch (bucket) {
    case "completed":
      return eq(jobs.status, "done");
    case "failed":
      return inArray(jobs.status, [...FAILED_STATUSES]);
    case "scheduled":
      return and(inArray(jobs.status, [...UNFINISHED_STATUSES]), scheduled) as SQL;
    case "active":
      // Exactly the complement of `scheduled` within the unfinished rows, and
      // written as the negation of the *same* expression rather than as a
      // second hand-authored clause — that is how two conditions stop being
      // complements without anybody noticing.
      return and(inArray(jobs.status, [...UNFINISHED_STATUSES]), not(scheduled)) as SQL;
  }
}
