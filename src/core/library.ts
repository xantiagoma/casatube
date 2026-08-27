/**
 * The library: what has already been downloaded, and the one way to remove it.
 *
 * Two rules shape every line of this file.
 *
 * 🔴 **It is read-only except for deletion**, and deletion is a *move*. PLAN §18
 * settles it: a delete renames into `.trash/` inside the library — same
 * filesystem, so it is instantaneous and undo costs a second rename. Nothing
 * here calls `unlink` on a library file; the only real removal happens in
 * {@link Library.emptyTrash}, which is retention and force-delete, not "delete".
 *
 * ⚠️ **The root is very often a network mount, and a dead mount hangs rather
 * than failing** (PLAN §15, "Timeouts"): on the reference deployment a read
 * from a broken mount returned 0 bytes after 19 seconds instead of erroring. So
 * every filesystem call here runs under a deadline and reports
 * `MountUnavailable` when it expires, and the whole walk runs under a second,
 * larger budget so that a mount which is merely *slow* degrades into a
 * truncated listing instead of a request that never answers.
 *
 * 📌 What a deadline can and cannot do: `readdir`/`stat` run on Bun's
 * threadpool, so an abandoned call does **not** block the event loop — the
 * server keeps answering and the stuck call is eventually collected. It cannot
 * be *cancelled*, which is why we race it rather than pretending to abort it.
 * (The same reasoning, and the same shape, as `api/destinations.ts`; this is the
 * copy that should outlive it — see the note on {@link withDeadline}.)
 *
 * 📌 **Listing is cheap on purpose.** `readdir` + one `stat` per entry, and not
 * a single byte of any file is read. Duration, resolution and track lists come
 * from {@link Library.probe}, which shells out to `ffprobe` for **one** item
 * only when someone asks. Probing a library on open would turn a page load into
 * thousands of subprocesses against a NAS.
 */
import { Result } from "better-result";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { MountUnavailable, NotFound, PathOutsideRoot, ProbeFailed, Timeout } from "./errors";
import type { LibraryError } from "./errors";

// --- Constants --------------------------------------------------------------

/** Inside the library on purpose: a rename across filesystems is a copy. */
export const TRASH_DIR = ".trash";

/**
 * Append-only, and the reason `restore` can exist at all: once a file has been
 * renamed into `.trash/<id>/`, the only record of where it came from is here.
 */
export const TRASH_JOURNAL = "trash.jsonl";

/**
 * PLAN §18 names `.srt`, `.vtt` and `.ass`. `.ssa` is the same format as `.ass`
 * under its older name, and a library that has one usually has both.
 */
export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set(["srt", "vtt", "ass", "ssa"]);

/**
 * Images that belong to a media file rather than being one, in the order they
 * are preferred.
 *
 * ⚠️ This is what keeps a downloaded poster out of the grid. `Name.jpg` written
 * next to `Name.mkv` is the sidecar convention every media server reads, and
 * without this rule it would list as an item of its own — a second card, for a
 * file nobody downloaded, next to the video it is a picture of.
 *
 * 📌 It lives **here**, with `SUBTITLE_EXTENSIONS`, rather than in
 * `core/thumbnails.ts` which is the module about them: that module already
 * imports this one for the deadline helper and the path guard, and a list
 * imported in both directions is an import cycle. One list, in the module that
 * has no dependencies of its own.
 *
 * JPEG first because it is what `--convert-thumbnails jpg` produces and what
 * every media server reads. WebP last because it is what YouTube actually
 * serves when ffmpeg was not there to convert it.
 */
export const THUMBNAIL_EXTENSIONS: readonly string[] = ["jpg", "jpeg", "png", "webp"];

/** The same list, for membership tests. Lowercase, without the dot. */
export const THUMBNAIL_SIDECAR_EXTENSIONS: ReadonlySet<string> = new Set(THUMBNAIL_EXTENSIONS);

/** Generous for a spinning disk, short enough that a dead mount is obvious. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** The whole walk. Past this the listing is truncated rather than endless. */
const DEFAULT_WALK_BUDGET_MS = 15_000;

/** Ceiling on files examined, so a pathological tree cannot flood a page. */
const DEFAULT_MAX_ITEMS = 5_000;

/** PLAN §18: "configurable retention" for the trash. This is the default. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const DEFAULT_FFPROBE_TIMEOUT_MS = 20_000;

// --- Deadlines --------------------------------------------------------------

/** A sentinel, so a legitimate `undefined` result is not mistaken for a timeout. */
const TIMED_OUT = Symbol("timed-out");

/**
 * Run `work`, or give up.
 *
 * The rejection is swallowed on purpose: once the deadline has passed nobody is
 * listening any more, and an unhandled rejection from an abandoned call would
 * take the process down for a NAS that woke up late.
 *
 * 📌 `api/destinations.ts` has a private copy of this function, written first.
 * It should import this one and delete its own — the file belongs to another
 * agent this session, so the duplicate is left standing rather than edited
 * behind their back.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  path: string,
  what: string,
): Promise<Result<T, MountUnavailable>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve_) => {
    timer = setTimeout(() => resolve_(TIMED_OUT), Math.max(1, ms));
  });

  try {
    const outcome = await Promise.race([work.then((value) => ({ value })), expired]);
    if (outcome === TIMED_OUT) {
      void work.catch(() => {});
      return Result.err(
        new MountUnavailable({ path, detail: `${what} did not answer within ${ms} ms` }),
      );
    }
    return Result.ok(outcome.value);
  } catch (cause) {
    return Result.err(new MountUnavailable({ path, detail: describeCause(cause) }));
  } finally {
    clearTimeout(timer);
  }
}

type Caught<T> = { ok: true; value: T } | { ok: false; cause: unknown };

/**
 * Turn a rejection into a value, so it survives {@link withDeadline}.
 *
 * Needed because "the file is not there" and "the mount is down" are opposite
 * situations (see `NotFound` vs `MountUnavailable` in `core/errors.ts`) and the
 * only thing that tells them apart is the errno — which a generic deadline
 * wrapper has already flattened into a message by the time it is returned.
 */
function capture<T>(work: Promise<T>): Promise<Caught<T>> {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );
}

function errnoOf(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : undefined;
}

