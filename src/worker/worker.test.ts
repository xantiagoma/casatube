/**
 * The acceptance test for the whole project.
 *
 * R1 and R2 say a job must survive the browser closing and the service
 * restarting. The browser is not involved here at all — that is the point, and
 * it is what makes R1 true by construction. R2 is what has to be proven, and it
 * is proven the only way that means anything: by actually stopping everything,
 * closing the database files, and starting again.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { openDb, closeDb } from "../core/db";
import { openJobQueue, shutdownEmbeddedQueue } from "../core/queue";
import { createRegistry } from "../providers/registry";
import { Worker } from "./worker";
import { createPluginRuntime, type PluginRuntime } from "../core/plugin-runtime";
import { DEFAULT_PREFERENCES } from "../core/types";
import type { Provider } from "../core/types";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "casatube-worker-"));
});

afterEach(async () => {
  await shutdownEmbeddedQueue();
  await rm(root, { recursive: true, force: true });
});

/**
 * A provider that writes a real file, in two halves, pausing in between.
 *
 * The pause is the whole point: it gives the test somewhere to interrupt that
 * is genuinely mid-download rather than between stages.
 */
function halfwayProvider(opts: {
  onHalfway?: () => Promise<void> | void;
  failFirstHalf?: boolean;
}): Provider {
  return {
    name: "test",
    supports: () => true,
    async probe() {
      return Result.ok({
        externalId: "abc", title: "A Video", duration: 10, source: "test",
        videoFormats: [{ id: "v1", width: 1920, height: 1080, codec: "avc1" }],
        audioTracks: [{ id: "a1", language: "en-US", isOriginal: true }],
        subtitles: [],
      });
    },
    async fetch(plan, ctx) {
      const file = join(ctx.workDir, `${plan.outputName}.mkv`);
      await mkdir(ctx.workDir, { recursive: true });
      await writeFile(file, "half");
      ctx.onProgress({ percent: 50, doneBytes: 4, totalBytes: 8 });
      if (opts.onHalfway) await opts.onHalfway();
      if (opts.failFirstHalf) {
        return Result.err({ _tag: "FetchFailed", url: plan.url, detail: "interrupted" } as never);
      }
      await writeFile(file, "halfhalf");
      ctx.onProgress({ percent: 100, doneBytes: 8, totalBytes: 8 });
      return Result.ok({ file, subtitleFiles: [] });
    },
  };
}

async function boot(provider: Provider, plugins?: PluginRuntime) {
  const db = openDb({ path: join(root, "app.db") });
  const queue = await openJobQueue({ db, queueDbPath: join(root, "queue.db") });
  const registry = createRegistry();
  registry.register(provider);
  const worker = new Worker({
    queue, registry, plugins,
    tempDir: join(root, "tmp"),
    libraryDir: join(root, "library"),
    leaseMs: 5_000, pollMs: 10,
  });
  return { db, queue, worker };
}

/**
 * A real plugin runtime over a directory this test writes.
 *
 * ⚠️ Not a stub. The thing being proven is that the *pipeline* calls the
 * runtime, and a hand-written fake would prove that the test's own fake gets
 * called — which is exactly the shape of check that let plugins ship dispatching
 * nothing at all.
 */
