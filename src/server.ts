/**
 * The server: HTTP surface, and the process that boots it.
 *
 * Two things live here and they are kept apart on purpose. `createApp` builds
 * the Elysia application from an already-assembled context and has **no side
 * effects** — no database opened, no port bound — which is what lets a test
 * stand one up against a temporary database, and what lets `App` be exported as
 * a type without importing this module doing anything. `main()` is the process:
 * it opens the real database, recovers whatever a previous run left in flight,
 * and listens.
 *
 * ## `App` is the contract with the browser
 *
 * `@elysiajs/eden` derives the client from this type, so renaming a route or
 * changing a payload becomes a **compile error in the frontend** instead of a
 * 404 discovered by clicking (PLAN §8). Nothing in `src/web` writes a `fetch`
 * by hand — including the SSE stream, which Eden parses back into typed frames.
 */
import { Elysia } from "elysia";

import { CredentialStore, credentialsKeyFromEnv, warnIfUnprotected } from "./core/credentials";
import { appDbPath, openDb, queueDbPath } from "./core/db";
import { Worker } from "./worker/worker";
import { BUILTIN_SEED_KEY, dbSettings, pluginSettingsStore } from "./core/settings";
import { describeSeed, seedBuiltins, type SeedRecord } from "./core/plugin-builtins";
import { createPluginRuntime, pluginsDir } from "./core/plugin-runtime";
import { NotificationStore, createJobNotifier } from "./core/notifications";
import { AppSettingsStore } from "./core/app-settings";
import { openJobQueue } from "./core/queue";
import { SourceScheduler } from "./core/scheduler";
import { NotificationRetention, policyFromSettings } from "./core/notification-retention";
import { SourceManager, registryDiscoverer } from "./core/sources";
import { createDefaultRegistry } from "./providers/registry";
import { describeFfmpegLocation, resolveFfmpegLocation } from "./providers/ytdlp";
import { createTelegramProvider } from "./providers/telegram";
import { loadConfig, type ServerConfig } from "./api/config";
import type { AppContext } from "./api/context";
import { credentialRoutes } from "./api/credentials";
import { destinationRoutes } from "./api/destinations";
import { eventRoutes } from "./api/events";
import { createLibraryHlsManager, hlsRoutes } from "./api/hls";
import { createLibraryTranscodeQueue, transcodeRoutes } from "./api/transcode";
import { notificationRoutes } from "./api/notifications";
import { statsRoutes } from "./api/stats";
import { jobRoutes } from "./api/jobs";
import { libraryRoutes } from "./api/library";
import { pluginRoutes } from "./api/plugins";
import { probeRoutes } from "./api/probe";
import { applyStoredSettings, settingRoutes } from "./api/settings";
import { sourceRoutes } from "./api/sources";
import { createQueueWatcher } from "./api/watcher";
import { buildClient, webRoutes, type ClientBundle } from "./api/web";

