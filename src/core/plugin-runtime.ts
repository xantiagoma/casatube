/**
 * The plugin runtime: discovery, capability injection, and hook dispatch.
 *
 * `plugins.ts` is the contract; this is the thing that honours it. Three
 * decisions carry the design, and each one is a rule the tests hold to:
 *
 * 1. **The manifest is read before the plugin does anything.** Discovery reads
 *    `name`, `description`, `matches`, `hooks` and `needs` from the default
 *    export and stops there — `setup()` is not called, no capability is handed
 *    over, no hook is registered. That is what lets the UI take a pasted URL,
 *    list the plugins that *would* apply, and leave the choice to the user
 *    (PLAN section 5).
 *
 *    Honest about the limit: reading an ES module's export means importing it,
 *    so the file's **top level** is evaluated. Nothing a well-written plugin
 *    does happens there — a plugin that opens a socket at the top level is
 *    misbehaving, and there is no parser here that would stop it.
 *
 * 2. **Capabilities are injected, never imported.** A plugin is handed `on`,
 *    `addProvider`, `log` and `config` — and `fetch` only if it declared
 *    `network`. A plugin that did not declare it gets a `fetch` that throws
 *    before touching the network, which is the closest an in-process module can
 *    get to "not receiving it". This is a UI contract, **not a sandbox**
 *    (PLAN section 5, and `plugins/README.md`).
 *
 * 3. **An observer can never fail a job.** Transforming hooks run in declared
 *    order, replace the value, and a throw becomes a `PluginHookFailed` the
 *    worker can fail the job with. Observing hooks are started in parallel, are
 *    **not awaited**, and their failures are logged and dropped. If the media
 *    server refresh fails, the video is downloaded and correct; marking the job
 *    failed would be a lie.
 *
 * And one rule about failure itself: **a broken plugin must not stop the
 * others**. A syntax error, a missing default export, a manifest that is not a
 * manifest, a `setup()` that throws — each is recorded against that plugin, and
 * the load carries on.
 */
import { Result, TaggedError } from "better-result";
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  Capability,
  HookDeclaration,
  HookKind,
  HookPoint,
  HookSignatures,
  Plugin,
  PluginApi,
  PluginManifest,
  PluginSetting,
  PluginSettingType,
} from "./plugins";
import {
  applyPatch,
  memoryPluginSettings,
  resolveConfig,
  resolveSettings,
  type PluginSettingsStore,
  type ResolvedSetting,
} from "./plugin-settings";
import type { DownloadPlan, Job, Provider } from "./types";

// --- Vocabulary -------------------------------------------------------------

export const HOOK_POINTS: readonly HookPoint[] = [
  "url:resolve",
  "job:queued",
  "probe:complete",
  "download:complete",
  "job:completed",
  "job:failed",
] as const;

export const HOOK_KINDS: readonly HookKind[] = ["transform", "observe"] as const;

export const CAPABILITIES: readonly Capability[] = [
  "network",
  "library:read",
  "library:write",
  "cookies",
  "subprocess",
] as const;

export const SETTING_TYPES: readonly PluginSettingType[] = ["text", "number", "boolean", "url", "select"] as const;

/** Extensions Bun imports directly. TypeScript needs no build step — PLAN section 5. */
const LOADABLE = [".ts", ".mts", ".js", ".mjs"] as const;

/**
 * The prefix on the throwaway copy every plugin is imported through.
 *
 * 🔴 **A query string does not bust Bun's module cache.** The obvious
 * `import(href + "?g=" + generation)` reads like it works and does not: Bun
 * keys its module registry on the resolved *path*, and strips the query and the
 * hash from a `file:` URL before looking it up. Measured, not assumed — the
 * three variants (`?g=`, `?t=<now>`, `#<now>`) all hand back the first
 * evaluation, and only a different filename returns the new source.
 *
 * So a reload copies each file to a sibling with this prefix, imports **that**,
 * and deletes it. A sibling rather than a temp directory because
 * `import.meta.dir` and any relative path inside the plugin have to resolve the
 * same way they would from the real file; and a leading `.` because that is
 * what `candidates()` skips and what `plugin-files.ts` refuses to write, so a
 * copy can never be mistaken for a plugin of its own.
 *
 * ⚠️ It is done on **every** load, not only reloads. Two runtimes over the same
 * directory in one process — which is what a test suite is — would otherwise
 * have a first load that behaves differently from every load after it.
 */
const RELOAD_PREFIX = ".casatube-reload-";

/**
 * A transforming hook threw.
 *
 * Deliberately *not* in `core/errors.ts`: that taxonomy belongs to the
 * application, and this failure belongs to the extension seam. It travels to
 * the worker, which turns it into a failed stage — the one path by which a
 * plugin can fail a job, and only ever a transforming one.
 */
export class PluginHookFailed extends TaggedError("PluginHookFailed")<{
  plugin: string;
  at: HookPoint;
  detail: string;
}> {}

