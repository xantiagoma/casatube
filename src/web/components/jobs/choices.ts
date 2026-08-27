/**
 * What the person actually chose, as opposed to what the server suggested.
 *
 * ⚠️ It lives in its own module with **no imports of its own** beyond the core
 * types, because three components need it and the shortest route to the
 * `ReferenceError: cannot access X before initialization` in
 * `docs/DISCOVERIES.md` is a shared value bouncing between two files that
 * import each other.
 */
import type { VideoCodecPreference } from "../../../core/types";

export interface Choices {
  maxResolution: number;
  /**
   * 🔴 Preselected, not imposed. The old build showed the codec and gave no way
   * to change it, which made a decision about someone else's television.
   */
  videoCodec: VideoCodecPreference;
  /** The audio *policy*: one original track, or a set of languages. */
  originalOnly: boolean;
  /** ISO 639-2/B tags, as the options report them. */
  audioTags: string[];
  /** ⚠️ Never derived from `audioTags` — R7. */
  subtitleTags: string[];
}

/** Add or remove one tag, without touching the other list. */
export function toggleTag(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((value) => value !== tag) : [...tags, tag];
}
