/**
 * Small charts, drawn by hand.
 *
 * A charting library was considered and refused for one reason: these are four
 * shapes over at most a few dozen points, and the whole visual contract is that
 * they take their colour from the theme tokens. Inline SVG does that with
 * `currentColor` and no runtime; a library would add a bundle, a second theming
 * mechanism, and a resize observer to draw a line.
 *
 * ⚠️ Every chart here degrades to something honest when there is no data —
 * a flat baseline and a caption, never an empty box that looks like a bug.
 */
import { useId } from "react";

import { cn } from "@/lib/utils";

/** A path through the points, in a 0..width / 0..height box. */
function linePath(values: number[], width: number, height: number, pad = 1): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = height / 2;
    return `M 0 ${y} L ${width} ${y}`;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);

  const points = values.map((value, index) => {
    const x = index * step;
    const y = pad + (height - pad * 2) * (1 - (value - min) / span);
    return [x, y] as const;
  });

  // A Catmull-Rom-ish smoothing: each segment gets control points a third of
  // the way to its neighbours. Straight polylines read as noise at this size.
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

interface SparklineProps {
  values: number[];
  className?: string;
  /** Any Tailwind text colour: the stroke and the fill both follow it. */
  tone?: string;
  filled?: boolean;
}

export function Sparkline({ values, className, tone = "text-info", filled = true }: SparklineProps) {
  const id = useId();
  const width = 120;
  const height = 36;
  const d = linePath(values, width, height, 2);
  const empty = values.length === 0 || values.every((value) => value === 0);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-9 w-full", tone, className)}
      role="img"
      aria-label={empty ? "No activity in this window" : "Trend"}
    >
      {empty ? (
        <line
          x1="0"
          y1={height - 2}
          x2={width}
          y2={height - 2}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="3 3"
          opacity="0.35"
        />
      ) : (
        <>
          {filled && (
            <>
              <defs>
                <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill={`url(#spark-${id})`} stroke="none" />
            </>
          )}
          <path d={d} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}

export interface TrendPoint {
  label: string;
  value: number;
}

/**
 * The big one, with a baseline, gridlines and end labels. Used where the design
 * shows a throughput graph rather than a thumbnail-sized trend.
 */
export function TrendChart({
  points,
  format,
  tone = "text-info",
  height = 160,
}: {
  points: TrendPoint[];
  format: (value: number) => string;
  tone?: string;
  height?: number;
}) {
  const id = useId();
  const width = 600;
  const values = points.map((point) => point.value);
  const max = Math.max(1, ...values);
  const d = linePath(values, width, height - 24, 4);
  const empty = values.length === 0 || values.every((value) => value === 0);

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={cn("w-full", tone)}
        style={{ height }}
        role="img"
        aria-label="Throughput over the selected window"
      >
        <defs>
          <linearGradient id={`trend-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2={width}
            y1={4 + (height - 28) * fraction}
            y2={4 + (height - 28) * fraction}
            stroke="var(--border)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {!empty && (
          <>
            <path d={`${d} L ${width} ${height - 24} L 0 ${height - 24} Z`} fill={`url(#trend-${id})`} stroke="none" />
            <path
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{points[0]?.label ?? "—"}</span>
        <span className="tabular-nums">{empty ? "no activity" : `peak ${format(max)}`}</span>
        <span>{points.at(-1)?.label ?? "—"}</span>
      </div>
    </div>
  );
}

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  /** A `var(--chart-n)` token. */
  color: string;
}

/**
 * The media-type distribution ring from the Library design.
 *
 * ⚠️ The centre label is dropped below ~96px: at the size the Library uses it
 * as a legend swatch there is no room for it, and a number half-covering the
 * ring is worse than no number.
 */
export function Donut({
  slices,
  size = 148,
  caption = "jobs",
}: {
  slices: DonutSlice[];
  size?: number;
  caption?: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = size / 2 - 12;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Distribution">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--muted)"
          strokeWidth="18"
        />
        {total > 0 &&
          slices.map((slice) => {
            const fraction = slice.value / total;
            const dash = `${circumference * fraction} ${circumference}`;
            const element = (
              <circle
                key={slice.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth="18"
                strokeDasharray={dash}
                strokeDashoffset={-offset}
              >
                <title>{`${slice.label}: ${slice.value}`}</title>
              </circle>
            );
            offset += circumference * fraction;
            return element;
          })}
      </g>
      {size >= 96 ? (
        <>
          <text
            x="50%"
            y="47%"
            textAnchor="middle"
            className="fill-foreground text-lg font-semibold tabular-nums"
          >
            {total}
          </text>
          <text
            x="50%"
            y="62%"
            textAnchor="middle"
            className="fill-muted-foreground text-[10px] tracking-wide uppercase"
          >
            {caption}
          </text>
        </>
      ) : null}
    </svg>
  );
}
