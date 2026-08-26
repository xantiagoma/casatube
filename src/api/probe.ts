/**
 * `POST /api/probe` — look before you queue.
 *
 * PLAN §15 wants the filename preview shown *before* the job is queued, "so a
 * bad name is caught before 800 MB, not after". This is the call that makes
 * that possible, and it is deliberately separate from enqueueing: it touches
 * the network, so it is allowed to be slow and allowed to fail, and neither of
 * those may ever stop a job from being recorded.
 *
 * ⚠️ It also spends the IP budget (PLAN §4.3). One probe per URL the user is
 * actually considering — never a background sweep.
 *
 * The answer carries three things, and the second two are why the form stopped
 * asking people to choose blind:
 *
 * - `info` — the raw media, unchanged.
 * - `options` — the same media as *choices*: the resolutions this video really
 *   has, the audio languages with the original marked, the subtitle languages
 *   with authored told apart from automatic (see `options.ts`).
 * - `suggested` — what the selection logic would pick, so the form starts from
 *   the right answer instead of from nothing.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";

import { resolvePreferences } from "../core/queue";
import type { AppContext } from "./context";
import { fail } from "./errors";
import { mediaOptions, suggestFor } from "./options";
import { preferencesSchema } from "./schemas";

/**
 * A probe is one `yt-dlp -J`. It normally answers in a couple of seconds; when
 * it does not, it is usually a source that has stopped answering, and a request
 * with no deadline is how a browser tab ends up waiting forever.
 */
const PROBE_TIMEOUT_MS = 45_000;

export function probeRoutes(ctx: AppContext) {
  const { registry } = ctx;

  return new Elysia().post(
    "/probe",
    async ({ body }) => {
      const provider = registry.resolve(body.url);
      if (Result.isError(provider)) return fail(provider.error);

      const info = await provider.value.probe(body.url, AbortSignal.timeout(PROBE_TIMEOUT_MS));
      if (Result.isError(info)) return fail(info.error);

      // The caller's current settings, so the suggestion honours a ceiling the
      // user already lowered instead of overwriting it with the default.
      const preferences = resolvePreferences(body.preferences);

      return {
        provider: provider.value.name,
        info: info.value,
        options: mediaOptions(info.value),
        suggested: suggestFor(info.value, preferences),
      };
    },
    {
      body: t.Object({
        url: t.String({ minLength: 1 }),
        /** The form's current settings, so the suggestion honours them (R7 included). */
        preferences: t.Optional(preferencesSchema),
      }),
    },
  );
}