/**
 * What a plugin's `addProvider` needs.
 *
 * Structural on purpose, so `core/` keeps not knowing about `providers/` —
 * `ProviderRegistry` satisfies it without being named here.
 */
export interface ProviderSink {
  register(provider: Provider): void;
}

/** Arguments each point is dispatched with — derived from the contract, never restated. */
export type HookArgs = { [P in HookPoint]: Parameters<HookSignatures[P]> };

/** What `run` answers with. Only the two transforming points carry a value. */
export interface HookOutcome {
  "url:resolve": string;
  "job:queued": void;
  "probe:complete": DownloadPlan;
  "download:complete": void;
  "job:completed": void;
  "job:failed": void;
}

export type PluginState = "active" | "disabled" | "error";

/** What `GET /api/plugins` shows, and everything the runtime knows about a plugin. */
export interface PluginStatus extends PluginManifest {
  /** The file it came from, relative to the plugins directory. */
  file: string;
  enabled: boolean;
  state: PluginState;
  /** Why it is not running, when it is not. */
  error?: string;
  /** Recent lines from its own `log`, newest last. Bounded. */
  log: string[];
  /** Providers it registered, by name. */
  providers: string[];
  /**
   * Declared settings marked `required` that have no value at any layer.
   *
   * Here rather than left to the settings endpoint because it is what the
   * *list* has to be able to say. A plugin sitting there `active` and doing
   * nothing because a token is missing looks identical to one that is working,
   * and that is precisely the silence this project keeps finding.
   */
  missingSettings: string[];
}

export interface PluginRuntimeOptions {
  /** `DATA_DIR/plugins`. Missing is fine — a fresh install has no plugins. */
  dir: string;
  /**
   * Where enable/disable and per-plugin config are persisted. Defaults to
   * `plugin-state.json` next to the plugins directory.
   */
  stateFile?: string;
  /** Where `addProvider` lands. Omit it and `addProvider` is refused with a log line. */
  registry?: ProviderSink;
  /** Base `config` handed to every plugin. Defaults to the environment — PLAN section 12. */
  config?: Record<string, unknown>;
  /**
   * Where the values typed into Settings are kept.
   *
   * Injected because the runtime must stand up with no database at all — the
   * API tests do exactly that — and because the store is the `settings` table,
   * which `core/` reaches through an interface rather than a schema import.
   * Omitted, it is an in-memory store: everything still resolves, nothing
   * survives a restart.
   */
  settings?: PluginSettingsStore;
  /** Where plugin log lines and the runtime's own complaints go. */
  log?: (line: string) => void;
  /** Whether a plugin nobody has decided about runs. */
  defaultEnabled?: boolean;
  /** Lines kept per plugin for the API. */
  logLimit?: number;
}

interface PersistedPlugin {
  enabled?: boolean;
  /** Merged over the base config, for this plugin only. */
  config?: Record<string, unknown>;
}

interface PersistedState {
  plugins?: Record<string, PersistedPlugin>;
}

interface HookRecord {
  plugin: string;
  at: HookPoint;
  kind: HookKind;
  fn: (...args: unknown[]) => unknown;
  /** Load order, then declaration order: the tiebreak when nothing is constrained. */
  base: number;
  before?: string;
  after?: string;
}

interface Entry {
  manifest: PluginManifest;
  plugin?: Plugin;
  file: string;
  enabled: boolean;
  state: PluginState;
  error?: string;
  log: string[];
  providers: string[];
  /**
   * Position in the directory listing.
   *
   * The tiebreak for hook order, and it has to be *load* order rather than
   * activation order: otherwise enabling a plugin from the UI would silently
   * move its hooks to the end of every chain it is in.
   */
  seat: number;
  /** `setup()` has run. Enabling a plugin for the first time is what runs it. */
  activated: boolean;
  /** Cleared on reload, so a provider from a previous generation stops claiming URLs. */
  live: boolean;
}

// --- Matching ---------------------------------------------------------------

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function globToRegExp(pattern: string): RegExp {
  // Escape everything a regex would read, turning `*` into a placeholder first
  // so the escaping pass cannot see it.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? " " : `\\${ch}`));
  return new RegExp(`^${escaped.replaceAll(" ", ".*")}$`, "i");
}

/**
 * Does this pattern claim this URL?
 *
 * A pattern with a scheme or a slash is matched against the whole URL; anything
 * else against the hostname. A bare host also claims its subdomains — `adf.ly`
 * covers `www.adf.ly`, because that is what someone writing it means — and
 * `*.adfly.com` stays the way to claim *only* subdomains.
 */
export function patternMatches(pattern: string, url: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;

  if (trimmed.includes("://") || trimmed.includes("/")) return globToRegExp(trimmed).test(url);

  const host = hostOf(url);
  if (host === null) return false;
  const needle = trimmed.toLowerCase();
  if (needle.includes("*")) return globToRegExp(needle).test(host);
  return host === needle || host.endsWith(`.${needle}`);
}

