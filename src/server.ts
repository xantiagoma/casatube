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

import { appDbPath, openDb, queueDbPath } from "./core/db";
import { Worker } from "./worker/worker";
import { openJobQueue } from "./core/queue";
import { SourceScheduler } from "./core/scheduler";
import { SourceManager, registryDiscoverer } from "./core/sources";
import { createDefaultRegistry } from "./providers/registry";
import { loadConfig, type ServerConfig } from "./api/config";
import type { AppContext } from "./api/context";
import { destinationRoutes } from "./api/destinations";
import { eventRoutes } from "./api/events";
import { notificationRoutes } from "./api/notifications";
import { statsRoutes } from "./api/stats";
import { jobRoutes } from "./api/jobs";
import { libraryRoutes } from "./api/library";
import { probeRoutes } from "./api/probe";
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
    .use(destinationRoutes(ctx))
    .use(libraryRoutes(ctx))
    .use(sourceRoutes(ctx))
    .use(statsRoutes(ctx))
    .use(notificationRoutes(ctx))
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
  const config = loadConfig();

  const db = openDb({ path: appDbPath(config.dataDir) });
  const queue = await openJobQueue({
    db,
    queueDbPath: queueDbPath(config.dataDir),
    onMirrorError: (context, cause) => console.error(`[casatube] queue mirror: ${context}`, cause),
  });

  // 🔴 R2. Anything a previous run was holding goes back to the queue before a
  // single request is served — otherwise the first thing the browser sees is a
  // job stuck in `downloading` with nobody working on it.
  const recovered = await queue.recoverOnStart();

  const registry = createDefaultRegistry({
    binary: config.ytdlpBinary,
    cookiesFile: config.cookiesFile,
  });
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

  const ctx: AppContext = { db, queue, registry, watcher, config, sources, scheduler };

  const bundle = await buildClient({ dev: config.dev });
  if (bundle.error) console.error(`[casatube] client bundle failed:\n${bundle.error}`);

  // The worker shares this process today, but nothing here assumes that: it
  // talks to the queue through the database like any other client would, and
  // the watcher polls the table rather than listening to it. That is what keeps
  // PLAN §17 rule 3 true — no in-memory state welds the two together.
  const worker = new Worker({
    queue,
    registry,
    tempDir: config.tempDir,
    libraryDir: config.libraryDir,
  });
  void worker.start();
  scheduler.start();

  const app = createApp(ctx, bundle);
  app.listen({ port: config.port, hostname: "0.0.0.0" });

  console.log(`[casatube] listening on http://localhost:${config.port}`);
  console.log(`[casatube] data dir ${config.dataDir}, library ${config.libraryDir}`);
  if (recovered > 0) console.log(`[casatube] recovered ${recovered} job(s) from the last run`);

  const stop = async (): Promise<void> => {
    worker.stop();
    scheduler.stop();
    await scheduler.drain();
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
