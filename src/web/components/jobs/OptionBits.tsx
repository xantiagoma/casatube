/**
 * The three shapes every option in the download panel is made of.
 *
 * There are exactly three kinds of control in this form and it is worth them
 * looking like three kinds: a **step** (a numbered decision with a heading), a
 * **choice** (pick one — radio) and a **track** (pick any — checkbox). Codec,
 * audio policy and resolution are all "pick one" and used to be drawn three
 * different ways, which made a list of fields out of what is really one
 * decision after another.
 *
 * Presentation only — no data, no rules, nothing that reads the media.
 */
import type { ReactNode } from "react";
import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface OptionBadge {
  text: string;
  tone?: "ok" | "warn";
}

function Badges({ badges }: { badges?: OptionBadge[] }) {
  if (!badges || badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <Badge
          key={badge.text}
          variant="secondary"
          className={cn(
            "px-1.5 py-0 text-[10px] font-medium",
            badge.tone === "ok" && "bg-success/12 text-success",
            badge.tone === "warn" && "bg-warning/15 text-warning",
          )}
        >
          {badge.text}
        </Badge>
      ))}
    </>
  );
}

/**
 * One numbered decision.
 *
 * 🔴 The number is the point of the component. The old form was a wall of
 * cards in which "Original audio only" sat two cards away from the audio list
 * it silently disabled; numbering forces every control to belong to a step, and
 * a control that belongs to no step is a control in the wrong place.
 */
export function Step({
  index,
  title,
  hint,
  children,
}: {
  index: number;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground tabular-nums"
        >
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </div>
      <div className="space-y-3 pl-0 sm:pl-7.5">{children}</div>
    </section>
  );
}

/** Pick one. A radio that is big enough to read the consequence on. */
export function ChoiceCard({
  selected,
  onSelect,
  label,
  badges,
  implication,
  dimmed,
  className,
}: {
  selected: boolean;
  onSelect(): void;
  label: string;
  badges?: OptionBadge[];
  implication?: ReactNode;
  dimmed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
        selected ? "border-primary/50 bg-primary/5" : "hover:bg-accent/40",
        dimmed && !selected && "opacity-60",
        className,
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
        )}
      >
        {selected && <Check className="size-2.5" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{label}</span>
          <Badges badges={badges} />
        </span>
        {implication ? <span className="block text-xs text-muted-foreground">{implication}</span> : null}
      </span>
    </button>
  );
}

/** Pick any. One language, ticked or not. */
export function TrackRow({
  id,
  label,
  detail,
  badges,
  checked,
  disabled,
  hint,
  onToggle,
}: {
  id: string;
  label: string;
  detail?: string;
  badges?: OptionBadge[];
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onToggle(): void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors",
        disabled ? "opacity-60" : "cursor-pointer hover:bg-accent/40",
        checked && !disabled && "border-primary/50 bg-primary/5",
      )}
    >
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{label}</span>
          <Badges badges={badges} />
        </span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

/** A switch that says what it costs, used for the post-processing flags. */
export function SwitchRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
