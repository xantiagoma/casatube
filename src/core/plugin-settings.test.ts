/**
 * Declared settings: the layer order, the redaction rule, and what actually
 * reaches a plugin's `config`.
 *
 * Two halves, deliberately. The first is against the pure functions, where the
 * whole table of layers can be exercised in a line each. The second stands up a
 * **real runtime over a real directory** and asserts that the plugin was handed
 * what the table says — because a resolution rule that is correct in isolation
 * and wired up wrongly is the same bug with a passing test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginRuntime, validatePlugin, type PluginRuntime } from "./plugin-runtime";
import {
  applyPatch,
  memoryPluginSettings,
  redact,
  redactDeclarations,
  resolveConfig,
  resolveSettings,
} from "./plugin-settings";
import type { PluginSetting } from "./plugins";

const TOKEN: PluginSetting = { key: "TOKEN", label: "Token", secret: true };
const URL_SETTING: PluginSetting = { key: "URL", label: "URL", default: "http://default.local" };

describe("the layer order", () => {
  test("stored beats the file, which beats the environment, which beats the default", () => {
    const layers = { stored: { URL: "a" }, file: { URL: "b" }, environment: { URL: "c" } };

    expect(resolveSettings([URL_SETTING], layers)[0]?.value).toBe("a");
    expect(resolveSettings([URL_SETTING], { file: layers.file, environment: layers.environment })[0]?.value).toBe("b");
    expect(resolveSettings([URL_SETTING], { environment: layers.environment })[0]?.value).toBe("c");
    expect(resolveSettings([URL_SETTING], {})[0]?.value).toBe("http://default.local");
  });

  test("each layer is named, because the form has to say where a value came from", () => {
    expect(resolveSettings([URL_SETTING], { stored: { URL: "a" } })[0]?.source).toBe("stored");
    expect(resolveSettings([URL_SETTING], { file: { URL: "b" } })[0]?.source).toBe("file");
    expect(resolveSettings([URL_SETTING], { environment: { URL: "c" } })[0]?.source).toBe("environment");
    expect(resolveSettings([URL_SETTING], {})[0]?.source).toBe("default");
    expect(resolveSettings([TOKEN], {})[0]?.source).toBe("unset");
  });

  test("blank is unset, so an empty variable does not shadow the default", () => {
    // ⚠️ `FOO=` in a compose file is how someone says "I am not setting this".
    // Treated as a value it would make every `default` unreachable in exactly
    // the deployments that need one.
    const resolved = resolveSettings([URL_SETTING], { environment: { URL: "   " } });
    expect(resolved[0]?.value).toBe("http://default.local");
    expect(resolved[0]?.source).toBe("default");
  });

  test("`fallback` answers what the revert button would do, without doing it", () => {
    const withEnv = resolveSettings([URL_SETTING], { stored: { URL: "typed" }, environment: { URL: "from-env" } })[0];
    expect(withEnv?.source).toBe("stored");
    // 🔴 The environment is untouched underneath. That is the whole promise of
    // the revert button, and this is the assertion that keeps it true.
    expect(withEnv?.fallback).toBe("environment");
    expect(withEnv?.fallbackValue).toBe("from-env");

    const nothingUnder = resolveSettings([TOKEN], { stored: { TOKEN: "typed" } })[0];
    expect(nothingUnder?.fallback).toBe("unset");
    expect(nothingUnder?.fallbackValue).toBeUndefined();
  });
});

describe("redaction", () => {
  test("a secret's value never survives `redact`, but its presence does", () => {
    const resolved = resolveSettings([TOKEN, URL_SETTING], { stored: { TOKEN: "hunter2", URL: "u" } });
    const out = redact(resolved);

    const token = out.find((setting) => setting.key === "TOKEN");
    expect(token?.configured).toBe(true);
    expect(token?.source).toBe("stored");
    expect(token?.value).toBeUndefined();
    expect(token?.fallbackValue).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("hunter2");

    // Non-secrets are untouched: the form cannot show what it is not given.
    expect(out.find((setting) => setting.key === "URL")?.value).toBe("u");
  });

  test("a secret's declared default is redacted too", () => {
    // ⚠️ The hole the obvious version leaves. `redact()` covers the settings
    // endpoint; the manifest travels on the *listing*, and a default written
    // into the declaration would have gone out with it.
    const declared = redactDeclarations([{ key: "TOKEN", label: "Token", secret: true, default: "hunter2" }]);
    expect(JSON.stringify(declared)).not.toContain("hunter2");
    expect(declared?.[0]?.key).toBe("TOKEN");
  });
});

describe("resolveConfig", () => {
  test("the whole environment travels, not only the declared keys", () => {
    // A plugin may read a variable its manifest never mentions — `jellyfin.ts`
    // reads MEDIA_SERVER_URL — and there is no sandbox here that could stop it.
    const config = resolveConfig([URL_SETTING], { environment: { OTHER: "kept", URL: "c" }, stored: { URL: "a" } });
    expect(config.OTHER).toBe("kept");
    expect(config.URL).toBe("a");
  });

  test("a declared setting with nothing anywhere is absent, not empty string", () => {
    const config = resolveConfig([TOKEN], { environment: { TOKEN: "" } });
    expect("TOKEN" in config).toBe(false);
  });
});

describe("applyPatch", () => {
  test("null clears, a blank string clears, a value sets", () => {
    expect(applyPatch({ A: "1", B: "2" }, { A: null })).toEqual({ B: "2" });
    expect(applyPatch({ A: "1" }, { A: "  " })).toEqual({});
    expect(applyPatch({ A: "1" }, { B: " x " })).toEqual({ A: "1", B: "x" });
  });
});

describe("the manifest gate covers settings too", () => {
  function reason(value: unknown): string {
    const outcome = validatePlugin(value);
    return Result.isError(outcome) ? outcome.error : "(accepted)";
  }

  const base = { name: "p", description: "d", setup() {} };

  test("a setting nobody could render is refused rather than shown as if it meant something", () => {
    expect(reason({ ...base, settings: [{ label: "x" }] })).toContain("plain identifier");
    expect(reason({ ...base, settings: [{ key: "A", label: "" }] })).toContain("needs a label");
    expect(reason({ ...base, settings: [{ key: "A", label: "a", type: "colour" }] })).toContain("unknown setting type");
    expect(reason({ ...base, settings: [{ key: "A", label: "a", type: "select" }] })).toContain("select with no options");
    expect(reason({ ...base, settings: [{ key: "A", label: "a", secret: "yes" }] })).toContain("must be true or false");
    expect(
      reason({ ...base, settings: [{ key: "A", label: "a" }, { key: "A", label: "b" }] }),
    ).toContain("declared twice");
  });

  test("a key that could not be an environment variable is refused", () => {
    // The environment is one of the layers, so a key with a dot in it is a key
    // the revert button could never mean anything for.
    expect(reason({ ...base, settings: [{ key: "a.b", label: "x" }] })).toContain("plain identifier");
    expect(reason({ ...base, settings: [{ key: "JELLYFIN_URL", label: "x" }] })).toBe("(accepted)");
  });
});

describe("against a real runtime", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "casatube-plugin-settings-"));
    dir = join(root, "plugins");
    mkdirSync(dir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A plugin that reports exactly what it was handed, so the assertion is on `config` itself. */
  function write(): void {
    writeFileSync(
      join(dir, "echo.ts"),
      `export default {
         name: "echo",
         description: "logs what it was configured with",
         settings: [
           { key: "URL", label: "URL", default: "http://default.local" },
           { key: "TOKEN", label: "Token", secret: true, required: true },
         ],
         hooks: [{ at: "job:completed", kind: "observe" }],
         setup({ on, log, config }) {
           log("URL=" + String(config.URL) + " TOKEN=" + String(config.TOKEN));
           on("job:completed", () => {});
         },
       };`,
      "utf8",
    );
  }

  async function boot(options: {
    environment?: Record<string, unknown>;
    stored?: Record<string, string>;
  }): Promise<PluginRuntime> {
    const runtime = createPluginRuntime({
      dir,
      stateFile: join(root, "plugin-state.json"),
      config: options.environment ?? {},
      settings: memoryPluginSettings(options.stored ? { echo: options.stored } : {}),
      log: () => {},
    });
    await runtime.load();
    return runtime;
  }

  test("the plugin receives the resolved value, not the environment one", async () => {
    write();
    const runtime = await boot({ environment: { URL: "http://from-env" }, stored: { URL: "http://typed-in-ui" } });
    expect(runtime.list()[0]?.log.join("\n")).toContain("URL=http://typed-in-ui");
  });

  test("the declared default reaches the plugin when nothing else does", async () => {
    write();
    const runtime = await boot({});
    expect(runtime.list()[0]?.log.join("\n")).toContain("URL=http://default.local");
  });

  test("saving a value re-runs setup with it — a reload, not a restart", async () => {
    write();
    const runtime = await boot({});
    expect(runtime.list()[0]?.log.join("\n")).toContain("TOKEN=undefined");

    const saved = await runtime.saveSettings("echo", { TOKEN: "hunter2" });
    expect(Result.isOk(saved)).toBe(true);

    // 🔴 The point of reloading on save. `setup` reads `config` once, so a
    // value that only landed in the store would never reach the plugin.
    expect(runtime.list()[0]?.log.join("\n")).toContain("TOKEN=hunter2");
  });

  test("clearing a stored value puts the environment back, untouched", async () => {
    write();
    const runtime = await boot({ environment: { URL: "http://from-env" }, stored: { URL: "http://typed-in-ui" } });

    await runtime.saveSettings("echo", { URL: null });
    expect(runtime.list()[0]?.log.join("\n")).toContain("URL=http://from-env");

    const resolved = runtime.settings("echo");
    expect(Result.isOk(resolved) ? resolved.value.find((setting) => setting.key === "URL")?.source : null).toBe(
      "environment",
    );
  });

  test("a required setting with nothing set is reported on the listing", async () => {
    write();
    const runtime = await boot({});
    // A plugin that is `active` and silently doing nothing is the failure this
    // field exists to make visible.
    expect(runtime.list()[0]?.state).toBe("active");
    expect(runtime.list()[0]?.missingSettings).toEqual(["TOKEN"]);

    await runtime.saveSettings("echo", { TOKEN: "x" });
    expect(runtime.list()[0]?.missingSettings).toEqual([]);
  });

  test("a key the plugin never declared is refused, not silently stored", async () => {
    write();
    const runtime = await boot({});
    const outcome = await runtime.saveSettings("echo", { NOPE: "x" });
    expect(Result.isError(outcome) && outcome.error).toContain("no setting called");
  });
});
