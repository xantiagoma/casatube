/**
 * What every route needs, handed in rather than reached for.
 *
 * Routes are factories over this so the server can be assembled with a
 * different database or a different registry — which is what makes an
 * end-to-end test possible without a real yt-dlp on the machine.
 */
import type { Db } from "../core/db";
import type { PluginRuntime } from "../core/plugin-runtime";
import type { JobQueue } from "../core/queue";
import type { SourceScheduler } from "../core/scheduler";
import type { SourceManager } from "../core/sources";
import type { ProviderRegistry } from "../providers/registry";
import type { ServerConfig } from "./config";
import type { QueueWatcher } from "./watcher";

export interface AppContext {
  /**
   * The application database.
   *
   * The queue keeps its own handle and exposes only job operations, so the
   * routes that read the other tables — notifications, analytics — would
   * otherwise have to open a second connection to the same file to answer a
   * `SELECT`.
   */
  db: Db;
  queue: JobQueue;
  registry: ProviderRegistry;
  /** Subscriptions, and the timer that services them — PLAN §11, phase 4. */
  sources: SourceManager;
  scheduler: SourceScheduler;
  watcher: QueueWatcher;
  /**
   * The loaded plugins, when the process has any.
   *
   * Optional because `createApp` must stand up without one — the routes fall
   * back to an empty runtime, which lists nothing and is exactly what a caller
   * that never loaded plugins should see.
   */
  plugins?: PluginRuntime;
  config: ServerConfig;
}
