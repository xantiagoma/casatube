/**
 * The worker: claims a job and walks it through the six stages.
 *
 * This is where R1 and R2 are actually satisfied. Everything it knows lives in
 * the database — nothing meaningful is held in a JS variable, because a process
 * that dies must lose nothing but time.
 */
import { Result } from "better-result";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { JobQueue } from "../core/queue";
import type { ProviderRegistry } from "../providers/registry";
import type { PluginRuntime } from "../core/plugin-runtime";
import type { DownloadPlan, FetchResult, Job, ProgressUpdate, StageName } from "../core/types";
import { buildDownloadPlan, freeStem, stemIsTaken, videoCodecNotice } from "../core/selection";
import { openLibrary, SUBTITLE_EXTENSIONS } from "../core/library";
import { demandsBackoff } from "../core/errors";
import { Semaphore } from "./semaphore";
import type { HookArgs } from "../core/plugin-runtime";
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
  /**
   * How many jobs may be in flight at once.
   *
   * Higher than the download limit on purpose: a job spends most of its life
   * uploading to the library or running ffmpeg, neither of which the source
   * cares about, and holding the queue still during those would waste the
   * limit rather than respect it.
   */
  maxActiveJobs?: number;
  /**
   * How many may be in the **download** stage at once — the only stage that
   * touches the source, and therefore the only number the IP budget cares
   * about (PLAN §17).
   *
   * 3 follows metube, which has run that for seven years across roughly ten
   * times the users of the tool this replaces.
   */
  maxConcurrentDownloads?: number;
  now?: () => Date;
  /**
   * Told when a job ends, so the bell has something in it.
   *
   * Optional and never awaited for correctness: a notification that fails to
   * write must not fail the download it was reporting on.
   */
  notifier?: {
    completed(job: Job): Promise<void>;
    failed(job: Job, error: string): Promise<void>;
  };
  /**
   * The loaded plugins, so their hooks actually fire.
   *
   * 🔴 Its absence was a real bug and not a small one: plugins loaded, appeared
   * on the Settings screen, could be enabled, disabled and configured, the
   * download window listed which ones "apply" — and **nothing ever called
   * them**, at any lifecycle point. Verified by a plugin that logged at all six
   * points and never printed a line.
   *
   * Optional for the reason `notifier` is: a worker in a test must stand up
   * without a plugin directory.
   */
  plugins?: PluginRuntime;
}

const nowIso = (now: () => Date) => now().toISOString();

export class Worker {
  #o: Required<WorkerOptions>;
  #running = false;
  #active = new Map<string, AbortController>();
  #downloads: Semaphore;

