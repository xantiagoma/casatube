/**
 * Application settings: the three places a value can come from, and which wins.
 *
 * 🔴 **The point of this module is that a setting says where it came from.**
 * PLAN §12 puts configuration in the environment, and until now that was the
 * whole story — which left the Settings screen showing numbers with no way to
 * find out *which variable* produced one, and no way to change it. So every
 * setting here carries three facts a reader needs and previously could not get:
 * the **environment variable name** (always, even when nothing sets it), the
 * **source** of the effective value, and whether writing it does anything
 * before the next restart.
 *
 * ## Precedence, stated once
 *
 * ```
 * user override  >  environment variable  >  code default
 * ```
 *
 * Explicit rather than implicit: `#effective()` walks those three in that order
 * and *records which one it took* in `source`. Nothing downstream re-derives
 * it — a second implementation of precedence is a second answer to the question
 * "why is this 720p".
 *
 * ⚠️ **An environment variable that cannot be read does not win.** It falls
 * through to the default, exactly as `api/config.ts` has always behaved
 * (`PORT=banana` boots on 8520 rather than crashing). The difference here is
 * that the fall-back is *reported* — `envInvalid` — instead of happening in
 * silence, which is the same class of failure as a control that does nothing.
 *
 * ## Live versus restart — the distinction that keeps this honest
 *
 * `PORT` is read once, when the process binds its socket. A form that accepted
 * a new port and then rendered it as the current one would be lying, and that
 * is precisely the failure this project exists to eliminate. So every
 * definition declares an `effect`:
 *
 * - **`live`** — read on every use, so a write is in force immediately. The
 *   download defaults are the whole of this category today.
 * - **`restart`** — read at boot into `ServerConfig` and then held. The write
 *   is stored and it is *real* (the next boot applies it), but until then the
 *   process is running the old value. `runningValue` carries what is actually
 *   in force and `pendingRestart` says the two disagree.
 *
 * ## Why this is not `api/config.ts`
 *
 * `loadConfig()` has to run **before** the database is open — it is what says
 * where the database is. So the layering is: environment and defaults produce a
 * config, the database is opened from it, and the stored overrides are applied
 * on top (`applyStoredSettings` in `api/settings.ts`). `DATA_DIR` is therefore
 * the one setting that can never be overridden, and it is marked so rather than
 * accepting a write it would silently ignore.
 *
 * 📌 Named `app-settings` and not `settings` because `core/settings.ts` is the
 * plugin-facing key/value store over the same table. Different concern, same
 * three columns; the keys here are all `<group>.<name>` and cannot collide with
 * the `plugin.config:*` namespace.
 */
import { eq } from "drizzle-orm";
import { Result } from "better-result";

import type { Db } from "./db";
import { InvalidSettingValue, NotFound, type SettingsError } from "./errors";
import { resolvePreferences } from "./queue";
import { settings as settingsTable } from "./schema";
import { DEFAULT_PREFERENCES, VIDEO_CODEC_PREFERENCES, type Preferences } from "./types";

// --- The vocabulary ---------------------------------------------------------

/** What a setting holds. Deliberately small: five shapes cover everything. */
export type SettingKind = "boolean" | "integer" | "string" | "enum" | "languages";

export type SettingValue = boolean | number | string | string[];

export type SettingSource = "user" | "env" | "default";

/** When a write takes effect. See the header — this is the load-bearing field. */
export type SettingEffect = "live" | "restart";

export type SettingGroupId =
  | "downloads"
  | "server"
  | "library"
  | "playback"
  | "thumbnails"
  | "notifications";

