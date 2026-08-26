/**
 * The six-stage pipeline, as data.
 *
 * A job's global status is *derived* from whichever stage is running, rather
 * than tracked separately. Two fields that must agree are two fields that can
 * disagree.
 */
import type { Job, Stage, StageName, JobStatus } from "../core/types";
import { STAGE_ORDER } from "../core/types";

/** What the UI shows while each stage runs. */
const STATUS_OF: Record<StageName, JobStatus> = {
  validate: "analyzing",
  analyze: "analyzing",
  download: "downloading",
  postprocess: "processing",
  metadata: "processing",
  move: "moving",
};

export function initialStages(): Stage[] {
  return STAGE_ORDER.map((name) => ({ name, status: "pending" }));
}

export function statusForStage(name: StageName): JobStatus {
  return STATUS_OF[name];
}

export function runningStage(stages: Stage[]): Stage | undefined {
  return stages.find((s) => s.status === "running");
}

export function markRunning(stages: Stage[], name: StageName, at: string): Stage[] {
  return stages.map((s) =>
    s.name === name ? { ...s, status: "running" as const, startedAt: at } : s,
  );
}

export function markDone(stages: Stage[], name: StageName, at: string): Stage[] {
  return stages.map((s) =>
    s.name === name ? { ...s, status: "done" as const, finishedAt: at } : s,
  );
}

export function markSkipped(stages: Stage[], name: StageName, at: string): Stage[] {
  return stages.map((s) =>
    s.name === name ? { ...s, status: "skipped" as const, finishedAt: at } : s,
  );
}

export function markFailed(
  stages: Stage[], name: StageName, error: string, at: string,
): Stage[] {
  return stages.map((s) =>
    s.name === name ? { ...s, status: "failed" as const, finishedAt: at, error } : s,
  );
}

/**
 * Where to resume after a restart.
 *
 * Stages already `done` are not repeated: `recoverOnStart` keeps the bytes
 * already fetched, so re-running `download` would discard work the whole
 * project exists to preserve. A stage left `running` when the process died is
 * restarted — it never finished, so it has no result to keep.
 */
export function resumeFrom(job: Job): StageName {
  const stages = job.stages.length ? job.stages : initialStages();
  const next = stages.find((s) => s.status !== "done" && s.status !== "skipped");
  return next?.name ?? "move";
}

/** Reset a stage left mid-flight, so a resumed job does not show a stale `running`. */
export function clearRunning(stages: Stage[]): Stage[] {
  return stages.map((s) =>
    s.status === "running" ? { ...s, status: "pending" as const, startedAt: undefined } : s,
  );
}