  constructor(o: WorkerOptions) {
    this.#o = {
      workerId: `slot-1`, leaseMs: 60_000, pollMs: 1_000,
      maxActiveJobs: 4, maxConcurrentDownloads: 3,
      now: () => new Date(), notifier: undefined as never, plugins: undefined as never, ...o,
    };
    this.#downloads = new Semaphore(this.#o.maxConcurrentDownloads);
  }

  /**
   * Fire a lifecycle hook for one job, honouring what that job opted out of.
   *
   * ⚠️ The two kinds are not treated the same and must not be. An **observer**
   * that fails is a log line: a media-server refresh that did not happen does
   * not make a correctly downloaded file wrong, so nothing here can turn one
   * into a failed job. A **transform** can change the outcome, so its failure
   * is the job's failure — which is why `probe:complete` is dispatched inline
   * in the stage that owns the plan rather than through this.
   */
  #observe<P extends "job:queued" | "download:complete" | "job:completed" | "job:failed">(
    job: Job,
    at: P,
    ...args: HookArgs[P]
  ): void {
    const plugins = this.#o.plugins;
    if (!plugins) return;
    void plugins.runWith(job.pluginsOff, at, ...args).then((outcome) => {
      // Only a transform can produce this, and none is registered at these
      // points — but a plugin declaring the wrong kind should not be silent.
      if (Result.isError(outcome)) {
        void this.#o.queue.update(job.id, {
          appendLog: [`plugin ${outcome.error.plugin} failed at ${at}: ${outcome.error.detail}`],
        });
      }
    });
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
      // Claim only while there is room. Claiming eagerly would take jobs off
      // the queue to sit in memory, which is exactly the state a restart
      // cannot recover — the lease would lapse and they would come back, but
      // the queue would have lied about them in the meantime.
      if (this.#active.size >= this.#o.maxActiveJobs) {
        await Bun.sleep(this.#o.pollMs);
        continue;
      }

      const claimed = await this.#o.queue.claimNext(this.#o.workerId);
      if (Result.isError(claimed) || !claimed.value) {
        await Bun.sleep(this.#o.pollMs);
        continue;
      }

      // Not awaited: the loop goes back for the next job while this one runs.
      // `run` handles its own failures and always clears itself from `#active`.
      void this.run(claimed.value);
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
      let downloaded: FetchResult | null = null;
      /** Where the move stage actually put it, suffix and all. */
      let movedTo: string | null = null;

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
          const failed = await queue.retry(job.id);
          // ⚠️ Only when the job is *finally* failed. `retry` puts a job with
          // attempts left back on the queue, and telling a plugin "this failed"
          // for every attempt would make one bad night look like four.
          if (Result.isOk(failed) && failed.value.status === "failed") {
            if (this.#o.notifier) void this.#o.notifier.failed(failed.value, detail);
            this.#observe(job, "job:failed", failed.value, detail);
          }
          return;
        }

        if (outcome.value?.plan) plan = outcome.value.plan;
        if (outcome.value?.downloaded) downloaded = outcome.value.downloaded;
        // 🔴 Where the bytes *actually* went, which is not always where the
        // plan said: a name already in use lands `Name (2)`. Recomputing the
        // path from the temporary filename would record a file that does not
        // exist under that name — and `POST /api/jobs/file-state` would then
        // report a finished download as missing.
        if (outcome.value?.movedTo) movedTo = outcome.value.movedTo;

        stages = markDone(stages, stage, nowIso(now));
        await queue.update(job.id, { stages });
      }

      const finished = await queue.update(job.id, {
        status: "done", progress: 100,
        outputFile: movedTo ?? (downloaded ? await this.#finalPath(job, downloaded.file) : null),
      });
      if (Result.isOk(finished)) {
        if (this.#o.notifier) void this.#o.notifier.completed(finished.value);
        this.#observe(job, "job:completed", finished.value);
      }
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

  /**
   * Where a file *would* land, before any collision is resolved.
   *
   * ⚠️ Only a prediction now. The move stage returns where the bytes actually
   * went, and that is what `outputFile` records — a path computed from the
   * temporary filename would name a file that may not exist under that name.
   */
  async #finalPath(job: Job, file: string): Promise<string> {
    return join(this.#o.libraryDir, job.destination, file.split("/").pop() ?? "output");
  }

  /**
   * Send everything built on `stem` to the library's trash.
   *
   * Every sidecar goes with the video, and for the same reason they were
   * renamed together: leaving `Talk.en.srt` behind would attach the old
   * subtitles to the new download.
   */
  async #trash(
    job: Job,
    folder: string,
    existing: readonly string[],
    stem: string,
    log: (line: string) => void,
  ): Promise<Result<null, { _tag: string; stage: string; detail: string }>> {
    const library = openLibrary({ root: this.#o.libraryDir });
    const lower = stem.toLowerCase();
    const doomed = existing
      .filter((name) => {
        const candidate = name.toLowerCase();
        return candidate === lower || candidate.startsWith(`${lower}.`);
      })
      // ⚠️ The video first, subtitles last. `library.remove` takes a video's
      // subtitles with it **in one trash entry**, and one entry is what makes
      // the undo work as a unit: restoring it brings the video and its
      // subtitles back together. Removing the subtitle first would put them in
      // two entries that have to be found and restored separately.
      .sort((a, b) => Number(isSubtitle(a)) - Number(isSubtitle(b)));

    for (const name of doomed) {
      // ⚠️ `library.remove` takes a video's **subtitles** with it, in one trash
      // entry, so by the time this loop reaches `Name.en.srt` it is usually
      // already gone. A vanished file is the library doing its job, not a
      // failure — but a file that is still there after a failed remove is.
      const absolute = join(folder, name);
      const removed = await library.remove(join(job.destination, name), {
        reason: "replaced by a download",
      });
      if (Result.isOk(removed)) {
        log(`replaced "${name}" — the old copy is in .trash and can be restored`);
        continue;
      }
      if (!(await stat(absolute).then(() => true).catch(() => false))) continue;

      // 🔴 Refuse rather than fall back to overwriting. "Replace" was asked for
      // on the understanding that the old file stays recoverable; a replace
      // whose trash step failed is a delete nobody agreed to.
      return Result.err({
        _tag: "StageFailed",
        stage: "move",
        detail: `could not move the existing ${name} to the trash: ${JSON.stringify(removed.error)}`,
      });
    }
    return Result.ok(null);
  }

  async #stage(
    stage: StageName,
    job: Job,
    ctx: {
      workDir: string; controller: AbortController;
      plan: DownloadPlan | null;
      downloaded: FetchResult | null;
      onProgress(p: ProgressUpdate): void;
      log(line: string): void;
    },
  ): Promise<Result<{ plan?: DownloadPlan; downloaded?: FetchResult; movedTo?: string } | null, any>> {
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

        // `job.outputName` is what a person typed into the form; absent, the
        // provider's title is used exactly as before.
        const built = buildDownloadPlan(job.url, info.value, job.preferences, job.outputName);
        if (Result.isError(built)) return built;

        /**
         * 🔴 A **transforming** hook, so its failure is the job's failure.
         *
         * This is the one point where a plugin can change what gets downloaded
         * — PLAN §5's `probe:complete`. Awaited, in declared order, and a throw
         * ends the job rather than quietly downloading the plan the plugin was
         * trying to replace.
         */
        const plan = this.#o.plugins
          ? await this.#o.plugins.runWith(job.pluginsOff, "probe:complete", info.value, built.value)
          : Result.ok(built.value);
        if (Result.isError(plan)) {
          return Result.err({
            _tag: "PluginHookFailed",
            detail: `plugin ${plan.error.plugin} failed at probe:complete: ${plan.error.detail}`,
          });
        }

        // 🔴 Never a silent substitution. The form says this before the job is
        // queued; the job log says it again, because a job created from an API
        // call or a watched source never passed through the form.
        const notice = videoCodecNotice(info.value.videoFormats, job.preferences);
        if (notice) ctx.log(notice.message);

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
        // The one stage the source sees. Everything else in the pipeline runs
        // free; this is where the IP budget is actually spent.
        const got = await this.#downloads.run(() =>
          provider.value.fetch(ctx.plan!, {
            workDir: ctx.workDir,
            signal: ctx.controller.signal,
            onProgress: ctx.onProgress,
            log: ctx.log,
          }),
        );
        if (Result.isError(got)) return got;
        // The bytes are on disk, in the working directory — not yet in the
        // library. That is what `download:complete` means and it is why it is
        // a separate point from `job:completed`.
        this.#observe(job, "download:complete", job, got.value.file);
        return Result.ok({ downloaded: got.value });
      }

      // The provider already merges, embeds and tags through yt-dlp's
      // post-processors, so these two have nothing left to do. They stay in the
      // pipeline because the UI shows six stages and a provider that does less
      // will need them.
      case "postprocess":
      case "metadata":
        return Result.ok(null);

      /**
       * 🔴 **Nothing here may ever replace a file that is already there.**
       *
       * This stage used to `rename` onto the target path, and `rename` on POSIX
       * *silently replaces*. Two videos whose titles clean down to the same
       * name — a live set and its re-upload, two talks called "Keynote", the
       * same video fetched twice at different codecs — and the second destroyed
       * the first. The stage's own verification then confirmed it: `stat` found
       * a non-empty file at the target, because there was one, and reported
       * success. Both downloads "worked" and one of the files was gone.
       */
      case "move": {
        if (!ctx.downloaded) return Result.ok(null);

        const folder = join(this.#o.libraryDir, job.destination);
        await mkdir(folder, { recursive: true });

        const original = ctx.downloaded.file.split("/").pop() ?? "output";
        const extension = extname(original);
        const stem = basename(original, extension);

        // One listing answers for the video and every sidecar at once.
        const existing = await readdir(folder).catch(() => [] as string[]);

        let finalStem = stem;
        if (stemIsTaken(existing, stem)) {
          if (job.onConflict === "replace") {
            // ⚠️ To the trash, not to `unlink`. "Download this again" is a
            // reasonable thing to mean and a terrible thing to be wrong about,
            // so the file it replaces stays restorable for the retention window
            // — and the journal records that a download did it.
            const trashed = await this.#trash(job, folder, existing, stem, ctx.log);
            if (Result.isError(trashed)) return trashed;
          } else {
            finalStem = freeStem(existing, stem);
            if (finalStem === "") {
              return Result.err({
                _tag: "StageFailed",
                stage: "move",
                detail: `${stem} and a thousand suffixes of it are all taken in ${job.destination || "the library root"}`,
              });
            }
            // 🔴 Said out loud, on the job, because the file is not called what
            // the plan said it would be called. A rename nobody is told about
            // is the silent substitution this whole change is about.
            ctx.log(
              `"${stem}" already exists in ${job.destination || "the library root"} — saved as "${finalStem}" instead`,
            );
          }
        }

        const target = join(folder, `${finalStem}${extension}`);
        await moveFile(ctx.downloaded.file, target);

        // Subtitles and the thumbnail travel with the video, keeping their
        // names — which is what makes them sidecars: `Name.en.srt` and
        // `Name.jpg` beside `Name.mkv`, the layout every media server reads.
        //
        // ⚠️ They follow the video's **final** stem, suffix included. A
        // `Talk (2).mkv` sitting beside `Talk.en.srt` is worse than no
        // subtitle: every media server would read that subtitle as belonging to
        // the *other* video, which is exactly the collision this stage exists
        // to prevent.
        //
        // A sidecar that fails to move must not fail the job: the video is
        // there, and a missing poster is a grey rectangle, not a lost download.
        const sidecars = [
          ...ctx.downloaded.subtitleFiles,
          ...(ctx.downloaded.thumbnailFile === undefined ? [] : [ctx.downloaded.thumbnailFile]),
        ];
        for (const sidecar of sidecars) {
          const name = sidecar.split("/").pop() ?? "sidecar";
          const renamed = name.startsWith(`${stem}.`) ? `${finalStem}${name.slice(stem.length)}` : name;
          try {
            await moveFile(sidecar, join(folder, renamed));
          } catch {
            // Already logged by its absence; the video is what matters.
          }
        }

        // Verify rather than assume: a move that silently produced nothing is
        // exactly the failure mode this project exists to eliminate.
        const written = await stat(target).catch(() => null);
        if (!written || written.size === 0) {
          return Result.err({ _tag: "StageFailed", stage: "move", detail: `nothing at ${target}` });
        }
        return Result.ok({ movedTo: target });
      }
    }
  }
}

