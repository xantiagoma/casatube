/**
 * The worker: claims a job and walks it through the six stages.
 *
 * This is where R1 and R2 are actually satisfied. Everything it knows lives in
 * the database — nothing meaningful is held in a JS variable, because a process
 * that dies must lose nothing but time.
 */
import { Result } from "better-result";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobQueue } from "../core/queue";
import type { ProviderRegistry } from "../providers/registry";
import type { DownloadPlan, Job, ProgressUpdate, StageName } from "../core/types";
import { buildDownloadPlan } from "../core/selection";
import { demandsBackoff } from "../core/errors";
import {
  clearRunning, initialStages, markDone, markFailed, markRunning,
  resumeFrom, statusForStage,
} from "./stages";

export interface WorkerOptions {
  queue: JobQueue;
  registry: ProviderRegistry;
  /** Worker-local scratch. ⚠️ Never shared — PLAN §17 rule 5. */
  tempDir: string;
  libraryDir: string;
  /** Identifies the slot. Distributed, this would be a hostname — PLAN §17 rule 2. */
  workerId?: string;
  /** How long a claim stays ours before it lapses. Renewed while we work. */
  leaseMs?: number;
  pollMs?: number;
  now?: () => Date;
}

const nowIso = (now: () => Date) => now().toISOString();

export class Worker {
  #o: Required<WorkerOptions>;
  #running = false;
  #active = new Map<string, AbortController>();

