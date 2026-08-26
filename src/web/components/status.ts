/**
 * How a status looks. One place, so the badge, the bar and the buttons cannot
 * disagree about what state a job is in.
 */
import type { JobStatus } from "../../core/types";

export type Tone = "idle" | "busy" | "ok" | "warn" | "danger";

interface StatusLook {
  label: string;
  tone: Tone;
}

const LOOKS: Record<JobStatus, StatusLook> = {
  queued: { label: "Queued", tone: "idle" },
  analyzing: { label: "Analyzing", tone: "busy" },
  downloading: { label: "Downloading", tone: "busy" },
  processing: { label: "Processing", tone: "busy" },
  moving: { label: "Moving", tone: "busy" },
  // Not a failure: the file is safe in the temp directory and the move is being
  // retried. PLAN §15 is explicit that this must never look like a loss.
  "waiting-for-destination": { label: "Waiting for library", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "idle" },
};

export function statusLook(status: JobStatus): StatusLook {
  return LOOKS[status] ?? { label: status, tone: "idle" };
}

/** Statuses a worker is actively holding — the ones worth animating. */
export function isActive(status: JobStatus): boolean {
  return status === "analyzing" || status === "downloading" || status === "processing" || status === "moving";
}

export function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}
