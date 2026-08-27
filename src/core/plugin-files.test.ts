/**
 * The plugins directory as files, which is what the editor writes through.
 *
 * The interesting assertions are all refusals. A filename this loader would
 * skip — `.hidden.ts`, `_draft.ts`, `thing.d.ts`, `a.test.ts` — is a file that
 * would be written successfully and then never appear anywhere, and "I saved it
 * and nothing happened" is the worst answer this screen could give.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkPluginFile,
  deletePluginFile,
  listPluginFiles,
  MAX_PLUGIN_BYTES,
  pluginFileExists,
  readPluginFile,
  writePluginFile,
} from "./plugin-files";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-plugin-files-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function reason(outcome: Result<string, string>): string {
  return Result.isError(outcome) ? outcome.error : "(accepted)";
}

describe("checkPluginFile", () => {
  test("accepts the names the loader actually loads", () => {
    for (const name of ["a.ts", "my-plugin.ts", "x.mts", "y.js", "z.mjs", "A1._-.ts"]) {
      expect(reason(checkPluginFile(name))).toBe("(accepted)");
    }
  });

  test("a path is refused with a message about paths, not about characters", () => {
    // 🔴 The order of the checks is the message. `../evil.ts` fails the pattern
    // too, and "must be letters and digits" would be a misleading answer to an
    // attempt to leave the directory.
    expect(reason(checkPluginFile("../evil.ts"))).toContain("cannot contain a path");
    expect(reason(checkPluginFile("sub/evil.ts"))).toContain("cannot contain a path");
    expect(reason(checkPluginFile("/etc/passwd"))).toContain("cannot contain a path");
  });

  test("names the loader skips are refused, with the reason they would be skipped", () => {
    expect(reason(checkPluginFile(".hidden.ts"))).toContain("would never be loaded");
    expect(reason(checkPluginFile("_draft.ts"))).toContain("would never be loaded");
    expect(reason(checkPluginFile("thing.d.ts"))).toContain(".d.ts");
    expect(reason(checkPluginFile("a.test.ts"))).toContain(".test.");
  });

  test("an extension nothing imports is refused", () => {
    expect(reason(checkPluginFile("readme.md"))).toContain("end in");
    expect(reason(checkPluginFile("noext"))).toContain("end in");
  });
});

describe("writing", () => {
  test("writes, reads back, and reports existence", async () => {
    expect(Result.isOk(await writePluginFile(dir, "a.ts", "export default {};"))).toBe(true);
    expect(await pluginFileExists(dir, "a.ts")).toBe(true);

    const read = await readPluginFile(dir, "a.ts");
    expect(Result.isOk(read) && read.value).toBe("export default {};");
  });

  test("leaves no temp file behind, and the temp name is one the loader skips", async () => {
    // ⚠️ The write is temp-then-rename so a reload cannot import a half-written
    // file. That only helps if the temp name is invisible to the loader, which
    // is why it starts with a dot.
    await writePluginFile(dir, "a.ts", "x".repeat(50_000));
    expect(readdirSync(dir)).toEqual(["a.ts"]);
  });

  test("a file bigger than the cap is refused rather than filling the disk", async () => {
    const huge = "x".repeat(MAX_PLUGIN_BYTES + 1);
    expect(reason(await writePluginFile(dir, "a.ts", huge))).toContain("limited to");
    expect(existsSync(join(dir, "a.ts"))).toBe(false);
  });

  test("a refused name never touches the filesystem", async () => {
    await writePluginFile(dir, "../escape.ts", "nope");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("reading and deleting", () => {
  test("a missing file says so, and says it differently from a bad name", async () => {
    // The two are told apart at the route, one as a 404 and one as a 400.
    expect(reason(await readPluginFile(dir, "gone.ts"))).toContain("there is no plugin file");
    expect(reason(await readPluginFile(dir, "../gone.ts"))).toContain("cannot contain a path");
  });

  test("delete removes it, and deleting twice is a clear answer rather than a silent success", async () => {
    writeFileSync(join(dir, "a.ts"), "export default {};");
    expect(Result.isOk(await deletePluginFile(dir, "a.ts"))).toBe(true);
    expect(existsSync(join(dir, "a.ts"))).toBe(false);
    expect(reason(await deletePluginFile(dir, "a.ts"))).toContain("there is no plugin file");
  });
});

describe("listing", () => {
  test("lists only what the loader would load, sorted", async () => {
    mkdirSync(join(dir, "sub"));
    for (const name of ["b.ts", "a.js", ".hidden.ts", "_x.ts", "notes.md", "t.d.ts"]) {
      writeFileSync(join(dir, name), "x");
    }
    expect((await listPluginFiles(dir)).map((file) => file.file)).toEqual(["a.js", "b.ts"]);
  });

  test("a directory that is not there is an empty list, not a failure", async () => {
    expect(await listPluginFiles(join(dir, "nope"))).toEqual([]);
  });
});

describe("what the file contains is not this module's business", () => {
  test("nonsense is written happily — the runtime is what reports it", async () => {
    // 🔴 Deliberate. Validating source here would mean a second, weaker parser
    // disagreeing with Bun's, and the failure someone needs to see is the one
    // the actual import produces.
    expect(Result.isOk(await writePluginFile(dir, "broken.ts", "export default { unclosed"))).toBe(true);
    expect(readFileSync(join(dir, "broken.ts"), "utf8")).toBe("export default { unclosed");
  });
});