  constructor(o: WorkerOptions) {
    this.#o = {
      workerId: `slot-1`, leaseMs: 60_000, pollMs: 1_000,
      now: () => new Date(), ...o,
    };
  }

  /** Cancel a job that is running right now. Queue state is the queue's business. */
  interrupt(jobId: string): boolean {
    const c = this.#active.get(jobId);
    if (!c) return false;
    c.abort();
    return true;
  }

  async start(): Promise<void> {
    this.#running = true;
    while (this.#running) {
      const claimed = await this.#o.queue.claimNext(this.#o.workerId);
      if (Result.isError(claimed) || !claimed.value) {
        await Bun.sleep(this.#o.pollMs);
        continue;
      }
      await this.run(claimed.value);
    }
  }

  stop(): void {
    this.#running = false;
    for (const c of this.#active.values()) c.abort();
  }

  /**
   * Run one job to completion.
   *
   * Public so a test can drive a single job without the polling loop — the
   * acceptance test for R2 needs exactly that.
   */
  async run(job: Job): Promise<void> {
    const { queue, now } = this.#o;
    const controller = new AbortController();
    this.#active.set(job.id, controller);

    // Keep the claim alive. An 800 MB download outlives any sane lease, so
    // without renewal the lease is either uselessly long or lapses under a
    // perfectly healthy worker.
    const renew = setInterval(() => {
      void queue.renewLease(job.id, this.#o.workerId);
    }, Math.max(1_000, Math.floor(this.#o.leaseMs / 3)));

    const workDir = join(this.#o.tempDir, job.id);

    try {
      let stages = job.stages.length ? clearRunning(job.stages) : initialStages();
      // Recovered from the row, not recomputed: a resume that skipped `analyze`
      // would otherwise have nothing to download.
      let plan: DownloadPlan | null = job.plan ?? null;
      let downloaded: { file: string; subtitleFiles: string[] } | null = null;

      const from = resumeFrom(job);
      const remaining = ["validate", "analyze", "download", "postprocess", "metadata", "move"]
        .slice(["validate", "analyze", "download", "postprocess", "metadata", "move"].indexOf(from)) as StageName[];

      for (const stage of remaining) {
        if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");

        stages = markRunning(stages, stage, nowIso(now));
        await queue.update(job.id, { stages, status: statusForStage(stage) });

        const outcome = await this.#stage(stage, job, {
          workDir, controller, plan, downloaded,
          onProgress: (p) => void queue.update(job.id, patchOf(p)),
          log: (line) => void queue.update(job.id, { appendLog: [line] }),
        });

        if (Result.isError(outcome)) {
          const e = outcome.error;
          const detail = "detail" in e ? String(e.detail) : e._tag;
          stages = markFailed(stages, stage, detail, nowIso(now));
          await queue.update(job.id, { stages });

          // A source that is refusing us must not be hammered. `demandsBackoff`
          // is the difference between retrying this job and easing off entirely.
          if (demandsBackoff(e)) {
            const wait = "retryAfterMs" in e && e.retryAfterMs ? Number(e.retryAfterMs) : 15 * 60_000;
            await queue.defer(job.id, wait);
          }
          await queue.update(job.id, { error: detail });
          await queue.retry(job.id);
          return;
        }

        if (outcome.value?.plan) plan = outcome.value.plan;
        if (outcome.value?.downloaded) downloaded = outcome.value.downloaded;

        stages = markDone(stages, stage, nowIso(now));
        await queue.update(job.id, { stages });
      }

      await queue.update(job.id, {
        status: "done", progress: 100,
        outputFile: downloaded ? await this.#finalPath(job, downloaded.file) : null,
      });
      await rm(workDir, { recursive: true, force: true });
    } catch (err) {
      if (controller.signal.aborted) {
        await this.#o.queue.update(job.id, { status: "cancelled" });
      } else {
        // A defect, not an expected failure: it escaped the Result channel.
        await this.#o.queue.update(job.id, {
          error: err instanceof Error ? err.message : String(err),
        });
        await this.#o.queue.retry(job.id);
      }
    } finally {
      clearInterval(renew);
      this.#active.delete(job.id);
    }
  }

  async #finalPath(job: Job, file: string): Promise<string> {
    return join(this.#o.libraryDir, job.destination, file.split("/").pop() ?? "output");
  }

  async #stage(
    stage: StageName,
    job: Job,
    ctx: {
      workDir: string; controller: AbortController;
      plan: DownloadPlan | null;
      downloaded: { file: string; subtitleFiles: string[] } | null;
      onProgress(p: ProgressUpdate): void;
      log(line: string): void;
    },
  ): Promise<Result<{ plan?: DownloadPlan; downloaded?: { file: string; subtitleFiles: string[] } } | null, any>> {
    const { registry, queue } = this.#o;

    switch (stage) {
      case "validate": {
        const provider = registry.resolve(job.url);
        if (Result.isError(provider)) return provider;
        // Record who claimed it, so the UI and any later resume agree.
        await queue.update(job.id, { provider: provider.value.name });
        return Result.ok(null);
      }

      case "analyze": {
        const provider = registry.resolve(job.url);
        if (Result.isError(provider)) return provider;
        const info = await provider.value.probe(job.url, ctx.controller.signal);
        if (Result.isError(info)) return info;

        const plan = buildDownloadPlan(job.url, info.value, job.preferences);
        if (Result.isError(plan)) return plan;

        await queue.update(job.id, {
          title: plan.value.outputName,
          duration: info.value.duration ?? null,
          thumbnail: info.value.thumbnail ?? null,
          source: info.value.source,
        });
        await queue.update(job.id, { plan: plan.value });
        return Result.ok({ plan: plan.value });
      }

      case "download": {
        if (!ctx.plan) return Result.ok(null);
        const provider = registry.resolve(job.url);
        if (Result.isError(provider)) return provider;

        await mkdir(ctx.workDir, { recursive: true });
        const got = await provider.value.fetch(ctx.plan, {
          workDir: ctx.workDir,
          signal: ctx.controller.signal,
          onProgress: ctx.onProgress,
          log: ctx.log,
        });
        if (Result.isError(got)) return got;
        return Result.ok({ downloaded: got.value });
      }

      // The provider already merges, embeds and tags through yt-dlp's
      // post-processors, so these two have nothing left to do. They stay in the
      // pipeline because the UI shows six stages and a provider that does less
      // will need them.
      case "postprocess":
      case "metadata":
        return Result.ok(null);

      case "move": {
        if (!ctx.downloaded) return Result.ok(null);
        const target = await this.#finalPath(job, ctx.downloaded.file);
        await mkdir(dirname(target), { recursive: true });

        // Same filesystem: a rename, instant. Different: a copy, which may be
        // minutes over a network mount. Both are correct; only one is fast.
        try {
          await rename(ctx.downloaded.file, target);
        } catch {
          await Bun.write(target, Bun.file(ctx.downloaded.file));
          await rm(ctx.downloaded.file, { force: true });
        }

        for (const sub of ctx.downloaded.subtitleFiles) {
          const subTarget = join(dirname(target), sub.split("/").pop() ?? "sub");
          try { await rename(sub, subTarget); }
          catch { await Bun.write(subTarget, Bun.file(sub)); await rm(sub, { force: true }); }
        }

        // Verify rather than assume: a move that silently produced nothing is
        // exactly the failure mode this project exists to eliminate.
        const s = await stat(target).catch(() => null);
        if (!s || s.size === 0) {
          return Result.err({ _tag: "StageFailed", stage: "move", detail: `nothing at ${target}` });
        }
        return Result.ok(null);
      }
    }
  }
}

function patchOf(p: ProgressUpdate) {
  return {
    progress: p.percent !== undefined ? Math.round(p.percent) : undefined,
    doneBytes: p.doneBytes, totalBytes: p.totalBytes,
    speed: p.speed, eta: p.eta,
  };
}
