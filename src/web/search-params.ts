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

export const DOWNLOAD_TABS = ["active", "completed", "failed", "scheduled"] as const;
export type DownloadTab = (typeof DOWNLOAD_TABS)[number];

export interface DownloadsSearch {
  tab: DownloadTab;
  q?: string;
  job?: string;
}

export const QUEUE_FILTERS = ["all", "waiting", "running", "done", "failed"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

export const INSPECTOR_TABS = ["details", "tasks", "logs"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export interface QueueSearch {
  status: QueueFilter;
  job?: string;
  panel: InspectorTab;
}

export const LIBRARY_SORTS = ["modified", "name", "size"] as const;
export const SORT_ORDERS = ["asc", "desc"] as const;
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
