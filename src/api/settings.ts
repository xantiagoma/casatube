/**
 * `/api/settings` — the three endpoints that make configuration editable.
 *
 * | | |
 * |---|---|
 * | `GET /api/settings` | every setting, with its source, its environment variable name and whether it needs a restart |
 * | `PUT /api/settings/:key` | write a user override |
 * | `DELETE /api/settings/:key` | remove it, and say what the value fell back to |
 *
 * The precedence rule — **user > environment > default** — lives in
 * `core/app-settings.ts` and is not re-implemented here. This module is the
 * HTTP boundary and one piece of boot wiring, and nothing else.
 *
 * ## The three things worth knowing
 *
 * 📌 **`GET` always names the environment variable**, set or not. That is the
 * question the read-only screen could not answer: "which variable do I put in
 * the compose file for this?" — and it is why `envVar` is a required field on
 * the definition rather than an optional annotation.
 *
 * 🔴 **A write to a restart-scoped setting is stored and reported as pending.**
 * `PUT /api/settings/server.port` answers `200` with `pendingRestart: true` and
 * `runningValue` still holding the port the socket is actually on. It does not
 * answer as though the port had moved, and it does not refuse the write either:
 * the value is real, it is simply not in force yet. Anything else would be a
 * control that lies in one direction or the other.
 *
 * ⚠️ **`DELETE` is a reset, not a delete of the setting.** The setting cannot
 * be removed — it is a definition in the code. What goes away is the user's
 * override, and the response says exactly where the value landed (`resetsTo`,
 * plus the new `source` and `value`), because "reset" is meaningless if it does
 * not say what to.
 *
 * ## Boot wiring
 *
 * `applyStoredSettings` is the other half of the restart-scoped settings: the
 * process reads the environment into a `ServerConfig`, opens the database from
 * it, and then lets the stored overrides win. Running it *before*
 * `captureRunning()` is what makes the snapshot the truth about the process
 * rather than a guess.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";

import { AppSettingsStore, type ResolvedSetting } from "../core/app-settings";
import type { ServerConfig } from "./config";
import { fail } from "./errors";

/** Only what these routes use — the same narrowing `stats.ts` does. */
export interface SettingsContext {
  settings: AppSettingsStore;
}

export function settingRoutes(ctx: SettingsContext) {
  const { settings } = ctx;

  return (
    new Elysia({ prefix: "/settings" })
      /**
       * Everything, in one call.
       *
       * One request rather than one per setting because the screen renders them
       * together and because `restartPending` is a fact about the *set* — a
       * banner saying "three changes are waiting for a restart" cannot be
       * assembled from responses that each only know about themselves.
       *
       * `preferences` travels with it: it is the merged result of the whole
       * `downloads.*` group, which is what a job with no preferences actually
       * gets. Deriving it in the browser would be the precedence rule
       * implemented a second time, in the one place it is free to drift.
       */
      .get("/", async () => settings.snapshot())

      /**
       * Write an override.
       *
       * The body is `{ value }` and `value` is `t.Unknown()` on purpose: a
       * setting can be a boolean, a whole number, a string, one of a fixed set,
       * or a list of language tags, and Elysia cannot type that from the route.
       * The check that matters is `validateValue`, which knows the *definition*
       * — the range, the option list, the tag grammar — and answers 422 with
       * the rule it broke rather than with "the request body did not validate".
       */
      .put(
        "/:key",
        async ({ params, body }) => {
          const saved = await settings.set(params.key, body.value);
          if (Result.isError(saved)) return fail(saved.error);
          return saved.value;
        },
        { body: t.Object({ value: t.Unknown() }) },
      )

      /**
       * Reset: remove the override and report where the value went.
       *
       * Idempotent. Resetting a setting that has no override is not an error —
       * it is a request for a state the system is already in, and the response
       * is the same resolved setting either way.
       */
      .delete("/:key", async ({ params }) => {
        const cleared = await settings.clear(params.key);
        if (Result.isError(cleared)) return fail(cleared.error);
        return cleared.value;
      })
  );
}

