/**
 * The plugins that ship with CasaTube, and the four cases "install a default
 * file" turns out to have.
 *
 * 🔴 The one worth the whole file is **kept-yours**: an upgrade must never
 * write over a plugin someone has edited. That is a silent data loss with no
 * error and no trace, and the only thing that distinguishes it from a normal
 * update is the seed record — the SHA-256 of exactly what the seeder last
 * wrote.
 *
 * The bottom of the file loads the real shipped sources through the real
 * runtime. A built-in that reads beautifully and does not load would fail on
 * someone else's machine, on first boot, in a file they never wrote — the same
 * reason `api/plugins.test.ts` loads the template it hands out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";

import { describeSeed, readBuiltins, seedBuiltins, sha256, type BuiltinPlugin } from "./plugin-builtins";
import { createPluginRuntime, type PluginHookFailed } from "./plugin-runtime";

/**
 * The resolved URL, or the failure as a string.
 *
 * ⚠️ Not `result.value` with a cast: a transform that failed the job would then
 * read as `undefined` and an assertion on the URL would still pass for the
 * wrong reason. Turning the error branch into a distinguishable string is what
 * makes "it never fails the job" a claim the test can actually check.
 */
function resolved(result: Result<string, PluginHookFailed>): string {
  return Result.isOk(result) ? result.value : `FAILED: ${result.error.detail}`;
}

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-builtins-"));
  dir = join(root, "plugins");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function shipped(source: string): BuiltinPlugin[] {
  return [{ file: "demo.ts", source, sha: sha256(source) }];
}

function onDisk(): string | null {
  try {
    return readFileSync(join(dir, "demo.ts"), "utf8");
  } catch {
    return null;
  }
}

describe("the four cases", () => {
  test("a fresh install: written, and recorded", async () => {
    const result = await seedBuiltins(dir, {}, shipped("v1"));
    expect(result.outcomes).toEqual([{ file: "demo.ts", action: "written" }]);
    expect(onDisk()).toBe("v1");
    expect(result.record["demo.ts"]).toBe(sha256("v1"));
  });

  test("deleted by the user: it stays deleted", async () => {
    const first = await seedBuiltins(dir, {}, shipped("v1"));
    rmSync(join(dir, "demo.ts"));

    const second = await seedBuiltins(dir, first.record, shipped("v1"));
    expect(second.outcomes[0]?.action).toBe("kept-deleted");
    expect(onDisk()).toBeNull();
    // Still recorded, so it does not come back on the boot after that either.
    expect(second.record["demo.ts"]).toBe(sha256("v1"));
  });

  test("untouched, and the build ships a new version: the upgrade lands", async () => {
    const first = await seedBuiltins(dir, {}, shipped("v1"));
    const second = await seedBuiltins(dir, first.record, shipped("v2"));

    expect(second.outcomes[0]?.action).toBe("updated");
    expect(onDisk()).toBe("v2");
    expect(second.record["demo.ts"]).toBe(sha256("v2"));
  });

  test("🔴 edited by the user: the upgrade does NOT land, and says so", async () => {
    const first = await seedBuiltins(dir, {}, shipped("v1"));
    writeFileSync(join(dir, "demo.ts"), "v1 + my changes", "utf8");

    const second = await seedBuiltins(dir, first.record, shipped("v2"));

    expect(second.outcomes[0]?.action).toBe("kept-yours");
    expect(onDisk()).toBe("v1 + my changes");
    // ⚠️ And it is announced. An upgrade that silently did not reach your copy
    // is a mystery; one that says so is a decision you can act on.
    expect(describeSeed(second.outcomes).join("\n")).toContain("left as you edited it");
  });
});

describe("the record, and what it costs to be without one", () => {
  test("a file identical to what ships is adopted, so a restored backup is not frozen at kept-yours", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "demo.ts"), "v1", "utf8");

    const result = await seedBuiltins(dir, {}, shipped("v1"));
    expect(result.outcomes[0]?.action).toBe("unchanged");
    expect(result.record["demo.ts"]).toBe(sha256("v1"));

    // Which is what lets the *next* upgrade reach it.
    const next = await seedBuiltins(dir, result.record, shipped("v2"));
    expect(next.outcomes[0]?.action).toBe("updated");
  });

  test("a file that was there first and differs is never written over", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "demo.ts"), "mine, and it was here first", "utf8");

    const result = await seedBuiltins(dir, {}, shipped("v1"));
    expect(result.outcomes[0]?.action).toBe("kept-yours");
    expect(onDisk()).toBe("mine, and it was here first");
  });

  test("the boot log stays quiet about the ordinary case", () => {
    expect(describeSeed([{ file: "a.ts", action: "unchanged" }])).toEqual([]);
    expect(describeSeed([{ file: "a.ts", action: "written" }])).toEqual(["a.ts: installed"]);
  });
});

