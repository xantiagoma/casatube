/**
 * What became of a finished job's file — **checked against the disk**, not
 * inferred from the fact that a download once succeeded.
 *
 * ## The gap this closes
 *
 * A `done` job records an `outputFile`, and until now that string was the whole
 * story: the UI badged such a row *Filed* and its tooltip admitted, in words,
 * that a file deleted outside CasaTube read exactly the same way. That is the
 * failure this project keeps writing down — a measurement that measures
 * something adjacent to the question. "CasaTube moved a file here once" and
 * "there is a file here" are different sentences, and only the second one is
 * what someone opening the Downloads screen wants.
 *
 * ## The five answers, and why the fifth is not a hedge
 *
 * | | |
 * |---|---|
 * | `present` | it is on disk, at the recorded path, right now |
 * | `missing` | the library answered, and there is nothing there |
 * | `trashed` | absent from its path because CasaTube's own trash holds it — restorable |
 * | `none` | the job finished and recorded no path at all. There is nothing to look for |
 * | `unknown` | nothing could be established, and `reason` says what stopped it |
 *
 * 🔴 **`unknown` outranks `missing` whenever the evidence is not conclusive.**
 * A sleeping NAS answers `ENOENT` for every path under it, and a mountpoint
 * whose mount failed does so while looking perfectly healthy from above. Saying
 * "your download is gone" in either case would be a lie told with confidence,
 * which is worse than the silence it replaces. `core/library.ts`'s
 * {@link Library.presence} carries the three gates that keep them apart.
 *
 * ## Why the disk is consulted before the trash
 *
 * The trash journal is authoritative about *deletions*, not about the present.
 * So presence decides first, and the trash is consulted only to **explain an
 * absence**: a file that is missing and is in the trash is `trashed` (and can be
 * restored); a file that is present is `present` even if a stale journal entry
 * mentions it — which is exactly what a re-download over the same name produces.
 */
import { Result } from "better-result";

import type { Job } from "./types";
import type { Library, Presence, PresenceReason } from "./library";

export type FileState = "present" | "missing" | "trashed" | "none" | "unknown";

/**
 * Why nothing could be said.
 *
 * `not-finished` is separated from the mount failures on purpose: it is not a
 * fault at all, it is a job whose file does not exist yet, and a UI should draw
 * nothing rather than an alarm.
 */
export type FileStateReason =
  | "not-finished"
  | PresenceReason
  | "outside-library"
  /**
   * Absent from disk, and the trash could not be read — so the one thing that
   * would tell "deleted through CasaTube" from "deleted behind its back" is the
   * thing that did not answer. Reporting `missing` here would be a guess.
   */
  | "trash-unreadable";

export interface JobFileState {
  id: string;
  state: FileState;
  /** Only on `unknown`. */
  reason?: FileStateReason;
  /** A sentence a UI can show verbatim. Only on `unknown`. */
  detail?: string;
  /** The library-relative path that was checked, when there was one. */
  path?: string;
  /** Bytes on disk. Only on `present` — and it is the *file's* size, not the job's. */
  size?: number;
  /** ISO-8601. Only on `present`. */
  modifiedAt?: string;
  /** The trash entry holding it. Only on `trashed`, and it is what a restore needs. */
  trashId?: string;
}

export interface FileStateReport {
  states: JobFileState[];
  /** How many paths were actually `stat`ed. */
  checked: number;
  /** What the whole batch cost, in ms. The number the UI can show and a test can assert. */
  elapsedMs: number;
  /** True when the budget ran out and some answers are `timed-out`. */
  exhausted: boolean;
  /** When this was read, ISO-8601 UTC. A file state is a snapshot, and it ages. */
  at: string;
}

/**
 * The library-relative path a job's output should be at.
 *
 * ⚠️ `Job.outputFile` is **absolute** — the worker builds it as
 * `join(libraryDir, destination, name)` — and the library only ever speaks in
 * paths relative to its root. Two cases, and the second one is not theoretical:
 *
 * 1. The recorded path is under the current root → strip the root.
 * 2. It is **not**, because the root moved. `LIBRARY_DIR` changed, or the row
 *    was written inside a container at `/library` and is now being read on the
 *    host at `/mnt/nas/media`. The layout inside the library did not move, so
 *    `destination/name` still names the same file. Rebuilding from those is a
 *    better answer than refusing.
 *
 * Returns `null` only when there is no filename to work with at all.
 */