async function pluginsWith(source: string, name = "recorder"): Promise<PluginRuntime> {
  const dir = join(root, "plugins");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.ts`), source);
  const runtime = createPluginRuntime({ dir, registry: createRegistry() });
  await runtime.load();
  return runtime;
}

/**
 * A plugin that records every hook it is called at.
 *
 * ⚠️ It records into `globalThis`, not into a file. A plugin is loaded by
 * dynamic `import`, so it shares this process's globals — which makes the
 * recording synchronous and impossible to lose. The first attempt wrote to a
 * file with `Bun.write` and recorded nothing, and the test then could not tell
 * "the hook never fired" from "the write never landed": two very different
 * bugs behind one empty list.
 */
function recorderSource(channel: string, name = "recorder"): string {
  return `export default {
  name: ${JSON.stringify(name)},
  version: "1.0.0",
  description: "records the hooks it is called at",
  capabilities: [],
  matches: ["*"],
  hooks: [
    { at: "job:queued", kind: "observe" },
    { at: "probe:complete", kind: "transform" },
    { at: "download:complete", kind: "observe" },
    { at: "job:completed", kind: "observe" },
    { at: "job:failed", kind: "observe" },
  ],
  setup({ on }) {
    const channel = ${JSON.stringify(channel)};
    const note = (line) => {
      globalThis[channel] = [...(globalThis[channel] ?? []), line];
    };
    on("job:queued", () => note("job:queued"));
    on("probe:complete", (info, plan) => { note("probe:complete"); return plan; });
    on("download:complete", () => note("download:complete"));
    on("job:completed", () => note("job:completed"));
    on("job:failed", () => note("job:failed"));
  },
};
`;
}

function recorded(channel: string): string[] {
  return ((globalThis as Record<string, unknown>)[channel] as string[] | undefined) ?? [];
}

test("a job completes end to end and the file lands in the library", async () => {
  const { db, queue, worker } = await boot(halfwayProvider({}));

  const queued = await queue.enqueue({
    url: "https://example.test/v", destination: "Videos",
    preferences: DEFAULT_PREFERENCES,
  });
  expect(Result.isOk(queued)).toBe(true);

  const claimed = await queue.claimNext("slot-1");
  expect(Result.isOk(claimed) && claimed.value).toBeTruthy();
  await worker.run((claimed as { value: NonNullable<unknown> }).value as never);

  const done = await queue.get(Result.unwrap(queued).job.id);
  expect(Result.unwrap(done).status).toBe("done");

  const files = await readdir(join(root, "library", "Videos"));
  expect(files).toHaveLength(1);

  await queue.close();
  closeDb(db);
});

test("the provider's thumbnail lands next to the video, as a sidecar", async () => {
  // 🔴 The move stage is where a sidecar is either kept or lost. The subtitles
  // already travelled; the poster has to travel the same way and keep its name,
  // because `Name.jpg` beside `Name.mkv` is what makes it a sidecar at all.
  const provider: Provider = {
    ...halfwayProvider({}),
    async fetch(plan, ctx) {
      await mkdir(ctx.workDir, { recursive: true });
      const file = join(ctx.workDir, `${plan.outputName}.mkv`);
      const poster = join(ctx.workDir, `${plan.outputName}.jpg`);
      await writeFile(file, "video");
      await writeFile(poster, "poster");
      return Result.ok({ file, subtitleFiles: [], thumbnailFile: poster });
    },
  };
  const { db, queue, worker } = await boot(provider);

  const queued = await queue.enqueue({
    url: "https://example.test/v", destination: "Videos",
    preferences: DEFAULT_PREFERENCES,
  });
  const claimed = await queue.claimNext("slot-1");
  await worker.run((claimed as { value: NonNullable<unknown> }).value as never);

  expect(Result.unwrap(await queue.get(Result.unwrap(queued).job.id)).status).toBe("done");
  const files = (await readdir(join(root, "library", "Videos"))).sort();
  expect(files).toEqual(["A Video.jpg", "A Video.mkv"]);

  await queue.close();
  closeDb(db);
});

test("🔴 R2: a job interrupted mid-download survives a full restart", async () => {
  // --- first boot: get the job genuinely mid-download, then stop dead -------
  let first = await boot(halfwayProvider({ failFirstHalf: true }));

  const queued = await first.queue.enqueue({
    url: "https://example.test/v", destination: "Videos",
    preferences: DEFAULT_PREFERENCES,
  });
  const jobId = Result.unwrap(queued).job.id;

  const claimed = await first.queue.claimNext("slot-1");
  await first.worker.run(Result.unwrap(claimed) as never);

  const midway = Result.unwrap(await first.queue.get(jobId));
  expect(midway.status).not.toBe("done");
  expect(midway.doneBytes).toBe(4);        // progress was recorded…
  expect(midway.progress).toBe(50);        // …and it is on disk, not in memory

  // Everything goes away: connections closed, embedded manager shut down.
  await first.queue.close();
  closeDb(first.db);
  await shutdownEmbeddedQueue();

  expect(await Bun.file(join(root, "app.db")).exists()).toBe(true);

  // --- second boot: same files, nothing carried over in the process --------
  const second = await boot(halfwayProvider({}));
  const recovered = await second.queue.recoverOnStart();
  expect(recovered).toBeGreaterThanOrEqual(0);

  const afterRestart = Result.unwrap(await second.queue.get(jobId));
  expect(afterRestart.doneBytes).toBe(4);  // the bytes survived the restart

  // It must be claimable again — a job that recovers but cannot be picked up
  // is R2 failing quietly, which is worse than failing loudly.
  const reclaimed = await second.queue.claimNext("slot-1");
  expect(Result.isOk(reclaimed) && reclaimed.value?.id).toBe(jobId);

  await second.worker.run(Result.unwrap(reclaimed) as never);

  const finished = Result.unwrap(await second.queue.get(jobId));
  expect(finished.status).toBe("done");

  const files = await readdir(join(root, "library", "Videos"));
  expect(files).toHaveLength(1);

  await second.queue.close();
  closeDb(second.db);
});

// --- Plugin hooks actually firing (2026-08-27) -------------------------------

/**
 * 🔴 The bug this block exists for: **no hook was ever dispatched**.
 *
 * Plugins loaded, validated, appeared on the Settings screen, could be enabled,
 * disabled and configured, and the download window listed which ones "apply" —
 * and nothing in the pipeline ever called `runtime.run`. Found by installing a
 * plugin that logged at all six points and watching it print nothing.
 *
 * So every test here drives a **real** runtime over a real plugin file. A fake
 * would only prove the fake gets called, which is precisely the check that was
 * missing.
 */
test("🔴 the pipeline fires every hook it declares, in the order the job happens", async () => {
  const log = `hooks-${Math.round(performance.now() * 1000)}`;
  const plugins = await pluginsWith(recorderSource(log));
  const { db, queue, worker } = await boot(halfwayProvider({}), plugins);

  const queued = Result.unwrap(
    await queue.enqueue({ url: "https://example.test/v", destination: "Videos" }),
  );
  const claimed = await queue.claimNext("slot-1");
  await worker.run(Result.unwrap(claimed) as never);
  await plugins.observersIdle();

  // `job:queued` belongs to the enqueue path (the API route fires it), so the
  // worker's share is the three that happen while the job runs.
  expect(recorded(log)).toEqual(["probe:complete", "download:complete", "job:completed"]);
  expect(Result.unwrap(await queue.get(queued.job.id)).status).toBe("done");

  await queue.close();
  closeDb(db);
});

test("🔴 a job's opt-out is honoured at every point, not just the first", async () => {
  // One gate, in `eligible`. A second one further down the pipeline is how
  // "off" comes to mean different things at different lifecycle points.
  const log = `hooks-${Math.round(performance.now() * 1000)}`;
  const plugins = await pluginsWith(recorderSource(log));
  const { db, queue, worker } = await boot(halfwayProvider({}), plugins);

  await queue.enqueue({
    url: "https://example.test/v",
    destination: "Videos",
    pluginsOff: ["recorder"],
  });
  const claimed = await queue.claimNext("slot-1");
  await worker.run(Result.unwrap(claimed) as never);
  await plugins.observersIdle();

  expect(recorded(log)).toEqual([]);

  await queue.close();
  closeDb(db);
});

test("an opt-out names one plugin and leaves the others running", async () => {
  const kept = `kept-${Math.round(performance.now() * 1000)}`;
  const dropped = `dropped-${Math.round(performance.now() * 1000)}`;
  const dir = join(root, "plugins");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "kept.ts"), recorderSource(kept, "kept"));
  await writeFile(join(dir, "dropped.ts"), recorderSource(dropped, "dropped"));
  const plugins = createPluginRuntime({ dir, registry: createRegistry() });
  await plugins.load();

  const { db, queue, worker } = await boot(halfwayProvider({}), plugins);
  await queue.enqueue({
    url: "https://example.test/v",
    destination: "Videos",
    pluginsOff: ["dropped", "a-plugin-that-does-not-exist"],
  });
  await worker.run(Result.unwrap(await queue.claimNext("slot-1")) as never);
  await plugins.observersIdle();

  expect(recorded(kept)).toEqual(["probe:complete", "download:complete", "job:completed"]);
  expect(recorded(dropped)).toEqual([]);

  await queue.close();
  closeDb(db);
});

test("🔴 a transforming hook that throws fails the job rather than downloading the old plan", async () => {
  // `probe:complete` is the one point where a plugin decides what gets
  // downloaded. Swallowing its failure would download the plan the plugin was
  // trying to replace, and call it a success.
  const dir = join(root, "plugins");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "angry.ts"),
    `export default {
  name: "angry", version: "1.0.0", description: "throws", capabilities: [], matches: ["*"],
  hooks: [{ at: "probe:complete", kind: "transform" }],
  setup({ on }) { on("probe:complete", () => { throw new Error("no"); }); },
};
`,
  );
  const plugins = createPluginRuntime({ dir, registry: createRegistry() });
  await plugins.load();

  const { db, queue, worker } = await boot(halfwayProvider({}), plugins);
  const queued = Result.unwrap(
    await queue.enqueue({ url: "https://example.test/v", destination: "Videos" }),
  );
  await worker.run(Result.unwrap(await queue.claimNext("slot-1")) as never);

  const job = Result.unwrap(await queue.get(queued.job.id));
  expect(job.status).not.toBe("done");
  expect(job.error).toContain("angry");
  // And nothing landed in the library, which is the half that matters.
  expect(await readdir(join(root, "library")).catch(() => [])).toEqual([]);

  await queue.close();
  closeDb(db);
});

test("🔴 an observer that throws does not fail a download that worked", async () => {
  // The whole reason the two kinds exist: a media-server refresh that failed
  // does not make a correctly downloaded file wrong.
  const dir = join(root, "plugins");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "noisy.ts"),
    `export default {
  name: "noisy", version: "1.0.0", description: "throws late", capabilities: [], matches: ["*"],
  hooks: [{ at: "job:completed", kind: "observe" }],
  setup({ on }) { on("job:completed", () => { throw new Error("boom"); }); },
};
`,
  );
  const plugins = createPluginRuntime({ dir, registry: createRegistry() });
  await plugins.load();

  const { db, queue, worker } = await boot(halfwayProvider({}), plugins);
  const queued = Result.unwrap(
    await queue.enqueue({ url: "https://example.test/v", destination: "Videos" }),
  );
  await worker.run(Result.unwrap(await queue.claimNext("slot-1")) as never);
  await plugins.observersIdle();

  expect(Result.unwrap(await queue.get(queued.job.id)).status).toBe("done");
  expect(await readdir(join(root, "library", "Videos"))).toHaveLength(1);

  await queue.close();
  closeDb(db);
});
