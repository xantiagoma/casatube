/**
 * What a video format is called: "1080p".
 *
 * 🔴 **Imports nothing but types, and that is load-bearing.** The browser labels
 * formats with this (the Format column, the job inspector), the server selects
 * with it, and both must say the same number. `selection.ts` pulls in
 * filenamify and the error classes, which a browser module must not reach for
 * one function — see `job-buckets.ts` for what a stray import into the client
 * bundle costs.
 */
import type { VideoFormat } from "./types";

/** The ladder video is labelled by. A computed class near one of these is that one. */
const STANDARD_RESOLUTIONS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320] as const;

/** How far a computed class may sit from a ladder step and still be called by it. */
const SNAP_TOLERANCE = 0.12;

/**
 * What "1080p" means for one format: the **resolution class** a person would
 * call it by — the one YouTube's own labels use.
 *
 * Two readings that both turned out wrong, and why:
 *
 * 🔴 **Not the height.** A phone video is 720×1280 — 720p by any reading a
 * person would recognise — and judging it by height calls it *1280p* and
 * refuses it under a 1080 ceiling. Two Telegram downloads failed that way, and
 * a portrait YouTube Short would have too.
 *
 * 🔴 **Not the shorter side either.** That fixed portrait video and broke
 * cinema: a 1920×800 film is a 1080p film — it fills a 1080p screen's width —
 * and the shorter side labelled it "800p", with Tears of Steel offering "858p",
 * "534p" and "356p" rows in the form. Correct by arithmetic, unreadable.
 *
 * So: the larger of the shorter side and what the longer side would be in
 * 16:9 (`longer × 9/16`), snapped to the standard ladder when it is within
 * {@link SNAP_TOLERANCE} of a step. 720×1280 → 720; 1920×800 → 1080;
 * 4096×1714 → 2160; 1440×1080 → 1080; 854×358 → 480. For ordinary 16:9
 * landscape video every reading agrees, which is why each wrong one survived
 * until a video that was not ordinary came along.
 *
 * 📌 The ceiling uses the same number, so a row labelled 1080p is exactly what a
 * 1080 ceiling admits.
 *
 * ⚠️ `null` when neither side is known, and it stays distinct from `0`: a format
 * whose dimensions the provider never reported is a last resort, not a 0p video.
 * One known side is still enough to judge by.
 */
export function resolutionOf(format: VideoFormat): number | null {
  const width = typeof format.width === "number" && format.width > 0 ? format.width : null;
  const height = typeof format.height === "number" && format.height > 0 ? format.height : null;
  if (width === null && height === null) {
    // Reported as 0 rather than absent: keep the old answer, which callers
    // already treat as "no usable size".
    return format.height ?? format.width ?? null;
  }
  // One side alone says too little to snap: an 800 could be 1920×800 or a
  // 16:10 1280×800. It is reported as it is.
  if (width === null || height === null) return (height ?? width)!;
  const shorter = Math.min(width, height);
  const longer = Math.max(width, height);
  const raw = Math.max(shorter, (longer * 9) / 16);

  let nearest: number = STANDARD_RESOLUTIONS[0];
  for (const step of STANDARD_RESOLUTIONS) {
    if (Math.abs(step - raw) < Math.abs(nearest - raw)) nearest = step;
  }
  return Math.abs(nearest - raw) / nearest <= SNAP_TOLERANCE ? nearest : Math.round(raw);
}

