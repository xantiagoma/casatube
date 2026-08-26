/**
 * The player, in both of the moments PLAN §8 asks for it:
 *
 * 1. **Before downloading** — the probe answers with a title, a thumbnail and a
 *    duration, so the card shows what is about to be queued. YouTube and the
 *    rest hand out no directly playable URL, so this is a poster, not a stream.
 * 2. **After downloading** — the library item is a file on the server, and
 *    `src` points at the endpoint that would serve its bytes.
 *
 * ⚠️ **There is no media-streaming endpoint in this build.** `GET
 * /api/library/file` does not exist, so playback of a finished file fails at
 * the `<video>` element and `MediaPlayerError` says so in words rather than
 * leaving a black rectangle. The component is written against the URL it will
 * have, so adding the route is the only change needed — nothing here is
 * pretending to work.
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
      <div className="absolute inset-0 grid place-items-center bg-black/15">
        <span className="grid size-12 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
          <Play className="size-5 translate-x-0.5 fill-current" aria-hidden />
        </span>
      </div>
      {duration ? (
        <span className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
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
  src,
  poster,
  title,
  duration,
  kind = "video",
  className,
  unplayableHint,
}: MediaPreviewProps) {
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
        src={src}
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
