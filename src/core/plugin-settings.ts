/**
 * Where a plugin's configuration comes from, and in what order.
 *
 * A plugin used to read `config` and get the process environment. That is one
 * layer, it is invisible from the UI, and changing it means editing a compose
 * file and restarting. Now there are four, and **this module is the single
 * author of the order**: the runtime builds `config` from it, the API renders
 * the form from it, and the "revert to the environment value" button is exactly
 * "delete the top layer and ask again".
 *
 * ```
 *   stored        the value typed into Settings          ← wins
 *   file          the `config` block in plugin-state.json
 *   environment   the process environment (PLAN §12)
 *   default       what the plugin's own manifest declares ← loses
 * ```
 *
 * 🔴 **`stored` above `environment` is the requirement, not an accident.** The
 * point of the form is to override a variable without editing the deployment —
 * and the point of the revert button is that the variable is still down there,
 * unchanged, waiting. Nothing here ever writes to the environment.
 *
 * ⚠️ **Blank is unset.** An environment variable set to the empty string is how
 * a compose file says "I am not setting this", and treating it as a value would
 * mean a `default` that never applies and a form that reports a value nobody
 * typed. Every layer is filtered through `isBlank` on the way in.
 *
 * ⚠️ **Secrets are redacted here, not at the route.** `redact()` is what the API
 * calls, so there is one place that decides a secret never leaves the server —
 * the same rule the cookies file follows (PLAN §12). A secret's *presence* is
 * reported, because "is this configured?" is a question the form has to answer.
 */
import type { PluginSetting } from "./plugins";

/** Which layer a value came from. `unset` means the plugin will not be told anything. */
export type SettingSource = "stored" | "file" | "environment" | "default" | "unset";

/** The layers, lowest priority last. `default` is not here: it lives on the declaration. */
export interface SettingLayers {
  /** Written by the UI. The only layer anything in this codebase writes. */
  stored?: Record<string, unknown>;
  /** The hand-edited `config` block in `DATA_DIR/plugin-state.json`. */
  file?: Record<string, unknown>;
  /** The process environment, or whatever the runtime was handed instead. */
  environment?: Record<string, unknown>;
}

/**
 * One setting, resolved — what the form draws a row from.
 *
 * `value` is deliberately optional rather than nullable: a secret has no
 * `value` field at all, so a component that forgets to check `secret` renders
 * nothing instead of rendering `undefined`.
 */
export interface ResolvedSetting extends PluginSetting {
  source: SettingSource;
  /** Absent when the setting is a secret, or when nothing is set. */
  value?: string;
  /** True when *something* is set. The only thing a secret reports. */
  configured: boolean;
  /**
   * What this setting would fall back to if the stored value were cleared.
   *
   * 🔴 This is what decides whether the revert button is offered. Offering
   * "use the environment value" where there is no environment value is a
   * button that silently empties the field.
   */
  fallback: SettingSource;
  /** The fallback's value, unless it is a secret. Shown as "the environment says …". */
  fallbackValue?: string;
}

/** An empty string is not a value — see the header. */
export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function text(value: unknown): string | undefined {
  if (isBlank(value)) return undefined;
  return typeof value === "string" ? value.trim() : String(value);
}

interface Found {
  source: SettingSource;
  value?: string;
}

/** The order, written once. Everything else in this file calls it. */
function lookup(key: string, layers: SettingLayers, fallbackDefault: string | undefined, skipStored: boolean): Found {
  if (!skipStored) {
    const stored = text(layers.stored?.[key]);
    if (stored !== undefined) return { source: "stored", value: stored };
  }
  const file = text(layers.file?.[key]);
  if (file !== undefined) return { source: "file", value: file };
  const env = text(layers.environment?.[key]);
  if (env !== undefined) return { source: "environment", value: env };
  const declared = text(fallbackDefault);
  if (declared !== undefined) return { source: "default", value: declared };
  return { source: "unset" };
}

/**
 * The config a plugin is handed.
 *
 * ⚠️ It is the whole environment plus the declared settings, not the declared
 * settings alone. Narrowing it to the manifest would break every plugin that
 * reads a variable it never declared — including the two-name fallback in
 * `jellyfin.ts` — and the manifest is a description of what a plugin *needs*,
 * not a list of what it is allowed to see. There is no sandbox here to enforce
 * such a list anyway (`plugins/README.md`).
 */
