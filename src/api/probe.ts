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
import { toOutputName, videoCodecNotice } from "../core/selection";
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

      // 🔴 What cannot be delivered, said out loud. On YouTube, AVC1 stops at
      // 1080p: "H.264 at 4K" is a request with no answer, and the old code
      // answered it by handing over AV1 without a word. `warnings` is that word
      // — computed against the preferences this call carried, so an API client
      // reading only this response still learns what it is about to get.
      const notice = videoCodecNotice(info.value.videoFormats, preferences);

      return {
        provider: provider.value.name,
        info: info.value,
        options: mediaOptions(info.value, preferences),
        suggested: suggestFor(info.value, preferences),
        /**
         * 🔴 The filename, before anything is queued — PLAN §15's *"so a bad
         * name is caught before 800 MB, not after"*, which until now was a
         * sentence in the plan and nothing in the product.
         *
         * The **cleaned** name, produced by the same function the download plan
         * uses, so the form shows what would really be written rather than the
         * title with its emoji and channel branding still in it.
         */
        outputName: toOutputName(info.value.title, info.value.externalId),
        warnings: notice ? [notice] : [],
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
