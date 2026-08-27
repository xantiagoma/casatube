/**
 * The plugin runtime, against **real plugin files in a real directory**.
 *
 * Stubbing the loader would be testing the wrong thing. The whole point of this
 * module is what happens when someone drops a file into `DATA_DIR/plugins/`, and
 * the cases that matter — a syntax error, a file that exports nothing, a
 * manifest with a hook point that does not exist — are things only a real
 * `import` produces. So every test here writes TypeScript to a temporary
 * directory and lets Bun import it, exactly as the running server would.
 *
 * The four rules being defended:
 *
 *  1. the manifest is readable without running the plugin,
 *  2. a transforming hook runs in declared order and its failure fails the job,
 *  3. an **observer can never fail a job**,
 *  4. a broken plugin does not take the load down with it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPluginRuntime,
  manifestMatches,
  patternMatches,
  validatePlugin,
  type PluginRuntime,
  type PluginRuntimeOptions,
} from "./plugin-runtime";
import type { DownloadPlan, Job, MediaInfo, Provider } from "./types";

let root: string;
let dir: string;
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-plugins-"));
  dir = join(root, "plugins");
  mkdirSync(dir);
  logs = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Drop a plugin file in, the way a user would. */
function write(file: string, source: string): void {
  writeFileSync(join(dir, file), source, "utf8");
}

async function runtimeFor(options: Partial<PluginRuntimeOptions> = {}): Promise<PluginRuntime> {
  const runtime = createPluginRuntime({
    dir,
    stateFile: join(root, "plugin-state.json"),
    config: {},
    log: (line) => logs.push(line),
    ...options,
  });
  await runtime.load();
  return runtime;
}

/**
 * A plugin that appends its own name at `url:resolve`, so the final string
 * *is* the execution order. Nothing to assert about ordering indirectly.
 */
function appender(name: string, extra = ""): string {
  return `export default {
    name: ${JSON.stringify(name)},
    description: "appends its name",
    hooks: [{ at: "url:resolve", kind: "transform"${extra} }],
    setup({ on }) { on("url:resolve", (url) => url + "|" + ${JSON.stringify(name)}); },
  };`;
}

/**
 * The value, or a failed test that says what came back instead.
 *
 * `Result` is a discriminated union, so `.value` does not exist until the
 * failure branch is ruled out — which is the point of it, and why these two
 * helpers are here rather than a cast in thirty places.
 */
function ok<T>(result: Result<T, unknown>): T {
  if (Result.isError(result)) throw new Error(`expected success, got ${String(result.error)}`);
  return result.value;
}

function failure<E>(result: Result<unknown, E>): E {
  if (Result.isOk(result)) throw new Error(`expected a failure, got ${String(result.value)}`);
  return result.error;
}

/** Enough of a job for the hooks that take one. The runtime only reads `url` and `title`. */
function job(url = "https://www.youtube.com/watch?v=x"): Job {
  return { id: "job-1", url, title: "A video" } as unknown as Job;
}

