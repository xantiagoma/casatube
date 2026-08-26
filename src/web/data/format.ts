/**
 * Turning numbers into something a person can read.
 *
 * Presentation-neutral on purpose: these are pure functions over the server's
 * numbers, so a future skin can reuse them without dragging any component with
 * it.
 */
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Durations and ETAs, as `1:02:03` or `4:07`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "0%";
  return `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

/**
 * "just now", "3 min ago" — coarse on purpose.
 *
 * ⚠️ Server timestamps are UTC ISO strings; `Date` parses the `Z` and the
 * browser renders local time. Nothing here may assume the two agree.
 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString();
}

/** Absolute local time, labelled, for anything a person might compare to a clock. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleTimeString();
}

/** A date and a time, local, for anything a person might compare to a calendar. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 4 min", "in 2 h" — the other direction from `formatRelative`. */
export function formatUntil(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.round((then - now) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

/** "6 h", "30 min", "2 d" — an interval, not an instant. */
export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The host of a URL, or the whole thing when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A library path as a folder and a filename, for two-line rendering. */
export function splitPath(path: string): { folder: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? { folder: "", name: path } : { folder: path.slice(0, cut), name: path.slice(cut + 1) };
}

/** A whole number with thousands separators. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

/** A duration in milliseconds, as "12m 34s" — the shape the metric cards use. */
export function formatElapsed(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "—";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