export function resolveConfig(
  declared: readonly PluginSetting[] | undefined,
  layers: SettingLayers,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(layers.environment ?? {}) };
  for (const setting of declared ?? []) {
    const found = lookup(setting.key, layers, setting.default, false);
    if (found.value === undefined) delete out[setting.key];
    else out[setting.key] = found.value;
  }
  // Undeclared keys from the two writable layers still travel: a plugin may
  // read something its manifest does not mention, and dropping it silently is
  // the failure this project exists to avoid.
  for (const layer of [layers.file, layers.stored]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (!isBlank(value)) out[key] = text(value);
    }
  }
  return out;
}

/** Every declared setting, resolved, with secrets still carrying their values. */
export function resolveSettings(
  declared: readonly PluginSetting[] | undefined,
  layers: SettingLayers,
): ResolvedSetting[] {
  return (declared ?? []).map((setting) => {
    const found = lookup(setting.key, layers, setting.default, false);
    const under = lookup(setting.key, layers, setting.default, true);
    return {
      ...setting,
      source: found.source,
      ...(found.value !== undefined ? { value: found.value } : {}),
      configured: found.value !== undefined,
      fallback: under.source,
      ...(under.value !== undefined ? { fallbackValue: under.value } : {}),
    };
  });
}

/**
 * The same list with every secret's value removed.
 *
 * 🔴 The one function the API is allowed to answer with. `configured` and
 * `source` survive — the form has to be able to say "a token is set, and it
 * came from the environment" — and the string itself never crosses the wire.
 */
export function redact(settings: readonly ResolvedSetting[]): ResolvedSetting[] {
  return settings.map((setting) => {
    if (setting.secret !== true) return { ...setting };
    const { value, fallbackValue, default: declaredDefault, ...rest } = setting;
    void value;
    void fallbackValue;
    void declaredDefault;
    return { ...rest };
  });
}

/**
 * A manifest's own declarations, with a secret's `default` removed.
 *
 * ⚠️ Small and easy to skip, and it is the hole the obvious version leaves: a
 * plugin that declares `{ secret: true, default: "hunter2" }` would publish that
 * string through `GET /api/plugins` even though `redact()` keeps it out of the
 * settings endpoint. The same rule has to hold on every route that echoes a
 * manifest, so it is a function rather than a line in one handler.
 */
export function redactDeclarations(declared: readonly PluginSetting[] | undefined): PluginSetting[] | undefined {
  if (declared === undefined) return undefined;
  return declared.map((setting) => {
    if (setting.secret !== true) return { ...setting };
    const { default: declaredDefault, ...rest } = setting;
    void declaredDefault;
    return { ...rest };
  });
}

/**
 * Where the UI's values are kept, behind an interface.
 *
 * Synchronous because the implementation is `bun:sqlite`, which is, and because
 * the runtime builds a plugin's `config` inside a synchronous `setup` call. An
 * async store here would push a promise into the one place that cannot await.
 *
 * ⚠️ **Stored in plain text**, in the same database as everything else. That is
 * the honest state of it: a token in `DATA_DIR/casatube.db` is exactly as
 * exposed as the same token in a compose file, and pretending otherwise with a
 * reversible obfuscation would be worse than saying so.
 */
export interface PluginSettingsStore {
  /** What the UI has stored for this plugin. Never defaults, never the environment. */
  read(plugin: string): Record<string, string>;
  /** A full replacement. An absent key is a cleared key — that is the revert button. */
  write(plugin: string, values: Record<string, string>): void;
}

/** For tests, and for any runtime standing up without a database. */
export function memoryPluginSettings(initial: Record<string, Record<string, string>> = {}): PluginSettingsStore {
  const held = new Map<string, Record<string, string>>(Object.entries(initial));
  return {
    read: (plugin) => ({ ...(held.get(plugin) ?? {}) }),
    write: (plugin, values) => void held.set(plugin, { ...values }),
  };
}

/**
 * Apply a patch to what is stored, and answer with the whole new record.
 *
 * `null` clears a key — that is the revert button, expressed as one round trip
 * rather than a second endpoint. Blank strings clear too, because a form field
 * someone emptied means the same thing as a field they never filled.
 */
export function applyPatch(
  current: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next: Record<string, string> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || isBlank(value)) delete next[key];
    else next[key] = value.trim();
  }
  return next;
}