describe("the manifest is read before the plugin runs", () => {
  test("a disabled plugin is listed in full, and its setup never runs", async () => {
    const marker = join(root, "setup-ran");
    write(
      "spy.ts",
      `import { writeFileSync } from "node:fs";
       export default {
         name: "spy",
         description: "records that it was activated",
         matches: ["youtube.com", "*.vimeo.com"],
         needs: ["network"],
         hooks: [{ at: "job:completed", kind: "observe" }],
         setup({ on }) {
           writeFileSync(${JSON.stringify(marker)}, "yes");
           on("job:completed", () => {});
         },
       };`,
    );

    const runtime = await runtimeFor({ defaultEnabled: false });

    // Everything the UI needs to offer a choice, with none of the plugin's own
    // logic having run.
    const [status] = runtime.list();
    expect(status?.name).toBe("spy");
    expect(status?.description).toBe("records that it was activated");
    expect(status?.matches).toEqual(["youtube.com", "*.vimeo.com"]);
    expect(status?.needs).toEqual(["network"]);
    expect(status?.hooks).toEqual([{ at: "job:completed", kind: "observe" }]);
    expect(status?.state).toBe("disabled");
    expect(existsSync(marker)).toBe(false);

    // Saying yes is what runs it.
    expect(Result.isOk(await runtime.enable("spy"))).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  test("applicableTo answers from manifests alone", async () => {
    write("yt.ts", `export default { name: "yt", description: "youtube only", matches: ["youtube.com"], setup() {} };`);
    write("any.ts", `export default { name: "any", description: "everything", matches: [], setup() {} };`);
    write("vim.ts", `export default { name: "vim", description: "vimeo", matches: ["*.vimeo.com"], setup() {} };`);

    const runtime = await runtimeFor({ defaultEnabled: false });

    expect(runtime.applicableTo("https://www.youtube.com/watch?v=x").map((p) => p.name).sort()).toEqual(["any", "yt"]);
    expect(runtime.applicableTo("https://player.vimeo.com/video/1").map((p) => p.name).sort()).toEqual(["any", "vim"]);
    expect(runtime.applicableTo("https://example.org/a").map((p) => p.name)).toEqual(["any"]);
  });
});

describe("transforming hooks", () => {
  test("run in declared order", async () => {
    // Filenames set the base order; the plugin names make the result readable.
    write("01.ts", appender("first"));
    write("02.ts", appender("second"));
    write("03.ts", appender("third"));

    const runtime = await runtimeFor();
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|first|second|third");
  });

  test("before and after beat load order", async () => {
    // `aaa` loads first and would run first; `after: "zzz"` moves it behind.
    write("a.ts", appender("aaa", `, after: "zzz"`));
    write("z.ts", appender("zzz"));

    const runtime = await runtimeFor();
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|zzz|aaa");
  });

  test("a hook that returns nothing leaves the value alone", async () => {
    write(
      "peek.ts",
      `export default {
         name: "peek",
         description: "looks and says nothing",
         hooks: [{ at: "url:resolve", kind: "transform" }],
         setup({ on }) { on("url:resolve", () => undefined as unknown as string); },
       };`,
    );

    const runtime = await runtimeFor();
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a");
  });

  test("one that throws fails the job, and names itself", async () => {
    write("ok.ts", appender("ok"));
    write(
      "bad.ts",
      `export default {
         name: "bad",
         description: "throws",
         hooks: [{ at: "url:resolve", kind: "transform" }],
         setup({ on }) { on("url:resolve", () => { throw new Error("the shortener is down"); }); },
       };`,
    );

    const runtime = await runtimeFor();
    const error = failure(await runtime.run("url:resolve", "https://e.com/a"));

    expect(error._tag).toBe("PluginHookFailed");
    expect(error.plugin).toBe("bad");
    expect(error.at).toBe("url:resolve");
    expect(error.detail).toBe("the shortener is down");
  });

  test("can replace the download plan at probe:complete", async () => {
    write(
      "cap.ts",
      `export default {
         name: "cap",
         description: "caps the resolution",
         hooks: [{ at: "probe:complete", kind: "transform" }],
         setup({ on }) { on("probe:complete", (info, plan) => ({ ...plan, outputName: "capped" })); },
       };`,
    );

    const runtime = await runtimeFor();
    const info = { title: "A video" } as unknown as MediaInfo;
    const plan = { url: "https://e.com/a", outputName: "original" } as unknown as DownloadPlan;

    expect(ok(await runtime.run("probe:complete", info, plan)).outputName).toBe("capped");
    // The original is untouched: the hook returned a new plan, it did not edit ours.
    expect(plan.outputName).toBe("original");
  });
});

describe("observing hooks can never fail a job", () => {
  test("an observer that throws leaves the run successful, and the others still run", async () => {
    const marker = join(root, "sibling-ran");
    write(
      "boom.ts",
      `export default {
         name: "boom",
         description: "always throws",
         hooks: [{ at: "job:completed", kind: "observe" }],
         setup({ on }) { on("job:completed", () => { throw new Error("jellyfin is down"); }); },
       };`,
    );
    write(
      "sibling.ts",
      `import { writeFileSync } from "node:fs";
       export default {
         name: "sibling",
         description: "writes a file",
         hooks: [{ at: "job:completed", kind: "observe" }],
         setup({ on }) { on("job:completed", () => { writeFileSync(${JSON.stringify(marker)}, "yes"); }); },
       };`,
    );

    const runtime = await runtimeFor();

    // The rule: the job completed, and it stays completed.
    expect(Result.isOk(await runtime.run("job:completed", job()))).toBe(true);

    await runtime.observersIdle();

    // One observer failing did not stop the other from running.
    expect(existsSync(marker)).toBe(true);

    // And the failure is not swallowed into nothing: it is on the plugin's own log.
    const boom = runtime.list().find((plugin) => plugin.name === "boom");
    expect(boom?.state).toBe("active");
    expect(boom?.log.join("\n")).toContain("jellyfin is down");
    expect(logs.join("\n")).toContain("jellyfin is down");
  });

  test("a rejected promise from an observer is not an unhandled rejection either", async () => {
    write(
      "async-boom.ts",
      `export default {
         name: "async-boom",
         description: "rejects later",
         hooks: [{ at: "job:failed", kind: "observe" }],
         setup({ on }) {
           on("job:failed", async () => {
             await new Promise((r) => setTimeout(r, 5));
             throw new Error("the webhook timed out");
           });
         },
       };`,
    );

    const runtime = await runtimeFor();
    expect(Result.isOk(await runtime.run("job:failed", job(), "the download failed"))).toBe(true);

    await runtime.observersIdle();
    expect(runtime.list()[0]?.log.join("\n")).toContain("the webhook timed out");
  });

  test("observers are not awaited: a slow one does not hold the pipeline up", async () => {
    const started = join(root, "observer-started");
    write(
      "slow.ts",
      `import { writeFileSync } from "node:fs";
       export default {
         name: "slow",
         description: "takes its time",
         hooks: [{ at: "job:completed", kind: "observe" }],
         setup({ on }) {
           on("job:completed", async () => {
             writeFileSync(${JSON.stringify(started)}, "yes");
             await new Promise((r) => setTimeout(r, 250));
           });
         },
       };`,
    );

    const runtime = await runtimeFor();
    const before = Date.now();
    await runtime.run("job:completed", job());
    const elapsed = Date.now() - before;

    // It was started, and we did not wait for it.
    expect(existsSync(started)).toBe(true);
    expect(elapsed).toBeLessThan(200);

    await runtime.observersIdle();
  });
});

describe("a broken plugin does not take the load down", () => {
  test("a syntax error is recorded, and the healthy plugin still loads", async () => {
    write("broken.ts", `export default { name: "broken", description: "unclosed`);
    write("healthy.ts", appender("healthy"));

    const runtime = await runtimeFor();
    const listed = runtime.list();

    const broken = listed.find((plugin) => plugin.file === "broken.ts");
    expect(broken?.state).toBe("error");
    expect(broken?.error).toContain("could not be imported");

    // And the good one is alive and dispatching.
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|healthy");
  });

  test("a file exporting nothing, a bad manifest, and a bad hook point are each one row", async () => {
    write("empty.ts", `export const unrelated = 1;`);
    write("nameless.ts", `export default { description: "no name", setup() {} };`);
    write("nohook.ts", `export default { name: "nohook", description: "x", hooks: [{ at: "job:done", kind: "observe" }], setup() {} };`);
    write("nocap.ts", `export default { name: "nocap", description: "x", needs: ["gpu"], setup() {} };`);
    write("nosetup.ts", `export default { name: "nosetup", description: "x" };`);
    write("healthy.ts", appender("healthy"));

    const runtime = await runtimeFor();
    const byFile = new Map(runtime.list().map((plugin) => [plugin.file, plugin]));

    expect(byFile.get("empty.ts")?.error).toContain("not a plugin object");
    expect(byFile.get("nameless.ts")?.error).toContain("name must be");
    expect(byFile.get("nohook.ts")?.error).toContain("unknown hook point");
    expect(byFile.get("nocap.ts")?.error).toContain("unknown capability");
    expect(byFile.get("nosetup.ts")?.error).toContain("setup must be a function");
    expect(byFile.get("healthy.ts")?.state).toBe("active");
  });

  test("a setup that throws disables that plugin only, and leaves no half-registered hook", async () => {
    write(
      "half.ts",
      `export default {
         name: "half",
         description: "registers, then explodes",
         hooks: [{ at: "url:resolve", kind: "transform" }],
         setup({ on }) {
           on("url:resolve", (url) => url + "|half");
           throw new Error("no config file");
         },
       };`,
    );
    write("healthy.ts", appender("healthy"));

    const runtime = await runtimeFor();
    const half = runtime.list().find((plugin) => plugin.name === "half");

    expect(half?.state).toBe("error");
    expect(half?.error).toContain("no config file");
    // The hook it managed to register before throwing is gone: running it would
    // mean running against state its setup never finished building.
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|healthy");
  });

  test("two plugins claiming the same name: the second is refused, not silently ignored", async () => {
    write("a-first.ts", appender("twin"));
    write("b-second.ts", appender("twin"));

    const runtime = await runtimeFor();
    const second = runtime.list().find((plugin) => plugin.file === "b-second.ts");

    expect(second?.state).toBe("error");
    expect(second?.error).toContain("already used by a-first.ts");
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|twin");
  });

  test("no plugins directory at all is an empty list, not a failure", async () => {
    const runtime = createPluginRuntime({ dir: join(root, "nope"), stateFile: join(root, "s.json"), log: () => {} });
    await runtime.load();
    expect(runtime.list()).toEqual([]);
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a");
  });
});

describe("matches decides who is dispatched to", () => {
  test("a plugin that did not claim the URL does not run on it", async () => {
    // Numbered, so the order in the answer is the file order and not an accident
    // of the alphabet.
    write(
      "1-yt.ts",
      `export default {
         name: "yt",
         description: "youtube only",
         matches: ["youtube.com", "youtu.be"],
         hooks: [{ at: "url:resolve", kind: "transform" }],
         setup({ on }) { on("url:resolve", (url) => url + "|yt"); },
       };`,
    );
    write("2-all.ts", appender("all"));

    const runtime = await runtimeFor();

    expect(ok(await runtime.run("url:resolve", "https://www.youtube.com/watch?v=x"))).toBe(
      "https://www.youtube.com/watch?v=x|yt|all",
    );
    expect(ok(await runtime.run("url:resolve", "https://vimeo.com/1"))).toBe("https://vimeo.com/1|all");
  });

  test("the URL for the job hooks comes off the job", async () => {
    write(
      "yt.ts",
      `import { appendFileSync } from "node:fs";
       export default {
         name: "yt",
         description: "youtube only",
         matches: ["youtube.com"],
         hooks: [{ at: "job:completed", kind: "observe" }],
         setup({ on }) { on("job:completed", (j) => appendFileSync(${JSON.stringify(join(root, "seen"))}, j.url + "\\n")); },
       };`,
    );

    const runtime = await runtimeFor();
    await runtime.run("job:completed", job("https://vimeo.com/1"));
    await runtime.run("job:completed", job("https://www.youtube.com/watch?v=x"));
    await runtime.observersIdle();

    expect(readFileSync(join(root, "seen"), "utf8").trim()).toBe("https://www.youtube.com/watch?v=x");
  });

  test("patternMatches: bare hosts cover subdomains, globs do not cover the apex", () => {
    expect(patternMatches("adf.ly", "https://adf.ly/x")).toBe(true);
    expect(patternMatches("adf.ly", "https://www.adf.ly/x")).toBe(true);
    expect(patternMatches("adf.ly", "https://notadf.ly/x")).toBe(false);
    expect(patternMatches("*.adfly.com", "https://a.b.adfly.com/x")).toBe(true);
    expect(patternMatches("*.adfly.com", "https://adfly.com/x")).toBe(false);
    expect(patternMatches("https://example.org/*", "https://example.org/a/b")).toBe(true);
    expect(patternMatches("youtube.com", "not a url at all")).toBe(false);
    expect(manifestMatches({ name: "x", description: "" }, "https://anything.example/x")).toBe(true);
  });
});

describe("capabilities are injected, not imported", () => {
  test("a plugin that did not declare network gets a fetch it cannot use", async () => {
    write(
      "quiet.ts",
      `import { writeFileSync } from "node:fs";
       export default {
         name: "quiet",
         description: "asks for nothing",
         setup({ fetch, log }) {
           try { fetch("https://example.org"); log("fetch worked"); }
           catch (error) { log("denied: " + (error as Error).message); }
         },
       };`,
    );

    const runtime = await runtimeFor();
    const status = runtime.list()[0];

    expect(status?.state).toBe("active");
    expect(status?.log.join("\n")).toContain("denied:");
    expect(status?.log.join("\n")).toContain(`"network" capability`);
  });

  test("a plugin that declared network gets the real thing, and its config", async () => {
    write(
      "loud.ts",
      `export default {
         name: "loud",
         description: "asks for the network",
         needs: ["network"],
         setup({ fetch, log, config }) {
           log("fetch is a " + typeof fetch);
           log("token is " + String(config.SOME_TOKEN));
         },
       };`,
    );

    const runtime = await runtimeFor({ config: { SOME_TOKEN: "abc123" } });
    const log = runtime.list()[0]?.log.join("\n") ?? "";

    expect(log).toContain("fetch is a function");
    expect(log).toContain("token is abc123");
  });

  test("config is frozen, so one plugin cannot edit what the next one sees", async () => {
    write(
      "greedy.ts",
      `export default {
         name: "greedy",
         description: "tries to write to config",
         setup({ config, log }) {
           try { (config as Record<string, unknown>).SOME_TOKEN = "stolen"; log("wrote"); }
           catch { log("refused"); }
         },
       };`,
    );

    const config = { SOME_TOKEN: "abc123" };
    await runtimeFor({ config });
    expect(config.SOME_TOKEN).toBe("abc123");
  });
});

describe("enabling and disabling", () => {
  test("a disabled plugin is not dispatched to, and the choice survives a reload", async () => {
    write("a.ts", appender("aaa"));
    write("z.ts", appender("zzz"));

    const runtime = await runtimeFor();
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|aaa|zzz");

    expect(ok(await runtime.disable("aaa")).state).toBe("disabled");
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|zzz");

    // Written down, so a restart does not turn it back on.
    const state = JSON.parse(readFileSync(join(root, "plugin-state.json"), "utf8")) as {
      plugins: Record<string, { enabled: boolean }>;
    };
    expect(state.plugins.aaa?.enabled).toBe(false);

    const rebooted = await runtimeFor();
    expect(rebooted.list().find((plugin) => plugin.name === "aaa")?.state).toBe("disabled");
    expect(ok(await rebooted.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|zzz");

    expect(ok(await rebooted.enable("aaa")).state).toBe("active");
    expect(ok(await rebooted.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a|aaa|zzz");
  });

  test("enabling something that is not there, or that failed to load, says so", async () => {
    write("broken.ts", `export default { name: "broken", description: "unclosed`);
    const runtime = await runtimeFor();

    expect(failure(await runtime.enable("ghost"))).toContain(`no plugin named "ghost"`);
    expect(failure(await runtime.enable("broken"))).toContain("failed to load");
  });
});

describe("reloading actually reloads", () => {
  /**
   * 🔴 The regression test for a bug that had been shipped and believed fixed.
   *
   * `load()` used to import `file.ts?g=<generation>` with a comment saying the
   * query string was what made a reload see new source. It is not: Bun keys its
   * module registry on the resolved **path** and drops the query and the hash
   * from a `file:` URL, so every reload handed back the first evaluation and
   * editing a plugin did nothing at all. Nothing errored; the old plugin simply
   * kept running.
   *
   * That was invisible until there was an editor, because nobody edited a
   * plugin without also restarting the process. See `docs/DISCOVERIES.md`.
   */
  function version(n: number): string {
    return `export default {
      name: "v",
      description: "version ${n}",
      hooks: [{ at: "url:resolve", kind: "transform" }],
      setup({ on }) { on("url:resolve", (url) => url + "|${n}"); },
    };`;
  }

  test("an edited file is re-read, in the manifest and in the code", async () => {
    write("v.ts", version(1));
    const runtime = await runtimeFor();
    expect(runtime.list()[0]?.description).toBe("version 1");
    expect(ok(await runtime.run("url:resolve", "u"))).toBe("u|1");

    write("v.ts", version(2));
    await runtime.load();

    expect(runtime.list()[0]?.description).toBe("version 2");
    // The manifest moving is not enough on its own: `setup` has to have run
    // again, or the hook still points at the old closure.
    expect(ok(await runtime.run("url:resolve", "u"))).toBe("u|2");
  });

  test("a reload leaves nothing behind in the plugins directory", async () => {
    // The import goes through a hidden sibling copy, which is the only thing
    // that busts the cache. A copy left on disk would be litter in a directory
    // the user browses, and one left with a loadable name would be a duplicate
    // plugin.
    write("v.ts", version(1));
    const runtime = await runtimeFor();
    await runtime.load();
    await runtime.load();

    expect(readdirSync(dir)).toEqual(["v.ts"]);
    expect(runtime.list()).toHaveLength(1);
  });

  test("a file that becomes broken, then fixed, follows the source both ways", async () => {
    write("v.ts", version(1));
    const runtime = await runtimeFor();
    expect(runtime.list()[0]?.state).toBe("active");

    write("v.ts", "export default { unclosed");
    await runtime.load();
    expect(runtime.list()[0]?.state).toBe("error");
    // The message names the file the user wrote, not the internal copy.
    expect(runtime.list()[0]?.error).not.toContain("casatube-reload");

    write("v.ts", version(3));
    await runtime.load();
    expect(runtime.list()[0]?.state).toBe("active");
    expect(ok(await runtime.run("url:resolve", "u"))).toBe("u|3");
  });
});

describe("providers from plugins", () => {
  test("are registered, and stop claiming URLs when the plugin is switched off", async () => {
    write(
      "extractor.ts",
      `export default {
         name: "extractor",
         description: "a custom extractor",
         matches: ["fancy.example"],
         setup({ addProvider }) {
           addProvider({
             name: "fancy",
             supports: (url) => url.includes("fancy.example"),
             probe: async () => { throw new Error("not used"); },
             fetch: async () => { throw new Error("not used"); },
           });
         },
       };`,
    );

    const registered: Provider[] = [];
    const runtime = await runtimeFor({ registry: { register: (p) => registered.push(p) } });

    expect(registered.map((p) => p.name)).toEqual(["fancy"]);
    expect(runtime.list()[0]?.providers).toEqual(["fancy"]);
    expect(registered[0]?.supports("https://fancy.example/v/1")).toBe(true);

    // A registry has no `unregister`, so the wrapper is what makes "off" mean off.
    await runtime.disable("extractor");
    expect(registered[0]?.supports("https://fancy.example/v/1")).toBe(false);
  });

  test("addProvider without a registry is refused, not a crash", async () => {
    write(
      "extractor.ts",
      `export default {
         name: "extractor",
         description: "a custom extractor",
         setup({ addProvider }) { addProvider({ name: "fancy", supports: () => true } as never); },
       };`,
    );

    const runtime = await runtimeFor();
    expect(runtime.list()[0]?.state).toBe("active");
    expect(runtime.list()[0]?.log.join("\n")).toContain("no provider registry");
  });
});

describe("the manifest gate", () => {
  test("a hook the manifest did not declare is refused", async () => {
    // Without a declaration there is no `kind`, so the runtime cannot know
    // whether a failure should fail the job. Running it anyway would be a guess.
    write(
      "sneaky.ts",
      `export default {
         name: "sneaky",
         description: "declares an observer, registers a transform",
         hooks: [{ at: "job:completed", kind: "observe" }],
         setup({ on }) {
           on("job:completed", () => {});
           on("url:resolve", (url) => url + "|sneaky");
         },
       };`,
    );

    const runtime = await runtimeFor();
    expect(ok(await runtime.run("url:resolve", "https://e.com/a"))).toBe("https://e.com/a");
    expect(runtime.list()[0]?.log.join("\n")).toContain("not declared in the manifest");
  });

  test("validatePlugin is the same gate, callable on its own", () => {
    expect(failure(validatePlugin(null))).toContain("not a plugin object");
    expect(failure(validatePlugin({ name: "a b", description: "x", setup() {} }))).toContain("name must be");
    expect(failure(validatePlugin({ name: "ok", description: "x", matches: [1], setup() {} }))).toContain("matches must be");
    expect(ok(validatePlugin({ name: "ok", description: "x", setup() {} })).name).toBe("ok");
  });
});

describe("the jellyfin plugin", () => {
  /** A stand-in Jellyfin: records what it was asked, answers how it is told to. */
  function jellyfinStub(code = 204) {
    const seen: { path: string; token: string | null; method: string }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push({ path: url.pathname, token: request.headers.get("x-emby-token"), method: request.method });
        return new Response(null, { status: code });
      },
    });
    return { seen, url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
  }

  function install(): void {
    // The file that ships in the repo, loaded the way a user's copy would be.
    // The type-only import in it is erased before it ever runs, which is why
    // copying it out of the repo does not break it.
    writeFileSync(join(dir, "jellyfin.ts"), readFileSync(join(import.meta.dir, "../plugins/builtin/jellyfin.ts"), "utf8"));
  }

  test("asks for a library scan when a job completes", async () => {
    const server = jellyfinStub();
    install();

    const runtime = await runtimeFor({ config: { JELLYFIN_URL: `${server.url}/`, JELLYFIN_TOKEN: "secret" } });
    await runtime.run("job:completed", job());
    await runtime.observersIdle();

    expect(server.seen).toEqual([{ path: "/Library/Refresh", token: "secret", method: "POST" }]);
    expect(runtime.list()[0]?.log.join("\n")).toContain("asked Jellyfin to scan");
    server.stop();
  });

  test("PLAN's MEDIA_SERVER_* names work too", async () => {
    const server = jellyfinStub();
    install();

    const runtime = await runtimeFor({ config: { MEDIA_SERVER_URL: server.url, MEDIA_SERVER_TOKEN: "t" } });
    await runtime.run("job:completed", job());
    await runtime.observersIdle();

    expect(server.seen[0]?.path).toBe("/Library/Refresh");
    server.stop();
  });

  test("a Jellyfin that answers 500 does not fail the job", async () => {
    const server = jellyfinStub(500);
    install();

    const runtime = await runtimeFor({ config: { JELLYFIN_URL: server.url, JELLYFIN_TOKEN: "secret" } });

    // This is the whole reason it is an observer: the video is downloaded and
    // correct, and the media server having a bad day does not change that.
    expect(Result.isOk(await runtime.run("job:completed", job()))).toBe(true);

    await runtime.observersIdle();
    expect(runtime.list()[0]?.log.join("\n")).toContain("Jellyfin answered 500");
    server.stop();
  });

  test("unconfigured, it says so once and then stays out of the way", async () => {
    install();

    const runtime = await runtimeFor({ config: {} });
    const out = await runtime.run("job:completed", job());
    await runtime.observersIdle();

    expect(Result.isOk(out)).toBe(true);
    expect(runtime.list()[0]?.state).toBe("active");
    expect(runtime.list()[0]?.log.join("\n")).toContain("not configured");
    // It registered no hook at all, so there is nothing to fail per download.
    expect(runtime.list()[0]?.log.filter((line) => line.includes("failed"))).toEqual([]);
  });
});