/** No `matches` means "everything" — the media-server notifier is the case that wants it. */
export function manifestMatches(manifest: PluginManifest, url: string): boolean {
  const patterns = manifest.matches;
  if (patterns === undefined || patterns.length === 0) return true;
  return patterns.some((pattern) => patternMatches(pattern, url));
}

// --- Manifest validation ----------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * A setting key is an environment variable name.
 *
 * Not a coincidence and not decoration: the environment is one of the layers a
 * setting resolves through (`plugin-settings.ts`), so a key that could not be
 * an environment variable is a key the "revert to the environment value" button
 * could never mean anything for.
 */
const SETTING_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown, field: string): Result<string[] | undefined, string> {
  if (value === undefined) return Result.ok(undefined);
  if (!Array.isArray(value)) return Result.err(`${field} must be an array of strings`);
  for (const item of value) {
    if (typeof item !== "string") return Result.err(`${field} must be an array of strings`);
  }
  return Result.ok(value as string[]);
}

function validateHooks(value: unknown): Result<HookDeclaration[] | undefined, string> {
  if (value === undefined) return Result.ok(undefined);
  if (!Array.isArray(value)) return Result.err("hooks must be an array");
  const out: HookDeclaration[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return Result.err("each hook must be an object");
    const at = raw.at;
    const kind = raw.kind;
    if (typeof at !== "string" || !HOOK_POINTS.includes(at as HookPoint)) {
      return Result.err(`unknown hook point ${JSON.stringify(at)}`);
    }
    if (typeof kind !== "string" || !HOOK_KINDS.includes(kind as HookKind)) {
      return Result.err(`the hook at ${at} must be "transform" or "observe"`);
    }
    if (raw.before !== undefined && typeof raw.before !== "string") return Result.err("before must be a string");
    if (raw.after !== undefined && typeof raw.after !== "string") return Result.err("after must be a string");
    out.push({
      at: at as HookPoint,
      kind: kind as HookKind,
      ...(typeof raw.before === "string" ? { before: raw.before } : {}),
      ...(typeof raw.after === "string" ? { after: raw.after } : {}),
    });
  }
  return Result.ok(out);
}

/**
 * The settings declaration, checked the same way the hooks are.
 *
 * A setting with no `key` would render a form row that writes nowhere; a `type`
 * nobody recognises would render as text and quietly lose a checkbox. Both are
 * the same failure as an unknown hook point — something declared, shown to the
 * user, and dead. So the plugin is refused with the reason instead.
 */
function validateSettings(value: unknown): Result<PluginSetting[] | undefined, string> {
  if (value === undefined) return Result.ok(undefined);
  if (!Array.isArray(value)) return Result.err("settings must be an array");
  const out: PluginSetting[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) return Result.err("each setting must be an object");
    const key = raw.key;
    if (typeof key !== "string" || !SETTING_KEY_RE.test(key)) {
      return Result.err(`a setting key must be a plain identifier, got ${JSON.stringify(key)}`);
    }
    if (seen.has(key)) return Result.err(`the setting ${JSON.stringify(key)} is declared twice`);
    seen.add(key);
    if (typeof raw.label !== "string" || raw.label.trim() === "") {
      return Result.err(`the setting ${JSON.stringify(key)} needs a label`);
    }
    for (const field of ["description", "default", "placeholder"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "string") {
        return Result.err(`${field} on ${JSON.stringify(key)} must be a string`);
      }
    }
    for (const field of ["secret", "required"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "boolean") {
        return Result.err(`${field} on ${JSON.stringify(key)} must be true or false`);
      }
    }
    const type = raw.type;
    if (type !== undefined && (typeof type !== "string" || !SETTING_TYPES.includes(type as PluginSettingType))) {
      return Result.err(`unknown setting type ${JSON.stringify(type)} on ${JSON.stringify(key)}`);
    }
    let options: { value: string; label?: string }[] | undefined;
    if (raw.options !== undefined) {
      if (!Array.isArray(raw.options)) return Result.err(`options on ${JSON.stringify(key)} must be an array`);
      options = [];
      for (const option of raw.options) {
        if (!isRecord(option) || typeof option.value !== "string") {
          return Result.err(`each option on ${JSON.stringify(key)} needs a string value`);
        }
        options.push({
          value: option.value,
          ...(typeof option.label === "string" ? { label: option.label } : {}),
        });
      }
    }
    if (type === "select" && (options === undefined || options.length === 0)) {
      return Result.err(`the setting ${JSON.stringify(key)} is a select with no options`);
    }
    out.push({
      key,
      label: raw.label,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.default === "string" ? { default: raw.default } : {}),
      ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
      ...(raw.secret === true ? { secret: true } : {}),
      ...(raw.required === true ? { required: true } : {}),
      ...(type !== undefined ? { type: type as PluginSettingType } : {}),
      ...(options !== undefined ? { options } : {}),
    });
  }
  return Result.ok(out);
}

/**
 * The gate between "a file exported something" and "we have a plugin".
 *
 * Everything a plugin claims is checked here, before any of it is trusted: a
 * hook at a point that does not exist would otherwise be silently dead, and a
 * capability nobody recognises would be shown to the user as if it meant
 * something.
 */
