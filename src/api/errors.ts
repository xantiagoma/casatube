/**
 * The HTTP boundary — where a `Result` becomes a status code.
 *
 * PLAN §10 rule 5: conversion happens at boundaries only. This is one of the
 * two boundaries (the worker is the other), so it is the only place in the
 * server that turns a tagged error into a number.
 *
 * The tag travels in the body as well as deciding the status, because the UI
 * reacts to the *kind* of failure — "rate limited, back off" reads nothing like
 * "that URL is not supported" — and string-matching a message is exactly what
 * the taxonomy exists to avoid.
 */
import { status } from "elysia";
import type { ElysiaCustomStatusResponse } from "elysia/error";

/** What every failing endpoint answers with. One shape, so the client has one branch. */
export interface ApiError {
  /** The `_tag` from `core/errors.ts`. Stable; safe to switch on. */
  tag: string;
  /** Human-readable, for display. Never the only thing the client can use. */
  message: string;
  /** Whether trying the same request again could plausibly work. */
  retryable: boolean;
}

/**
 * Tag → status. Anything unlisted is a defect that escaped, and 500 is honest
 * about that.
 */
const STATUS_BY_TAG: Record<string, number> = {
  // Provider
  UnsupportedUrl: 422,
  FormatUnavailable: 422,
  ProbeFailed: 502,
  FetchFailed: 502,
  Blocked: 502,
  RateLimited: 429,
  AuthRequired: 401,
  ProviderCancelled: 499,
  // Settings. A refused value is the request's fault, not the server's.
  InvalidSettingValue: 422,
  // Queue
  NotFound: 404,
  InvalidTransition: 409,
  LeaseLost: 409,
  // Credentials. 422: the request was understood and the credential is not
  // usable — a malformed cookie file is not a server fault and never retryable.
  InvalidCredential: 422,
  // Library
  MountUnavailable: 503,
  PathOutsideRoot: 400,
  LocalProbeFailed: 502,
  // Playback
  TranscodeUnavailable: 422,
  // 415: the request was understood and the *format* is the thing we cannot
  // serve. Never retryable — the file will not become a different format.
  UnsupportedSubtitle: 415,
  // A thumbnail that cannot exist is a 404, not a fault: the grid draws its
  // grey rectangle and the page is otherwise correct. See `core/errors.ts`.
  ThumbnailUnavailable: 404,
  TranscodeBusy: 503,
  // 409: the library is in a state that refuses this request — a name already
  // taken, a file already queued. Nothing is wrong; something is in the way.
  TranscodeRejected: 409,
  // A plugin refused the request. 422: it was understood, and a *plugin* — not
  // the server and not the source — decided it could not go ahead.
  PluginRejected: 422,
  // Telegram refused a login step. 422: the request was understood and the
  // *credential* or the code is what is wrong. A flood wait is the exception and
  // is retryable — see RETRYABLE_TAGS.
  TelegramLoginFailed: 422,
  // 503: the route is right and a runtime component is missing.
  TelegramLoginUnavailable: 503,
  // Worker
  StageFailed: 500,
  Cancelled: 409,
  Timeout: 504,
  DiskFull: 507,
};

/** Errors where repeating the identical request is worth a try. */
const RETRYABLE_TAGS = new Set([
  "ProbeFailed",
  // Every slot is busy right now; in a minute one will not be.
  "TranscodeBusy",
  "FetchFailed",
  "RateLimited",
  "Blocked",
  "MountUnavailable",
  "Timeout",
  "StageFailed",
  // ⚠️ Retryable, but not immediately: a flood wait carries the seconds, and the
  // client is expected to honour them rather than hammer the endpoint.
  "TelegramLoginFailed",
]);

type Taggedish = { _tag: string; message?: string } & Record<string, unknown>;

/**
 * A readable sentence per tag.
 *
 * `better-result`'s own `message` is built for a stack trace; these are built
 * for someone looking at a queue row wondering what to do next.
 */