export interface SettingGroup {
  id: SettingGroupId;
  label: string;
  description: string;
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: "downloads",
    label: "Download defaults",
    description:
      "What a job gets when nothing else is said: the form's starting point, a watched source, an API call that sends no preferences. Every one of these is in force the moment it is saved.",
  },
  {
    id: "server",
    label: "Server",
    description: "Read once, at boot. A change here is stored and applies at the next restart.",
  },
  {
    id: "library",
    label: "Library",
    description: "Where finished files land, and how long a deleted one stays recoverable.",
  },
  {
    id: "playback",
    label: "Playback (HLS)",
    description:
      "Limits on temp disk and CPU rather than preferences: every session leaves segments on disk and holds an ffmpeg.",
  },
  {
    id: "thumbnails",
    label: "Thumbnails",
    description: "Limits on the ffmpeg processes and cache that scrolling a cold library can spend.",
  },
  {
    id: "notifications",
    label: "Notifications",
    description:
      "How much history the bell keeps. A sweep runs every six hours; both values take effect at the next one, without a restart.",
  },
] as const;

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDefinition {
  key: string;
  group: SettingGroupId;
  label: string;
  description: string;
  kind: SettingKind;
  /**
   * ⚠️ Always a real name, even when nothing sets it. This field is the answer
   * to "I cannot see which variable sets this when it is not defined".
   */
  envVar: string;
  defaultValue: SettingValue;
  effect: SettingEffect;
  /** One sentence, only when `effect` is `restart`. Why a restart, concretely. */
  restartReason?: string;
  /** False when a stored override could not possibly be honoured. */
  editable?: boolean;
  editableReason?: string;
  /** ⚠️ Credentials never travel back through the API — PLAN §12. */
  secret?: boolean;
  options?: readonly SettingOption[];
  min?: number;
  max?: number;
  /** For strings where empty means "unset" — e.g. "find it on PATH". */
  allowEmpty?: boolean;
}

const CODEC_OPTIONS: readonly SettingOption[] = VIDEO_CODEC_PREFERENCES.map((value) => ({
  value,
  label:
    value === "auto"
      ? "auto — H.264 first, direct play on most TVs"
      : value === "efficient"
        ? "efficient — AV1/VP9 first, smaller files, may transcode"
        : value.toUpperCase(),
}));