export function validatePlugin(value: unknown): Result<Plugin, string> {
  if (!isRecord(value)) return Result.err("the default export is not a plugin object");

  const name = value.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return Result.err(`name must be a plain identifier, got ${JSON.stringify(name)}`);
  }
  if (typeof value.description !== "string") return Result.err("description is required");
  if (typeof value.setup !== "function") return Result.err("setup must be a function");

  const matches = stringArray(value.matches, "matches");
  if (Result.isError(matches)) return Result.err(matches.error);

  const hooks = validateHooks(value.hooks);
  if (Result.isError(hooks)) return Result.err(hooks.error);

  const needs = stringArray(value.needs, "needs");
  if (Result.isError(needs)) return Result.err(needs.error);
  for (const capability of needs.value ?? []) {
    if (!CAPABILITIES.includes(capability as Capability)) {
      return Result.err(`unknown capability ${JSON.stringify(capability)}`);
    }
  }

  const declared = validateSettings(value.settings);
  if (Result.isError(declared)) return Result.err(declared.error);

  return Result.ok({
    name,
    description: value.description,
    ...(matches.value ? { matches: matches.value } : {}),
    ...(hooks.value ? { hooks: hooks.value } : {}),
    ...(needs.value ? { needs: needs.value as Capability[] } : {}),
    ...(declared.value ? { settings: declared.value } : {}),
    setup: value.setup as Plugin["setup"],
  });
}

/** A copy, so what the API hands out cannot be edited into what the plugin declared. */
function manifestOf(manifest: PluginManifest): PluginManifest {
  return {
    name: manifest.name,
    description: manifest.description,
    ...(manifest.matches ? { matches: [...manifest.matches] } : {}),
    ...(manifest.hooks ? { hooks: manifest.hooks.map((hook) => ({ ...hook })) } : {}),
    ...(manifest.needs ? { needs: [...manifest.needs] } : {}),
    ...(manifest.settings
      ? {
          settings: manifest.settings.map((setting) => ({
            ...setting,
            ...(setting.options ? { options: setting.options.map((option) => ({ ...option })) } : {}),
          })),
        }
      : {}),
  };
}

// --- Ordering ---------------------------------------------------------------

/**
 * Declared order, with `before` and `after` honoured.
 *
 * A name matching no hook at this point is ignored rather than an error —
 * PLAN's own example says `before: "provider:resolve"`, which names the host's
 * own step, not another plugin. A cycle keeps base order for whatever is left
 * of it: refusing to run the hooks would be a worse answer than running them in
 * the order the files were read.
 */
export function orderHooks(records: HookRecord[]): HookRecord[] {
  const sorted = [...records].sort((a, b) => a.base - b.base);
  const indexByPlugin = new Map<string, number[]>();
  sorted.forEach((item, index) => {
    const existing = indexByPlugin.get(item.plugin);
    if (existing) existing.push(index);
    else indexByPlugin.set(item.plugin, [index]);
  });

  const edges: Set<number>[] = sorted.map(() => new Set<number>());
  const indegree = new Array<number>(sorted.length).fill(0);
  const addEdge = (from: number, to: number): void => {
    if (from === to) return;
    const out = edges[from];
    if (!out || out.has(to)) return;
    out.add(to);
    indegree[to] = (indegree[to] ?? 0) + 1;
  };

  sorted.forEach((item, index) => {
    if (item.before !== undefined) {
      for (const target of indexByPlugin.get(item.before) ?? []) addEdge(index, target);
    }
    if (item.after !== undefined) {
      for (const target of indexByPlugin.get(item.after) ?? []) addEdge(target, index);
    }
  });

  const out: HookRecord[] = [];
  const taken = new Array<boolean>(sorted.length).fill(false);
  for (let step = 0; step < sorted.length; step += 1) {
    // Lowest base index whose constraints are already satisfied. Stable, so
    // anything unconstrained keeps the order it was declared in.
    let pick = -1;
    for (let i = 0; i < sorted.length; i += 1) {
      if (!taken[i] && indegree[i] === 0) {
        pick = i;
        break;
      }
    }
    if (pick === -1) {
      // A cycle. Everything still standing goes in base order.
      for (let i = 0; i < sorted.length; i += 1) {
        const item = sorted[i];
        if (!taken[i] && item) out.push(item);
      }
      return out;
    }
    taken[pick] = true;
    indegree[pick] = -1;
    const item = sorted[pick];
    if (item) out.push(item);
    for (const next of edges[pick] ?? []) indegree[next] = (indegree[next] ?? 0) - 1;
  }
  return out;
}

// --- The runtime ------------------------------------------------------------