/** Everything under `/api`. Kept separate so the catch-all can exclude it by prefix. */
function apiRoutes(ctx: AppContext) {
  return new Elysia({ prefix: "/api" })
    .get("/health", () => ({
      ok: true,
      // Useful enough to be worth returning, and none of it is a secret. The
      // cookies file is *not* here: PLAN §12 says credentials are never echoed
      // back through the API, and a path is enough to go looking.
      version: "0.1.0",
      watchers: ctx.watcher.subscribers(),
      providers: ctx.registry.providers().map((provider) => provider.name),
    }))
    .use(jobRoutes(ctx))
    .use(probeRoutes(ctx))
    // 🔴 Write-only. Nothing under here ever returns a secret — see the header
    // of `api/credentials.ts`.
    .use(credentialRoutes(ctx))
    .use(destinationRoutes(ctx))
    .use(libraryRoutes(ctx))
    // After `libraryRoutes`, and a separate module: these own ffmpeg processes
    // and temp disk, which nothing else under `/library` does. See `api/hls.ts`.
    .use(hlsRoutes(ctx))
    // Next to the HLS routes and separate from them for the same reason: this
    // one owns a process too. ⚠️ Unlike HLS it **re-encodes** — see
    // `core/transcode.ts` for why it runs one job at a time.
    .use(transcodeRoutes(ctx))
    .use(sourceRoutes(ctx))
    .use(statsRoutes(ctx))
    .use(notificationRoutes(ctx))
    /**
     * Plugins. `ctx.plugins` is optional, so an app assembled without a runtime
     * still answers here — with an empty list, which is the truthful answer for
     * a process that loaded none. Constructing one costs nothing: the runtime
     * reads the disk in `load()`, never in its constructor.
     */
    .use(
      pluginRoutes(
        ctx.plugins ?? createPluginRuntime({ dir: pluginsDir(ctx.config.dataDir), registry: ctx.registry }),
        // Where a plugin file goes. The runtime knows it and keeps it to
        // itself, so the layout function answers again here — an empty plugins
        // screen has to be able to say where the directory is.
        pluginsDir(ctx.config.dataDir),
      ),
    )
    /**
     * Editable configuration. Like `plugins`, the store is optional on the
     * context and built here when it is absent — it reads the table on demand,
     * so constructing one costs nothing and an app assembled without it still
     * answers correctly.
     */
    .use(settingRoutes({ settings: ctx.settings ?? new AppSettingsStore({ db: ctx.db }) }))
    .use(eventRoutes(ctx));
}

export function createApp(ctx: AppContext, bundle: ClientBundle) {
  return (
    new Elysia()
      /**
       * The last net. Routes convert their own `Result`s (PLAN §10 rule 5); by
       * the time something reaches here it is a defect or a bad request, and
       * both are more useful as JSON with a tag than as an empty 500.
       */
      .onError(({ code, error, path, status }) => {
        if (code === "NOT_FOUND") {
          return status(404, { tag: "NotFound", message: `No such endpoint: ${path}`, retryable: false });
        }
        if (code === "VALIDATION") {
          return status(422, {
            tag: "InvalidRequest",
            message: error instanceof Error ? error.message : "The request body did not validate.",
            retryable: false,
          });
        }
        console.error(`[casatube] unhandled ${code} on ${path}:`, error);
        return status(500, {
          tag: "Unexpected",
          message: error instanceof Error ? error.message : "Something went wrong.",
          retryable: true,
        });
      })
      .use(apiRoutes(ctx))
      // Last: it ends in a catch-all, and anything after it would be shadowed.
      .use(webRoutes(ctx, bundle))
  );
}

/** What Eden consumes. See the header. */
export type App = ReturnType<typeof createApp>;

export interface StartedServer {
  app: ReturnType<typeof createApp>;
  config: ServerConfig;
  stop(): Promise<void>;
}

