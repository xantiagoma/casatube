/**
 * Ordering, filtering, and reading the server's file check — as pure functions.
 *
 * 🔴 They live apart from the screens for the reason `job-view.ts` does: the
 * Queue and Downloads sort and filter the *same* jobs, and two copies of "newest
 * first" is how the two screens end up disagreeing about which one that is.
 * Being pure also makes them the only part of this work a test can reach —
 * there is no DOM test setup in this repo, so a sort written inside a component
 * is a sort nothing checks.
 *
 * ⚠️ **The sorting and the text search are client-side over the snapshot the
 * server already sent.** The file state is not, and no longer is: it comes from
 * `POST /api/jobs/file-state`, because the disk is not something the browser
 * can be given a copy of.
 *
 * `GET /api/jobs` returns up to 200 jobs ordered by priority then oldest-first,
 * with no sort or search parameters of its own; re-ordering here is therefore
 * re-ordering *that page*, not the whole history. See the report: a server-side
 * `sort`/`order`/`q` on the jobs route is what would make this exact past the
 * two-hundredth job.
 */
import type { Job, JobStatus, Priority } from "../../../core/types";
import type { JobFileState } from "../../data/queries";
import type { FileFilter, JobSort, QueueFilter, SortOrder } from "../../search-params";
import { RUNNING, WAITING, bucketOf, jobTitle } from "./job-view";

// --- Sorting ----------------------------------------------------------------

/**
 * Status, as a line from "moving right now" to "will never move again".
 *
 * The lifecycle order rather than the alphabet: sorting by status is asked for
 * to bring the *busy* rows together, and `analyzing` next to `cancelled` next to
 * `done` answers a question nobody has.
 */
const STATUS_RANK: Record<JobStatus, number> = {
  downloading: 0,
  processing: 1,
  moving: 2,
  analyzing: 3,
  "waiting-for-destination": 4,
  queued: 5,
  done: 6,
  failed: 7,
  cancelled: 8,
};

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/**
 * The number a sort compares, or `null` when the job simply does not have it.
 *
 * ⚠️ `null` is not zero. A job that has never reported a size is not a 0-byte
 * job, and sorting it as one puts the unknowns in the middle of the answer
 * — see `sortJobs`, which keeps them at the end in both directions.
 */
function sortKey(job: Job, sort: JobSort): number | null {
  switch (sort) {
    case "date": {
      const at = Date.parse(job.createdAt);
      return Number.isFinite(at) ? at : null;
    }
    case "status":
      return STATUS_RANK[job.status] ?? 99;
    case "priority":
      return PRIORITY_RANK[job.priority] ?? PRIORITY_RANK.normal;
    case "size":
      // What the download is expected to weigh. `doneBytes` would rank a job by
      // how far along it is, which is the progress bar's job, not the size's.
      return job.totalBytes ?? null;
    case "duration":
      return job.duration ?? null;
  }
}

/**
 * Sorted, newest-first by default.
 *
 * Three properties worth stating, because each one is a bug when it is missing:
 *
 * 1. **Unknowns sink.** A job with no size sorts last whether the direction is
 *    largest-first or smallest-first. Flipping the direction must not promote
 *    "we don't know" to the top of the screen.
 * 2. **The order is total.** Ties break on `createdAt` and then `id`, so the
 *    rows do not shuffle when an SSE frame arrives and re-renders the table with
 *    equal keys — `Array.prototype.sort` is stable, but the *input* array is a
 *    fresh snapshot each frame, so stability alone guarantees nothing.
 * 3. **It does not mutate.** The array belongs to the React Query cache, so
 *    this is `toSorted`, not `sort` — sorting the cache in place would reorder
 *    the Dashboard's copy of the same snapshot as a side effect.
 */
export function sortJobs(jobs: readonly Job[], sort: JobSort, order: SortOrder): Job[] {
  const direction = order === "asc" ? 1 : -1;
  return jobs.toSorted((a, b) => {
    const left = sortKey(a, sort);
    const right = sortKey(b, sort);

    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else if (left !== right) {
      return (left < right ? -1 : 1) * direction;
    }

    const added = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (Number.isFinite(added) && added !== 0) return added;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

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

// --- Filtering --------------------------------------------------------------

/** The Queue's status filter. `scheduled` counts as waiting: it has not run. */
export function matchesStatus(job: Job, filter: QueueFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "waiting":
      return WAITING.includes(job.status) || bucketOf(job) === "scheduled";
    case "running":
      return RUNNING.includes(job.status);
    case "done":
      return job.status === "done";
    case "failed":
      return job.status === "failed" || job.status === "cancelled";
  }
}

/**
 * Free-text search over the four things a person would type.
 *
 * The output filename is in there deliberately: after a download the name on
 * disk is often the only part of it anyone remembers.
 */
export function matchesText(job: Job, needle: string): boolean {
  const wanted = needle.trim().toLowerCase();
  if (wanted === "") return true;
  return (
    jobTitle(job).toLowerCase().includes(wanted) ||
    job.url.toLowerCase().includes(wanted) ||
    (job.outputFile ?? "").toLowerCase().includes(wanted) ||
    job.destination.toLowerCase().includes(wanted)
  );
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
