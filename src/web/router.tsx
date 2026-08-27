/**
 * The routes, and the search params that belong to the URL rather than to a
 * component.
 *
 * 🔴 PLAN §8: the Library's filters, the Queue's status filter and the
 * Downloads tabs live in the URL so a view can be shared, bookmarked and
 * survive a reload. `validateSearch` is what makes that safe — a hand-typed
 * `?sort=banana` becomes the default instead of a crash, and every screen reads
 * a typed object rather than picking strings out of `location.search`.
 *
 * Routes are declared in code rather than generated from files: the client is
 * bundled by `Bun.build` straight from `index.html`, and a file-route generator
 * would add a build step to a project whose whole deployment story is
 * `bun src/server.ts`.
 */
import { createRootRoute, createRoute, createRouter, type SearchSchemaInput } from "@tanstack/react-router";

import { AppShell } from "./components/layout/AppShell";
import { Dashboard } from "./screens/Dashboard";
import { Downloads } from "./screens/Downloads";
import { LibraryScreen } from "./screens/Library";
import { Queue } from "./screens/Queue";
import { SchedulerScreen } from "./screens/Scheduler";
import { Settings } from "./screens/Settings";
import { Sources } from "./screens/Sources";
import { Storage } from "./screens/Storage";
import {
  DOWNLOAD_TABS,
  INSPECTOR_TABS,
  LIBRARY_SORTS,
  LIBRARY_VIEWS,
  QUEUE_FILTERS,
  RANGES,
  SETTINGS_SECTIONS,
  SORT_ORDERS,
  SOURCE_KINDS,
  oneOf,
  optionalOneOf,
  text,
  type DashboardSearch,
  type DownloadsSearch,
  type LibrarySearch,
  type QueueSearch,
  type SettingsSearch,
  type SourcesSearch,
  type StorageSearch,
} from "./search-params";

const rootRoute = createRootRoute({ component: AppShell });

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): DashboardSearch => ({
    range: oneOf(search.range, RANGES, "24h"),
  }),
  component: Dashboard,
});

const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/downloads",
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): DownloadsSearch => ({
    tab: oneOf(search.tab, DOWNLOAD_TABS, "active"),
    panel: oneOf(search.panel, INSPECTOR_TABS, "details"),
    ...(text(search.q) !== undefined ? { q: text(search.q)! } : {}),
    ...(text(search.job) !== undefined ? { job: text(search.job)! } : {}),
  }),
  component: Downloads,
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): QueueSearch => ({
    status: oneOf(search.status, QUEUE_FILTERS, "all"),
    panel: oneOf(search.panel, INSPECTOR_TABS, "details"),
    ...(text(search.job) !== undefined ? { job: text(search.job)! } : {}),
  }),
  component: Queue,
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): LibrarySearch => ({
    sort: oneOf(search.sort, LIBRARY_SORTS, "modified"),
    order: oneOf(search.order, SORT_ORDERS, "desc"),
    view: oneOf(search.view, LIBRARY_VIEWS, "grid"),
    trash: search.trash === true || search.trash === "true",
    ...(text(search.q) !== undefined ? { q: text(search.q)! } : {}),
    ...(text(search.folder) !== undefined ? { folder: text(search.folder)! } : {}),
    ...(text(search.item) !== undefined ? { item: text(search.item)! } : {}),
  }),
  component: LibraryScreen,
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): SourcesSearch => ({
    kind: oneOf(search.kind, SOURCE_KINDS, "all"),
    ...(text(search.id) !== undefined ? { id: text(search.id)! } : {}),
  }),
  component: Sources,
});

const schedulerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scheduler",
  component: SchedulerScreen,
});

const storageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/storage",
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): StorageSearch => ({
    range: oneOf(search.range, RANGES, "24h"),
  }),
  component: Storage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): SettingsSearch => {
    const section = optionalOneOf(search.section, SETTINGS_SECTIONS);
    return section === undefined ? {} : { section };
  },
  component: Settings,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  downloadsRoute,
  queueRoute,
  libraryRoute,
  sourcesRoute,
  schedulerRoute,
  storageRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // A deep link into a path the server serves but the client does not know is
  // a typo, not a reason to show a blank page.
  defaultNotFoundComponent: () => (
    <div className="py-16 text-center">
      <p className="text-lg font-semibold">No such screen</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The address bar says something CasaTube does not have.
      </p>
    </div>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