describe("the plugins actually shipped", () => {
  test("there are at least three, and they include the transformer and the observers", async () => {
    const builtins = await readBuiltins();
    const names = builtins.map((builtin) => builtin.file);
    expect(names).toContain("jellyfin.ts");
    expect(names).toContain("unshorten.ts");
    expect(names).toContain("webhook.ts");
  });

  test("🔴 seeded into an empty directory, every one of them loads", async () => {
    // The instrument that matters. A default plugin that does not load fails on
    // first boot, in a file the user did not write, with an error about code
    // they were told to trust.
    await seedBuiltins(dir, {});

    const runtime = createPluginRuntime({
      dir,
      stateFile: join(root, "plugin-state.json"),
      config: {},
      log: () => {},
    });
    await runtime.load();

    const loaded = runtime.list();
    expect(loaded.length).toBeGreaterThanOrEqual(3);
    for (const plugin of loaded) {
      expect(`${plugin.name}: ${plugin.error ?? "ok"}`).toBe(`${plugin.name}: ok`);
      expect(plugin.state).toBe("active");
    }
  });

  test("unconfigured, the two that need configuration say so and register nothing", async () => {
    await seedBuiltins(dir, {});
    const runtime = createPluginRuntime({
      dir,
      stateFile: join(root, "plugin-state.json"),
      config: {},
      log: () => {},
    });
    await runtime.load();

    for (const name of ["jellyfin", "webhook"]) {
      const plugin = runtime.list().find((item) => item.name === name);
      // ⚠️ "Active and doing nothing" is the correct state for a notifier
      // nobody has pointed anywhere. It has to be *visible*, which is what
      // `missingSettings` is for.
      expect(plugin?.log.join("\n")).toContain("not configured");
      expect(plugin?.missingSettings.length).toBeGreaterThan(0);
    }

    // And the transformer works with no configuration at all, because every
    // one of its settings has a usable default.
    expect(runtime.list().find((item) => item.name === "unshorten")?.missingSettings).toEqual([]);
  });

  test("the transformer is only dispatched for the hosts it claims", async () => {
    await seedBuiltins(dir, {});
    const runtime = createPluginRuntime({
      dir,
      stateFile: join(root, "plugin-state.json"),
      config: {},
      log: () => {},
    });
    await runtime.load();

    // `matches` is enforced at dispatch, so a URL nowhere near a shortener must
    // come back untouched — and, just as importantly, no request is made for it.
    const untouched = await runtime.run("url:resolve", "https://youtube.com/watch?v=x");
    expect(resolved(untouched)).toBe("https://youtube.com/watch?v=x");
  });

  test("the transformer follows the chain, caps it, and never fails the job", async () => {
    /**
     * ⚠️ The shipped source with **one line changed**: `matches` is widened to
     * `["*"]` so the hook is dispatched for a `localhost` stub. Everything
     * being tested — the redirect loop, the cap, the catch that returns the
     * original URL — is the real file's code, unedited. The alternative is
     * pointing at bit.ly and having the test depend on the internet and on
     * somebody else's redirect staying where it is.
     */
    const source = (await readBuiltins()).find((builtin) => builtin.file === "unshorten.ts");
    expect(source).toBeDefined();
    const widened = source!.source.replace(/matches: \[[^\]]*\]/, 'matches: ["*"]');
    expect(widened).toContain('matches: ["*"]');

    const hops = join(root, "hops");
    mkdirSync(hops, { recursive: true });
    writeFileSync(join(hops, "unshorten.ts"), widened, "utf8");

    let chain = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/short") return new Response(null, { status: 302, headers: { location: "/middle" } });
        if (path === "/middle") return new Response(null, { status: 301, headers: { location: "/final" } });
        if (path === "/loop") return new Response(null, { status: 302, headers: { location: "/loop2" } });
        if (path === "/loop2") {
          chain += 1;
          return new Response(null, { status: 302, headers: { location: "/loop" } });
        }
        return new Response("ok");
      },
    });
    const base = `http://localhost:${server.port}`;

    const runtime = createPluginRuntime({
      dir: hops,
      stateFile: join(root, "hops-state.json"),
      config: {},
      log: () => {},
    });
    await runtime.load();

    const followed = await runtime.run("url:resolve", `${base}/short`);
    expect(resolved(followed)).toBe(`${base}/final`);

    // A loop is capped rather than chased for ever, and the answer is still a
    // URL — a transform that threw here would fail the download.
    const looped = await runtime.run("url:resolve", `${base}/loop`);
    expect(resolved(looped)).toContain(base);
    expect(resolved(looped)).not.toContain("FAILED");
    expect(chain).toBeLessThan(10);

    // 🔴 An unreachable host is not a reason to refuse a download: yt-dlp can
    // very often resolve the link itself. The original URL comes back.
    server.stop(true);
    const dead = await runtime.run("url:resolve", `${base}/short`);
    expect(resolved(dead)).toBe(`${base}/short`);
  }, 20_000);
});
