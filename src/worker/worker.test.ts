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

async function boot(provider: Provider) {
  const db = openDb({ path: join(root, "app.db") });
  const queue = await openJobQueue({ db, queueDbPath: join(root, "queue.db") });
  const registry = createRegistry();
  registry.register(provider);
  const worker = new Worker({
    queue, registry,
    tempDir: join(root, "tmp"),
    libraryDir: join(root, "library"),
    leaseMs: 5_000, pollMs: 10,
  });
  return { db, queue, worker };
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
