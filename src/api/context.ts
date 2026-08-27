/**
 * What every route needs, handed in rather than reached for.
 *
 * Routes are factories over this so the server can be assembled with a
 * different database or a different registry — which is what makes an
 * end-to-end test possible without a real yt-dlp on the machine.
 */
import type { CredentialStore } from "../core/credentials";
import type { Db } from "../core/db";
import type { HlsManager } from "../core/hls";
import type { PluginRuntime } from "../core/plugin-runtime";
import type { JobQueue } from "../core/queue";
import type { TranscodeQueue } from "../core/transcode";
import type { SourceScheduler } from "../core/scheduler";
import type { SourceManager } from "../core/sources";
import type { ProviderRegistry } from "../providers/registry";
import type { AppSettingsStore } from "../core/app-settings";
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
  /**
   * Per-site credentials — cookies, passwords, API keys.
   *
   * Handed in like everything else here, and **the same instance the provider
   * registry was built with**. Two stores over the same table would still
   * work, but the registry's copy is the one that decrypts and the routes' copy
   * is the one that validates, and a divergence in `CREDENTIALS_KEY` between
   * them would show up as "saved fine, never applies".
   */
  credentials: CredentialStore;
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
  /**
   * On-demand HLS playback.
   *
   * ⚠️ Handed in rather than built by the route because it is the one piece of
   * the HTTP layer that owns **processes and disk**: up to `maxSessions`
   * ffmpegs and a directory under `TEMP_DIR`. Whoever creates it has to stop
   * it, and only the process knows when that is. Optional for the same reason
   * `plugins` is — `createApp` must stand up in a test without one.
   */
  hls?: HlsManager;
  /**
   * The transcode queue — the one thing here that **re-encodes**.
   *
   * ⚠️ Optional for the same reason `hls` is, and owned for the same reason: it
   * holds a polling loop and, at any moment, one ffmpeg burning the machine.
   * Whoever creates it starts it and stops it; a route must never be the thing
   * that owns a process outliving the request.
   */
  transcodes?: TranscodeQueue;
  /**
   * Editable configuration — user override > environment variable > default.
   *
   * Optional for the same reason `plugins` is: `createApp` must stand up in a
   * test without one, and constructing it costs nothing (it reads the table on
   * demand, never in its constructor). ⚠️ A store built here rather than handed
   * in has **no boot snapshot**, so it captures "what is running" on its first
   * read — correct for a test, and the reason `main()` hands one in instead.
   */
  settings?: AppSettingsStore;
  config: ServerConfig;
}
