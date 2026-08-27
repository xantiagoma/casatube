import { useEffect, useRef } from "react";
/**
 * The player, in both of the moments PLAN §8 asks for it:
 *
 * 1. **Before downloading** — the probe answers with a title, a thumbnail and a
 *    duration, so the card shows what is about to be queued. YouTube and the
 *    rest hand out no directly playable URL, so this is a poster, not a stream.
 * 2. **After downloading** — the library item is a file on the server, and
 *    `src` points at `GET /api/library/file`, which streams it and answers
 *    range requests, so the player can seek.
 *
 * ⚠️ **No `src` is a real state, and it means two different things.** Before a
 * download there is nothing to play — YouTube hands out no playable URL — and
 * after one there may be a container no browser will open, MKV above all.
 * Either way the answer is the poster plus `unplayableHint` **without a play
 * button**: a triangle that does nothing when pressed is worse than no
 * triangle, and the caller's hint is the only place that knows which of the two
 * happened.
 */
import { Film, Music, Play } from "lucide-react";

import {
  MediaPlayer,
  MediaPlayerControls,
  MediaPlayerError,
  MediaPlayerFullscreen,
  MediaPlayerLoading,
  MediaPlayerPiP,
  MediaPlayerPlay,
  MediaPlayerPlaybackSpeed,
  MediaPlayerSeek,
  MediaPlayerSeekBackward,
  MediaPlayerSeekForward,
  MediaPlayerTime,
  MediaPlayerVideo,
  MediaPlayerVolume,
} from "@/components/ui/media-player";
import { cn } from "@/lib/utils";
import { formatDuration } from "../../data/format";

export interface MediaPreviewProps {
  /**
   * The source is an HLS playlist, so it needs `hls.js` unless the browser
   * plays HLS natively. Set by the caller, which knows whether the file was
   * served directly or remuxed.
   */
  hls?: boolean;

  /** Absent when nothing is playable — a probe result, or a build with no streaming route. */
  src?: string | null;
  poster?: string | null;
  title?: string;
  duration?: number | null;
  kind?: "video" | "audio";
  className?: string;
  /** Why there is no player, when there is none. */
  unplayableHint?: string;
}

/** The poster, with the duration chip the reference design puts in the corner. */
function Poster({
  poster,
  duration,
  kind,
  hint,
}: {
  poster?: string | null;
  duration?: number | null;
  kind: "video" | "audio";
  hint?: string;
}) {
  const Icon = kind === "audio" ? Music : Film;
  return (
    <div className="group relative aspect-video w-full overflow-hidden rounded-lg bg-muted">
      {poster ? (
        <img src={poster} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <div className="grid size-full place-items-center text-muted-foreground">
          <Icon className="size-8" aria-hidden />
        </div>
      )}
      {/* No play affordance when we already know nothing will play. */}
      {hint ? null : (
        <div className="absolute inset-0 grid place-items-center bg-black/15">
          <span className="grid size-12 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Play className="size-5 translate-x-0.5 fill-current" aria-hidden />
          </span>
        </div>
      )}
      {duration ? (
        <span
          className={cn(
            "absolute right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums",
            // Clear of the hint band, which owns the bottom edge when present.
            hint ? "bottom-8" : "bottom-2",
          )}
        >
          {formatDuration(duration)}
        </span>
      ) : null}
      {hint ? (
        <span className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-[11px] text-white/90">{hint}</span>
      ) : null}
    </div>
  );
}

export function MediaPreview({
  hls = false,
  src,
  poster,
  title,
  duration,
  kind = "video",
  className,
  unplayableHint,
}: MediaPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  /**
   * Attach `hls.js` when the source is a playlist the browser cannot open
   * itself.
   *
   * Safari plays HLS natively and that is where CasaTube is mostly watched, but
   * Chromium answers "maybe" to `canPlayType` and then fails on exactly the
   * case that matters: a playlist ffmpeg is still writing. So anything
   * non-native goes through `hls.js`.
   *
   * The import is dynamic because it is ~400 KB and most sessions never open a
   * file that needs it.
   */
  useEffect(() => {
    if (!hls || !src) return;
    let destroy: (() => void) | undefined;
    let cancelled = false;

    void import("hls.js").then(({ default: Hls }) => {
      // The panel may have closed, or moved to another file, while the import
      // resolved. Attaching then would leave a player on a detached element.
      if (cancelled || !videoRef.current || !Hls.isSupported()) return;
      // The playlist grows while ffmpeg writes it, so a long buffer would sit
      // waiting for segments that do not exist yet.
      const player = new Hls({ maxBufferLength: 30 });
      player.loadSource(src);
      player.attachMedia(videoRef.current);
      destroy = () => player.destroy();
    });

    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [hls, src]);

  if (!src) {
    return (
      <div className={className}>
        <Poster poster={poster} duration={duration} kind={kind} hint={unplayableHint} />
      </div>
    );
  }

  return (
    <MediaPlayer
      label={title ?? "Media"}
      /**
       * ⚠️ `h-auto` is load-bearing. The Dice UI root carries `size-full`, so
       * inside a flex column it stretches to whatever space is going and leaves
       * a tall black band under a 16:9 video. Height comes from the video.
       */
      className={cn("h-auto w-full overflow-hidden rounded-lg border bg-black", className)}
    >
      <MediaPlayerVideo
        ref={videoRef}
        src={hls ? undefined : src}
        poster={poster ?? undefined}
        preload="metadata"
        playsInline
        className="aspect-video w-full"
      />
      <MediaPlayerLoading />
      <MediaPlayerError />
      <MediaPlayerControls className="flex-col items-start gap-2">
        <MediaPlayerSeek />
        <div className="flex w-full items-center gap-2">
          <MediaPlayerPlay />
          <MediaPlayerSeekBackward />
          <MediaPlayerSeekForward />
          <MediaPlayerVolume expandable />
          <MediaPlayerTime />
          <div className="flex-1" />
          <MediaPlayerPlaybackSpeed />
          <MediaPlayerPiP />
          <MediaPlayerFullscreen />
        </div>
      </MediaPlayerControls>
    </MediaPlayer>
  );
}
