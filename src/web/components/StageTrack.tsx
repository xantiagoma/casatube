/**
 * The six stages of the pipeline, side by side.
 *
 * PLAN §6: a job is a pipeline, not a status. A single word — "downloading" —
 * cannot say that the download finished and ffmpeg is now merging, which is
 * exactly the moment a progress bar sitting at 100% looks like a hang. Showing
 * all six makes the difference visible without reading a log.
 */
import { STAGE_ORDER, type Stage } from "../../core/types";

export function StageTrack({ stages }: { stages: Stage[] }): React.JSX.Element {
  const byName = new Map(stages.map((stage) => [stage.name, stage]));

  return (
    <div className="stages" aria-label="Pipeline stages">
      {STAGE_ORDER.map((name) => {
        // A job created before a stage existed simply has no record for it;
        // `pending` is the honest reading of that, not an error.
        const stage = byName.get(name);
        const status = stage?.status ?? "pending";
        return (
          <div key={name} className={`stage ${status}`} title={stage?.error ?? `${name}: ${status}`}>
            <div className="pip" />
            <span className="name">{name}</span>
          </div>
        );
      })}
    </div>
  );
}
