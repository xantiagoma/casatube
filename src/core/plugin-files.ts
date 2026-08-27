/**
 * The plugins directory as a set of files you can create, read, replace and
 * delete — which is what an editor in the browser needs underneath it.
 *
 * Deliberately separate from the runtime. `plugin-runtime.ts` answers "what is
 * loaded and what does it do"; this answers "what is on disk". Keeping them
 * apart is what lets a *broken* file be edited: the runtime knows it as an
 * error row with a made-up name, and this module knows it as `broken.ts`, which
 * is the thing someone actually wants to open.
 *
 * 🔴 **A file is addressed by filename, never by plugin name.** A plugin whose
 * source does not parse has no name — the runtime invents one from the
 * filename — so a route keyed on the manifest could not reach exactly the file
 * that most needs fixing.
 *
 * ## The rules on a name, and why each one is a refusal rather than a fix
 *
 * The loader skips files starting with `.` or `_`, `.d.ts` files, and anything
 * with `.test.` in it. Silently correcting such a name would produce a file at
 * a path the author did not choose; accepting it would produce a plugin that
 * never loads and never says why. So both are refused, with the reason.
 */
import { Result } from "better-result";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Extensions the runtime imports. Restated as a value so the check is one regex. */
const EXTENSIONS = ["ts", "mts", "js", "mjs"] as const;

const NAME_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*\\.(${EXTENSIONS.join("|")})$`);

/**
 * Bigger than any plugin has a reason to be, and small enough that a paste
 * accident cannot fill the disk. A bundled plugin with a library in it is the
 * case that gets close, and `bun build` output for something like `dayjs` is
 * tens of kilobytes.
 */
export const MAX_PLUGIN_BYTES = 1_000_000;

/**
 * Is this a filename this directory will actually load?
 *
 * Returns the name unchanged on success so callers can use it as the one gate:
 * `const file = ok(checkPluginFile(input))` and nothing downstream re-checks.
 */
export function checkPluginFile(name: string): Result<string, string> {
  const trimmed = name.trim();
  if (trimmed === "") return Result.err("a plugin needs a filename");
  // Checked before the pattern so the message names the real problem: `../x.ts`
  // fails the pattern too, and "must be letters and digits" would be a
  // misleading answer to an attempt to leave the directory.
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return Result.err("a plugin filename cannot contain a path — it goes directly in the plugins directory");
  }
  if (trimmed.startsWith(".") || trimmed.startsWith("_")) {
    return Result.err(`"${trimmed}" would never be loaded: names starting with "." or "_" are skipped`);
  }
  if (trimmed.endsWith(".d.ts")) return Result.err(`"${trimmed}" would never be loaded: .d.ts files are skipped`);
  if (trimmed.includes(".test.")) {
    return Result.err(`"${trimmed}" would never be loaded: names containing ".test." are skipped`);
  }
  if (!NAME_RE.test(trimmed)) {
    return Result.err(`"${trimmed}" must be letters, digits, ".", "-" or "_" and end in ${EXTENSIONS.map((e) => `.${e}`).join(", ")}`);
  }
  return Result.ok(trimmed);
}

export interface PluginFile {
  file: string;
  bytes: number;
  modifiedAt: string;
}

/** What is in the directory, by the same rules the loader uses. Missing directory is empty. */
export async function listPluginFiles(dir: string): Promise<PluginFile[]> {
  let names: string[];
  try {
    const found = await readdir(dir, { withFileTypes: true });
    names = found.filter((item) => !item.isDirectory()).map((item) => item.name);
  } catch {
    return [];
  }
  const out: PluginFile[] = [];
  for (const name of names.sort()) {
    if (Result.isError(checkPluginFile(name))) continue;
    try {
      const info = await stat(join(dir, name));
      out.push({ file: name, bytes: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() });
    } catch {
      // It was there a moment ago. A file that vanished mid-listing is not an
      // error to report to a browser; it is simply not in the answer.
    }
  }
  return out;
}

export async function readPluginFile(dir: string, name: string): Promise<Result<string, string>> {
  const checked = checkPluginFile(name);
  if (Result.isError(checked)) return checked;
  try {
    return Result.ok(await readFile(join(dir, checked.value), "utf8"));
  } catch {
    return Result.err(`there is no plugin file called "${checked.value}"`);
  }
}

export async function pluginFileExists(dir: string, name: string): Promise<boolean> {
  const checked = checkPluginFile(name);
  if (Result.isError(checked)) return false;
  try {
    await stat(join(dir, checked.value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a plugin, atomically.
 *
 * 🔴 Temp file then `rename`, and the temp name starts with `.` so the loader
 * skips it. A plugin saved straight into place can be imported halfway written
 * — the runtime reloads on save, and "the file exists" is not "the file is
 * finished". That is the same mistake the HLS segment reader made, in a
 * different module, and it cost an afternoon there.
 */
export async function writePluginFile(dir: string, name: string, source: string): Promise<Result<string, string>> {
  const checked = checkPluginFile(name);
  if (Result.isError(checked)) return checked;
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_PLUGIN_BYTES) {
    return Result.err(`that is ${bytes} bytes; a plugin file is limited to ${MAX_PLUGIN_BYTES}`);
  }

  const target = join(dir, checked.value);
  const temp = join(dir, `.${checked.value}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, source, "utf8");
    await rename(temp, target);
    return Result.ok(checked.value);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined);
    return Result.err(`could not write ${checked.value}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function deletePluginFile(dir: string, name: string): Promise<Result<string, string>> {
  const checked = checkPluginFile(name);
  if (Result.isError(checked)) return checked;
  if (!(await pluginFileExists(dir, checked.value))) {
    return Result.err(`there is no plugin file called "${checked.value}"`);
  }
  try {
    // Unlinked, not moved to a trash. A plugin is source code; the version that
    // matters is the one in whatever the author keeps, and a second copy left
    // behind in the data directory is a credential in a file nobody remembers.
    await rm(join(dir, checked.value));
    return Result.ok(checked.value);
  } catch (cause) {
    return Result.err(`could not delete ${checked.value}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