export interface PluginRuntime {
  /**
   * Read the directory, validate the manifests, activate what is enabled.
   * Idempotent: calling it again is a reload.
   */
  load(): Promise<void>;
  /** Everything found, the broken ones included. */
  list(): PluginStatus[];
  /** The ones that would act on this URL — the answer the download window needs. */
  applicableTo(url: string): PluginStatus[];
  enable(name: string): Promise<Result<PluginStatus, string>>;
  disable(name: string): Promise<Result<PluginStatus, string>>;
  /**
   * One plugin's declared settings, resolved through every layer.
   *
   * ⚠️ **Secret values are present here.** This is the runtime, not the wire —
   * `plugin-settings.ts`'s `redact()` is what the API calls, and it is the only
   * thing allowed to answer a browser.
   */
  settings(name: string): Result<ResolvedSetting[], string>;
  /**
   * Store values for a plugin and put them into effect.
   *
   * A key set to `null` — or to a blank string — is **cleared**, which is the
   * revert button: the layer below (the environment, or the manifest's default)
   * becomes the answer again, unchanged, because nothing here ever wrote to it.
   *
   * 🔴 It reloads. `setup()` reads `config` once, when it runs, so a plugin
   * whose token changed is a plugin that has to be set up again — and a partial
   * re-activation would leave its old provider wrapper in a registry that has
   * no `unregister`. A full reload is the only path that is correct for
   * providers, hooks and `setup` at the same time.
   */
  saveSettings(name: string, patch: Record<string, string | null>): Promise<Result<ResolvedSetting[], string>>;
  /**
   * Fire a lifecycle point.
   *
   * Transforming hooks are awaited in order and may replace the value; a throw
   * ends the chain as `PluginHookFailed`. Observing hooks are started and left
   * to run — the returned promise never waits for them, and never fails on them.
   */
  run<P extends HookPoint>(at: P, ...args: HookArgs[P]): Promise<Result<HookOutcome[P], PluginHookFailed>>;
  /**
   * The same, with a per-download opt-out.
   *
   * 🔴 `skip` can only ever take a plugin **away**. There is no "run this one
   * anyway": a plugin that is off server-wide was never activated, its
   * `setup()` never ran and its hooks were never registered, so there is
   * nothing to dispatch to. Offering the other direction would be a switch that
   * moves and changes nothing — the failure this codebase has already paid for
   * twice (`MAX_CONCURRENT_DOWNLOADS`, `LOG_LEVEL`).
   *
   * Names that match no plugin are ignored rather than rejected: a job carries
   * its exclusions for as long as it exists, and a plugin can be deleted while
   * a job that opted out of it is still queued.
   */
  runWith<P extends HookPoint>(
    skip: readonly string[],
    at: P,
    ...args: HookArgs[P]
  ): Promise<Result<HookOutcome[P], PluginHookFailed>>;
  /** Resolves once every observer started so far has settled. For tests and shutdown. */
  observersIdle(): Promise<void>;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  const dir = options.dir;
  const stateFile = options.stateFile ?? join(dirname(dir), "plugin-state.json");
  const sink = options.registry;
  const baseConfig = options.config ?? ({ ...process.env } as Record<string, unknown>);
  const settingsStore = options.settings ?? memoryPluginSettings();
  const sinkLog = options.log ?? ((line: string) => console.log(line));
  const defaultEnabled = options.defaultEnabled ?? true;
  const logLimit = options.logLimit ?? 100;

  const entries = new Map<string, Entry>();
  const hooks = new Map<HookPoint, HookRecord[]>();
  let persisted: PersistedState = {};
  let generation = 0;
  /** In-flight observers. Each already swallowed its failure, so awaiting these cannot reject. */
  let observers = new Set<Promise<void>>();

  const say = (line: string): void => sinkLog(`[plugins] ${line}`);

  const record = (entry: Entry, line: string): void => {
    entry.log.push(line);
    if (entry.log.length > logLimit) entry.log.splice(0, entry.log.length - logLimit);
  };

  /** The layers for one plugin, in one place — see `plugin-settings.ts` for the order. */
  const layersFor = (name: string) => ({
    environment: baseConfig,
    file: persisted.plugins?.[name]?.config,
    stored: settingsStore.read(name),
  });

  const resolvedFor = (manifest: PluginManifest): ResolvedSetting[] =>
    resolveSettings(manifest.settings, layersFor(manifest.name));

  const statusOf = (entry: Entry): PluginStatus => ({
    ...manifestOf(entry.manifest),
    file: entry.file,
    enabled: entry.enabled,
    state: entry.state,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    log: [...entry.log],
    providers: [...entry.providers],
    missingSettings: resolvedFor(entry.manifest)
      .filter((setting) => setting.required === true && !setting.configured)
      .map((setting) => setting.key),
  });

  // --- persistence ---