/**
 * Every setting this build can actually honour.
 *
 * 🔴 **Nothing is listed here that the code does not read.**
 * `MAX_CONCURRENT_DOWNLOADS` and `LOG_LEVEL` are set by the Dockerfile *and* by
 * `docker-compose.yml`, and are read by nothing under `src/` — the worker runs
 * one job at a time and there is no log-level switch. Putting them on this
 * screen would produce a control that changes a number and no behaviour, which
 * is worse than their absence.
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // --- Download defaults: the only group that is live -----------------------
  {
    key: "downloads.maxResolution",
    group: "downloads",
    label: "Maximum resolution",
    description: "The ceiling a job downloads at when nothing else is stated.",
    kind: "integer",
    envVar: "DEFAULT_MAX_RESOLUTION",
    defaultValue: DEFAULT_PREFERENCES.maxResolution,
    effect: "live",
    min: 144,
    max: 4320,
  },
  {
    key: "downloads.videoCodec",
    group: "downloads",
    label: "Video codec",
    description:
      "A preselection, never a silent swap: naming a codec gives up resolution rather than answering with a different codec.",
    kind: "enum",
    envVar: "DEFAULT_VIDEO_CODEC",
    defaultValue: DEFAULT_PREFERENCES.videoCodec,
    effect: "live",
    options: CODEC_OPTIONS,
  },
  {
    key: "downloads.originalOnly",
    group: "downloads",
    label: "Original audio only",
    description: "Keep exactly one audio track: the one the source marks as original.",
    kind: "boolean",
    envVar: "DEFAULT_ORIGINAL_ONLY",
    defaultValue: DEFAULT_PREFERENCES.originalOnly,
    effect: "live",
  },
  {
    key: "downloads.audioLanguages",
    group: "downloads",
    label: "Audio languages",
    description:
      "Extra audio tracks to keep, by language tag. Empty means whatever the source calls the original.",
    kind: "languages",
    envVar: "DEFAULT_AUDIO_LANGUAGES",
    defaultValue: DEFAULT_PREFERENCES.audioLanguages,
    effect: "live",
  },
  {
    key: "downloads.subtitleLanguages",
    group: "downloads",
    label: "Subtitle languages",
    description: "⚠️ Independent of audio (R7). Never derived from the audio list.",
    kind: "languages",
    envVar: "DEFAULT_SUBTITLE_LANGUAGES",
    defaultValue: DEFAULT_PREFERENCES.subtitleLanguages,
    effect: "live",
  },
  {
    key: "downloads.embedSubtitles",
    group: "downloads",
    label: "Embed subtitles",
    description: "On: inside the container. Off: sidecar files, which every media server reads.",
    kind: "boolean",
    envVar: "DEFAULT_EMBED_SUBTITLES",
    defaultValue: DEFAULT_PREFERENCES.embedSubtitles,
    effect: "live",
  },
  {
    key: "downloads.sponsorblock",
    group: "downloads",
    label: "SponsorBlock",
    description: "Mark or remove sponsor segments where the provider supports it.",
    kind: "boolean",
    envVar: "DEFAULT_SPONSORBLOCK",
    defaultValue: DEFAULT_PREFERENCES.sponsorblock,
    effect: "live",
  },

  // --- Server: every one of these is read at boot ---------------------------
  {
    key: "server.port",
    group: "server",
    label: "HTTP port",
    description: "The port the web interface and the API listen on.",
    kind: "integer",
    envVar: "PORT",
    defaultValue: 8520,
    effect: "restart",
    restartReason:
      "The socket is bound once, as the process starts. Nothing can move a listening server to another port.",
    min: 1,
    max: 65535,
  },
  {
    key: "server.dataDir",
    group: "server",
    label: "Data directory",
    description: "Both SQLite databases, the temp downloads and the thumbnail cache.",
    kind: "string",
    envVar: "DATA_DIR",
    defaultValue: "./data",
    effect: "restart",
    restartReason: "Read before anything else, because it is what says where the database is.",
    editable: false,
    editableReason:
      "The database that would hold the override lives inside this directory, so an override could never be read early enough to be honoured. This one really is environment-only.",
  },
  {
    key: "server.tempDir",
    group: "server",
    label: "Temp directory",
    description:
      "Downloads land here first and are moved into the library once they are complete. Its default is derived from the data directory rather than fixed.",
    kind: "string",
    envVar: "TEMP_DIR",
    // ⚠️ A placeholder. The real default is `${DATA_DIR}/tmp`, which depends on
    // another setting and so cannot be a literal here — `derivedDefaults`
    // replaces it with the value `loadConfig` actually computed. Leaving `""`
    // showing would put an empty string on screen next to the word "default"
    // for a path the process is really using.
    defaultValue: "",
    effect: "restart",
    restartReason: "The worker is handed this path when it is constructed, at boot.",
  },
  {
    key: "server.eventsPollMs",
    group: "server",
    label: "Queue poll interval (ms)",
    description:
      "How often the job table is re-read to decide whether the live stream has anything new to say.",
    kind: "integer",
    envVar: "EVENTS_POLL_MS",
    defaultValue: 750,
    effect: "restart",
    restartReason: "The watcher's timer is created at boot and runs for the life of the process.",
    min: 100,
    max: 60_000,
  },
  {
    key: "server.cookiesFile",
    group: "server",
    label: "Cookies file",
    description:
      "A signed-in session for age-gated or members-only media. ⚠️ Cookies are credentials: the path is never sent back through the API (PLAN §12) — only whether one is configured.",
    kind: "string",
    envVar: "COOKIES_FILE",
    defaultValue: "",
    effect: "restart",
    restartReason: "Handed to the provider registry at boot.",
    editable: false,
    editableReason:
      "Credentials are set on the server, not through a browser. PLAN §12: they belong on disk with restrictive permissions and never travel through the API.",
    secret: true,
    allowEmpty: true,
  },
  {
    key: "server.ytdlpBinary",
    group: "server",
    label: "yt-dlp binary",
    description:
      "Empty means whatever is on PATH. Pointing at a specific build is the only way to pin an extraction bug.",
    kind: "string",
    envVar: "YTDLP_BIN",
    defaultValue: "",
    effect: "restart",
    restartReason: "The provider registry is built once, at boot.",
    allowEmpty: true,
  },
  {
    key: "server.ffmpegBinary",
    group: "server",
    label: "ffmpeg binary",
    description:
      "Used by CasaTube for HLS and thumbnails, and forwarded to yt-dlp as --ffmpeg-location. Empty means whatever is on PATH. ⚠️ A value that does not resolve to an existing path is not forwarded at all, and the boot log says so.",
    kind: "string",
    envVar: "FFMPEG_BIN",
    defaultValue: "",
    effect: "restart",
    restartReason: "The HLS manager, the thumbnail cache and the provider registry are constructed at boot.",
    allowEmpty: true,
  },
  {
    key: "server.ffprobeBinary",
    group: "server",
    label: "ffprobe binary",
    description: "Empty means whatever is on PATH.",
    kind: "string",
    envVar: "FFPROBE_BIN",
    defaultValue: "",
    effect: "restart",
    restartReason: "Read into the configuration at boot.",
    allowEmpty: true,
  },

  // --- Library --------------------------------------------------------------
  {
    key: "library.libraryDir",
    group: "library",
    label: "Library directory",
    description: "The destination root. Job destinations are subfolders of this, never absolute paths.",
    kind: "string",
    envVar: "LIBRARY_DIR",
    defaultValue: "/library",
    effect: "restart",
    restartReason: "The worker and every library route are handed this root at boot.",
  },
  {
    key: "library.trashRetentionDays",
    group: "library",
    label: "Trash retention (days)",
    description:
      "How long a deleted item stays in .trash/ before a purge may remove it — the width of the undo window.",
    kind: "integer",
    envVar: "TRASH_RETENTION_DAYS",
    defaultValue: 30,
    effect: "restart",
    restartReason: "Read into the configuration at boot and held by the library routes.",
    min: 0,
    max: 3650,
  },

  // --- Playback -------------------------------------------------------------
  {
    key: "playback.hlsSegmentSeconds",
    group: "playback",
    label: "Segment length (s)",
    description: "⚠️ A target, not a guarantee: with the video copied, cuts can only land on keyframes.",
    kind: "integer",
    envVar: "HLS_SEGMENT_SECONDS",
    defaultValue: 6,
    effect: "restart",
    restartReason:
      "The HLS manager is constructed at boot; it owns the ffmpeg processes and the directory they write into.",
    min: 1,
    max: 60,
  },
  {
    key: "playback.hlsMaxSessions",
    group: "playback",
    label: "Simultaneous remuxes",
    description:
      "Over the cap a finished session is evicted; if they are all mid-remux the answer is a retryable 503, never a fourth ffmpeg.",
    kind: "integer",
    envVar: "HLS_MAX_SESSIONS",
    defaultValue: 3,
    effect: "restart",
    restartReason: "The HLS manager is constructed at boot.",
    min: 1,
    max: 16,
  },
  {
    key: "playback.hlsIdleMs",
    group: "playback",
    label: "Finished session kept for (ms)",
    description: "A finished remux costs disk. Nobody reading it for this long and the segments go.",
    kind: "integer",
    envVar: "HLS_IDLE_MS",
    defaultValue: 60 * 60 * 1000,
    effect: "restart",
    restartReason: "The HLS manager is constructed at boot.",
    min: 10_000,
    max: 24 * 60 * 60 * 1000,
  },
  {
    key: "playback.hlsTranscodeIdleMs",
    group: "playback",
    label: "Unwatched remux killed after (ms)",
    description:
      "A remux nobody is reading costs CPU, not disk — that is a closed tab, so it is killed far sooner than a finished one is swept.",
    kind: "integer",
    envVar: "HLS_TRANSCODE_IDLE_MS",
    defaultValue: 5 * 60 * 1000,
    effect: "restart",
    restartReason: "The HLS manager is constructed at boot.",
    min: 10_000,
    max: 6 * 60 * 60 * 1000,
  },

  // --- Thumbnails -----------------------------------------------------------
  {
    key: "thumbnails.width",
    group: "thumbnails",
    label: "Generated width (px)",
    description: "Sidecar images from the provider are served as they are; this is only for frames we extract.",
    kind: "integer",
    envVar: "THUMBNAIL_WIDTH",
    defaultValue: 480,
    effect: "restart",
    restartReason: "The thumbnail cache is constructed at boot.",
    min: 64,
    max: 1920,
  },
  {
    key: "thumbnails.maxConcurrent",
    group: "thumbnails",
    label: "Simultaneous ffmpegs",
    description:
      "Ten requests for one file are still one process; this caps how many *different* files can be generated at once.",
    kind: "integer",
    envVar: "THUMBNAIL_MAX_CONCURRENT",
    defaultValue: 2,
    effect: "restart",
    restartReason: "The thumbnail cache is constructed at boot.",
    min: 1,
    max: 8,
  },
  {
    key: "thumbnails.timeoutMs",
    group: "thumbnails",
    label: "Generation deadline (ms)",
    description: "After this the process is killed and the request answers Timeout.",
    kind: "integer",
    envVar: "THUMBNAIL_TIMEOUT_MS",
    defaultValue: 20_000,
    effect: "restart",
    restartReason: "The thumbnail cache is constructed at boot.",
    min: 1_000,
    max: 120_000,
  },
  {
    key: "thumbnails.maxEntries",
    group: "thumbnails",
    label: "Cached frames",
    description: "Oldest first, pruned above this count.",
    kind: "integer",
    envVar: "THUMBNAIL_MAX_ENTRIES",
    defaultValue: 5_000,
    effect: "restart",
    restartReason: "The thumbnail cache is constructed at boot.",
    min: 100,
    max: 100_000,
  },

  // --- Notifications: live, because the sweep re-reads them -----------------
  {
    key: "notifications.retentionDays",
    group: "notifications",
    label: "Keep read notifications for (days)",
    description:
      "Read notifications older than this are removed by the six-hourly sweep. 0 keeps them for ever. ⚠️ Unread ones are never removed by age.",
    kind: "integer",
    envVar: "NOTIFICATION_RETENTION_DAYS",
    defaultValue: 30,
    effect: "live",
    min: 0,
    max: 3650,
  },
  {
    key: "notifications.maxEntries",
    group: "notifications",
    label: "Maximum notifications kept",
    description:
      "A ceiling on the table, because the age rule spares unread ones and a bell nobody opens would grow for ever. Over it, read notifications are removed oldest first and only then unread ones — and the log says when an unread one went. 0 removes the ceiling.",
    kind: "integer",
    envVar: "NOTIFICATION_MAX_ENTRIES",
    defaultValue: 5_000,
    effect: "live",
    min: 0,
    max: 1_000_000,
  },
] as const;

const BY_KEY = new Map<string, SettingDefinition>(SETTING_DEFINITIONS.map((d) => [d.key, d]));

export function settingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

/** Which download-preference field each `downloads.*` key feeds. */
const PREFERENCE_FIELD: Readonly<Record<string, keyof Preferences>> = {
  "downloads.maxResolution": "maxResolution",
  "downloads.videoCodec": "videoCodec",
  "downloads.originalOnly": "originalOnly",
  "downloads.audioLanguages": "audioLanguages",
  "downloads.subtitleLanguages": "subtitleLanguages",
  "downloads.embedSubtitles": "embedSubtitles",
  "downloads.sponsorblock": "sponsorblock",
};

