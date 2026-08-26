/**
 * Request shapes shared by more than one route.
 *
 * `preferencesSchema` lives here because two routes now accept preferences —
 * `POST /api/jobs` and `POST /api/probe`, which uses them to suggest what the
 * form should start with. Two copies of the list would be a field accepted by
 * one and dropped by the other, which shows up as a preselection that quietly
 * disagrees with what gets queued.
 */
import { t } from "elysia";

export const preferencesSchema = t.Partial(
  t.Object({
    originalOnly: t.Boolean(),
    audioLanguages: t.Array(t.String()),
    /** ⚠️ R7: independent of audio. Never derived from `audioLanguages`. */
    subtitleLanguages: t.Array(t.String()),
    maxResolution: t.Integer({ minimum: 144, maximum: 4320 }),
    sponsorblock: t.Boolean(),
    embedSubtitles: t.Boolean(),
  }),
);
