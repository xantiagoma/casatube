/**
 * Ordering, filtering, and what became of the file — as pure functions.
 *
 * 🔴 They live apart from the screens for the reason `job-view.ts` does: the
 * Queue and Downloads sort and filter the *same* jobs, and two copies of "newest
 * first" is how the two screens end up disagreeing about which one that is.
 * Being pure also makes them the only part of this work a test can reach —
 * there is no DOM test setup in this repo, so a sort written inside a component
 * is a sort nothing checks.
 *
 * ⚠️ All of this is **client-side over the snapshot the server already sent**.
 * `GET /api/jobs` returns up to 200 jobs ordered by priority then oldest-first,
 * with no sort or search parameters of its own; re-ordering here is therefore
 * re-ordering *that page*, not the whole history. See the report: a server-side
 * `sort`/`order`/`q` on the jobs route is what would make this exact past the
 * two-hundredth job.
 */
import type { TrashEntry } from "../../../core/library";
import type { Job, JobStatus, Priority } from "../../../core/types";
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
 * 🔴 Four states, and the fourth one is the honest one.
 *
 * - `filed` — the job recorded an output path and that path is not in the trash.
 * - `trashed` — it is in the library's trash, and the Library screen can restore it.
 * - `none` — the job says `done` and recorded no output path at all.
 * - `unknown` — nothing can be said: the job has not finished, or the trash
 *   listing could not be read.
 *
 * ⚠️ **There is no `missing`.** A file removed outside CasaTube — `rm` on the
 * NAS, a folder moved, a mount that came back empty — is indistinguishable from
 * `filed` here, because nothing in `GET /api/jobs` stats the output path and
 * there is no endpoint that answers "does this path still exist" for a list of
 * jobs. Claiming "on disk" from a recorded string would be exactly the
 * measurement-that-measures-something-else this project keeps getting caught by,
 * so `filed` says what is true — *CasaTube put it there* — and no more.
 */
export type FileState = "filed" | "trashed" | "none" | "unknown";

/**
 * The trash, indexed for lookup.
 *
 * Two indexes because the two paths meet in the middle: a `TrashEntry.path` is
 * **library-relative** (`Videos/Foo.mkv`) and a `Job.outputFile` is
 * **absolute** (`/library/Videos/Foo.mkv`), and the browser is never told where
 * the library root is on disk.
 */
export interface TrashIndex {
  /** `folder\0name`, built from the entry's relative path. */
  slots: Set<string>;
  /** The relative paths that contain a folder, for the suffix check. */
  nested: string[];
}

/**
 * ⚠️ A NUL between the halves, not a slash or a space — both of those are legal
 * inside a filename, so either would let `("a", "b c")` and `("a b", "c")`
 * collide into one key: a file reported as trashed because a differently-named
 * one in a differently-named folder was.
 */
function slot(folder: string, name: string): string {
  return `${folder}\u0000${name}`;
}

function cut(path: string): { folder: string; name: string } {
  const at = path.lastIndexOf("/");
  return at === -1 ? { folder: "", name: path } : { folder: path.slice(0, at), name: path.slice(at + 1) };
}

/** `""`, `"."` and `"/Videos/"` all name the same folder. */
function normaliseFolder(folder: string): string {
  return folder.replace(/^[./]+/, "").replace(/\/+$/, "");
}

export function indexTrash(entries: readonly TrashEntry[]): TrashIndex {
  const slots = new Set<string>();
  const nested: string[] = [];
  for (const entry of entries) {
    const { folder, name } = cut(entry.path);
    slots.add(slot(normaliseFolder(folder), name));
    if (folder !== "") nested.push(entry.path);
  }
  return { slots, nested };
}

/**
 * Is this job's output in the trash?
 *
 * The primary test pairs the job's `destination` (a library subfolder, already
 * normalised by the API) with the filename off `outputFile`. The suffix test is
 * the fallback for a job whose file did not end up under its declared
 * destination — and it deliberately only considers entries that *have* a folder,
 * because `endsWith("/Foo.mkv")` would match any `Foo.mkv` anywhere.
 */
export function isTrashed(job: Job, index: TrashIndex): boolean {
  if (!job.outputFile) return false;
  const { name } = cut(job.outputFile);
  if (index.slots.has(slot(normaliseFolder(job.destination), name))) return true;
  return index.nested.some((path) => job.outputFile!.endsWith(`/${path}`));
}

export function fileStateOf(job: Job, index: TrashIndex | null): FileState {
  // Before `done` there is nothing to have become of: the file is in the temp
  // directory, which is not a state anyone is asking about.
  if (job.status !== "done") return "unknown";
  if (!job.outputFile) return "none";
  if (index === null) return "unknown";
  return isTrashed(job, index) ? "trashed" : "filed";
}

export function matchesFile(state: FileState, filter: FileFilter): boolean {
  return filter === "any" || state === filter;
}