// --- Parsing and validation -------------------------------------------------

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

// Loose on purpose: `pt-BR`, `zh-Hans` and three-letter tags all arrive here,
// and refusing a tag a provider really uses is a worse failure than accepting
// one nobody has. What this refuses is punctuation that could not be a tag.
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

/**
 * An environment string, as a value — or `null` when it says nothing usable.
 *
 * ⚠️ `null` for a variable that is *set but unparseable* is deliberate: it is
 * what `api/config.ts` has always done, and the caller reports it rather than
 * swallowing it.
 */
export function parseEnvValue(definition: SettingDefinition, raw: string | undefined): SettingValue | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();

  switch (definition.kind) {
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (TRUE.has(lower)) return true;
      if (FALSE.has(lower)) return false;
      return null;
    }
    case "integer": {
      if (trimmed === "") return null;
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed)) return null;
      if (definition.min !== undefined && parsed < definition.min) return null;
      if (definition.max !== undefined && parsed > definition.max) return null;
      return parsed;
    }
    case "string":
      // Empty is "unset" — the same reading `config.ts`'s `str()` gives it.
      return trimmed === "" ? null : trimmed;
    case "enum":
      return definition.options?.some((option) => option.value === trimmed) === true ? trimmed : null;
    case "languages":
      return trimmed === "" ? [] : normaliseLanguages(trimmed.split(","));
  }
}

