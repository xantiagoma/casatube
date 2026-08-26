/**
 * What every route needs, handed in rather than reached for.
 *
 * Routes are factories over this so the server can be assembled with a
 * different database or a different registry — which is what makes an
 * end-to-end test possible without a real yt-dlp on the machine.
 */
import type { JobQueue } from "../core/queue";
import type { ProviderRegistry } from "../providers/registry";
import type { ServerConfig } from "./config";
import type { QueueWatcher } from "./watcher";

export interface AppContext {
  queue: JobQueue;
  registry: ProviderRegistry;
  watcher: QueueWatcher;
  config: ServerConfig;
}