async function main(): Promise<StartedServer> {
  let config = loadConfig();

  const db = openDb({ path: appDbPath(config.dataDir) });

  /**
   * 🔴 The environment produced `config`; the stored overrides now win over it.
   *
   * This has to happen here and not inside `loadConfig`: the database that
   * holds the overrides is found *using* the configuration, so the order is
   * environment → database → overrides applied. It is also what makes a
   * restart-scoped setting real — without this, writing `server.port` would
   * store a number no restart ever reads.
   *
   * `captureRunning()` runs immediately after, so the snapshot of "what this
   * process is actually using" is taken from the values it is about to boot
   * with rather than guessed at later.
   */
  const settingsStore = new AppSettingsStore({
    db,
    // ⚠️ `TEMP_DIR`'s default is a function of `DATA_DIR`, so the catalogue
    // cannot hold it as a literal. Handing it over here is what stops the
    // screen from printing `""` next to "default" for a directory the worker
    // is actually writing into.
    derivedDefaults: { "server.tempDir": `${config.dataDir}/tmp` },
  });
  config = await applyStoredSettings(config, settingsStore);
  await settingsStore.captureRunning();

  const queue = await openJobQueue({
    db,
    queueDbPath: queueDbPath(config.dataDir),
    onMirrorError: (context, cause) => console.error(`[casatube] queue mirror: ${context}`, cause),
  });

  // 🔴 R2. Anything a previous run was holding goes back to the queue before a
  // single request is served — otherwise the first thing the browser sees is a
  // job stuck in `downloading` with nobody working on it.
  const recovered = await queue.recoverOnStart();

  // 🔴 Loud, before anything can be pasted. PLAN §15 and the Settings screen
  // both claim credentials are encrypted at rest; with no key that claim is
  // false, and the only acceptable version of "false" is one that says so.
  warnIfUnprotected(credentialsKeyFromEnv(), (line) => console.warn(line));

  const credentials = new CredentialStore({ db, tempDir: config.tempDir });

  /**
   * yt-dlp's ffmpeg, made to be the same one as ours.
   *
   * Until this existed, `FFMPEG_BIN` meant two things: it configured *our*
   * ffmpeg (HLS, thumbnails) and yt-dlp used whatever `PATH` held. The visible
   * half of that failure was a `.webp` poster no media server would render —
   * see `docs/DISCOVERIES.md`. Resolved rather than forwarded, because yt-dlp
   * answers a location that does not exist by continuing without ffmpeg.
   */
  const ffmpegLocation = resolveFfmpegLocation(config.ffmpegBinary);
  for (const line of describeFfmpegLocation(config.ffmpegBinary, ffmpegLocation)) {
    console.warn(`[casatube] ffmpeg ${line}`);
  }

  const registry = createDefaultRegistry({
    binary: config.ytdlpBinary,
    // The global fallback from PLAN §12. A per-site credential overrides it.
    cookiesFile: config.cookiesFile,
    credentials,
    ffmpegLocation: ffmpegLocation?.path,
  });

  /**
   * Telegram, ahead of the fallback.
   *
   * 🔴 The one source yt-dlp genuinely cannot reach: a private channel's video
   * is never an HTTP URL, it is MTProto chunks. `register` inserts in front of
   * the yt-dlp catch-all, which is exactly what PLAN §5 means by "a custom
   * extractor for a site yt-dlp covers badly".
   *
   * ⚠️ It claims **private** links only, and only when there is a credential
   * store to authenticate against. Public `t.me` links keep going to yt-dlp's
   * `telegram:embed` — claiming a URL this cannot serve would take it away from
   * a fallback that might manage it.
   */
  registry.register(createTelegramProvider({ credentials }));
  /**
   * The plugins that ship with CasaTube, put into the data directory.
   *
   * ⚠️ Before `load()`, because seeding writes the files that `load()` then
   * reads — and after the database is open, because what has already been
   * seeded is a row in `settings`. See `core/plugin-builtins.ts` for the four
   * cases: your edits are never written over, and a plugin you deleted stays
   * deleted.
   */
  const store = dbSettings(db);
  const seeded = await seedBuiltins(pluginsDir(config.dataDir), store.get<SeedRecord>(BUILTIN_SEED_KEY) ?? {});
  store.set(BUILTIN_SEED_KEY, seeded.record);
  for (const line of describeSeed(seeded.outcomes)) console.log(`[casatube] plugin ${line}`);

  // Plugins load before the worker starts: a plugin may register a provider in
  // setup(), and a provider that appears after the first job is claimed would
  // never be asked about it.
  const plugins = createPluginRuntime({
    dir: pluginsDir(config.dataDir),
    registry,
    // What the Settings form writes. Without it the form still renders and
    // still resolves, and nothing it saves survives a restart.
    settings: pluginSettingsStore(store),
  });
  await plugins.load();

  const watcher = createQueueWatcher(queue, { pollMs: config.eventsPollMs });

  // Automation. The manager writes through `queue.enqueue` like any other
  // client, and the scheduler only decides *when* — so nothing here is a second
  // path into the job table (PLAN §17 rule 3).
  const sources = new SourceManager({ db, queue, discover: registryDiscoverer(registry) });
  const scheduler = new SourceScheduler({
    manager: sources,
    log: (line) => console.log(`[casatube] ${line}`),
    onError: (sourceId, error) => console.error(`[casatube] source ${sourceId}:`, error),
  });

  // Built here, not in the route, because it has to be stopped — it holds a
  // sweep timer and, at any moment, up to `HLS_MAX_SESSIONS` ffmpeg processes.
  const hls = createLibraryHlsManager(config);

  // Built here for the same reason `hls` is: it holds a polling loop and, when
  // it is working, one ffmpeg. ⚠️ And unlike HLS, that ffmpeg is *encoding* —
  // so a copy left running by a botched shutdown is the whole machine, not a
  // few percent of one core.
  const transcodes = createLibraryTranscodeQueue({ db, config });

  const ctx: AppContext = {
    db, queue, registry, watcher, config, sources, scheduler, plugins, hls, credentials, transcodes,
    settings: settingsStore,
  };

  const bundle = await buildClient({ dev: config.dev });
  if (bundle.error) console.error(`[casatube] client bundle failed:\n${bundle.error}`);

  // The worker shares this process today, but nothing here assumes that: it
  // talks to the queue through the database like any other client would, and
  // the watcher polls the table rather than listening to it. That is what keeps
  // PLAN §17 rule 3 true — no in-memory state welds the two together.
  const notificationStore = new NotificationStore({ db });
  const notifier = createJobNotifier(
    notificationStore,
    (cause) => console.error("[casatube] notification write failed", cause),
  );

  /**
   * Retention for `notifications`, which until now grew until somebody pressed
   * the button. The policy is read on every sweep because both settings are
   * `live` — see `core/notification-retention.ts`.
   */
  const notificationRetention = new NotificationRetention({
    store: notificationStore,
    policy: () => policyFromSettings((key) => settingsStore.get(key)),
    log: (line) => console.log(`[casatube] ${line}`),
    onError: (error) => console.error("[casatube] notification retention failed", error),
  });

  const worker = new Worker({
    queue,
    registry,
    notifier,
    // 🔴 Without this the pipeline fires no hooks at all — plugins loaded,
    // configured and listed as applicable, and never called once.
    plugins,
    tempDir: config.tempDir,
    libraryDir: config.libraryDir,
    maxConcurrentDownloads: config.maxConcurrentDownloads,
  });
  void worker.start();
  scheduler.start();
  notificationRetention.start();

  // Anything a killed process was mid-way through goes back to `queued` before
  // the loop starts, so a restart costs time and nothing else.
  const requeuedTranscodes = await transcodes.recoverOnStart();
  transcodes.start();

  const app = createApp(ctx, bundle);
  app.listen({ port: config.port, hostname: "0.0.0.0" });

  console.log(`[casatube] listening on http://localhost:${config.port}`);
  console.log(`[casatube] data dir ${config.dataDir}, library ${config.libraryDir}`);
  console.log(`[casatube] hls sessions in ${hls.root} (max ${config.hls.maxSessions})`);
  if (recovered > 0) console.log(`[casatube] recovered ${recovered} job(s) from the last run`);
  if (requeuedTranscodes > 0) {
    console.log(`[casatube] requeued ${requeuedTranscodes} interrupted transcode(s)`);
  }
  console.log(`[casatube] ${plugins.list().length} plugin(s) loaded`);

  const stop = async (): Promise<void> => {
    worker.stop();
    scheduler.stop();
    notificationRetention.stop();
    // Before the port closes: an ffmpeg left behind by a restart is a core
    // burning on a file nobody is watching, and nothing would ever reap it.
    await hls.stop();
    // ⚠️ And the encoder, for the same reason and more so: this one is using
    // every core. Its row stays `running` and comes back as `queued`.
    await transcodes.stop();
    await scheduler.drain();
    await notificationRetention.drain();
    watcher.stop();
    await app.stop();
    queue.close();
    db.$client.close(false);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[casatube] ${signal}, shutting down`);
      void stop().then(() => process.exit(0));
    });
  }

  return { app, config, stop };
}

if (import.meta.main) await main();