function normaliseLanguages(values: unknown[]): string[] | null {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") return null;
    const tag = value.trim();
    if (tag === "") continue;
    if (!LANGUAGE_TAG.test(tag)) return null;
    out.push(tag.toLowerCase());
  }
  // Sorted and de-duplicated for the same reason `resolvePreferences` does it:
  // ["en","es"] and ["es","en"] are one request, and two fingerprints for one
  // request is how duplicate detection quietly stops working.
  return [...new Set(out)].sort();
}

/**
 * A value from the browser, checked.
 *
 * Anything that fails is refused with a sentence naming the constraint — never
 * coerced. Coercion is how `maxResolution: "1080p"` becomes `NaN` and the
 * screen shows a number the worker will never use.
 */
export function validateValue(
  definition: SettingDefinition,
  value: unknown,
): Result<SettingValue, InvalidSettingValue> {
  const bad = (detail: string): Result<SettingValue, InvalidSettingValue> =>
    Result.err(new InvalidSettingValue({ key: definition.key, detail }));

  switch (definition.kind) {
    case "boolean":
      return typeof value === "boolean" ? Result.ok(value) : bad("Expected true or false.");
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return bad("Expected a number.");
      if (!Number.isInteger(value)) return bad("Expected a whole number.");
      if (definition.min !== undefined && value < definition.min) return bad(`Must be at least ${definition.min}.`);
      if (definition.max !== undefined && value > definition.max) return bad(`Must be at most ${definition.max}.`);
      return Result.ok(value);
    }
    case "string": {
      if (typeof value !== "string") return bad("Expected text.");
      const trimmed = value.trim();
      if (trimmed === "" && definition.allowEmpty !== true) {
        return bad("Cannot be empty. Reset it instead, which returns it to the environment or the default.");
      }
      if (trimmed.length > 4096) return bad("Too long.");
      return Result.ok(trimmed);
    }
    case "enum": {
      const allowed = definition.options ?? [];
      if (typeof value !== "string" || !allowed.some((option) => option.value === value)) {
        return bad(`Expected one of: ${allowed.map((option) => option.value).join(", ")}.`);
      }
      return Result.ok(value);
    }
    case "languages": {
      if (!Array.isArray(value)) return bad("Expected a list of language tags.");
      if (value.length > 50) return bad("Too many languages.");
      const tags = normaliseLanguages(value);
      return tags === null ? bad("Every entry must be a language tag such as en, es or pt-BR.") : Result.ok(tags);
    }
  }
}

