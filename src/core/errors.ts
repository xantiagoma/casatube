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

/**
 * A transforming plugin hook threw, and the job cannot be honestly created.
 *
 * 🔴 A rejected request rather than a queued job. `url:resolve` runs *before*
 * the row is written, and a shortener that failed leaves a URL nobody has
 * resolved — queueing it anyway would download something other than what was
 * asked for, which is the silent substitution this project keeps paying for.
 * The plugin is named, because the fix is in the plugin.
 */
export class PluginRejected extends TaggedError("PluginRejected")<{
  plugin: string;
  at: string;
  detail: string;
}> {}

/**
 * A subtitle format a browser cannot be given.
 *
 * ⚠️ 415 rather than a best-effort conversion. `.ass` and `.ssa` carry
 * positioning, fonts and drawing commands WebVTT has no way to express, so a
 * converted one is not the subtitle that was downloaded — it is a worse
 * subtitle wearing its name, and the viewer has no way to tell. The file stays
 * downloadable; it is simply not offered as a track.
 */
export class UnsupportedSubtitle extends TaggedError("UnsupportedSubtitle")<{
  path: string;
  format: string;
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

/**
 * `ffprobe` could not read a file we already hold.
 *
 * Distinct from ProbeFailed, which is about a remote source: this is a local
 * subprocess on a file that exists, so a 502 would be a lie about where the
 * fault is. Corrupt file, missing codec, or a mount that went away mid-read.
 */
export class LocalProbeFailed extends TaggedError("LocalProbeFailed")<{
  path: string;
  detail: string;
}> {}

/**
 * This file cannot be made playable in a browser — and saying so is the point.
 *
 * ⚠️ Not a defect and not a missing feature: CasaTube remuxes, it does not
 * re-encode video (see the header of `core/hls.ts`). A VP9 stream has no
 * MPEG-TS mapping, so the only way to deliver it as HLS would be an hour of CPU
 * spent producing a worse picture than the file already holds. The honest answer
 * is this error and a download button, not a spinner that never resolves.
 */
export class TranscodeUnavailable extends TaggedError("TranscodeUnavailable")<{
  path: string;
  detail: string;
}> {}

/**
 * Every remux slot is taken. Temporary, and worth coming back for.
 *
 * Distinct from {@link TranscodeUnavailable} because the reactions are
 * opposite: this one is worth retrying in a minute, that one never will be.
 */
export class TranscodeBusy extends TaggedError("TranscodeBusy")<{
  path: string;
  active: number;
  limit: number;
}> {}

/**
 * There is no picture for this file, and there is no way to make one.
 *
 * ⚠️ Deliberately **not** a 500 and deliberately not silence. A thumbnail is a
 * convenience: the file itself is fine, the library screen already knows how to
 * draw a grey rectangle, and the honest report is "there is nothing to show"
 * rather than an error that makes a working download look broken. What it must
 * not do is disappear — the detail says *why* (no video stream, ffmpeg refused
 * it, the frame came out empty), which is the difference between a known
 * limitation and a corrupt file nobody noticed.
 */
export class ThumbnailUnavailable extends TaggedError("ThumbnailUnavailable")<{
  path: string;
  detail: string;
}> {}

export class NotFound extends TaggedError("NotFound")<{
  what: string;
  id: string;
}> {}

// --- Credentials ------------------------------------------------------------

/**
 * A credential was rejected, or could not be opened.
 *
 * 🔴 `field` and `detail` are the whole value of this error. A cookie jar that
 * is one tab short fails **twenty minutes into an 800 MB download**, three
 * layers away from the paste that caused it — so the rejection has to happen at
 * the moment of writing and it has to say which line and what is wrong with it.
 *
 * ⚠️ Neither field ever carries the secret. `detail` names positions, counts and
 * domains; a value out of the file would end up in an HTTP response and a log
 * line, which is exactly what the credential store exists to prevent.
 */
export class InvalidCredential extends TaggedError("InvalidCredential")<{
  /** Which part was wrong: `scope`, `cookies`, `username`, `password`, `secret`… */
  field: string;
  detail: string;
}> {}

// --- Settings ---------------------------------------------------------------

/**
 * A setting was refused, and the refusal names the constraint.
 *
 * 🔴 Refused rather than coerced. `maxResolution: "1080p"` coerced becomes
 * `NaN`, the screen renders a number, and the worker uses something else — a
 * control that looks like it worked and did not. `detail` is what the form puts
 * next to the field, so it states the rule ("Must be at most 4320") rather than
 * saying that something went wrong.
 *
 * It also carries the settings that exist and cannot be written: `DATA_DIR`,
 * because the database that would hold the override lives inside it, and
 * `COOKIES_FILE`, because credentials do not travel through the API (PLAN §12).
 * Both are answered with the reason rather than with a 404 pretending they are
 * not there.
 */
export class InvalidSettingValue extends TaggedError("InvalidSettingValue")<{
  key: string;
  detail: string;
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

export type LibraryError =
  | MountUnavailable
  | PathOutsideRoot
  | NotFound
  | LocalProbeFailed
  | Timeout;

/** What asking for a thumbnail can fail with, on top of the library's own faults. */
export type ThumbnailError = ThumbnailUnavailable | LibraryError;

/** What on-demand playback can fail with, on top of the library's own faults. */
export type PlaybackError = TranscodeUnavailable | TranscodeBusy | LibraryError;

export type QueueError = NotFound | InvalidTransition | LeaseLost;

/** What reading or writing a setting can fail with. */
export type SettingsError = NotFound | InvalidSettingValue;

/** What storing or opening a credential can fail with. */
export type CredentialError = InvalidCredential | NotFound;

/**
 * Should the system slow down because of this error?
 *
 * Used by the worker to decide between retrying this one job and easing off
 * globally. Getting this wrong is what turns a temporary throttle into a ban.
 */
export function demandsBackoff(e: { _tag: string }): boolean {
  return e._tag === "RateLimited" || e._tag === "Blocked";
}

/**
 * A transcode that will not be started, and the reason.
 *
 * 🔴 Separate from {@link TranscodeUnavailable}, which is about *playback* —
 * "this file cannot reach a browser". This one is about a **request to
 * re-encode** that is being refused before any CPU is spent: the output name is
 * taken, the same file is already queued, the preset does not exist, or the
 * conversion would land on top of the original. Every one of those is something
 * the asker can fix, and none of them is a fault in the file.
 *
 * ⚠️ It is deliberately *not* retryable. Retrying "that name is taken" produces
 * the same answer for ever; the fix is a different name or a different preset.
 */
export class TranscodeRejected extends TaggedError("TranscodeRejected")<{
  path: string;
  detail: string;
}> {}