export function libraryRelativeOutput(
  outputFile: string,
  root: string,
  destination: string,
): string | null {
  const normalise = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = normalise(outputFile);
  const rootPath = normalise(root);

  // ⚠️ The root itself is a directory, not a file. Caught here because the
  // fallback below would otherwise take `basename("/library/")` — which is
  // `"library"` — and confidently report `Videos/library`.
  if (file === "" || file === rootPath) return null;

  if (rootPath !== "" && file.startsWith(`${rootPath}/`)) {
    const relative = file.slice(rootPath.length + 1);
    return relative === "" ? null : relative;
  }

  const name = file.slice(file.lastIndexOf("/") + 1);
  if (name === "") return null;
  const folder = normalise(destination).replace(/^\/+/, "");
  return folder === "" ? name : `${folder}/${name}`;
}

/** The reason and sentence that travel with an `unknown`, from a {@link Presence}. */
function fromPresence(presence: Extract<Presence, { state: "unknown" }>): JobFileState["reason"] {
  return presence.reason;
}

export interface FileStateOptions {
  /** Budget for the whole disk check. Passed straight through to `presence`. */
  budgetMs?: number;
  concurrency?: number;
  /** Overridable so a test can pin the timestamp. */
  now?: () => Date;
}

/**
 * The state of every job's file, in one pass over the disk.
 *
 * 🔴 **One batch, one root check, one trash read, one bounded pool of `stat`s.**
 * The alternative — asking per row — is what makes a completed tab of 128
 * downloads into 128 sequential round trips against a network mount, and it is
 * why this takes a list rather than a job.
 */
export async function jobFileStates(
  jobs: readonly Job[],
  library: Library,
  options: FileStateOptions = {},
): Promise<FileStateReport> {
  const now = options.now ?? (() => new Date());
  const states = new Map<string, JobFileState>();
  /** job id → the library-relative path we are going to ask about. */
  const wanted = new Map<string, string>();

  for (const job of jobs) {
    if (job.status !== "done") {
      states.set(job.id, {
        id: job.id,
        state: "unknown",
        reason: "not-finished",
        detail: "The job has not finished, so there is no file to look for yet.",
      });
      continue;
    }
    if (!job.outputFile || job.outputFile.trim() === "") {
      states.set(job.id, { id: job.id, state: "none" });
      continue;
    }
    const relative = libraryRelativeOutput(job.outputFile, library.root, job.destination);
    if (relative === null) {
      states.set(job.id, {
        id: job.id,
        state: "unknown",
        reason: "outside-library",
        detail: `The recorded path ${job.outputFile} does not name a file inside the library.`,
      });
      continue;
    }
    wanted.set(job.id, relative);
  }

  const order = (job: Job): JobFileState => states.get(job.id)!;

  if (wanted.size === 0) {
    return {
      states: jobs.map(order),
      checked: 0,
      elapsedMs: 0,
      exhausted: false,
      at: now().toISOString(),
    };
  }

  // The trash first, because it is one small read and its *failure* changes
  // what an absence is allowed to mean below.
  const trash = await library.listTrash();
  const trashById = new Map<string, string>();
  if (Result.isOk(trash)) {
    for (const entry of trash.value) trashById.set(entry.path, entry.id);
  }

  const report = await library.presence([...wanted.values()], {
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });

  for (const [id, path] of wanted) {
    const presence = report.results.get(path) ?? {
      state: "unknown" as const,
      reason: "timed-out" as const,
      detail: "The check did not get to this file.",
    };

    if (presence.state === "present") {
      states.set(id, {
        id,
        state: "present",
        path,
        size: presence.size,
        modifiedAt: presence.modifiedAt,
      });
      continue;
    }

    if (presence.state === "unknown") {
      states.set(id, { id, state: "unknown", reason: fromPresence(presence), detail: presence.detail, path });
      continue;
    }

    // Absent from the recorded path. The trash is the only thing that can say
    // whether CasaTube is the one that moved it.
    const trashId = trashById.get(path);
    if (trashId !== undefined) {
      states.set(id, { id, state: "trashed", path, trashId });
      continue;
    }
    if (Result.isError(trash)) {
      states.set(id, {
        id,
        state: "unknown",
        reason: "trash-unreadable",
        detail:
          "The file is not at its recorded path and the library's trash could not be read, " +
          "so there is no way to tell a deletion made here from one made behind our back.",
        path,
      });
      continue;
    }
    states.set(id, { id, state: "missing", path });
  }

  return {
    states: jobs.map(order),
    checked: report.checked,
    elapsedMs: report.elapsedMs,
    exhausted: report.exhausted,
    at: now().toISOString(),
  };
}