/** Structural equality, for the two comparisons this module makes. */
function sameValue(a: SettingValue | null, b: SettingValue | null): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

// --- The resolved shape -----------------------------------------------------

/**
 * One setting, with everything a reader needs in order to act on it.
 *
 * This is the wire shape `GET /api/settings` returns, and it is deliberately
 * verbose: every field answers a question the read-only screen left
 * unanswerable.
 */
export interface ResolvedSetting {
  key: string;
  group: SettingGroupId;
  label: string;
  description: string;
  kind: SettingKind;
  /** ⚠️ Always present, whether or not anything sets it. */
  envVar: string;
  /** The effective value after precedence. `null` only for a secret. */
  value: SettingValue | null;
  /** Which of the three won. */
  source: SettingSource;
  defaultValue: SettingValue | null;
  /** The environment's value, parsed. `null` when unset — or unreadable. */
  envValue: SettingValue | null;
  /** The variable is set and could not be read, so it is being ignored. */
  envInvalid: boolean;
  /** The stored override, when there is one. */
  userValue: SettingValue | null;
  updatedAt: string | null;
  /** Where a reset would land, and on what. `null` when there is nothing to reset. */
  resetsTo: { source: "env" | "default"; value: SettingValue | null } | null;
  effect: SettingEffect;
  restartReason: string | null;
  /** What the running process is actually using right now. */
  runningValue: SettingValue | null;
  /** ⚠️ `value` is stored, `runningValue` is in force, and the two disagree. */
  pendingRestart: boolean;
  editable: boolean;
  editableReason: string | null;
  /** For a secret: whether one is set at all — the only thing the UI is owed. */
  configured: boolean;
  secret: boolean;
  options: readonly SettingOption[] | null;
  min: number | null;
  max: number | null;
}

export interface SettingsSnapshot {
  groups: readonly SettingGroup[];
  settings: ResolvedSetting[];
  /** The download defaults, already merged — what a job with no preferences gets. */
  preferences: Preferences;
  /** True when anything at all is waiting for a restart. */
  restartPending: boolean;
  at: string;
}

// --- The store --------------------------------------------------------------

export interface AppSettingsStoreOptions {
  db: Db;
  /** Defaults to `process.env`. Injected so a test can state the environment. */
  env?: Record<string, string | undefined>;
  /**
   * Defaults the catalogue cannot state as literals.
   *
   * ⚠️ Exactly one setting needs this today and it is worth the mechanism:
   * `TEMP_DIR` defaults to `${DATA_DIR}/tmp`, so its default is a *function of
   * another setting*. A literal in the definition would render as `""` beside
   * the word "default" for a directory the process is demonstrably using — the
   * screen would be wrong about the one thing it exists to report.
   */
  derivedDefaults?: Record<string, SettingValue>;
  now?: () => Date;
}

interface StoredRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

interface Effective {
  value: SettingValue;
  source: SettingSource;
  userValue: SettingValue | null;
  envValue: SettingValue | null;
  envInvalid: boolean;
  updatedAt: string | null;
}

export class AppSettingsStore {
  readonly #db: Db;
  readonly #env: Record<string, string | undefined>;
  readonly #derived: Record<string, SettingValue>;
  readonly #now: () => Date;
  /**
   * What the process is actually running with.
   *
   * Captured at boot by `captureRunning()`, or lazily on the first read for a
   * store nobody booted (a test). Without it there is no way to tell "the port
   * is 8520" from "the port is stored as 9000 and the socket is on 8520" — and
   * that difference is the whole of the live/restart distinction.
   */
  #running: Map<string, SettingValue> | null = null;

