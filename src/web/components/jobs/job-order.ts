/**
 * The sort control's labels, and reading the server's file check.
 *
 * 🔴 **The sorting and the text search used to be here, and their absence is
 * the point.** They ran over the page the server had already sent, so "the
 * largest failed download" meant "the largest of the latest two hundred" and
 * nothing on screen marked the difference. `GET /api/jobs` takes `sort`,
 * `order`, `q`, `status` and `bucket` now and answers with `total`;
 * `core/queue.ts` owns the ordering, including the two rules that used to live
 * in this file — unknown values sink in both directions, and equal keys break
 * on newest-first so the table cannot shuffle between two polls.
 *
 * What is left is what the browser genuinely owns. The **labels** on the sort
 * control, because "ascending priority" is a sentence about ranks and the
 * person reading it wants to know whether High is at the top. And the **file
 * state**, which is not a column at all: it is the answer to a `stat` the
 * server made separately (`POST /api/jobs/file-state`), so it can only ever be
 * applied to rows already in hand.
 */
import type { Job } from "../../../core/types";
import type { JobFileState } from "../../data/queries";
import type { FileFilter, JobSort, SortOrder } from "../../search-params";

/**
 * What each direction *means*, per sort.
 *
 * 🔴 "Ascending priority" is a sentence about ranks, and the person reading it
 * wants to know whether High is at the top. So the control never says asc/desc:
 * it says "Highest first". The mapping is here so the two screens cannot label
 * the same toggle differently.
 */
export const SORT_LOOK: Record<JobSort, { label: string; asc: string; desc: string }> = {
  date: { label: "Date added", asc: "Oldest first", desc: "Newest first" },
  status: { label: "Status", asc: "Active first", desc: "Finished first" },
  priority: { label: "Priority", asc: "Highest first", desc: "Lowest first" },
  size: { label: "Size", asc: "Smallest first", desc: "Largest first" },
  duration: { label: "Duration", asc: "Shortest first", desc: "Longest first" },
};

export function directionLabel(sort: JobSort, order: SortOrder): string {
  return order === "asc" ? SORT_LOOK[sort].asc : SORT_LOOK[sort].desc;
}

// --- What became of the file ------------------------------------------------

/**
 * 🔴 **Five states now, and the server established every one of them by
 * looking.**
 *
 * This block used to derive the answer here, in the browser, from two strings:
 * a job's recorded `outputFile` and the library's trash listing. It could
 * therefore say *Filed* — "CasaTube put it there" — and nothing more, and the
 * badge's own tooltip had to admit that a file deleted outside CasaTube read
 * exactly the same way. That was documented as a limitation and it was a fault:
 * the screen showed a fact adjacent to the one it was asked for.
 *
 * `POST /api/jobs/file-state` now answers it properly (`core/file-state.ts`),
 * and the derivation is gone rather than duplicated. What is left here is the
 * part that is genuinely the browser's: matching an answer to a row, and
 * deciding what a filter means.
 *
 * | | |
 * |---|---|
 * | `present` | on disk, at the recorded path, when the check ran |
 * | `missing` | the library answered and there is nothing there |
 * | `trashed` | in CasaTube's trash — restorable from the Library screen |
 * | `none` | finished, and no path was ever recorded |
 * | `unknown` | nothing could be established, and `reason` says what stopped it |
 */
export type FileState = JobFileState["state"];

/**
 * Why an answer is `unknown` — the server's reasons, plus the one the browser
 * owns.
 *
 * `not-checked` is not a failure: it is "no answer has arrived for this row
 * yet", which is what every row looks like before the first check returns and
 * what a row looks like if it was not in the batch. Distinguishing it from
 * `mount-unavailable` is what lets the badge stay quiet during the former and
 * speak up during the latter.
 */
export type FileStateReason = NonNullable<JobFileState["reason"]> | "not-checked";

export interface ResolvedFileState {
  state: FileState;
  reason?: FileStateReason;
  /** The server's sentence, shown verbatim rather than re-worded here. */
  detail?: string;
  path?: string;
  size?: number;
  modifiedAt?: string;
  trashId?: string;
}

const NOT_CHECKED: ResolvedFileState = { state: "unknown", reason: "not-checked" };

/**
 * The check's answers, by job id.
 *
 * `null` when there is no answer to index — the query has not run, or it
 * failed. It travels as `null` all the way to the badge, which then draws
 * nothing rather than inventing a verdict.
 */
export function indexFileStates(states: readonly JobFileState[] | undefined): Map<string, JobFileState> | null {
  if (states === undefined) return null;
  return new Map(states.map((state) => [state.id, state]));
}

/**
 * What this row should say about its file.
 *
 * ⚠️ An id with no answer is `not-checked`, **never** `missing`. The two cases
 * that produce it — the check has not returned, and this job was not in the
 * batch — are both "we have not looked", and the entire point of this work is
 * that "we have not looked" and "it is gone" stopped being the same badge.
 */
export function fileStateOf(job: Job, index: Map<string, JobFileState> | null): ResolvedFileState {
  if (index === null) return NOT_CHECKED;
  const found = index.get(job.id);
  if (found === undefined) return NOT_CHECKED;
  const { id: _id, ...rest } = found;
  return rest;
}

/**
 * Does this row belong in the current filter?
 *
 * ⚠️ **`unknown` deliberately excludes a job that has not finished.** A running
 * download has no file yet, which is not the same as a file that could not be
 * checked — and a filter called "Could not check" that returned every active
 * job would bury the handful of rows a person is actually hunting for.
 */
export function matchesFile(state: ResolvedFileState, filter: FileFilter): boolean {
  if (filter === "any") return true;
  if (filter === "unknown") {
    return state.state === "unknown" && state.reason !== "not-finished" && state.reason !== "not-checked";
  }
  return state.state === filter;
}

/**
 * The ids worth asking the disk about: the finished ones, and nothing else.
 *
 * ⚠️ One pass, and **not** memoised at the call site. `jobs.data?.jobs ?? []`
 * is a fresh array on any render where the query has no data, so a `useMemo`
 * keyed on it re-runs every render anyway — it buys nothing and costs a
 * dependency that lies. The answer is a *string* in the query key, so its
 * identity does not matter; only its contents do.
 */
export function finishedIds(jobs: readonly Job[]): string[] {
  const ids: string[] = [];
  for (const job of jobs) if (job.status === "done") ids.push(job.id);
  return ids;
}

/** Rows whose file the server says is gone — what the re-download offer counts. */
export function missingCount(jobs: readonly Job[], index: Map<string, JobFileState> | null): number {
  if (index === null) return 0;
  let total = 0;
  for (const job of jobs) if (fileStateOf(job, index).state === "missing") total += 1;
  return total;
}
