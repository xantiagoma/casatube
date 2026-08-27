/**
 * The plugins that come with CasaTube, and how they get into your directory.
 *
 * ## Why they are copied rather than loaded from where they ship
 *
 * A built-in loaded from inside the image would be one you can read and not
 * change: the editor could open it and every save would be lost on the next
 * `docker pull`. Copying them into `DATA_DIR/plugins/` makes them **yours** —
 * one loading path, one directory, editable, deletable, and backed up with the
 * rest of the data directory.
 *
 * ## The four cases, because "ship a default file" has more than one
 *
 * The seed record — a filename → SHA-256 of exactly what we last wrote — is
 * what tells them apart. Without it, every one of these is indistinguishable
 * from the others:
 *
 * | On disk | Recorded | What happens | Why |
 * |---|---|---|---|
 * | missing | never seeded | **written** | a fresh install, or a new built-in in an upgrade |
 * | missing | seeded | left alone | you deleted it, and it must stay deleted |
 * | unchanged since we wrote it | matches | **rewritten if it shipped changed** | you never touched it, so an upgrade reaches you |
 * | changed | differs | left alone, and **said out loud** | your edits win; a silent overwrite is the worst outcome here |
 *
 * 🔴 The fourth row is the one that decides the design. Overwriting an edited
 * plugin would delete someone's work with no error and no trace — and the last
 * row's log line is the difference between "the upgrade did not reach my copy"
 * being discoverable and being a mystery.
 *
 * ⚠️ The sources live under `src/`, not in the repository's `plugins/` folder,
 * for the reason `docs/DISCOVERIES.md` records: the image copies `src`,
 * `drizzle` and two JSON files, and nothing else. A seeder reading
 * `plugins/jellyfin.ts` would work perfectly in development and find nothing in
 * the only deployment anyone runs.
 */
import { Result } from "better-result";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { writePluginFile } from "./plugin-files";

/** Where the shipped sources are, relative to this file. Inside `src`, so inside the image. */
const BUILTIN_DIR = join(import.meta.dir, "../plugins/builtin");

export interface BuiltinPlugin {
  file: string;
  source: string;
  sha: string;
}

export function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** The shipped plugins, read from `src/plugins/builtin`. */
export async function readBuiltins(dir: string = BUILTIN_DIR): Promise<BuiltinPlugin[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".ts") && !name.includes(".test."));
  } catch {
    // No directory means a build that did not ship them. An empty list is the
    // truthful answer; refusing to boot over it would be worse.
    return [];
  }
  return Promise.all(
    names.sort().map(async (file) => {
      const source = await readFile(join(dir, file), "utf8");
      return { file, source, sha: sha256(source) };
    }),
  );
}

export type SeedAction = "written" | "updated" | "kept-yours" | "kept-deleted" | "unchanged" | "failed";

export interface SeedOutcome {
  file: string;
  action: SeedAction;
  detail?: string;
}

/** The record: filename → the SHA-256 of what the seeder last wrote there. */
export type SeedRecord = Record<string, string>;

export interface SeedResult {
  outcomes: SeedOutcome[];
  /** The record to persist. Callers write it; this function stays free of storage. */
  record: SeedRecord;
}

/**
 * Put the built-ins in place, honouring what is already there.
 *
 * Pure with respect to storage — it is handed the previous record and answers
 * with the next one — so the whole table above is testable without a database.
 */
export async function seedBuiltins(
  dir: string,
  previous: SeedRecord,
  builtins?: BuiltinPlugin[],
): Promise<SeedResult> {
  const shipped = builtins ?? (await readBuiltins());
  const record: SeedRecord = { ...previous };
  const outcomes: SeedOutcome[] = [];

  if (shipped.length > 0) await mkdir(dir, { recursive: true }).catch(() => undefined);

  for (const builtin of shipped) {
    const target = join(dir, builtin.file);
    const recorded = previous[builtin.file];

    let existing: string | undefined;
    try {
      await stat(target);
      existing = await readFile(target, "utf8");
    } catch {
      existing = undefined;
    }

    if (existing === undefined) {
      if (recorded !== undefined) {
        // Seeded once, and not there now. Somebody deleted it, and putting it
        // back every boot is the single most annoying thing this could do.
        outcomes.push({ file: builtin.file, action: "kept-deleted" });
        continue;
      }
      const written = await writePluginFile(dir, builtin.file, builtin.source);
      if (Result.isError(written)) {
        outcomes.push({ file: builtin.file, action: "failed", detail: written.error });
        continue;
      }
      record[builtin.file] = builtin.sha;
      outcomes.push({ file: builtin.file, action: "written" });
      continue;
    }

    const current = sha256(existing);
    if (current === builtin.sha) {
      // Byte-identical to what ships. Record it even if it was not recorded —
      // a directory restored from a backup taken before the record existed is
      // otherwise frozen at "kept-yours" for ever.
      record[builtin.file] = builtin.sha;
      outcomes.push({ file: builtin.file, action: "unchanged" });
      continue;
    }

    if (recorded !== undefined && recorded === current) {
      // Untouched since we wrote it, and what ships has changed: this is an
      // upgrade, and it is allowed to land.
      const written = await writePluginFile(dir, builtin.file, builtin.source);
      if (Result.isError(written)) {
        outcomes.push({ file: builtin.file, action: "failed", detail: written.error });
        continue;
      }
      record[builtin.file] = builtin.sha;
      outcomes.push({ file: builtin.file, action: "updated" });
      continue;
    }

    outcomes.push({
      file: builtin.file,
      action: "kept-yours",
      detail: "edited here, so the version shipped with this build was not written over it",
    });
  }

  return { outcomes, record };
}

/** One line per file, for the boot log. Silence about a skipped upgrade is the thing to avoid. */
export function describeSeed(outcomes: readonly SeedOutcome[]): string[] {
  const words: Record<SeedAction, string> = {
    written: "installed",
    updated: "updated to the version in this build",
    "kept-yours": "left as you edited it",
    "kept-deleted": "stays deleted",
    unchanged: "unchanged",
    failed: "could not be written",
  };
  return outcomes
    // `unchanged` is the common case and says nothing worth reading at boot.
    .filter((outcome) => outcome.action !== "unchanged")
    .map((outcome) => `${outcome.file}: ${words[outcome.action]}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
}