/** The same set `library.remove` uses to decide what travels with a video. */
function isSubtitle(name: string): boolean {
  return SUBTITLE_EXTENSIONS.has(extname(name).slice(1).toLowerCase());
}

/**
 * Move one file, across filesystems if it has to be.
 *
 * Same filesystem: a rename, instant. Different: a copy, which may be minutes
 * over a network mount. Both are correct; only one is fast.
 *
 * ⚠️ The caller has already established that nothing is at `target`. This does
 * not check, because a check here would be a second opinion about a question
 * the move stage answered with a directory listing — and two answers to one
 * question is how they come to disagree.
 */
async function moveFile(from: string, target: string): Promise<void> {
  try {
    await rename(from, target);
  } catch {
    await Bun.write(target, Bun.file(from));
    await rm(from, { force: true });
  }
}

/** Exported for its test: which status a progress reading implies is the subtle part. */
export function patchOf(p: ProgressUpdate) {
  const patch = {
    progress: p.percent !== undefined ? Math.round(p.percent) : undefined,
    doneBytes: p.doneBytes, totalBytes: p.totalBytes,
    speed: p.speed, eta: p.eta,
  };
  // ⚠️ yt-dlp merges and embeds *inside* the download stage, after the bytes
  // are in. That is processing, and saying "Downloading" at 100% with the last
  // speed still showing made a job that was busy look stuck.
  if (p.stage === "postprocess") {
    return { ...patch, status: statusForStage("postprocess"), speed: null, eta: null };
  }
  // Bytes are flowing: whatever a postprocessor said a moment ago, this is
  // downloading again.
  if (p.stage === "download") return { ...patch, status: statusForStage("download") };
  return patch;
}
