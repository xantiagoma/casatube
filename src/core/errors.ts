/**
 * The error taxonomy.
 *
 * Failure is normal here, not exceptional: sites change, formats vanish, network
 * mounts stall, providers rate-limit. Every one of those travels in the return
 * type as a tagged error the caller can distinguish — never as a thrown
 * exception, and never as an ad-hoc `{ ok: false }` object.
 *
 * `throw` is reserved for defects: bugs and impossible states.
 */
import { TaggedError } from "better-result";

// --- Provider ---------------------------------------------------------------

/** No provider claimed this URL. Refuse clearly rather than half-attempting. */
export class UnsupportedUrl extends TaggedError("UnsupportedUrl")<{
  url: string;
}> {}

export class ProbeFailed extends TaggedError("ProbeFailed")<{
  url: string;
  detail: string;
}> {}

/**
 * The source refused us — bot check, geo-block, removed video.
 * Retrying immediately makes it worse; see RateLimited.
 */
export class Blocked extends TaggedError("Blocked")<{
  url: string;
  detail: string;
}> {}

/**
 * We are being throttled. The only correct response is to back off.
 *
 * This one is expensive: yt-dlp's success depends on the reputation of the
 * outbound IP, and a residential address tolerates far fewer requests than it
 * looks like. Treat every RateLimited as a signal to slow the whole system
 * down, not just this job.
 */
export class RateLimited extends TaggedError("RateLimited")<{
  url: string;
  retryAfterMs?: number;
}> {}

/** Needs a logged-in session: age-gated, members-only, or a bot challenge. */
export class AuthRequired extends TaggedError("AuthRequired")<{
  url: string;
}> {}

export class FormatUnavailable extends TaggedError("FormatUnavailable")<{
  url: string;
  wanted: string;
}> {}

/**
 * The download itself failed, as opposed to the metadata lookup.
 *
 * Distinct from ProbeFailed because they happen at different stages and mean
 * different things to a retry: a probe failure may be permanent, a fetch
 * failure is often worth another attempt.
 */
export class FetchFailed extends TaggedError("FetchFailed")<{
  url: string;
  detail: string;
  exitCode?: number;
}> {}

/**
 * The caller aborted through the signal.
 *
 * Lives in ProviderError as well as WorkerError because a provider is where the
 * abort is actually observed, and reporting it as a failure would be a lie —
 * cancelling is a normal outcome, not a fault.
 */
export class ProviderCancelled extends TaggedError("ProviderCancelled")<{
  url: string;
}> {}

// --- Worker -----------------------------------------------------------------

export class StageFailed extends TaggedError("StageFailed")<{
  stage: string;
  detail: string;
  exitCode?: number;
}> {}

/** The user cancelled, or the process was interrupted. Not a failure. */
export class Cancelled extends TaggedError("Cancelled")<{ jobId: string }> {}

export class Timeout extends TaggedError("Timeout")<{
  what: string;
  ms: number;
}> {}

export class DiskFull extends TaggedError("DiskFull")<{ path: string }> {}

// --- Library ----------------------------------------------------------------

/**
 * The library root is unreachable. Usually a network mount that went away.
 *
 * Distinct from NotFound on purpose: "the mount is down" and "the file is not
 * there" demand opposite reactions, and conflating them is how a stalled mount
 * gets mistaken for an empty library.
 */
export class MountUnavailable extends TaggedError("MountUnavailable")<{
  path: string;
  detail: string;
}> {}

/** Refused: a path that escapes the library root. */
export class PathOutsideRoot extends TaggedError("PathOutsideRoot")<{
  path: string;
  root: string;
}> {}

export class NotFound extends TaggedError("NotFound")<{
  what: string;
  id: string;
}> {}

// --- Queue ------------------------------------------------------------------

/**
 * This worker no longer holds the lease — it lapsed and someone else took the
 * job. Distinct from NotFound: the job exists, we just stopped owning it.
 */
export class LeaseLost extends TaggedError("LeaseLost")<{
  jobId: string;
  workerId: string;
}> {}

export class InvalidTransition extends TaggedError("InvalidTransition")<{
  jobId: string;
  from: string;
  to: string;
}> {}

// --- Unions -----------------------------------------------------------------

export type ProviderError =
  | UnsupportedUrl
  | ProbeFailed
  | FetchFailed
  | ProviderCancelled
  | Blocked
  | RateLimited
  | AuthRequired
  | FormatUnavailable;

export type WorkerError = StageFailed | Cancelled | Timeout | DiskFull | ProviderError;

export type LibraryError = MountUnavailable | PathOutsideRoot | NotFound;

export type QueueError = NotFound | InvalidTransition | LeaseLost;

/**
 * Should the system slow down because of this error?
 *
 * Used by the worker to decide between retrying this one job and easing off
 * globally. Getting this wrong is what turns a temporary throttle into a ban.
 */
export function demandsBackoff(e: { _tag: string }): boolean {
  return e._tag === "RateLimited" || e._tag === "Blocked";
}
