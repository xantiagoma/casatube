/**
 * The data layer's front door: one typed client, no hand-written `fetch`.
 *
 * Eden derives every call from the server's own `App` type, so a route rename
 * is a compile error here rather than a 404 found by clicking (PLAN §8). The
 * import below is `import type` and disappears at build time — the server never
 * reaches the browser bundle, only its shape does.
 *
 * 🔴 R3 lives in this folder. Everything that talks to the server is here;
 * components take props and render. Reskinning must not require touching this.
 */
import { treaty } from "@elysiajs/eden";
import type { App } from "../../server";

/**
 * Same origin, always. The server serves this bundle, so there is no
 * deployment where the API is somewhere else — and a configurable base URL
 * would be a setting nobody sets correctly.
 *
 * 🔴 **`parseDate: false` is not a preference.** Eden's default reviver walks
 * every response and turns anything that looks like an ISO-8601 string into a
 * `Date` — including `createdAt`, `updatedAt` and the snapshot's `at`. The
 * server sends strings and the types say `string`, so the default makes the
 * runtime quietly disagree with the compiler on every timestamp in the app.
 *
 * It cost an afternoon to find: the queue table rendered once and then froze
 * with the indicator still reading "Live". The frames were arriving and being
 * discarded, because the guard in `stream.ts` checks `typeof at === "string"`
 * and every frame was failing it. Nothing logged, nothing threw — the stream
 * looked healthy and delivered nothing.
 */
export const api = treaty<App>(
  typeof window === "undefined" ? "http://localhost:8520" : window.location.origin,
  { parseDate: false },
);

/** What a component gets back from an action: never a thrown exception. */
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };

export interface ApiFailure {
  /** The `_tag` from the server's taxonomy — safe to switch on. */
  tag: string;
  message: string;
  retryable: boolean;
}

/**
 * Normalise Eden's `{ data, error }` into one shape.
 *
 * Eden reports a non-2xx in `error`, a network failure in `error.value` as
 * something else entirely, and success in `data`. Collapsing that here means
 * components have exactly one branch to write, and no component ever has to
 * guess what shape a failure arrived in.
 */
export function normalise<T>(response: { data: T | null; error: unknown }): ActionResult<T> {
  if (response.error) {
    const value = (response.error as { value?: unknown }).value;
    if (value && typeof value === "object" && "tag" in value) {
      const failure = value as Partial<ApiFailure>;
      return {
        ok: false,
        error: {
          tag: String(failure.tag ?? "Unexpected"),
          message: String(failure.message ?? "Something went wrong."),
          retryable: failure.retryable === true,
        },
      };
    }
    const status = (response.error as { status?: number }).status;
    return {
      ok: false,
      error: {
        tag: "Unreachable",
        message: status
          ? `The server answered ${status} without a reason.`
          : "The server is unreachable. It may be restarting — the queue is safe either way.",
        retryable: true,
      },
    };
  }
  if (response.data === null || response.data === undefined) {
    return { ok: false, error: { tag: "Empty", message: "The server sent nothing back.", retryable: true } };
  }
  return { ok: true, value: response.data };
}

/**
 * A failed request, as an exception.
 *
 * React Query owns pending/error state, and it decides both by whether the
 * query function **threw**. So the boundary between "Eden's `{ data, error }`"
 * and "React Query's world" is exactly here: `normalise` for anywhere that
 * wants to branch on a value, `unwrap` for anything React Query calls.
 */
export class ApiRequestError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = "ApiRequestError";
    this.failure = failure;
  }
}

/** Eden's response, or a throw. What every `queryFn` and `mutationFn` returns. */
export function unwrap<T>(response: { data: T | null; error: unknown }): T {
  const result = normalise(response);
  if (!result.ok) throw new ApiRequestError(result.error);
  return result.value;
}