function describeCause(cause: unknown): string {
  const code = errnoOf(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  if (code === undefined) return message;
  // ⚠️ Bun already puts the errno at the front of the message, so prefixing
  // unconditionally produced "EACCES: EACCES: permission denied…" — which is
  // the sentence a user reads in a badge tooltip, so it is worth the two lines.
  return message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
}

// --- Paths ------------------------------------------------------------------

/**
 * Resolve a library-relative path, or refuse it.
 *
 * 🔴 This is the guard PLAN §18 asks for — "nothing outside the library root,
 * enforced by `PathOutsideRoot`" — and it is enforced against the **resolved**
 * path, not the string. `api/destination.ts` already refuses `..`, absolute
 * paths and backslashes at the HTTP edge; this is the second check, done where
 * the write actually happens, because a rule enforced only at the edge is a
 * rule that a second entry point walks past.
 *
 * ⚠️ `resolve` collapses `..` textually and does **not** follow symlinks. That
 * is deliberate: a symlink inside the library is only ever *moved* by this
 * module (a rename moves the link, never its target), and following one would
 * turn a listing into a loop.
 */
export function resolveInRoot(root: string, relative: string): Result<string, PathOutsideRoot> {
  const rootAbs = resolve(root);
  const refuse = (): Result<string, PathOutsideRoot> =>
    Result.err(new PathOutsideRoot({ path: relative, root: rootAbs }));

  if (relative.includes("\0")) return refuse();
  // Backslashes separate on the platforms that use them, so a path that looks
  // harmless here could climb out there. Refuse rather than translate.
  if (relative.includes("\\")) return refuse();
  if (isAbsolute(relative) || /^[a-z]:/i.test(relative)) return refuse();

  const target = resolve(rootAbs, relative);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return refuse();
  return Result.ok(target);
}

/** Library-relative, `/`-separated. Never absolute — PLAN §12. */
function toRelative(root: string, absolute: string): string {
  const rootAbs = resolve(root);
  if (absolute === rootAbs) return "";
  return absolute.slice(rootAbs.length + 1).split(sep).join("/");
}

function joinRelative(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** `Foo.en.srt` → `{ base: "Foo.en", ext: "srt" }`. A dotfile has no extension. */
function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

function extensionOf(path: string): string {
  return splitExtension(path.slice(path.lastIndexOf("/") + 1)).ext;
}

/** Position in {@link THUMBNAIL_EXTENSIONS}' order; anything else sorts last. */
function preferredThumbnail(ext: string): number {
  const index = THUMBNAIL_EXTENSIONS.indexOf(ext);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

// --- Shapes -----------------------------------------------------------------

export interface SubtitleFile {
  /** Relative to the library root. */
  path: string;
  name: string;
  /** Lowercase, without the dot. */
  ext: string;
  size: number;
  /**
   * From the filename, when it carries one: `Foo.en.srt` → `en`.
   *
   * ⚠️ A guess from a naming convention, not a declaration. Absent when the
   * sidecar is simply `Foo.srt`, and never invented — the same discipline
   * `selection.toLanguageTag` applies to tracks (PLAN §4.1).
   */
  language?: string;
  /** `Foo.en.forced.srt`. Media servers treat these differently. */
  forced: boolean;
}

export interface LibraryItem {
  /** Relative to the library root, `/`-separated. */
  path: string;
  /** Filename with extension. */
  name: string;
  /** Containing subfolder, `""` at the root. */
  folder: string;
  /** Lowercase, without the dot. */
  ext: string;
  size: number;
  /** ISO 8601, UTC. */
  modifiedAt: string;
  /** Sidecars sharing this file's base name, in the same folder. */
  subtitles: SubtitleFile[];
  /**
   * The provider's own image, when one was downloaded beside the file.
   *
   * Library-relative, like everything else here. Its **absence does not mean
   * there is no thumbnail** — `GET /api/library/thumbnail` falls back to a
   * generated frame — so this is "the creator chose this picture", not "a
   * picture exists".
   */
  thumbnail?: string;
}

export type LibrarySort = "name" | "size" | "modified";
export type SortOrder = "asc" | "desc";

export interface LibraryQuery {
  /** Subfolder to list. `""` or absent is the whole library. */
  folder?: string;
  /** Descend into subfolders. Default true. */
  recursive?: boolean;
  /** Case-insensitive substring of the filename. */
  search?: string;
  sort?: LibrarySort;
  order?: SortOrder;
  limit?: number;
  /** Opaque; from a previous page's `nextCursor`. */
  cursor?: string;
}

export interface LibraryListing {
  root: string;
  folder: string;
  items: LibraryItem[];
  /** How many items matched the filters, of those examined. See `truncated`. */
  matched: number;
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
  /**
   * The walk stopped early — item cap or time budget. `matched` is therefore a
   * floor, not a total: it is what was *seen*, and saying so beats a number
   * that quietly means something else.
   */
  truncated: boolean;
  at: string;
}

export interface TrashedFile {
  /** Where it was, relative to the root. */
  original: string;
  /** Where it is now, relative to the root — under `.trash/`. */
  trashed: string;
  size: number;
}

export interface TrashEntry {
  id: string;
  /** ISO 8601, UTC. */
  deletedAt: string;
  /** The item that was deleted — the media file, not its sidecars. */
  path: string;
  name: string;
  /** The item and every sidecar that travelled with it. */
  files: TrashedFile[];
  /** Total bytes held by this entry. */
  size: number;
  /** Free text recorded with the deletion, e.g. who asked. */
  reason?: string;
  /**
   * In `.trash/` with no journal record — a directory that survived the loss of
   * the journal, or was put there by hand. It can be emptied but **not
   * restored**: nothing knows where it came from.
   */
  orphan?: boolean;
}

export interface RestoreResult {
  id: string;
  /** Where the item actually landed — see the collision note on `restore`. */
  path: string;
  files: { from: string; to: string }[];
  /** True when the original name was taken and a free one was used instead. */
  renamed: boolean;
}

export interface EmptyTrashResult {
  removed: number;
  freedBytes: number;
  remaining: number;
  /** The cutoff actually applied, in days. `0` means "everything". */
  olderThanDays: number;
}

export interface ProbeStream {
  index: number;
  kind: "video" | "audio" | "subtitle" | "other";
  codec?: string;
  /** As stated by the container, never guessed. */
  language?: string;
  title?: string;
  width?: number;
  height?: number;
  fps?: number;
  channels?: number;
  isDefault: boolean;
}

export interface MediaProbe {
  path: string;
  durationSeconds: number | null;
  bitrate: number | null;
  formatName: string | null;
  /** Of the first video stream, which is what "resolution" means to a person. */
  width: number | null;
  height: number | null;
  streams: ProbeStream[];
}

/**
 * Whether one path is really on disk — and, when nothing can be said, why not.
 *
 * 🔴 **`missing` is a claim, and `unknown` is the absence of one.** They are
 * separate members rather than "not present" for the reason this whole file
 * runs under deadlines: the root is very often a network mount, and a mount
 * that is asleep, unmounted or unreadable answers `ENOENT` for every path in
 * it. Telling someone their file is gone when the NAS is merely down is the
 * one wrong answer this type exists to make impossible to give by accident.
 */
export type Presence =
  | { state: "present"; size: number; modifiedAt: string }
  | { state: "missing" }
  | { state: "unknown"; reason: PresenceReason; detail: string };

/**
 * Why a path could not be answered for.
 *
 * | | |
 * |---|---|
 * | `mount-unavailable` | the root itself did not answer — nothing under it can be judged |
 * | `library-empty` | the root answered and holds **nothing**, while we were asked about files in it. An unmounted mountpoint looks exactly like this, and so does a library someone emptied; the safe reading is the one that does not announce a loss |
 * | `timed-out` | the batch's budget ran out before this path's turn |
 * | `unreadable` | the path itself refused — `EACCES`, `ELOOP`, a device error |
 */
export type PresenceReason = "mount-unavailable" | "library-empty" | "timed-out" | "unreadable";

export interface PresenceOptions {
  /**
   * The budget for the **whole batch**, not per path. Anything unanswered when
   * it expires comes back `unknown`, never `missing`.
   */
  budgetMs?: number;
  /** How many `stat` calls are in flight at once. */
  concurrency?: number;
}

export interface PresenceReport {
  /** One entry per **distinct** path asked about, keyed by the path as given. */
  results: Map<string, Presence>;
  /** How many paths were actually `stat`ed, as opposed to answered from a rule. */
  checked: number;
  /** Wall-clock cost of the batch, for the caller to report and for a test to assert on. */
  elapsedMs: number;
  /** True when the batch ran out of budget — some answers are `timed-out`. */
  exhausted: boolean;
}

/** Generous for a spinning disk; a NAS that needs longer is a NAS that is down. */
const DEFAULT_PRESENCE_BUDGET_MS = 3_000;

/**
 * ⚠️ Parallel on purpose, and bounded on purpose. Two hundred serialised
 * `stat`s over NFS at 30 ms each is six seconds; two hundred at once is a
 * thundering herd against a box that also runs Home Assistant. Sixteen keeps
 * the round trips overlapping without becoming the load itself.
 */
const DEFAULT_PRESENCE_CONCURRENCY = 16;

export interface LibraryOptions {
  root: string;
  /** Per filesystem call. */
  timeoutMs?: number;
  /** For a whole walk. Beyond it, the listing is truncated. */
  walkBudgetMs?: number;
  maxItems?: number;
  /** Default retention for {@link Library.emptyTrash}. */
  retentionDays?: number;
  ffprobePath?: string;
  ffprobeTimeoutMs?: number;
  /** Where deletions are recorded, besides the journal. Defaults to stdout. */
  log?: (line: string) => void;
}

// --- Journal ----------------------------------------------------------------

type JournalRecord =
  | { op: "delete"; entry: TrashEntry }
  | { op: "restore"; id: string; at: string; to: string }
  | { op: "empty"; id: string; at: string; freedBytes: number };

// --- The library ------------------------------------------------------------

export interface Library {
  readonly root: string;
  readonly retentionDays: number;
  list(query?: LibraryQuery): Promise<Result<LibraryListing, LibraryError>>;
  item(path: string): Promise<Result<LibraryItem, LibraryError>>;
  /**
   * Are these paths still on disk? One answer per path, and **never a
   * failure** — see the implementation for why every way of not knowing is a
   * value rather than an error.
   */
  presence(paths: readonly string[], options?: PresenceOptions): Promise<PresenceReport>;
  probe(path: string): Promise<Result<MediaProbe, LibraryError | ProbeFailed | Timeout>>;
  remove(path: string, options?: { reason?: string }): Promise<Result<TrashEntry, LibraryError>>;
  restore(path: string): Promise<Result<RestoreResult, LibraryError>>;
  emptyTrash(olderThanDays?: number): Promise<Result<EmptyTrashResult, LibraryError>>;
  listTrash(): Promise<Result<TrashEntry[], LibraryError>>;
}

export function openLibrary(options: LibraryOptions): Library {
  const root = resolve(options.root);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const walkBudgetMs = options.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const retentionDays = options.retentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const ffprobeTimeoutMs = options.ffprobeTimeoutMs ?? DEFAULT_FFPROBE_TIMEOUT_MS;
  const log = options.log ?? ((line: string) => console.log(line));

  const trashRoot = join(root, TRASH_DIR);
  const journalPath = join(trashRoot, TRASH_JOURNAL);

  // --- filesystem primitives, all deadlined -------------------------------

  async function statUnder(
    absolute: string,
    what: string,
    budget = timeoutMs,
  ): Promise<Result<Stats, MountUnavailable | NotFound>> {
    const raced = await withDeadline(capture(stat(absolute)), budget, absolute, what);
    if (Result.isError(raced)) return raced;
    const caught = raced.value;
    if (caught.ok) return Result.ok(caught.value);
    const code = errnoOf(caught.cause);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return Result.err(new NotFound({ what: "library path", id: toRelative(root, absolute) }));
    }
    return Result.err(new MountUnavailable({ path: absolute, detail: describeCause(caught.cause) }));
  }

  async function exists(absolute: string): Promise<boolean> {
    const seen = await statUnder(absolute, "checking a path");
    return Result.isOk(seen);
  }

  async function readdirUnder(
    absolute: string,
    budget: number,
  ): Promise<Result<Dirent[], MountUnavailable>> {
    return withDeadline(
      readdir(absolute, { withFileTypes: true }),
      budget,
      absolute,
      "reading the library",
    );
  }

  // --- listing ------------------------------------------------------------

  interface RawFile {
    folder: string;
    name: string;
    base: string;
    ext: string;
    size: number;
    modifiedMs: number;
  }

  /**
   * Every regular file under `start`, with its size and mtime.
   *
   * Breadth-first, so if the caps bite it is the deep corners that are lost
   * rather than the top of the library. Hidden entries are skipped — `.trash`,
   * `@eaDir`, `.stfolder` and friends are the media server's business, and
   * `.trash` in particular is *not* library content, it is the undo buffer.
   */
  async function walk(
    start: string,
    startFolder: string,
    recursive: boolean,
  ): Promise<Result<{ files: RawFile[]; truncated: boolean }, MountUnavailable>> {
    const files: RawFile[] = [];
    let truncated = false;
    const until = Date.now() + walkBudgetMs;
    let frontier: string[] = [startFolder];

    while (frontier.length > 0 && !truncated) {
      const next: string[] = [];

      for (const folder of frontier) {
        const remaining = until - Date.now();
        if (remaining <= 0) {
          truncated = true;
          break;
        }

        const absolute = folder === startFolder ? start : join(root, folder);
        const entries = await readdirUnder(absolute, Math.min(timeoutMs, remaining));
        // Only the starting folder failing is fatal. A single unreadable
        // subfolder — a permissions quirk, a stale handle — must not cost the
        // whole listing.
        if (Result.isError(entries)) {
          if (folder === startFolder) return entries;
          continue;
        }

        for (const entry of entries.value) {
          if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue;
          // `readdir` does not follow links, so a symlinked directory reports
          // `isDirectory() === false` and is excluded here — which is what we
          // want: following one turns a listing into a loop, and `..` is not
          // the only way out of a root.
          if (entry.isDirectory()) {
            if (recursive) next.push(joinRelative(folder, entry.name));
            continue;
          }
          if (!entry.isFile()) continue;
          if (files.length >= maxItems) {
            truncated = true;
            break;
          }

          const child = join(absolute, entry.name);
          const stats = await statUnder(child, "measuring a file", Math.min(timeoutMs, Math.max(1, until - Date.now())));
          // A file that vanished between `readdir` and `stat` is not an error:
          // it is a download that finished moving. Skip it.
          if (Result.isError(stats)) {
            if (stats.error._tag === "MountUnavailable" && folder === startFolder) return Result.err(stats.error);
            continue;
          }

          const { base, ext } = splitExtension(entry.name);
          files.push({
            folder,
            name: entry.name,
            base,
            ext,
            size: stats.value.size,
            modifiedMs: stats.value.mtimeMs,
          });
        }
        if (truncated) break;
      }

      frontier = next;
    }

    return Result.ok({ files, truncated });
  }

  /**
   * Attach sidecars to the file they belong to.
   *
   * A sidecar belongs to the **longest** media base it extends, which is what
   * makes `Foo.en.srt` land on `Foo.en.mkv` when that exists and on `Foo.mkv`
   * when it does not — the shorter-prefix rule alone gets that backwards.
   * Sidecars nobody claims stay in the listing as items of their own, because a
   * stray subtitle is still something the user may want to see and delete.
   */
  function assemble(files: RawFile[]): LibraryItem[] {
    const byFolder = new Map<string, RawFile[]>();
    for (const file of files) {
      const bucket = byFolder.get(file.folder);
      if (bucket === undefined) byFolder.set(file.folder, [file]);
      else bucket.push(file);
    }

    const items: LibraryItem[] = [];

    for (const [folder, bucket] of byFolder) {
      const subs = bucket.filter((f) => SUBTITLE_EXTENSIONS.has(f.ext));
      const images = bucket.filter((f) => THUMBNAIL_SIDECAR_EXTENSIONS.has(f.ext));
      const media = bucket.filter(
        (f) => !SUBTITLE_EXTENSIONS.has(f.ext) && !THUMBNAIL_SIDECAR_EXTENSIONS.has(f.ext),
      );
      // Longest base first: `Foo.en` must be tried before `Foo`.
      const candidates = [...media].sort((a, b) => b.base.length - a.base.length);

      const attached = new Map<string, SubtitleFile[]>();
      const posters = new Map<string, string>();
      const claimed = new Set<string>();

      const ownerOf = (file: RawFile): RawFile | undefined =>
        candidates.find(
          (m) => file.base === m.base || file.base.toLowerCase().startsWith(`${m.base.toLowerCase()}.`),
        );

      // Images first, and by the same ownership rule as subtitles: an image
      // that belongs to a video in this folder is that video's poster and not a
      // library item. One that belongs to nothing stays an item — a stray
      // picture is still a file the user may want to see and delete.
      for (const image of images) {
        const owner = ownerOf(image);
        if (owner === undefined) continue;
        // First one wins, in the preference order the extensions are listed in:
        // a folder with both `Foo.jpg` and `Foo.webp` should answer with the
        // JPEG, because that is what a media server reads.
        const already = posters.get(owner.name);
        if (already === undefined || preferredThumbnail(image.ext) < preferredThumbnail(extensionOf(already))) {
          posters.set(owner.name, joinRelative(folder, image.name));
        }
        claimed.add(image.name);
      }

      for (const sub of subs) {
        const owner = ownerOf(sub);
        if (owner === undefined) continue;
        const suffix = sub.base.length > owner.base.length ? sub.base.slice(owner.base.length + 1) : "";
        const parts = suffix === "" ? [] : suffix.split(".");
        const language = parts.find((p) => /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(p));
        const sidecar: SubtitleFile = {
          path: joinRelative(folder, sub.name),
          name: sub.name,
          ext: sub.ext,
          size: sub.size,
          forced: parts.some((p) => p.toLowerCase() === "forced"),
        };
        if (language !== undefined) sidecar.language = language;

        const list = attached.get(owner.name);
        if (list === undefined) attached.set(owner.name, [sidecar]);
        else list.push(sidecar);
        claimed.add(sub.name);
      }

      for (const file of bucket) {
        if (claimed.has(file.name)) continue;
        const poster = posters.get(file.name);
        items.push({
          path: joinRelative(folder, file.name),
          name: file.name,
          folder,
          ext: file.ext,
          size: file.size,
          modifiedAt: new Date(file.modifiedMs).toISOString(),
          subtitles: (attached.get(file.name) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
          ...(poster === undefined ? {} : { thumbnail: poster }),
        });
      }
    }

    return items;
  }

  // --- cursor -------------------------------------------------------------
  // Opaque to the client, and deliberately *not* an offset: an offset silently
  // skips or repeats rows when the library changes between pages, and a library
  // changes exactly when a download finishes. The cursor carries the sort key
  // of the last row seen, so the next page resumes from a position rather than
  // from a count.

  interface CursorPosition {
    key: string | number;
    path: string;
  }

  function keyOf(item: LibraryItem, sort: LibrarySort): string | number {
    if (sort === "size") return item.size;
    if (sort === "modified") return item.modifiedAt;
    return item.name.toLowerCase();
  }

  function encodeCursor(item: LibraryItem, sort: LibrarySort): string {
    const position: CursorPosition = { key: keyOf(item, sort), path: item.path };
    return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
  }

  function decodeCursor(raw: string): CursorPosition | undefined {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const { key, path } = parsed as { key?: unknown; path?: unknown };
      if (typeof path !== "string") return undefined;
      if (typeof key !== "string" && typeof key !== "number") return undefined;
      return { key, path };
    } catch {
      // A cursor we cannot read is a cursor from another version, or a typo in
      // a URL. Starting from the beginning is a better answer than a 500.
      return undefined;
    }
  }

  function comparePositions(a: CursorPosition, b: CursorPosition, order: SortOrder): number {
    let cmp: number;
    if (typeof a.key === "number" && typeof b.key === "number") cmp = a.key - b.key;
    else cmp = String(a.key).localeCompare(String(b.key));
    // Path is the tiebreak, so the order is total: two files of the same size
    // must not be able to swap places between pages.
    if (cmp === 0) cmp = a.path.localeCompare(b.path);
    return order === "desc" ? -cmp : cmp;
  }

  async function list(query: LibraryQuery = {}): Promise<Result<LibraryListing, LibraryError>> {
    const folderInput = (query.folder ?? "").replace(/^\/+|\/+$/g, "");
    const startAbs = resolveInRoot(root, folderInput);
    if (Result.isError(startAbs)) return startAbs;

    const recursive = query.recursive ?? true;
    const walked = await walk(startAbs.value, folderInput, recursive);
    if (Result.isError(walked)) {
      // A subfolder that is not there is a 404; the *root* not being there is
      // `MountUnavailable`, because an unmounted mount and a deleted directory
      // are the same observation and the mount is the likelier one (PLAN §15).
      if (folderInput !== "") {
        const onDisk = await statUnder(startAbs.value, "reading the folder");
        if (Result.isError(onDisk) && onDisk.error._tag === "NotFound") return Result.err(onDisk.error);
      }
      return walked;
    }

    const sort = query.sort ?? "modified";
    const order = query.order ?? (sort === "modified" ? "desc" : "asc");
    const needle = query.search?.trim().toLowerCase() ?? "";

    let items = assemble(walked.value.files);
    if (needle !== "") items = items.filter((item) => item.name.toLowerCase().includes(needle));
    items.sort((a, b) =>
      comparePositions({ key: keyOf(a, sort), path: a.path }, { key: keyOf(b, sort), path: b.path }, order),
    );

    const matched = items.length;

    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor !== undefined) {
      const after = items.findIndex(
        (item) => comparePositions(cursor, { key: keyOf(item, sort), path: item.path }, order) < 0,
      );
      items = after === -1 ? [] : items.slice(after);
    }

    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = items.length > limit && last !== undefined ? encodeCursor(last, sort) : null;

    return Result.ok({
      root,
      folder: folderInput,
      items: page,
      matched,
      nextCursor,
      truncated: walked.value.truncated,
      at: new Date().toISOString(),
    });
  }

  async function item(path: string): Promise<Result<LibraryItem, LibraryError>> {
    const absolute = resolveInRoot(root, path);
    if (Result.isError(absolute)) return absolute;
    const relative = toRelative(root, absolute.value);
    if (relative === "") return Result.err(new NotFound({ what: "library file", id: path }));

    const stats = await statUnder(absolute.value, "reading a file");
    if (Result.isError(stats)) return stats;
    if (!stats.value.isFile()) return Result.err(new NotFound({ what: "library file", id: relative }));

    // One `readdir` of the containing folder is what makes the sidecars
    // findable, and it is the same call the listing already makes. Cheaper than
    // guessing at names and `stat`ing each guess.
    const folder = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    const entries = await readdirUnder(dirname(absolute.value), timeoutMs);
    if (Result.isError(entries)) return entries;

    const name = basename(relative);
    const siblings: RawFile[] = [];
    for (const entry of entries.value) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const { base, ext } = splitExtension(entry.name);
      // ⚠️ Every file in the folder, not just the sidecars: which item a
      // sidecar belongs to depends on the *other* media files present
      // (`Foo.en.srt` prefers `Foo.en.mkv` over `Foo.mkv`), so hiding them here
      // would make this answer disagree with the listing's.
      siblings.push({ folder, name: entry.name, base, ext, size: 0, modifiedMs: 0 });
    }

    // Sizes: known already for the item itself, one `stat` each for the
    // sidecars, and never for the other media files — they are only here to
    // decide ownership and are discarded below.
    for (const sibling of siblings) {
      if (sibling.name === name) {
        sibling.size = stats.value.size;
        sibling.modifiedMs = stats.value.mtimeMs;
        continue;
      }
      if (!SUBTITLE_EXTENSIONS.has(sibling.ext)) continue;
      const sub = await statUnder(join(dirname(absolute.value), sibling.name), "measuring a subtitle");
      if (Result.isOk(sub)) {
        sibling.size = sub.value.size;
        sibling.modifiedMs = sub.value.mtimeMs;
      }
    }

    const found = assemble(siblings).find((candidate) => candidate.name === name);
    // Reachable only if the file is itself a sidecar of another file present in
    // the folder — `Foo.en.srt` next to `Foo.mkv`. It is still a real file, so
    // answer with it rather than pretending it is missing.
    if (found === undefined) {
      const { ext } = splitExtension(name);
      return Result.ok({
        path: relative,
        name,
        folder,
        ext,
        size: stats.value.size,
        modifiedAt: new Date(stats.value.mtimeMs).toISOString(),
        subtitles: [],
      });
    }
    return Result.ok(found);
  }

  // --- presence -----------------------------------------------------------

  /**
   * `stat` one absolute path and turn the outcome into a {@link Presence}.
   *
   * 🔴 It does **not** go through {@link statUnder}, and the difference is the
   * point: that helper folds everything that is not `ENOENT` into
   * `MountUnavailable`, which flattens "the file is not there" and "I was not
   * allowed to look" into one shape whose only distinguishing mark is a string.
   * Here the errno is read directly, because it is the *whole* decision.
   */
  async function presenceOf(absolute: string, budget: number): Promise<Presence> {
    const raced = await withDeadline(capture(stat(absolute)), budget, absolute, "checking a file");
    if (Result.isError(raced)) {
      return { state: "unknown", reason: "timed-out", detail: raced.error.detail };
    }
    const caught = raced.value;
    if (caught.ok) {
      // A directory that took the file's name is not the file. Reporting it
      // `present` would offer to play something that cannot be played.
      if (!caught.value.isFile()) return { state: "missing" };
      return {
        state: "present",
        size: caught.value.size,
        modifiedAt: new Date(caught.value.mtimeMs).toISOString(),
      };
    }
    const code = errnoOf(caught.cause);
    // ⚠️ These two, and only these two, are evidence of absence. `ENOENT` is
    // "no such entry"; `ENOTDIR` is "something on the way is not a folder",
    // which is the same answer about the leaf.
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
    return { state: "unknown", reason: "unreadable", detail: describeCause(caught.cause) };
  }

  /**
   * Are these files still where they were put?
   *
   * 🔴 **This never fails.** It returns a verdict per path, and every way of
   * not knowing is one of those verdicts — because the caller is a UI drawing a
   * badge per row, and a thrown error there means either a blank screen or, far
   * worse, a row silently rendered as if the answer had been "gone".
   *
   * The order of the three gates below is the design, and each one exists
   * because of a real way a library disappears:
   *
   * 1. **The root does not answer** (`LIBRARY_DIR` pointing nowhere, the mount
   *    unreachable, permissions removed) → everything is `mount-unavailable`.
   *    Nothing under a root that cannot be read is judgeable.
   * 2. **The root answers and is completely empty**, while we were asked about
   *    files in it → everything is `library-empty`. ⚠️ This is the gate that
   *    matters most in practice: an NFS mount that failed to mount leaves the
   *    *mountpoint directory* behind, so the root `stat`s perfectly and every
   *    file under it is `ENOENT`. Gate 1 cannot see that; this one can. It
   *    misreads a genuinely emptied library as unknown, which is the direction
   *    to be wrong in — an unnecessary "cannot say" costs a re-check, and an
   *    unwarranted "your file is gone" costs someone their afternoon.
   * 3. **Per path**, on its own errno — see {@link presenceOf}.
   *
   * ⚠️ A path that resolves outside the root is refused rather than checked,
   * and refused as `unreadable` rather than `missing`: it is a fact about the
   * *request*, and "outside the library" is not "not on disk".
   */
  async function presence(
    paths: readonly string[],
    options: PresenceOptions = {},
  ): Promise<PresenceReport> {
    const started = Date.now();
    const budgetMs = options.budgetMs ?? DEFAULT_PRESENCE_BUDGET_MS;
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_PRESENCE_CONCURRENCY);
    const deadline = started + budgetMs;
    const remaining = (): number => deadline - Date.now();

    const wanted = [...new Set(paths)];
    const results = new Map<string, Presence>();
    const report = (checked: number, exhausted: boolean): PresenceReport => ({
      results,
      checked,
      elapsedMs: Date.now() - started,
      exhausted,
    });
    const everything = (reason: PresenceReason, detail: string): PresenceReport => {
      for (const path of wanted) results.set(path, { state: "unknown", reason, detail });
      return report(0, reason === "timed-out");
    };

    if (wanted.length === 0) return report(0, false);

    // Gate 1 — the root itself. ⚠️ Not `presenceOf`: that answers about a
    // *file*, and a healthy library root is a directory, which it would
    // correctly and uselessly call `missing`. What is being asked here is only
    // "did the root answer at all".
    const rootStat = await statUnder(root, "reading the library root", Math.min(timeoutMs, Math.max(1, remaining())));
    if (Result.isError(rootStat)) {
      return everything(
        "mount-unavailable",
        rootStat.error._tag === "NotFound"
          ? `the library root ${root} is not there`
          : `the library root did not answer: ${rootStat.error.detail}`,
      );
    }
    if (!rootStat.value.isDirectory()) {
      return everything("mount-unavailable", `the library root ${root} is not a directory`);
    }

    // Gate 2 — the root answered. Is there anything in it?
    const entries = await readdirUnder(root, Math.min(timeoutMs, Math.max(1, remaining())));
    if (Result.isError(entries)) {
      return everything("mount-unavailable", `the library root could not be read: ${entries.error.detail}`);
    }
    if (entries.value.length === 0) {
      return everything(
        "library-empty",
        `the library root ${root} is empty — if it is a network mount, it is probably not mounted`,
      );
    }

    // Gate 3 — one answer per path, in a bounded pool.
    let cursor = 0;
    let checked = 0;
    let exhausted = false;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= wanted.length) return;
        const path = wanted[index]!;

        const left = remaining();
        if (left <= 0) {
          exhausted = true;
          results.set(path, {
            state: "unknown",
            reason: "timed-out",
            detail: `the ${budgetMs} ms budget for this batch ran out before this file's turn`,
          });
          continue;
        }

        const absolute = resolveInRoot(root, path);
        if (Result.isError(absolute)) {
          results.set(path, {
            state: "unknown",
            reason: "unreadable",
            detail: `${path} is not inside the library root`,
          });
          continue;
        }

        const answer = await presenceOf(absolute.value, Math.min(timeoutMs, left));
        if (answer.state === "unknown" && answer.reason === "timed-out") exhausted = true;
        checked += 1;
        results.set(path, answer);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
    return report(checked, exhausted);
  }

  // --- ffprobe ------------------------------------------------------------

  interface FfprobeStream {
    index?: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    channels?: number;
    avg_frame_rate?: string;
    disposition?: Record<string, number>;
    tags?: Record<string, string>;
  }

  interface FfprobeOutput {
    format?: { duration?: string; bit_rate?: string; format_name?: string };
    streams?: FfprobeStream[];
  }

  function parseFraction(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const [num, den] = value.split("/");
    const n = Number(num);
    const d = den === undefined ? 1 : Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
    const fps = n / d;
    return fps > 0 ? Math.round(fps * 1000) / 1000 : undefined;
  }

  function numberOr(value: string | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Duration, resolution and tracks for **one** item.
   *
   * Deliberately not part of `list`: `ffprobe` opens the file and reads from it,
   * which on a network mount is the difference between a listing and a stall.
   * Called lazily, per item, when a detail view actually needs it.
   */
  async function probe(path: string): Promise<Result<MediaProbe, LibraryError | ProbeFailed | Timeout>> {
    const absolute = resolveInRoot(root, path);
    if (Result.isError(absolute)) return absolute;
    const relative = toRelative(root, absolute.value);

    const stats = await statUnder(absolute.value, "reading a file");
    if (Result.isError(stats)) return stats;
    if (!stats.value.isFile()) return Result.err(new NotFound({ what: "library file", id: relative }));

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      // `Bun.spawn`, never `Bun.$` — a shell in the middle would reinterpret
      // quoting in a filename, and library filenames are full of quotes.
      proc = Bun.spawn(
        [
          ffprobePath,
          "-v", "error",
          "-print_format", "json",
          "-show_format",
          "-show_streams",
          absolute.value,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
    } catch (cause) {
      return Result.err(new ProbeFailed({ url: relative, detail: `ffprobe could not start: ${describeCause(cause)}` }));
    }

    const finished = (async () => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    })();

    const raced = await withDeadline(capture(finished), ffprobeTimeoutMs, relative, "ffprobe");
    if (Result.isError(raced)) {
      try {
        proc.kill();
      } catch {
        // Already gone. Nothing to do.
      }
      return Result.err(new Timeout({ what: `ffprobe on ${relative}`, ms: ffprobeTimeoutMs }));
    }
    if (!raced.value.ok) {
      return Result.err(new ProbeFailed({ url: relative, detail: describeCause(raced.value.cause) }));
    }

    const { stdout, stderr, exitCode } = raced.value.value;
    if (exitCode !== 0) {
      return Result.err(
        new ProbeFailed({ url: relative, detail: stderr.trim() || `ffprobe exited with ${exitCode}` }),
      );
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch (cause) {
      return Result.err(new ProbeFailed({ url: relative, detail: `unreadable ffprobe output: ${describeCause(cause)}` }));
    }

    const streams: ProbeStream[] = (parsed.streams ?? []).map((stream, position) => {
      const kind =
        stream.codec_type === "video" || stream.codec_type === "audio" || stream.codec_type === "subtitle"
          ? stream.codec_type
          : "other";
      const out: ProbeStream = {
        index: stream.index ?? position,
        kind,
        isDefault: (stream.disposition?.default ?? 0) === 1,
      };
      if (stream.codec_name !== undefined) out.codec = stream.codec_name;
      if (stream.tags?.language !== undefined) out.language = stream.tags.language;
      if (stream.tags?.title !== undefined) out.title = stream.tags.title;
      if (stream.width !== undefined) out.width = stream.width;
      if (stream.height !== undefined) out.height = stream.height;
      if (stream.channels !== undefined) out.channels = stream.channels;
      const fps = parseFraction(stream.avg_frame_rate);
      if (fps !== undefined) out.fps = fps;
      return out;
    });

    const video = streams.find((stream) => stream.kind === "video");
    return Result.ok({
      path: relative,
      durationSeconds: numberOr(parsed.format?.duration),
      bitrate: numberOr(parsed.format?.bit_rate),
      formatName: parsed.format?.format_name ?? null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      streams,
    });
  }

  // --- trash --------------------------------------------------------------

  async function readJournal(): Promise<Result<JournalRecord[], MountUnavailable>> {
    const raced = await withDeadline(
      capture(readFile(journalPath, "utf8")),
      timeoutMs,
      journalPath,
      "reading the trash journal",
    );
    if (Result.isError(raced)) return raced;
    const caught = raced.value;
    // No journal means nothing has ever been deleted. Not a failure.
    if (!caught.ok) {
      const code = errnoOf(caught.cause);
      if (code === "ENOENT") return Result.ok([]);
      return Result.err(new MountUnavailable({ path: journalPath, detail: describeCause(caught.cause) }));
    }

    const records: JournalRecord[] = [];
    for (const line of caught.value.split("\n")) {
      if (line.trim() === "") continue;
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        // A torn last line from a crash mid-append. Skipping it loses one
        // record; refusing to read the journal would lose every restore.
      }
    }
    return Result.ok(records);
  }

  /** The journal is a log; the live set is its replay. */
  function replay(records: JournalRecord[]): Map<string, TrashEntry> {
    const live = new Map<string, TrashEntry>();
    for (const record of records) {
      if (record.op === "delete") live.set(record.entry.id, record.entry);
      else live.delete(record.id);
    }
    return live;
  }

  async function append(record: JournalRecord): Promise<Result<void, MountUnavailable>> {
    const made = await withDeadline(
      mkdir(trashRoot, { recursive: true }),
      timeoutMs,
      trashRoot,
      "creating the trash folder",
    );
    if (Result.isError(made)) return made;
    const written = await withDeadline(
      appendFile(journalPath, `${JSON.stringify(record)}\n`, "utf8"),
      timeoutMs,
      journalPath,
      "recording the deletion",
    );
    if (Result.isError(written)) return written;
    return Result.ok(undefined);
  }

  function newId(when: Date): string {
    const stamp = when.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function renameUnder(from: string, to: string, what: string): Promise<Result<void, MountUnavailable>> {
    const moved = await withDeadline(rename(from, to), timeoutMs, from, what);
    if (Result.isError(moved)) return moved;
    return Result.ok(undefined);
  }

  /**
   * Delete — which here means **move into `.trash/`** (PLAN §18).
   *
   * 🔴 Never `unlink`. The trash is inside the library root, so this is a
   * rename on one filesystem: instantaneous whatever the file's size, and undo
   * is the same rename backwards.
   *
   * Sidecars travel with the item. Deleting `Foo.mkv` and leaving `Foo.en.srt`
   * behind would leave the library full of subtitles for videos that no longer
   * exist, and restoring half an item is not a restore.
   */
  async function remove(path: string, opts: { reason?: string } = {}): Promise<Result<TrashEntry, LibraryError>> {
    const absolute = resolveInRoot(root, path);
    if (Result.isError(absolute)) return absolute;
    const relative = toRelative(root, absolute.value);

    if (relative === "") {
      return Result.err(new PathOutsideRoot({ path, root }));
    }
    // The trash is not library content, and emptying it is a different
    // operation with a different guard.
    if (relative === TRASH_DIR || relative.startsWith(`${TRASH_DIR}/`)) {
      return Result.err(new PathOutsideRoot({ path, root }));
    }

    const stats = await statUnder(absolute.value, "reading the item");
    if (Result.isError(stats)) return stats;

    const targets: { absolute: string; relative: string; size: number }[] = [
      { absolute: absolute.value, relative, size: stats.value.size },
    ];

    if (stats.value.isFile()) {
      const parent = dirname(absolute.value);
      const folder = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
      const name = basename(relative);
      const { base } = splitExtension(name);
      const entries = await readdirUnder(parent, timeoutMs);
      if (Result.isError(entries)) return entries;
      for (const entry of entries.value) {
        if (!entry.isFile() || entry.name === name) continue;
        const sub = splitExtension(entry.name);
        if (!SUBTITLE_EXTENSIONS.has(sub.ext)) continue;
        const owns = sub.base === base || sub.base.toLowerCase().startsWith(`${base.toLowerCase()}.`);
        if (!owns) continue;
        const sidecar = await statUnder(join(parent, entry.name), "measuring a subtitle");
        targets.push({
          absolute: join(parent, entry.name),
          relative: joinRelative(folder, entry.name),
          size: Result.isOk(sidecar) ? sidecar.value.size : 0,
        });
      }
    }

    const when = new Date();
    const id = newId(when);
    const entryDir = join(trashRoot, id);
    const made = await withDeadline(
      mkdir(entryDir, { recursive: true }),
      timeoutMs,
      entryDir,
      "creating the trash folder",
    );
    if (Result.isError(made)) return made;

    const moved: TrashedFile[] = [];
    for (const target of targets) {
      const destination = join(entryDir, basename(target.relative));
      const result = await renameUnder(target.absolute, destination, "moving the file to the trash");
      if (Result.isError(result)) {
        // Put back whatever already moved. A half-deleted item is worse than a
        // failed delete: the user asked for one thing and got neither.
        for (const done of moved) {
          await renameUnder(join(root, done.trashed), join(root, done.original), "undoing a partial delete");
        }
        await withDeadline(rm(entryDir, { recursive: true, force: true }), timeoutMs, entryDir, "cleaning up");
        return Result.err(result.error);
      }
      moved.push({
        original: target.relative,
        trashed: `${TRASH_DIR}/${id}/${basename(target.relative)}`,
        size: target.size,
      });
    }

    const entry: TrashEntry = {
      id,
      deletedAt: when.toISOString(),
      path: relative,
      name: basename(relative),
      files: moved,
      size: moved.reduce((total, file) => total + file.size, 0),
    };
    if (opts.reason !== undefined) entry.reason = opts.reason;

    const recorded = await append({ op: "delete", entry });
    if (Result.isError(recorded)) {
      // Without the record there is no way back, so the delete is undone
      // rather than left as an unrestorable pile in `.trash/`.
      for (const done of moved) {
        await renameUnder(join(root, done.trashed), join(root, done.original), "undoing an unrecorded delete");
      }
      await withDeadline(rm(entryDir, { recursive: true, force: true }), timeoutMs, entryDir, "cleaning up");
      return Result.err(recorded.error);
    }

    log(
      `[casatube] library delete ${JSON.stringify({ id, path: relative, files: moved.length, bytes: entry.size, at: entry.deletedAt, reason: opts.reason })}`,
    );
    return Result.ok(entry);
  }

  /** Everything currently in the trash, newest first — journal entries and orphans. */
  async function listTrash(): Promise<Result<TrashEntry[], LibraryError>> {
    const journal = await readJournal();
    if (Result.isError(journal)) return journal;
    const live = replay(journal.value);

    const entries = await readdirUnder(trashRoot, timeoutMs);
    // No trash folder at all is an empty trash, not a broken library.
    if (Result.isError(entries)) {
      const onDisk = await statUnder(trashRoot, "reading the trash");
      if (Result.isError(onDisk) && onDisk.error._tag === "NotFound") return Result.ok([]);
      return Result.err(entries.error);
    }

    const known = new Set(live.keys());
    const all = [...live.values()];

    for (const entry of entries.value) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      const stats = await statUnder(join(trashRoot, entry.name), "reading a trash entry");
      all.push({
        id: entry.name,
        deletedAt: new Date(Result.isOk(stats) ? stats.value.mtimeMs : 0).toISOString(),
        path: "",
        name: entry.name,
        files: [],
        size: 0,
        orphan: true,
      });
    }

    all.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return Result.ok(all);
  }

  /** `Foo.mkv` → `Foo (restored).mkv` → `Foo (restored 2).mkv`. */
  async function freeName(folder: string, name: string): Promise<string> {
    const { base, ext } = splitExtension(name);
    const suffix = ext === "" ? "" : `.${ext}`;
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const candidate = attempt === 1 ? `${base} (restored)${suffix}` : `${base} (restored ${attempt})${suffix}`;
      if (!(await exists(join(folder, candidate)))) return candidate;
    }
    return `${base} (restored ${Date.now()})${suffix}`;
  }

  /**
   * Undo a delete.
   *
   * Accepts whatever the caller happens to be holding: the entry id, the
   * original path, or the path inside `.trash/`. All three identify one entry,
   * and the whole entry comes back — item and sidecars together.
   *
   * ⚠️ **Never overwrites.** If something already occupies the original name —
   * the file was downloaded again after the delete — the restored copy lands
   * beside it as `… (restored)` and the result says so. Silently replacing the
   * newer file would make an undo destructive, which is the one thing an undo
   * must not be.
   */
  async function restore(path: string): Promise<Result<RestoreResult, LibraryError>> {
    const journal = await readJournal();
    if (Result.isError(journal)) return journal;
    const live = replay(journal.value);

    const wanted = path.trim().replace(/^\/+/, "");
    let entry = live.get(wanted);
    if (entry === undefined) {
      const matches = [...live.values()].filter(
        (candidate) =>
          candidate.path === wanted ||
          candidate.files.some((file) => file.trashed === wanted || file.original === wanted) ||
          wanted === `${TRASH_DIR}/${candidate.id}`,
      );
      // Newest first: deleting the same path twice means the last delete is the
      // one an undo refers to.
      matches.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      entry = matches[0];
    }
    if (entry === undefined) return Result.err(new NotFound({ what: "trash entry", id: path }));
    if (entry.files.length === 0) {
      return Result.err(new NotFound({ what: "restorable trash entry", id: entry.id }));
    }

    const moves: { from: string; to: string }[] = [];
    let renamed = false;
    let primary = entry.path;

    for (const file of entry.files) {
      const source = resolveInRoot(root, file.trashed);
      if (Result.isError(source)) return source;
      const target = resolveInRoot(root, file.original);
      if (Result.isError(target)) return target;

      const folder = dirname(target.value);
      const made = await withDeadline(
        mkdir(folder, { recursive: true }),
        timeoutMs,
        folder,
        "recreating the folder",
      );
      if (Result.isError(made)) return made;

      let destination = target.value;
      if (await exists(destination)) {
        renamed = true;
        destination = join(folder, await freeName(folder, basename(target.value)));
      }

      const result = await renameUnder(source.value, destination, "restoring the file");
      if (Result.isError(result)) return result;

      const to = toRelative(root, destination);
      moves.push({ from: file.trashed, to });
      if (file.original === entry.path) primary = to;
    }

    await withDeadline(
      rm(join(trashRoot, entry.id), { recursive: true, force: true }),
      timeoutMs,
      join(trashRoot, entry.id),
      "cleaning up the trash entry",
    );

    const at = new Date().toISOString();
    const recorded = await append({ op: "restore", id: entry.id, at, to: primary });
    if (Result.isError(recorded)) return recorded;

    log(`[casatube] library restore ${JSON.stringify({ id: entry.id, to: primary, files: moves.length, at })}`);
    return Result.ok({ id: entry.id, path: primary, files: moves, renamed });
  }

  /**
   * The only place a library file is really removed.
   *
   * `olderThanDays` is the retention window PLAN §18 asks for; omitted, the
   * configured default applies. **`0` empties the trash outright** — the
   * force-delete for when the space is needed now, and the reason this
   * parameter is not simply a boolean.
   */
  async function emptyTrash(olderThanDays?: number): Promise<Result<EmptyTrashResult, LibraryError>> {
    const days = Math.max(0, olderThanDays ?? retentionDays);
    const cutoff = Date.now() - days * 86_400_000;

    const all = await listTrash();
    if (Result.isError(all)) return all;

    let removed = 0;
    let freedBytes = 0;
    const kept: TrashEntry[] = [];

    for (const entry of all.value) {
      const deletedAt = Date.parse(entry.deletedAt);
      const stale = !Number.isFinite(deletedAt) || deletedAt <= cutoff;
      if (!stale) {
        kept.push(entry);
        continue;
      }
      const dir = join(trashRoot, entry.id);
      const gone = await withDeadline(
        rm(dir, { recursive: true, force: true }),
        timeoutMs,
        dir,
        "emptying the trash",
      );
      if (Result.isError(gone)) return gone;
      removed += 1;
      freedBytes += entry.size;
      if (!entry.orphan) {
        const recorded = await append({ op: "empty", id: entry.id, at: new Date().toISOString(), freedBytes: entry.size });
        if (Result.isError(recorded)) return recorded;
      }
      log(`[casatube] library purge ${JSON.stringify({ id: entry.id, path: entry.path, bytes: entry.size })}`);
    }

    // The journal is append-only between purges, and a purge is the natural
    // moment to compact it: every record it still needs is a live entry.
    if (removed > 0) {
      const compacted = await compact(kept.filter((entry) => entry.orphan !== true));
      if (Result.isError(compacted)) return compacted;
    }

    return Result.ok({ removed, freedBytes, remaining: kept.length, olderThanDays: days });
  }

  /** Rewrite the journal as just the deletes that are still live. */
  async function compact(entries: TrashEntry[]): Promise<Result<void, MountUnavailable>> {
    const body = entries.map((entry) => `${JSON.stringify({ op: "delete", entry })}\n`).join("");
    const temporary = `${journalPath}.tmp`;
    const written = await withDeadline(
      writeFile(temporary, body, "utf8"),
      timeoutMs,
      temporary,
      "rewriting the trash journal",
    );
    if (Result.isError(written)) return written;
    return renameUnder(temporary, journalPath, "replacing the trash journal");
  }

  return { root, retentionDays, list, item, presence, probe, remove, restore, emptyTrash, listTrash };
}
