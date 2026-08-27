/**
 * The `settings` table, finally used.
 *
 * It has been in the schema since the first migration and nothing wrote to it,
 * because PLAN §12 puts *server* configuration in the environment and there is
 * no endpoint that writes an environment variable back. That is still true.
 * What goes in here is the other thing: state that belongs to **this
 * installation** rather than to the deployment — the values someone typed into
 * a plugin's form, and the record of which built-in plugins have already been
 * offered.
 *
 * A key/value table rather than a column per setting, because the keys are open
 * ended: a plugin nobody has written yet has settings nobody can add a column
 * for. `value` is JSON, so a record survives without a schema change.
 *
 * ⚠️ **Not encrypted.** A plugin's token lands here in plain text, in the same
 * file as the job history. It is exactly as exposed as the same token in a
 * compose file — which is where it lives today — and a reversible obfuscation
 * would only make it *look* protected. Backups of `DATA_DIR` contain
 * credentials; that is a fact about the directory, and it is written down here
 * rather than implied.
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "./db";
import type { PluginSettingsStore } from "./plugin-settings";
import { settings } from "./schema";

/**
 * A key/value store, synchronous.
 *
 * `bun:sqlite` is synchronous, and the two callers — a plugin's `setup()` and
 * the seeder at boot — are both places where a promise would have to be
 * awaited somewhere that cannot await. Making the interface honest about that
 * is cheaper than making every caller pretend.
 */
export interface SettingsStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

export function dbSettings(db: Db): SettingsStore {
  return {
    get<T>(key: string): T | undefined {
      const row = db.select().from(settings).where(eq(settings.key, key)).limit(1).all()[0];
      return row === undefined ? undefined : (row.value as T);
    },
    set(key: string, value: unknown): void {
      db.insert(settings)
        .values({ key, value })
        // One statement rather than a read and a write: two clients saving the
        // same plugin's form at once would otherwise race, and the loser's
        // values would vanish with no error anywhere.
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` },
        })
        .run();
    },
    remove(key: string): void {
      db.delete(settings).where(eq(settings.key, key)).run();
    },
  };
}

/** For tests and for an app assembled without a database. */
export function memorySettings(initial: Record<string, unknown> = {}): SettingsStore {
  const held = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T,>(key: string) => held.get(key) as T | undefined,
    set: (key, value) => void held.set(key, value),
    remove: (key) => void held.delete(key),
  };
}

/** One namespace, so a plugin called `builtins` cannot collide with the seed record. */
export function pluginSettingsKey(plugin: string): string {
  return `plugin.config:${plugin}`;
}

/** Which built-in plugin files have been written out, and what they contained. */
export const BUILTIN_SEED_KEY = "plugins.builtins";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The plugin-facing view of the same table.
 *
 * Values are coerced to strings on the way out: the column is JSON, so a
 * hand-edited row could hold a number, and a plugin that got `8096` where every
 * other layer gives it `"8096"` would be the exact inconsistency
 * `plugin-settings.ts` exists to prevent.
 */
export function pluginSettingsStore(store: SettingsStore): PluginSettingsStore {
  return {
    read(plugin: string): Record<string, string> {
      const raw = store.get<unknown>(pluginSettingsKey(plugin));
      if (!isRecord(raw)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value === null || value === undefined) continue;
        out[key] = typeof value === "string" ? value : String(value);
      }
      return out;
    },
    write(plugin: string, values: Record<string, string>): void {
      // An empty record is removed rather than stored: "this plugin has nothing
      // set" and "this plugin has an empty object" are the same fact, and only
      // one of them survives a `DELETE FROM settings` someone runs by hand.
      if (Object.keys(values).length === 0) store.remove(pluginSettingsKey(plugin));
      else store.set(pluginSettingsKey(plugin), values);
    },
  };
}