function describe(error: Taggedish): string {
  switch (error._tag) {
    case "UnsupportedUrl":
      return "No provider recognises this URL.";
    case "ProbeFailed":
      return `Could not read this video's details: ${String(error.detail ?? "unknown reason")}`;
    case "FetchFailed":
      return `The download failed: ${String(error.detail ?? "unknown reason")}`;
    case "Blocked":
      return `The source refused the request: ${String(error.detail ?? "unknown reason")}`;
    case "RateLimited":
      return "The source is rate-limiting us. Waiting before trying again.";
    /**
     * ⚠️ The provider's own sentence wins when it has one. The default below
     * names a cookies file or a username and password, and for a source that
     * takes neither — Telegram wants an apiId, an apiHash and a session string —
     * it is worse than no advice: it sends someone looking for the wrong thing.
     */
    case "AuthRequired":
      if (typeof error.detail === "string" && error.detail !== "") return error.detail;
      return (
        "This needs a signed-in session. Add a credential for this site under " +
        "Settings — a Netscape cookies.txt for YouTube, or a username and password " +
        "where the site supports one."
      );
    /**
     * ⚠️ The detail is the message. A credential is rejected for a reason the
     * person pasting it can act on — "line 4 is separated by spaces, not tabs" —
     * and flattening that into "invalid credential" throws away the only part
     * that helps.
     */
    case "InvalidCredential":
      return `That credential was rejected (${String(error.field ?? "secret")}): ${String(error.detail ?? "unknown reason")}`;
    case "FormatUnavailable":
      return `No format matched what was asked for: ${String(error.wanted ?? "")}`.trim();
    case "ProviderCancelled":
    case "Cancelled":
      return "Cancelled.";
    case "NotFound":
      return `No such ${String(error.what ?? "item")}.`;
    case "InvalidSettingValue":
      return `That value was refused: ${String(error.detail ?? "it did not validate")}`;
    case "InvalidTransition":
      return `A job that is ${String(error.from ?? "in this state")} cannot become ${String(error.to ?? "that")}.`;
    case "LeaseLost":
      return "Another worker took this job.";
    case "TelegramLoginUnavailable":
      return `This build has no Telegram sign-in flow. ${String(error.detail ?? "")}`.trim();
    case "TelegramLoginFailed": {
      const seconds = Number(error.retryAfterSeconds ?? 0);
      if (seconds > 0) {
        return `Telegram is rate-limiting this login. Wait ${seconds} second${seconds === 1 ? "" : "s"} and try again.`;
      }
      const code = String(error.code ?? "UNKNOWN");
      if (code === "PHONE_CODE_INVALID") return "That code is not right. Check it and try again — the same code request is still valid.";
      if (code === "PHONE_CODE_EXPIRED") return "That code has expired. Start the login again to get a new one.";
      if (code === "PASSWORD_HASH_INVALID") return "That two-step password is not right.";
      if (code === "PHONE_NUMBER_INVALID") return "Telegram does not recognise that phone number.";
      if (code === "API_ID_INVALID") return "That api_id and api_hash pair is not valid — check both at my.telegram.org.";
      return `Telegram refused: ${String(error.detail ?? code)}`;
    }
    case "UnsupportedSubtitle":
      return (
        `${String(error.format ?? "That format").toUpperCase()} subtitles cannot be shown in a browser — ` +
        "they carry styling WebVTT has no way to express. The file can still be downloaded."
      );
    case "PluginRejected":
      return (
        `The "${String(error.plugin ?? "unknown")}" plugin failed at ` +
        `${String(error.at ?? "a hook")} and the job was not created: ` +
        `${String(error.detail ?? "no reason given")}. Turn it off for this ` +
        `download, or fix it under Settings.`
      );
    case "MountUnavailable":
      return `The library is unreachable: ${String(error.detail ?? "")}`.trim();
    case "PathOutsideRoot":
      return "That destination escapes the library root.";
    case "LocalProbeFailed":
      return `ffprobe could not read that file: ${String(error.detail ?? "unknown reason")}`;
    case "ThumbnailUnavailable":
      return `There is no thumbnail for this file: ${String(error.detail ?? "unknown reason")}`;
    case "TranscodeUnavailable":
      return `This file cannot be played in a browser: ${String(error.detail ?? "unknown reason")}`;
    case "TranscodeBusy":
      return `All ${String(error.limit ?? "the")} playback slots are in use. Try again in a moment.`;
    case "TranscodeRejected":
      return String(error.detail ?? "That conversion cannot be queued.");
    case "Timeout":
      return `${String(error.what ?? "The operation")} timed out.`;
    case "DiskFull":
      return "There is no space left on the working disk.";
    case "StageFailed":
      return `The ${String(error.stage ?? "job")} stage failed: ${String(error.detail ?? "unknown reason")}`;
    default:
      return error.message ?? "Something went wrong.";
  }
}

export function toApiError(error: { _tag: string }): ApiError {
  const tagged = error as Taggedish;
  return {
    tag: tagged._tag,
    message: describe(tagged),
    retryable: RETRYABLE_TAGS.has(tagged._tag),
  };
}

/** Every status this boundary can produce. Kept as literals — see `fail`. */
export type ApiErrorCode = 400 | 401 | 404 | 409 | 422 | 429 | 499 | 500 | 502 | 503 | 504 | 507;

/**
 * Turn a tagged error into the response for it.
 *
 * ⚠️ The annotation is doing real work. The status is looked up at runtime, so
 * it is a `number` as far as the compiler is concerned — and Elysia types a
 * handler's responses **by status code**, so a non-literal code collapses the
 * whole response type and the success shape disappears with it: `data` on the
 * client becomes `ApiError` and the `Job` is gone. Declaring the union of codes
 * this function can actually return keeps the two branches apart, which is what
 * lets Eden give the frontend `data: Job` and `error.value: ApiError`.
 *
 * Verified rather than assumed: without this annotation, `api.api.jobs({ id
 * }).delete()` types `data` as `ApiError`.
 */
export function fail(error: { _tag: string }): ElysiaCustomStatusResponse<ApiErrorCode, ApiError, ApiErrorCode> {
  const body = toApiError(error);
  const code = (STATUS_BY_TAG[body.tag] ?? 500) as ApiErrorCode;
  return status(code, body) as ElysiaCustomStatusResponse<ApiErrorCode, ApiError, ApiErrorCode>;
}

export function statusForTag(tag: string): number {
  return STATUS_BY_TAG[tag] ?? 500;
}