  constructor(options: AppSettingsStoreOptions) {
    this.#db = options.db;
    this.#env = options.env ?? process.env;
    this.#derived = options.derivedDefaults ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async #rows(): Promise<Map<string, StoredRow>> {
    const rows = await this.#db.select().from(settingsTable);
    const map = new Map<string, StoredRow>();
    for (const row of rows) {
      // Only our own keys. The same table carries `plugin.config:*` records
      // (see `core/settings.ts`), and a stray key must not become a setting.
      if (BY_KEY.has(row.key)) map.set(row.key, { key: row.key, value: row.value, updatedAt: row.updatedAt });
    }
    return map;
  }

  /**
   * 🔴 The precedence rule, and the only place it is implemented.
   */
  /** The code's default for a key — derived where the catalogue cannot say. */
  #defaultOf(definition: SettingDefinition): SettingValue {
    return this.#derived[definition.key] ?? definition.defaultValue;
  }

  #effective(definition: SettingDefinition, rows: Map<string, StoredRow>): Effective {
    const row = rows.get(definition.key);
    // A stored value is re-validated on the way out: a definition can tighten
    // its range in a later build, and an override that no longer passes must
    // not become a value the code would never accept from the API.
    let userValue: SettingValue | null = null;
    if (row !== undefined && definition.editable !== false) {
      const checked = validateValue(definition, row.value);
      if (Result.isOk(checked)) userValue = checked.value;
    }

    const raw = this.#env[definition.envVar];
    const envValue = parseEnvValue(definition, raw);
    const envInvalid = raw !== undefined && raw.trim() !== "" && envValue === null;

    if (userValue !== null) {
      return {
        value: userValue,
        source: "user",
        userValue,
        envValue,
        envInvalid,
        updatedAt: row?.updatedAt ?? null,
      };
    }
    if (envValue !== null) {
      return { value: envValue, source: "env", userValue: null, envValue, envInvalid, updatedAt: null };
    }
    return {
      value: this.#defaultOf(definition),
      source: "default",
      userValue: null,
      envValue,
      envInvalid,
      updatedAt: null,
    };
  }

  #resolveOne(
    definition: SettingDefinition,
    rows: Map<string, StoredRow>,
    running: Map<string, SettingValue>,
  ): ResolvedSetting {
    const { value, source, userValue, envValue, envInvalid, updatedAt } = this.#effective(definition, rows);
    const secret = definition.secret === true;
    const configured = secret ? value !== "" : true;

    const resetsTo =
      userValue === null
        ? null
        : envValue !== null
          ? { source: "env" as const, value: secret ? null : envValue }
          : { source: "default" as const, value: secret ? null : this.#defaultOf(definition) };

    /**
     * ⚠️ A live setting is *always* running whatever it currently resolves to.
     *
     * Reading the boot snapshot for one would report a value that stopped being
     * true the moment it was saved — the running server would show
     * `maxResolution: 720` beside a stored `2160` it is already using. The boot
     * snapshot only means anything for the settings the process read once.
     */
    const runningValue = definition.effect === "live" ? value : (running.get(definition.key) ?? null);
    const pendingRestart = definition.effect === "restart" && !sameValue(runningValue, value);

    return {
      key: definition.key,
      group: definition.group,
      label: definition.label,
      description: definition.description,
      kind: definition.kind,
      envVar: definition.envVar,
      // 🔴 A secret's value never leaves the server. `configured` is what the
      // screen needs and all it is entitled to — PLAN §12.
      value: secret ? null : value,
      source,
      defaultValue: secret ? null : this.#defaultOf(definition),
      envValue: secret ? null : envValue,
      envInvalid,
      userValue: secret ? null : userValue,
      updatedAt,
      resetsTo,
      effect: definition.effect,
      restartReason: definition.restartReason ?? null,
      runningValue: secret ? null : runningValue,
      pendingRestart,
      editable: definition.editable !== false,
      editableReason: definition.editableReason ?? null,
      configured,
      secret,
      options: definition.options ?? null,
      min: definition.min ?? null,
      max: definition.max ?? null,
    };
  }

  #snapshotRunning(rows: Map<string, StoredRow>): Map<string, SettingValue> {
    const running = new Map<string, SettingValue>();
    for (const definition of SETTING_DEFINITIONS) {
      running.set(definition.key, this.#effective(definition, rows).value);
    }
    return running;
  }

  /**
   * Record what this process is running with.
   *
   * Called once at boot, *after* the stored overrides have been applied to the
   * configuration — so the snapshot is by construction exactly what the running
   * process holds, rather than a guess about it.
   */
  async captureRunning(): Promise<void> {
    this.#running = this.#snapshotRunning(await this.#rows());
  }

  #ensureRunning(rows: Map<string, StoredRow>): Map<string, SettingValue> {
    this.#running ??= this.#snapshotRunning(rows);
    return this.#running;
  }

  /** The effective value for one key, or `null` when there is no such setting. */
  async get(key: string): Promise<SettingValue | null> {
    const definition = BY_KEY.get(key);
    if (definition === undefined) return null;
    return this.#effective(definition, await this.#rows()).value;
  }

  async resolve(key: string): Promise<Result<ResolvedSetting, SettingsError>> {
    const definition = BY_KEY.get(key);
    if (definition === undefined) return Result.err(new NotFound({ what: "setting", id: key }));
    const rows = await this.#rows();
    return Result.ok(this.#resolveOne(definition, rows, this.#ensureRunning(rows)));
  }

  async list(): Promise<ResolvedSetting[]> {
    const rows = await this.#rows();
    const running = this.#ensureRunning(rows);
    return SETTING_DEFINITIONS.map((definition) => this.#resolveOne(definition, rows, running));
  }

  async snapshot(): Promise<SettingsSnapshot> {
    const rows = await this.#rows();
    const running = this.#ensureRunning(rows);
    const resolved = SETTING_DEFINITIONS.map((definition) => this.#resolveOne(definition, rows, running));
    return {
      groups: SETTING_GROUPS,
      settings: resolved,
      preferences: this.#preferences(rows),
      restartPending: resolved.some((setting) => setting.pendingRestart),
      at: this.#now().toISOString(),
    };
  }

  /**
   * Write a user override.
   *
   * ⚠️ The value is stored **even when it equals the environment's or the
   * default's**. "The same as the default, and pinned" and "following the
   * default" are different states: only the first survives someone changing the
   * variable, and collapsing them would silently un-pin a deliberate choice.
   */
  async set(key: string, value: unknown): Promise<Result<ResolvedSetting, SettingsError>> {
    const definition = BY_KEY.get(key);
    if (definition === undefined) return Result.err(new NotFound({ what: "setting", id: key }));
    if (definition.editable === false) {
      return Result.err(
        new InvalidSettingValue({
          key,
          detail: definition.editableReason ?? "This setting cannot be overridden through the API.",
        }),
      );
    }

    const checked = validateValue(definition, value);
    if (Result.isError(checked)) return Result.err(checked.error);

    const at = this.#now().toISOString();
    // One statement rather than a read and a write: two tabs saving the same
    // setting at once would otherwise race, and the loser would vanish with no
    // error anywhere.
    await this.#db
      .insert(settingsTable)
      .values({ key, value: checked.value, updatedAt: at })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: checked.value, updatedAt: at } });

    return this.resolve(key);
  }

  /** Remove the override. The answer says where the value fell back to. */
  async clear(key: string): Promise<Result<ResolvedSetting, SettingsError>> {
    const definition = BY_KEY.get(key);
    if (definition === undefined) return Result.err(new NotFound({ what: "setting", id: key }));
    await this.#db.delete(settingsTable).where(eq(settingsTable.key, key));
    return this.resolve(key);
  }

  #preferences(rows: Map<string, StoredRow>): Preferences {
    const partial: Record<string, SettingValue> = {};
    for (const [key, field] of Object.entries(PREFERENCE_FIELD)) {
      const definition = BY_KEY.get(key);
      if (definition === undefined) continue;
      // Safe by construction: PREFERENCE_FIELD pairs each key with the field
      // whose type its `kind` produces, and `validateValue` is what guarantees
      // a stored value still matches that kind.
      partial[field] = this.#effective(definition, rows).value;
    }
    // Through `resolvePreferences` rather than around it: sorting and
    // de-duplicating the language lists is what stops one request from having
    // two fingerprints, and a second implementation of it would drift.
    return resolvePreferences(partial as Partial<Preferences>);
  }

  /**
   * The download defaults, resolved.
   *
   * 🔴 This is what makes the `downloads.*` group *live*: it reads the table on
   * every call rather than capturing at boot, so a change is in force for the
   * very next job.
   */
  async preferences(): Promise<Preferences> {
    return this.#preferences(await this.#rows());
  }
}
