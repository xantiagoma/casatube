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
  sort: JobSort;
  order: SortOrder;
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
 */
export const JOB_SORTS = ["date", "status", "priority", "size", "duration"] as const;
export type JobSort = (typeof JOB_SORTS)[number];

/**
 * Downloads' file-state filter.
 *
 * ⚠️ There is no `missing`: nothing on the wire says whether a recorded output
 * path still exists. `components/jobs/job-order.ts` carries the full note.
 */
export const FILE_FILTERS = ["any", "filed", "trashed", "none"] as const;
export type FileFilter = (typeof FILE_FILTERS)[number];

export const LIBRARY_SORTS = ["modified", "name", "size"] as const;
export const SORT_ORDERS = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const LIBRARY_VIEWS = ["grid", "list"] as const;

export interface LibrarySearch {
  q?: string;
  folder?: string;
  sort: (typeof LIBRARY_SORTS)[number];
  order: (typeof SORT_ORDERS)[number];
  view: (typeof LIBRARY_VIEWS)[number];
  item?: string;
  /** The trash is a view of the library, not a separate screen. */
  trash: boolean;
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
