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
  // Queue
  NotFound: 404,
  InvalidTransition: 409,
  LeaseLost: 409,
  // Library
  MountUnavailable: 503,
  PathOutsideRoot: 400,
  LocalProbeFailed: 502,
  // Playback
  TranscodeUnavailable: 422,
  TranscodeBusy: 503,
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
    case "AuthRequired":
      return "This needs a signed-in session. Set COOKIES_FILE and try again.";
    case "FormatUnavailable":
      return `No format matched what was asked for: ${String(error.wanted ?? "")}`.trim();
    case "ProviderCancelled":
    case "Cancelled":
      return "Cancelled.";
    case "NotFound":
      return `No such ${String(error.what ?? "item")}.`;
    case "InvalidTransition":
      return `A job that is ${String(error.from ?? "in this state")} cannot become ${String(error.to ?? "that")}.`;
    case "LeaseLost":
      return "Another worker took this job.";
    case "MountUnavailable":
      return `The library is unreachable: ${String(error.detail ?? "")}`.trim();
    case "PathOutsideRoot":
      return "That destination escapes the library root.";
    case "LocalProbeFailed":
      return `ffprobe could not read that file: ${String(error.detail ?? "unknown reason")}`;
    case "TranscodeUnavailable":
      return `This file cannot be played in a browser: ${String(error.detail ?? "unknown reason")}`;
    case "TranscodeBusy":
      return `All ${String(error.limit ?? "the")} playback slots are in use. Try again in a moment.`;
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
