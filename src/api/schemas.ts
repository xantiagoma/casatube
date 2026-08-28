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

import { VIDEO_CODEC_PREFERENCES } from "../core/types";

export const preferencesSchema = t.Partial(
  t.Object({
    originalOnly: t.Boolean(),
    audioLanguages: t.Array(t.String()),
    /** ⚠️ R7: independent of audio. Never derived from `audioLanguages`. */
    subtitleLanguages: t.Array(t.String()),
    /** Off means a language with only machine captions gets nothing. */
    automaticSubtitles: t.Boolean(),
    maxResolution: t.Integer({ minimum: 144, maximum: 4320 }),
    /**
     * ⚠️ `{ default: undefined }` on purpose — `t.UnionEnum` otherwise sets
     * `default: values[0]`, which turns an omitted field into a stated
     * preference (see docs/DISCOVERIES.md). Here that default would even be the
     * *right* value, `auto`, which is what makes it dangerous: the bug would
     * only show the day the order of this list changes.
     */
    videoCodec: t.UnionEnum([...VIDEO_CODEC_PREFERENCES], { default: undefined }),
    sponsorblock: t.Boolean(),
    embedSubtitles: t.Boolean(),
  }),
);
