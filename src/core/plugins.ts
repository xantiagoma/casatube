/**
 * The plugin contract.
 *
 * Two extension points, deliberately distinct (PLAN §5):
 *  - a **Provider** answers "how do I get media from this URL?"
 *  - a **hook** answers "do something at this moment"
 *
 * Capabilities are injected, never imported. That is what stops most plugins
 * needing dependencies at all: a URL unshortener and a media-server notifier
 * need `fetch` and nothing else.
 */
import type { Provider, Job, MediaInfo, DownloadPlan } from "./types";

export type Capability =
  | "network" | "library:read" | "library:write" | "cookies" | "subprocess";

export type HookPoint =
  | "url:resolve" | "job:queued" | "probe:complete"
  | "download:complete" | "job:completed" | "job:failed";

/**
 * Transforming hooks run in declared order and can change the outcome; if one
 * fails, the job fails. Observing hooks run in parallel, are not awaited, and
 * **can never fail a job** — a media-server refresh that fails does not make a
 * correctly downloaded video wrong.
 */
export type HookKind = "transform" | "observe";

export interface HookDeclaration {
  at: HookPoint;
  kind: HookKind;
  /** Explicit ordering, so two hooks at one point are not left to load order. */
  before?: string;
  after?: string;
}

/** Signatures per point. Transforming hooks return the value they may replace. */
export interface HookSignatures {
  "url:resolve": (url: string) => string | Promise<string>;
  "job:queued": (job: Job) => void | Promise<void>;
  "probe:complete": (info: MediaInfo, plan: DownloadPlan) => DownloadPlan | Promise<DownloadPlan>;
  "download:complete": (job: Job, file: string) => void | Promise<void>;
  "job:completed": (job: Job) => void | Promise<void>;
  "job:failed": (job: Job, error: string) => void | Promise<void>;
}

export interface PluginApi {
  on<P extends HookPoint>(at: P, fn: HookSignatures[P]): void;
  addProvider(p: Provider): void;
  fetch: typeof globalThis.fetch;
  log(line: string): void;
  config: Readonly<Record<string, unknown>>;
}

/**
 * One thing a plugin needs to be told before it can work.
 *
 * 🔴 **Declared, not read blind.** The first version of `jellyfin.ts` reached
 * into `config` for `JELLYFIN_URL` and `JELLYFIN_TOKEN` and, when they were
 * missing, logged one line and did nothing. Correct behaviour, useless
 * interface: the only way to find out what to set was to read the source. A
 * declaration is what lets Settings draw a form instead.
 *
 * ⚠️ **Every value is a string**, including numbers and booleans, because the
 * layer underneath is the process environment and an environment variable is a
 * string. A setting that arrived as a `number` from the UI and a `string` from
 * the environment would be the worst kind of surprise — the plugin would work
 * until someone moved the value. `type` is a hint for the *form*, not a promise
 * about the runtime type.
 */
export interface PluginSetting {
  /** The key in `config`. By convention SCREAMING_SNAKE, like the variable it shadows. */
  key: string;
  /** The form label. Write it for someone who has not read the plugin. */
  label: string;
  /** One or two sentences: what it is for, and where to get it. */
  description?: string;
  /**
   * ⚠️ **Never returned by the API**, the same rule as the cookies file
   * (PLAN §12). The form shows "set" or "not set" and a box to replace it, and
   * nothing anywhere sends the value back to the browser.
   */
  secret?: boolean;
  /** What the plugin gets when neither the environment nor the UI has a value. */
  default?: string;
  /** Shown as a warning in the form. Nothing is enforced: an unconfigured plugin must still behave. */
  required?: boolean;
  /** How the form renders it. `select` needs `options`. */
  type?: PluginSettingType;
  /** For `type: "select"`. */
  options?: PluginSettingOption[];
  placeholder?: string;
}

export type PluginSettingType = "text" | "number" | "boolean" | "url" | "select";

export interface PluginSettingOption {
  value: string;
  label?: string;
}

export interface PluginManifest {
  name: string;
  description: string;
  /**
   * Hosts or patterns this plugin claims.
   *
   * Static on purpose: it is read **before any plugin code runs**, so the UI can
   * show which plugins would apply to a pasted URL and let the user choose
   * (PLAN §5).
   */
  matches?: string[];
  hooks?: HookDeclaration[];
  /**
   * Capabilities requested, shown at install time.
   *
   * ⚠️ A UI contract, not a sandbox. Withholding a capability works for a
   * well-behaved plugin; an in-process module can import Bun APIs directly, and
   * Bun has no Deno-style permission flags. Real isolation needs a separate
   * process, and is only worth it once third-party plugins are distributed.
   */
  needs?: Capability[];
  /**
   * What this plugin needs configured, so the UI can draw a form for it.
   *
   * Static, like `matches`, and read at the same moment: the form exists before
   * `setup()` has ever run, which is the only way a plugin can be configured
   * *before* it is switched on.
   */
  settings?: PluginSetting[];
}

export interface Plugin extends PluginManifest {
  setup(api: PluginApi): void | Promise<void>;
}

/** A plugin file default-exports this. */
export function registerPlugin(p: Plugin): Plugin {
  return p;
}
