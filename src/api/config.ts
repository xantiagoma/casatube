/**
 * Server configuration, read from the environment — PLAN §12.
 *
 * Everything the HTTP layer needs to boot lives here, so the image is the only
 * artefact and a deployment is a set of variables. Defaults are the ones PLAN
 * §12 names, because the default is what happens when nobody is watching.
 */
import { dataDir } from "../core/db";

export interface ServerConfig {
  port: number;
  /** Both SQLite files live here. */
  dataDir: string;
  /** Downloads land here before the move — the worker owns it, we only report it. */
  tempDir: string;
  /** Destination root. Job destinations are subfolders of this, never absolute. */
  libraryDir: string;
  /** ⚠️ Credentials. Never echoed back through the API — PLAN §12. */
  cookiesFile?: string;
  ytdlpBinary?: string;
  /**
   * How often the queue is re-read to decide whether the SSE stream has
   * anything new to say.
   *
   * Polling rather than an in-process event bus on purpose: the rows can also
   * be written by a worker in another process, and a bus would only see the
   * writes that happen to share our memory. See `events.ts`.
   */
  eventsPollMs: number;
  /**
   * How long a deleted item stays in `.trash/` before a purge may remove it.
   *
   * Deleting moves rather than unlinks, so this is the width of the undo
   * window — the thing that makes a mistaken delete recoverable.
   */
  trashRetentionDays: number;
  /** Rebuild the client bundle on every page load. Off in the image. */
  dev: boolean;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function str(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const dir = env.DATA_DIR ?? dataDir();
  return {
    port: int(env.PORT, 8520),
    dataDir: dir,
    tempDir: env.TEMP_DIR ?? `${dir}/tmp`,
    libraryDir: env.LIBRARY_DIR ?? "/library",
    cookiesFile: str(env.COOKIES_FILE),
    ytdlpBinary: str(env.YTDLP_BIN),
    eventsPollMs: int(env.EVENTS_POLL_MS, 750),
    trashRetentionDays: int(env.TRASH_RETENTION_DAYS, 30),
    dev: env.NODE_ENV !== "production" && str(env.CASATUBE_DEV) !== undefined,
  };
}