// --- Boot wiring ------------------------------------------------------------

/**
 * The stored override for `key`, when there is one — and `undefined` otherwise.
 *
 * 🔴 **`source === "user"` is the whole guard, and it was a bug before it was a
 * guard.** The first version applied the *resolved* value, which for an
 * untouched setting is the environment's or the catalogue's default — so
 * booting with `LIBRARY_DIR=/mnt/media` and nothing stored would have reset the
 * library root to `/library`, and `TEMP_DIR`'s derived `${DATA_DIR}/tmp`
 * default to `""`. `loadConfig` has already read the environment correctly by
 * the time this runs; the only thing left for it to do is let a *user override*
 * win. A test caught it (`the environment is left exactly as it was`).
 */
function override<T extends string | number>(
  resolved: Map<string, ResolvedSetting>,
  key: string,
  current: T,
): T {
  const setting = resolved.get(key);
  if (setting === undefined || setting.source !== "user") return current;
  return typeof setting.value === typeof current ? (setting.value as T) : current;
}

/**
 * Let the stored overrides win over the environment, once, at boot.
 *
 * 🔴 This is what makes a restart-scoped setting *real* rather than a row
 * nobody reads. Without it, `PUT /api/settings/server.port` would write a value
 * no restart ever picks up — the same broken control as before, moved one layer
 * down where it is harder to see.
 *
 * ⚠️ `DATA_DIR` is deliberately absent: the database that holds these rows
 * lives inside it, so the override could not be read early enough to be
 * honoured. It is marked `editable: false` in the definition, so the API
 * refuses the write with that sentence rather than accepting one and ignoring
 * it.
 */
export async function applyStoredSettings(config: ServerConfig, store: AppSettingsStore): Promise<ServerConfig> {
  const resolved = new Map((await store.list()).map((setting) => [setting.key, setting]));
  const at = <T extends string | number>(key: string, current: T): T => override(resolved, key, current);

  // The three binaries are optional, so an override of `""` is not a command
  // to run — it is "whatever is on PATH", which is `undefined` here.
  const binary = (key: string, current: string | undefined): string | undefined => {
    const setting = resolved.get(key);
    if (setting === undefined || setting.source !== "user") return current;
    return typeof setting.value === "string" && setting.value.trim() !== "" ? setting.value : undefined;
  };

  return {
    ...config,
    port: at("server.port", config.port),
    tempDir: at("server.tempDir", config.tempDir),
    libraryDir: at("library.libraryDir", config.libraryDir),
    eventsPollMs: at("server.eventsPollMs", config.eventsPollMs),
    trashRetentionDays: at("library.trashRetentionDays", config.trashRetentionDays),
    ytdlpBinary: binary("server.ytdlpBinary", config.ytdlpBinary),
    ffmpegBinary: binary("server.ffmpegBinary", config.ffmpegBinary),
    ffprobeBinary: binary("server.ffprobeBinary", config.ffprobeBinary),
    hls: {
      segmentSeconds: at("playback.hlsSegmentSeconds", config.hls.segmentSeconds),
      idleMs: at("playback.hlsIdleMs", config.hls.idleMs),
      transcodeIdleMs: at("playback.hlsTranscodeIdleMs", config.hls.transcodeIdleMs),
      maxSessions: at("playback.hlsMaxSessions", config.hls.maxSessions),
    },
    thumbnails: {
      width: at("thumbnails.width", config.thumbnails.width),
      maxConcurrent: at("thumbnails.maxConcurrent", config.thumbnails.maxConcurrent),
      timeoutMs: at("thumbnails.timeoutMs", config.thumbnails.timeoutMs),
      maxEntries: at("thumbnails.maxEntries", config.thumbnails.maxEntries),
    },
  };
}
