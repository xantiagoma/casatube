/**
 * The search params, as types the whole app can import.
 *
 * 🔴 They live apart from `router.tsx` for one structural reason: the screens
 * need these types, and `router.tsx` needs the screens. Declaring them in the
 * router makes that a cycle — the module graph loads one of the two halves
 * before it is complete, and the failure that produces is a blank page with no
 * error worth reading.
 *
 * PLAN §8: the Library's filters, the Queue's status filter and the Downloads
 * tabs live in the URL so a view can be shared, bookmarked and survive a
 * reload. `validateSearch` in the router is what makes that safe — a hand-typed
 * `?sort=banana` becomes the default instead of a crash — and these are the
 * shapes it validates into.
 */
import { JOB_SORT_KEYS, SORT_ORDERS, type JobSortKey, type SortOrder } from "../core/types";
import type { StatsRange } from "../core/stats";

/** Coerce anything to one of a known set, falling back rather than failing. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(String(value)) ? (value as T) : fallback;
}

export function optionalOneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return (allowed as readonly string[]).includes(String(value)) ? (value as T) : undefined;
}

/** A search param that is absent rather than empty. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A 1-based page number past the first, or absent: page 1 is the default and stays out of the URL. */
export function pageNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 1 ? n : undefined;
}

/** Rows per page on the job screens. */
export const JOB_PAGE_SIZE = 100;

/**
 * The fields that do *not* change which rows are listed — picking a job, or a
 * tab of its inspector. Changing anything else starts again at page 1.
 */
export const KEEPS_PAGE = new Set(["job", "panel", "page"]);

/** Whether a change to the search moves the list, so the page must go back to 1. */
export function resetsPage(fields: object): boolean {
  return Object.keys(fields).some((key) => !KEEPS_PAGE.has(key));
}

export const RANGES = ["24h", "7d", "30d"] as const satisfies readonly StatsRange[];

export interface DashboardSearch {
  range: StatsRange;
}

/** The inspector's tabs. Shared: Downloads and Queue both open the same panel. */
export const INSPECTOR_TABS = ["details", "tasks", "logs"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export const DOWNLOAD_TABS = ["active", "completed", "failed", "scheduled"] as const;
export type DownloadTab = (typeof DOWNLOAD_TABS)[number];

export interface DownloadsSearch {
  tab: DownloadTab;
  q?: string;
  /** 1-based; absent is page 1. */
  page?: number;
  job?: string;
  sort: JobSort;
  order: SortOrder;
  /** What became of the downloaded file — see `components/jobs/job-order`. */
  file: FileFilter;
  /**
   * Which tab of the inspector is open.
   *
   * 🔴 Here for the same reason the Queue has it: the inspector's tabs are
   * controlled, so their state has to live somewhere, and a screen that passed
   * a constant instead left Tasks and Logs unclickable. Being in the URL also
   * makes "this job, on its log" a link — which is the state worth sending
   * someone when something failed.
   */
  panel: InspectorTab;
}

export const QUEUE_FILTERS = ["all", "waiting", "running", "done", "failed"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

export interface QueueSearch {
  status: QueueFilter;
  q?: string;
  /** 1-based; absent is page 1. */
  page?: number;
  sort: JobSort;
  order: SortOrder;
  /**
   * What became of the file — the same filter Downloads has.
   *
   * It belongs here too because "which of my downloads lost its file" is not a
   * question about a tab: the Queue is the screen that shows *everything*, and
   * a filter that only existed on one of them made the answer depend on which
   * screen you happened to be looking at.
   */
  file: FileFilter;
  job?: string;
  panel: InspectorTab;
}

/**
 * How the two job screens order their rows.
 *
 * 🔴 In the URL rather than in a `useState` for the reason everything else here
 * is: "the biggest failed downloads, oldest first" is a view worth sending
 * someone, and a sort that lives in a component is a sort that a reload throws
 * away. `date` + `desc` is the default on both screens — a queue is read
 * newest-first, and the API's own order (priority, then oldest) is the wrong
 * one to show.
 *
 * ⚠️ **The list itself comes from `core/types.ts`**, because the server sorts
 * now and these keys travel to it as a query parameter. Two copies would let a
 * key exist on the screen that the route rejects — which is a filter that
 * silently does nothing.
 */
export const JOB_SORTS = JOB_SORT_KEYS;
export type JobSort = JobSortKey;

/**
 * The file-state filter, on **both** job screens.
 *
 * 🔴 `missing` and `unknown` are the two that earn their place. `missing` is a
 * fact the server established by looking at the disk (`POST
 * /api/jobs/file-state`), and it used to be unrepresentable — the badge said
 * *Filed* for a file that had been `rm`'d on the NAS, and the tooltip admitted
 * as much. `unknown` is its opposite number and just as load-bearing: a library
 * that is unreachable must produce *"could not check"* rows a person can find
 * and re-check, not rows quietly reported as gone.
 */
export const FILE_FILTERS = ["any", "present", "missing", "trashed", "none", "unknown"] as const;
export type FileFilter = (typeof FILE_FILTERS)[number];

export const LIBRARY_SORTS = ["modified", "name", "size"] as const;
export { SORT_ORDERS, type SortOrder };
export const LIBRARY_VIEWS = ["grid", "list"] as const;

/**
 * The three things the Library screen can be showing.
 *
 * 🔴 One param rather than a boolean per view. It began as `trash: boolean`,
 * and adding conversions to that would have meant two independent flags with an
 * impossible combination between them (`trash` *and* `conversions`) that
 * something would eventually have to arbitrate. The router still reads an old
 * `?trash=true` link and lands on the right tab — see `router.tsx`.
 */
export const LIBRARY_TABS = ["media", "conversions", "trash"] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

export interface LibrarySearch {
  q?: string;
  folder?: string;
  sort: (typeof LIBRARY_SORTS)[number];
  order: (typeof SORT_ORDERS)[number];
  view: (typeof LIBRARY_VIEWS)[number];
  item?: string;
  /** The trash and the conversions are views of the library, not other screens. */
  tab: LibraryTab;
}

export const SOURCE_KINDS = ["all", "playlists", "subscriptions"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourcesSearch {
  kind: SourceKind;
  id?: string;
}

export interface StorageSearch {
  range: StatsRange;
}

export const SETTINGS_SECTIONS = ["general", "downloads", "storage", "plugins", "notifications", "security"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface SettingsSearch {
  section?: SettingsSection;
}