  async function readState(): Promise<void> {
    try {
      const raw = await readFile(stateFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      persisted =
        isRecord(parsed) && isRecord(parsed.plugins)
          ? { plugins: parsed.plugins as Record<string, PersistedPlugin> }
          : {};
    } catch {
      // No file, or one we cannot read: everything takes its default. Not worth
      // failing a boot over — the worst case is a plugin the user turned off
      // coming back on, and that is visible in the UI.
      persisted = {};
    }
  }

  async function writeState(): Promise<void> {
    const plugins: Record<string, PersistedPlugin> = { ...(persisted.plugins ?? {}) };
    for (const [name, entry] of entries) {
      if (entry.plugin) plugins[name] = { ...(plugins[name] ?? {}), enabled: entry.enabled };
    }
    persisted = { plugins };
    try {
      await writeFile(stateFile, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    } catch (cause) {
      say(`could not persist plugin state to ${stateFile}: ${describe(cause)}`);
    }
  }

  // --- capability injection ---

  function deniedFetch(name: string): typeof globalThis.fetch {
    const denied = (): never => {
      throw new Error(
        `plugin "${name}" called fetch without declaring the "network" capability (add needs: ["network"])`,
      );
    };
    return denied as unknown as typeof globalThis.fetch;
  }

  function apiFor(entry: Entry, plugin: Plugin): PluginApi {
    const declared = new Map<HookPoint, HookDeclaration>();
    for (const hook of plugin.hooks ?? []) {
      if (!declared.has(hook.at)) declared.set(hook.at, hook);
      else record(entry, `two hooks declared at ${hook.at}; the first one wins`);
    }
    const wants = new Set<Capability>(plugin.needs ?? []);
    let order = 0;

    return {
      on<P extends HookPoint>(at: P, fn: HookSignatures[P]): void {
        const declaration = declared.get(at);
        // The kind lives only in the declaration, so an undeclared hook is one
        // the runtime literally cannot run: it does not know whether a failure
        // should fail the job. Refusing is the only honest answer, and it is
        // what keeps `hooks` a description of what the plugin really does.
        if (!declaration) {
          record(entry, `refused a hook at ${at}: not declared in the manifest`);
          return;
        }
        if (typeof fn !== "function") {
          record(entry, `refused a hook at ${at}: not a function`);
          return;
        }
        const list = hooks.get(at) ?? [];
        list.push({
          plugin: plugin.name,
          at,
          kind: declaration.kind,
          fn: fn as unknown as (...args: unknown[]) => unknown,
          base: entry.seat * 1_000 + order,
          ...(declaration.before !== undefined ? { before: declaration.before } : {}),
          ...(declaration.after !== undefined ? { after: declaration.after } : {}),
        });
        order += 1;
        hooks.set(at, orderHooks(list));
      },

      addProvider(provider: Provider): void {
        if (!sink) {
          record(entry, "addProvider is not available: this runtime has no provider registry");
          return;
        }
        if (typeof provider?.name !== "string" || typeof provider?.supports !== "function") {
          record(entry, "refused a provider: it does not look like a Provider");
          return;
        }
        // Wrapped rather than handed over raw. A registry has no `unregister`,
        // so this wrapper is what makes disabling a plugin — or reloading over
        // it — actually stop its provider claiming URLs.
        sink.register({
          ...provider,
          supports: (url: string) => (entry.enabled && entry.live ? provider.supports(url) : false),
        });
        entry.providers.push(provider.name);
      },

      fetch: wants.has("network") ? globalThis.fetch.bind(globalThis) : deniedFetch(plugin.name),

      log(line: string): void {
        record(entry, line);
        say(`${plugin.name}: ${line}`);
      },

      /**
       * ⚠️ Four layers, and `plugin-settings.ts` owns the order: what was typed
       * into Settings beats the `config` block in `plugin-state.json`, which
       * beats the environment, which beats the manifest's own `default`. The
       * whole environment still travels, because a plugin may read a variable
       * its manifest never mentions — and nothing here is a sandbox that could
       * stop it if it did (`plugins/README.md`).
       */
      config: Object.freeze(resolveConfig(plugin.settings, layersFor(plugin.name))),
    };
  }

  function dropHooksOf(name: string): void {
    for (const [at, list] of hooks) hooks.set(at, list.filter((hook) => hook.plugin !== name));
  }

  async function activate(entry: Entry): Promise<void> {
    const plugin = entry.plugin;
    if (!plugin || entry.activated) return;
    try {
      await plugin.setup(apiFor(entry, plugin));
      entry.activated = true;
      entry.state = "active";
      delete entry.error;
    } catch (cause) {
      // A half-registered plugin is worse than none: its hooks would run
      // against state its own setup never finished building.
      dropHooksOf(plugin.name);
      entry.activated = false;
      entry.enabled = false;
      entry.state = "error";
      entry.error = `setup failed: ${describe(cause)}`;
      record(entry, entry.error);
      say(`${plugin.name}: ${entry.error}`);
    }
  }

  // --- discovery ---

  async function candidates(): Promise<string[]> {
    try {
      const found = await readdir(dir, { withFileTypes: true });
      return found
        .filter((item) => !item.isDirectory())
        .map((item) => item.name)
        .filter((name) => !name.startsWith(".") && !name.startsWith("_"))
        .filter((name) => !name.endsWith(".d.ts") && !name.includes(".test."))
        .filter((name) => LOADABLE.some((ext) => name.endsWith(ext)))
        .sort();
    } catch {
      // No directory at all is the normal state of a fresh install, not a failure.
      return [];
    }
  }

  /**
   * Import a plugin file through a copy nobody else can see.
   *
   * See `RELOAD_PREFIX`. The copy is removed whether the import succeeded or
   * threw — a syntax error must not leave a file behind, since a crash between
   * the two would leave one for ever.
   */
  async function importThrough(file: string): Promise<unknown> {
    const shadowName = `${RELOAD_PREFIX}${generation}-${file}`;
    const shadow = join(dir, shadowName);
    await copyFile(join(dir, file), shadow);
    try {
      const module = (await import(pathToFileURL(shadow).href)) as Record<string, unknown>;
      return module.default ?? module.plugin;
    } finally {
      await rm(shadow, { force: true }).catch(() => undefined);
    }
  }

  /** Leftovers from a process that died mid-load. Invisible to the loader, but not to `ls`. */
  async function sweepShadows(): Promise<void> {
    try {
      const stale = (await readdir(dir)).filter((name) => name.startsWith(RELOAD_PREFIX));
      await Promise.all(stale.map((name) => rm(join(dir, name), { force: true }).catch(() => undefined)));
    } catch {
      // No directory. `candidates()` already treats that as the normal state of
      // a fresh install rather than a failure.
    }
  }

  /**
   * A file that could not become a plugin still gets a row.
   *
   * Skipping it silently is how someone spends an evening wondering why their
   * plugin does nothing, so it is listed by filename with the reason attached.
   */
  function broken(file: string, reason: string): void {
    const name = file.replace(/\.[^.]+$/, "");
    const key = entries.has(name) ? `${name} (${file})` : name;
    entries.set(key, {
      manifest: { name: key, description: "This file could not be loaded as a plugin." },
      file,
      enabled: false,
      state: "error",
      error: reason,
      log: [reason],
      providers: [],
      seat: entries.size,
      activated: false,
      live: true,
    });
    say(`${file}: ${reason}`);
  }

  async function load(): Promise<void> {
    generation += 1;
    // The old entries stay referenced by any provider wrapper already in the
    // registry. Marking them dead is what retires those wrappers.
    for (const entry of entries.values()) entry.live = false;
    entries.clear();
    hooks.clear();
    observers = new Set();

    await readState();
    await sweepShadows();

    for (const file of await candidates()) {
      let exported: unknown;
      try {
        exported = await importThrough(file);
      } catch (cause) {
        // A syntax error, a bad import, a throw at the top level. Recorded
        // against the file and skipped: one broken plugin does not stop a boot.
        //
        // The message is rewritten back to the real filename: it is the one the
        // user typed and the one the editor opens, and naming an internal copy
        // in an error about their code would be a small, pointless mystery.
        const detail = describe(cause).replaceAll(`${RELOAD_PREFIX}${generation}-${file}`, file);
        broken(file, `could not be imported: ${detail}`);
        continue;
      }

      const validated = validatePlugin(exported);
      if (Result.isError(validated)) {
        broken(file, validated.error);
        continue;
      }
      const plugin = validated.value;

      const clash = entries.get(plugin.name);
      if (clash) {
        broken(file, `the name "${plugin.name}" is already used by ${clash.file}`);
        continue;
      }

      const wanted = persisted.plugins?.[plugin.name]?.enabled ?? defaultEnabled;
      const entry: Entry = {
        manifest: plugin,
        plugin,
        file,
        enabled: wanted,
        state: wanted ? "active" : "disabled",
        log: [],
        providers: [],
        seat: entries.size,
        activated: false,
        live: true,
      };
      entries.set(plugin.name, entry);
      // Only now, and only if the user wants it: reading the manifest above
      // ran none of this plugin's own logic.
      if (wanted) await activate(entry);
    }

    const failed = [...entries.values()].filter((entry) => entry.state === "error").length;
    say(`loaded ${entries.size - failed} plugin(s) from ${dir}${failed > 0 ? `, ${failed} broken` : ""}`);
  }

  // --- dispatch ---

  function urlOf(at: HookPoint, args: unknown[]): string | null {
    if (at === "url:resolve") return typeof args[0] === "string" ? args[0] : null;
    if (at === "probe:complete") return (args[1] as DownloadPlan | undefined)?.url ?? null;
    return (args[0] as Job | undefined)?.url ?? null;
  }

  function eligible(at: HookPoint, url: string | null, skip: readonly string[] = []): HookRecord[] {
    return (hooks.get(at) ?? []).filter((hook) => {
      const entry = entries.get(hook.plugin);
      if (!entry || !entry.enabled || !entry.live) return false;
      // 🔴 The per-download opt-out. Applied *here*, with the server-wide
      // checks, so there is exactly one place that decides whether a hook runs
      // — a second gate somewhere downstream is how "off" comes to mean
      // different things at different lifecycle points.
      if (skip.includes(hook.plugin)) return false;
      // `matches` is the same declaration the UI showed. If it did not claim
      // this URL there, it does not get to act on it here.
      return url === null || manifestMatches(entry.manifest, url);
    });
  }

  function observe(hook: HookRecord, args: unknown[]): void {
    const done = (async () => {
      try {
        await hook.fn(...args);
      } catch (cause) {
        // The rule, and the reason the two kinds exist. An observer's failure
        // is a log line and nothing else: the video is downloaded and correct,
        // and failing the job over it would be a lie.
        const entry = entries.get(hook.plugin);
        const line = `observer at ${hook.at} failed: ${describe(cause)}`;
        if (entry) record(entry, line);
        say(`${hook.plugin}: ${line}`);
      }
    })();
    observers.add(done);
    void done.finally(() => observers.delete(done));
  }

  async function runWith<P extends HookPoint>(
    skip: readonly string[],
    at: P,
    ...args: HookArgs[P]
  ): Promise<Result<HookOutcome[P], PluginHookFailed>> {
    const current = [...args] as unknown[];
    const selected = eligible(at, urlOf(at, current), skip);

    // Started first, and never awaited: an observer must not delay the pipeline
    // any more than it can fail it. Each gets its own copy of the arguments so
    // a later transform cannot change what it was handed.
    for (const hook of selected) {
      if (hook.kind === "observe") observe(hook, [...current]);
    }

    for (const hook of selected) {
      if (hook.kind !== "transform") continue;
      let produced: unknown;
      try {
        produced = await hook.fn(...current);
      } catch (cause) {
        return Result.err(new PluginHookFailed({ plugin: hook.plugin, at, detail: describe(cause) }));
      }
      // Returning nothing means "unchanged" — the common case for a transform
      // that only inspects, and the reason an accidental `undefined` cannot
      // wipe out a URL or a plan.
      if (at === "url:resolve" && typeof produced === "string" && produced !== "") current[0] = produced;
      if (at === "probe:complete" && isRecord(produced)) current[1] = produced;
    }

    if (at === "url:resolve") return Result.ok(current[0] as HookOutcome[P]);
    if (at === "probe:complete") return Result.ok(current[1] as HookOutcome[P]);
    return Result.ok(undefined as HookOutcome[P]);
  }

  async function setEnabled(name: string, enabled: boolean): Promise<Result<PluginStatus, string>> {
    const entry = entries.get(name);
    if (!entry) return Result.err(`no plugin named "${name}"`);
    if (!entry.plugin) {
      return Result.err(`"${name}" failed to load and cannot be enabled: ${entry.error ?? "unknown reason"}`);
    }

    entry.enabled = enabled;
    if (enabled) {
      await activate(entry);
      if (entry.state !== "error") entry.state = "active";
    } else {
      // The hooks stay registered and dispatch filters on `enabled`. Re-enabling
      // is then instant and does not run `setup` twice, which a plugin holding a
      // timer or a connection would not survive.
      entry.state = "disabled";
    }
    await writeState();
    return Result.ok(statusOf(entry));
  }

  return {
    load,

    list: () => [...entries.values()].map(statusOf),

    applicableTo: (url: string) =>
      [...entries.values()]
        .filter((entry) => entry.state !== "error" && manifestMatches(entry.manifest, url))
        .map(statusOf),

    enable: (name: string) => setEnabled(name, true),
    disable: (name: string) => setEnabled(name, false),

    settings: (name: string) => {
      const entry = entries.get(name);
      if (!entry) return Result.err(`no plugin named "${name}"`);
      return Result.ok(resolvedFor(entry.manifest));
    },

    saveSettings: async (name: string, patch: Record<string, string | null>) => {
      const entry = entries.get(name);
      if (!entry) return Result.err(`no plugin named "${name}"`);
      const declared = entry.manifest.settings ?? [];
      // A key nobody declared is refused rather than stored. Storing it would
      // put a value in the database that no form ever shows again, which is how
      // a typo in a key becomes an hour of "the plugin ignores my setting".
      const known = new Set(declared.map((setting) => setting.key));
      const unknown = Object.keys(patch).filter((key) => !known.has(key));
      if (unknown.length > 0) {
        return Result.err(`"${name}" declares no setting called ${unknown.map((k) => `"${k}"`).join(", ")}`);
      }
      settingsStore.write(name, applyPatch(settingsStore.read(name), patch));
      await load();
      const reloaded = entries.get(name);
      // The reload can legitimately lose it: someone deleted the file between
      // the two lines. Answering with the values that were saved anyway would
      // describe a plugin that is no longer there.
      if (!reloaded) return Result.err(`no plugin named "${name}"`);
      return Result.ok(resolvedFor(reloaded.manifest));
    },

    run: (at, ...args) => runWith([], at, ...args),
    runWith,

    observersIdle: async () => {
      // Every promise here already swallowed its own failure, so this cannot
      // reject. Looped, because an observer may start another one.
      while (observers.size > 0) await Promise.all([...observers]);
    },
  };
}

/** The plugins directory for a data directory — one place that knows the layout. */
export function pluginsDir(dataDir: string): string {
  return join(dataDir, "plugins");
}
