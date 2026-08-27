/**
 * `/api/plugins`, over a real plugins directory.
 *
 * The route layer is thin by design — the runtime does the work — so what is
 * worth testing here is exactly the boundary: that the manifest survives the
 * trip to JSON, that `applicable` filters by `matches`, and that the two ways a
 * toggle can fail get told apart (a plugin that is not there is a 404; one that
 * is there but broken is a 409).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginRuntime, type PluginRuntime, type PluginStatus } from "../core/plugin-runtime";
import { memoryPluginSettings, type ResolvedSetting } from "../core/plugin-settings";
import { pluginRoutes } from "./plugins";

let root: string;
let dir: string;
let runtime: PluginRuntime;
/**
 * Only what the tests use. Elysia's own type carries its prefix and its whole
 * route table in the generics, so naming it here would mean restating the
 * routes — and the assertions are all about the HTTP answer anyway.
 */
let app: { handle: (request: Request) => Promise<Response> };

function write(file: string, source: string): void {
  writeFileSync(join(dir, file), source, "utf8");
}

function plugin(name: string, matches: string[], extra = ""): string {
  return `export default {
    name: ${JSON.stringify(name)},
    description: ${JSON.stringify(`the ${name} plugin`)},
    matches: ${JSON.stringify(matches)},
    needs: ["network"],
    hooks: [{ at: "job:completed", kind: "observe" }],
    setup({ on }) { on("job:completed", () => {}); ${extra} },
  };`;
}

async function boot(config: Record<string, unknown> = {}): Promise<void> {
  runtime = createPluginRuntime({
    dir,
    stateFile: join(root, "plugin-state.json"),
    config,
    settings: memoryPluginSettings(),
    log: () => {},
  });
  await runtime.load();
  app = new Elysia({ prefix: "/api" }).use(pluginRoutes(runtime, dir));
}

async function get(path: string): Promise<Response> {
  return app.handle(new Request(`http://local/api${path}`));
}

async function post(path: string): Promise<Response> {
  return app.handle(new Request(`http://local/api${path}`, { method: "POST" }));
}

async function send(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://local/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casatube-plugin-api-"));
  dir = join(root, "plugins");
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/plugins", () => {
  test("lists every plugin with its manifest and its state", async () => {
    write("yt.ts", plugin("yt", ["youtube.com"]));
    write("all.ts", plugin("all", []));
    await boot();

    const response = await get("/plugins");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { plugins: PluginStatus[] };

    const yt = body.plugins.find((item) => item.name === "yt");
    expect(yt?.description).toBe("the yt plugin");
    expect(yt?.matches).toEqual(["youtube.com"]);
    // The permissions, the way a phone shows them at install time — PLAN section 5.
    expect(yt?.needs).toEqual(["network"]);
    expect(yt?.hooks).toEqual([{ at: "job:completed", kind: "observe" }]);
    expect(yt?.state).toBe("active");
    expect(yt?.enabled).toBe(true);
    expect(yt?.file).toBe("yt.ts");
  });

  test("a plugin that failed to load is shown, not hidden", async () => {
    write("broken.ts", `export default { name: "broken", description: "unclosed`);
    await boot();

    const body = (await (await get("/plugins")).json()) as { plugins: PluginStatus[] };
    const broken = body.plugins[0];

    expect(broken?.state).toBe("error");
    expect(broken?.error).toContain("could not be imported");
    expect(broken?.file).toBe("broken.ts");
  });

  test("no plugins is an empty list — and still says where they would go", async () => {
    await boot();
    // 🔴 `dir` is on the empty answer too. That is the state where it matters:
    // a screen saying "no plugins installed" and nothing else cannot be acted
    // on, and the path depends on DATA_DIR, which only the server knows.
    expect((await (await get("/plugins")).json()) as unknown).toEqual({ plugins: [], dir });
  });
});

describe("starting from nothing", () => {
  test("GET /api/plugins/template is a saveable file, named", async () => {
    await boot();

    const response = await get("/plugins/template");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="casatube-plugin.ts"`);

    const source = await response.text();
    // It has to be a plugin, not prose about plugins.
    expect(source).toContain("export default plugin;");
    expect(source).toContain("hooks:");
    // And it has to name *this* installation's directory, not a placeholder.
    expect(source).toContain(dir);
    expect(source).not.toContain("__PLUGINS_DIR__");
  });

  test("GET /api/plugins/docs answers with the reference", async () => {
    await boot();

    const body = (await (await get("/plugins/docs")).json()) as { markdown: string; filename: string; dir: string };
    expect(body.dir).toBe(dir);
    expect(body.filename).toBe("casatube-plugin.ts");
    expect(body.markdown).toContain("job:completed");
    expect(body.markdown).toContain(dir);
  });

  test("the template is a plugin the runtime actually accepts", async () => {
    // ⚠️ The instrument that matters. A template that reads well and does not
    // load is worse than none: it fails on someone else's machine, after a
    // restart, with an error about a file they were told to trust. So the file
    // the button hands over is written into a plugins directory and loaded.
    await boot();
    const source = await (await get("/plugins/template")).text();
    write("from-template.ts", source);
    await boot();

    const body = (await (await get("/plugins")).json()) as { plugins: PluginStatus[] };
    const loaded = body.plugins.find((item) => item.file === "from-template.ts");

    // ⚠️ `active`, not `disabled`: a plugin the runtime has never seen defaults
    // to enabled, so dropping a file in is enough to make it run. Worth being
    // exact about — it is what the template and the screen have to say.
    expect(loaded?.state).toBe("active");
    expect(loaded?.error).toBeUndefined();
    expect(loaded?.name).toBe("my-plugin");
  });
});

describe("GET /api/plugins/applicable", () => {
  test("answers with the plugins that would act on a pasted URL", async () => {
    write("yt.ts", plugin("yt", ["youtube.com", "youtu.be"]));
    write("vimeo.ts", plugin("vimeo", ["*.vimeo.com"]));
    write("all.ts", plugin("all", []));
    await boot();

    const body = (await (await get("/plugins/applicable?url=https%3A%2F%2Fyoutu.be%2Fabc")).json()) as {
      url: string;
      plugins: PluginStatus[];
    };

    expect(body.url).toBe("https://youtu.be/abc");
    expect(body.plugins.map((item) => item.name).sort()).toEqual(["all", "yt"]);
  });

  test("a broken plugin is never offered: it cannot act on anything", async () => {
    write("broken.ts", `export default { name: "broken", description: "unclosed`);
    write("all.ts", plugin("all", []));
    await boot();

    const body = (await (await get("/plugins/applicable?url=https%3A%2F%2Fe.com%2Fa")).json()) as {
      plugins: PluginStatus[];
    };
    expect(body.plugins.map((item) => item.name)).toEqual(["all"]);
  });

  test("a disabled plugin is still offered, marked disabled", async () => {
    // The recommendation comes from `matches`; the decision stays with the
    // user, and they cannot decide about something they are not shown.
    write("yt.ts", plugin("yt", ["youtube.com"]));
    await boot();
    await post("/plugins/yt/disable");

    const body = (await (await get("/plugins/applicable?url=https%3A%2F%2Fyoutube.com%2Fw")).json()) as {
      plugins: PluginStatus[];
    };
    expect(body.plugins[0]?.name).toBe("yt");
    expect(body.plugins[0]?.enabled).toBe(false);
  });

  test("without a url it is a bad request, not an empty answer", async () => {
    await boot();
    expect((await get("/plugins/applicable")).status).toBeGreaterThanOrEqual(400);
  });
});

describe("POST /api/plugins/:name/enable and /disable", () => {
  test("switch a plugin off and back on", async () => {
    write("yt.ts", plugin("yt", ["youtube.com"]));
    await boot();

    const off = await post("/plugins/yt/disable");
    expect(off.status).toBe(200);
    expect(((await off.json()) as PluginStatus).state).toBe("disabled");

    const listed = (await (await get("/plugins")).json()) as { plugins: PluginStatus[] };
    expect(listed.plugins[0]?.enabled).toBe(false);

    const on = await post("/plugins/yt/enable");
    expect(on.status).toBe(200);
    expect(((await on.json()) as PluginStatus).state).toBe("active");
  });

  test("a plugin that is not there is a 404 with the shared error shape", async () => {
    await boot();

    const response = await post("/plugins/ghost/enable");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { tag: string; message: string; retryable: boolean };
    expect(body.tag).toBe("NotFound");
    expect(body.retryable).toBe(false);
  });

  test("a plugin that is there but broken is a 409, and says why", async () => {
    write("broken.ts", `export default { name: "broken", description: "unclosed`);
    await boot();

    const response = await post("/plugins/broken/enable");
    // Not a 404: the file exists and is listed. Enabling it is what cannot be done.
    expect(response.status).toBe(409);
    const body = (await response.json()) as { tag: string; message: string };
    expect(body.tag).toBe("PluginUnavailable");
    expect(body.message).toContain("failed to load");
  });

  test("enabling something whose setup throws reports it here, not at a boot nobody saw", async () => {
    write(
      "half.ts",
      `export default {
         name: "half",
         description: "explodes on setup",
         setup() { throw new Error("no config file"); },
       };`,
    );
    // Nothing is on by default here, so the failure happens on the click.
    runtime = createPluginRuntime({
      dir,
      stateFile: join(root, "plugin-state.json"),
      config: {},
      log: () => {},
      defaultEnabled: false,
    });
    await runtime.load();
    app = new Elysia({ prefix: "/api" }).use(pluginRoutes(runtime));

    const response = await post("/plugins/half/enable");
    expect(response.status).toBe(200);
    const body = (await response.json()) as PluginStatus;
    expect(body.state).toBe("error");
    expect(body.error).toContain("no config file");
    expect(body.enabled).toBe(false);
  });
});

/**
 * The editor's endpoints.
 *
 * These are the ones that write to disk and run code, so the assertions are
 * about the two things that must stay true whatever anybody types into the box:
 * a save takes effect **without a restart**, and a file that does not compile
 * takes **nothing else** down with it.
 */
describe("writing plugin files", () => {
  const source = (name: string, extra = "") => `export default {
    name: ${JSON.stringify(name)},
    description: "written through the API",
    hooks: [{ at: "job:completed", kind: "observe" }],
    setup({ on }) { on("job:completed", () => {}); ${extra} }
  };`;

  test("create, list, read back", async () => {
    await boot();

    const created = await send("PUT", "/plugins/source", { file: "made.ts", source: source("made") });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { saved: PluginStatus | null; warning: string; plugins: PluginStatus[] };

    // 🔴 Loaded, not merely written. A save that leaves the runtime holding the
    // previous generation is a control that appears to work and does nothing —
    // which is exactly what a restart used to be required for.
    expect(body.saved?.name).toBe("made");
    expect(body.saved?.state).toBe("active");
    expect(body.plugins.map((plugin) => plugin.file)).toContain("made.ts");

    const read = (await (await get("/plugins/source?file=made.ts")).json()) as { file: string; source: string };
    expect(read.source).toContain(`name: "made"`);
  });

  test("editing replaces the file, and the new manifest is what the list shows", async () => {
    await boot();
    await send("PUT", "/plugins/source", { file: "made.ts", source: source("made") });

    const edited = source("made", "").replace('description: "written through the API"', 'description: "edited"');
    const response = await send("PUT", "/plugins/source", { file: "made.ts", source: edited, overwrite: true });
    expect(response.status).toBe(200);

    const listed = (await (await get("/plugins")).json()) as { plugins: PluginStatus[] };
    expect(listed.plugins.find((plugin) => plugin.file === "made.ts")?.description).toBe("edited");
  });

  test("saving over an existing file without asking to is refused", async () => {
    // Not a nicety: "New plugin" prefills a filename, and two people who both
    // accept the default would otherwise silently overwrite one another.
    await boot();
    await send("PUT", "/plugins/source", { file: "made.ts", source: source("made") });

    const clash = await send("PUT", "/plugins/source", { file: "made.ts", source: source("other") });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { tag: string }).tag).toBe("PluginFileExists");
  });

  test("delete removes the file and the plugin with it", async () => {
    await boot();
    await send("PUT", "/plugins/source", { file: "made.ts", source: source("made") });

    const removed = await send("DELETE", "/plugins/source?file=made.ts");
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { plugins: PluginStatus[] }).plugins).toEqual([]);

    expect((await get("/plugins/source?file=made.ts")).status).toBe(404);
    expect((await send("DELETE", "/plugins/source?file=made.ts")).status).toBe(404);
  });

  test("a filename that would never load is refused, and nothing is written", async () => {
    await boot();
    for (const file of ["../escape.ts", "_draft.ts", "notes.md", "a.test.ts"]) {
      const response = await send("PUT", "/plugins/source", { file, source: source("x") });
      expect(`${file}: ${response.status}`).toBe(`${file}: 400`);
      expect(((await response.json()) as { tag: string }).tag).toBe("InvalidPluginFile");
    }
    expect(((await (await get("/plugins")).json()) as { plugins: PluginStatus[] }).plugins).toEqual([]);
  });

  test("🔴 a plugin with a syntax error is saved, reported, and takes nothing else down", async () => {
    await boot();
    await send("PUT", "/plugins/source", { file: "good.ts", source: source("good") });

    const broken = await send("PUT", "/plugins/source", { file: "bad.ts", source: "export default { unclosed" });
    // 200, because the write happened. The plugin's *state* carries the failure
    // — reporting it as a failed request would claim nothing was saved.
    expect(broken.status).toBe(200);
    const body = (await broken.json()) as { saved: PluginStatus | null; plugins: PluginStatus[] };

    expect(body.saved?.state).toBe("error");
    expect(body.saved?.error).toContain("could not be imported");

    // The whole point: everything else is still loaded and still working.
    const good = body.plugins.find((plugin) => plugin.file === "good.ts");
    expect(good?.state).toBe("active");
    expect(good?.error).toBeUndefined();

    // And it is still fixable from here — the broken file opens by filename,
    // because it has no manifest and therefore no name.
    const reopened = (await (await get("/plugins/source?file=bad.ts")).json()) as { source: string };
    expect(reopened.source).toBe("export default { unclosed");

    const fixed = await send("PUT", "/plugins/source", { file: "bad.ts", source: source("bad"), overwrite: true });
    expect(((await fixed.json()) as { saved: PluginStatus }).saved.state).toBe("active");
  });

  test("a plugin whose setup throws does not stop the others loading either", async () => {
    await boot();
    await send("PUT", "/plugins/source", { file: "good.ts", source: source("good") });

    const response = await send("PUT", "/plugins/source", {
      file: "boom.ts",
      source: `export default { name: "boom", description: "throws", setup() { throw new Error("nope"); } };`,
    });
    const body = (await response.json()) as { saved: PluginStatus | null; plugins: PluginStatus[] };

    expect(body.saved?.state).toBe("error");
    expect(body.saved?.error).toContain("nope");
    expect(body.plugins.find((plugin) => plugin.file === "good.ts")?.state).toBe("active");
  });

  test("every save carries the sandbox warning, not just the first", async () => {
    // ⚠️ An editor makes running code on the server easy, which makes this
    // sentence matter more rather than less — and a warning shown once is a
    // warning shown to whoever set the machine up, not to whoever is editing.
    await boot();
    const first = await send("PUT", "/plugins/source", { file: "made.ts", source: source("made") });
    const second = await send("PUT", "/plugins/source", {
      file: "made.ts",
      source: source("made"),
      overwrite: true,
    });

    for (const response of [first, second]) {
      const { warning } = (await response.json()) as { warning: string };
      expect(warning).toContain("not a sandbox");
      expect(warning).toContain("privileges");
    }
  });

  test("the template is what the editor starts from, and it loads through this route", async () => {
    await boot();
    const template = await (await get("/plugins/template")).text();

    const response = await send("PUT", "/plugins/source", { file: "from-template.ts", source: template });
    const body = (await response.json()) as { saved: PluginStatus | null };
    expect(body.saved?.state).toBe("active");
    expect(body.saved?.name).toBe("my-plugin");
  });
});

/**
 * Declared settings over HTTP.
 *
 * 🔴 The load-bearing test in here is the last one: a secret's value must not
 * appear in **any** response, and the way to check that is to search the whole
 * serialised body for the string rather than to check the one field somebody
 * remembered to redact.
 */
describe("plugin settings", () => {
  const configurable = `export default {
    name: "conf",
    description: "has settings",
    settings: [
      { key: "SITE", label: "Site", default: "http://default.local" },
      { key: "TOKEN", label: "Token", secret: true, required: true }
    ],
    hooks: [{ at: "job:completed", kind: "observe" }],
    setup({ on, log, config }) {
      // ⚠️ The length, never the value. A plugin's log is returned by the API,
      // and nothing on the server can redact what a plugin chose to print — so
      // a test that logged the token would be proving the leak rather than
      // catching it. The length is enough to show the value arrived.
      log("SITE=" + String(config.SITE) + " TOKEN_LEN=" + String(config.TOKEN ? String(config.TOKEN).length : 0));
      on("job:completed", () => {});
    }
  };`;

  async function settingsOf(): Promise<ResolvedSetting[]> {
    const body = (await (await get("/plugins/conf/settings")).json()) as { settings: ResolvedSetting[] };
    return body.settings;
  }

  test("the declaration travels on the listing, so the form exists before setup ran", async () => {
    write("conf.ts", configurable);
    await boot();

    const body = (await (await get("/plugins")).json()) as { plugins: PluginStatus[] };
    const conf = body.plugins.find((plugin) => plugin.name === "conf");
    expect(conf?.settings?.map((setting) => setting.key)).toEqual(["SITE", "TOKEN"]);
    // A required setting with nothing behind it is reported, because "active
    // and doing nothing" looks exactly like "working".
    expect(conf?.missingSettings).toEqual(["TOKEN"]);
  });

  test("each value reports the layer it came from", async () => {
    write("conf.ts", configurable);
    await boot({ SITE: "http://from-env" });

    const before = await settingsOf();
    expect(before.find((setting) => setting.key === "SITE")?.source).toBe("environment");
    expect(before.find((setting) => setting.key === "SITE")?.value).toBe("http://from-env");

    const saved = await send("PUT", "/plugins/conf/settings", { values: { SITE: "http://typed" } });
    expect(saved.status).toBe(200);

    const after = await settingsOf();
    const site = after.find((setting) => setting.key === "SITE");
    expect(site?.source).toBe("stored");
    expect(site?.value).toBe("http://typed");
    // 🔴 The environment underneath was never written to. That is what makes
    // the revert button honest rather than a second guess.
    expect(site?.fallback).toBe("environment");
    expect(site?.fallbackValue).toBe("http://from-env");

    // And the plugin was actually re-run with it.
    expect(runtime.list().find((plugin) => plugin.name === "conf")?.log.join("\n")).toContain("SITE=http://typed");
  });

  test("null reverts to the environment value", async () => {
    write("conf.ts", configurable);
    await boot({ SITE: "http://from-env" });
    await send("PUT", "/plugins/conf/settings", { values: { SITE: "http://typed" } });

    await send("PUT", "/plugins/conf/settings", { values: { SITE: null } });

    const site = (await settingsOf()).find((setting) => setting.key === "SITE");
    expect(site?.source).toBe("environment");
    expect(site?.value).toBe("http://from-env");
    expect(runtime.list().find((plugin) => plugin.name === "conf")?.log.join("\n")).toContain("SITE=http://from-env");
  });

  test("a key the plugin never declared is a 400, not a silent write", async () => {
    write("conf.ts", configurable);
    await boot();
    const response = await send("PUT", "/plugins/conf/settings", { values: { NOPE: "x" } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { tag: string }).tag).toBe("UnknownPluginSetting");
  });

  test("settings for a plugin that is not there is a 404", async () => {
    await boot();
    expect((await get("/plugins/ghost/settings")).status).toBe(404);
  });

  test("🔴 a secret's value never leaves the server, through any of these routes", async () => {
    write("conf.ts", configurable);
    await boot();
    await send("PUT", "/plugins/conf/settings", { values: { TOKEN: "hunter2" } });

    // It reached the plugin — otherwise this test would pass for the wrong
    // reason, by asserting that a value nobody stored is absent.
    expect(runtime.list().find((plugin) => plugin.name === "conf")?.log.join("\n")).toContain("TOKEN_LEN=7");

    for (const path of ["/plugins", "/plugins/conf/settings", "/plugins/applicable?url=https%3A%2F%2Fe.com%2Fa"]) {
      const text = await (await get(path)).text();
      expect(`${path}: ${text.includes("hunter2")}`).toBe(`${path}: false`);
    }

    // The presence is reported, because the form has to be able to say whether
    // a token is set at all.
    const token = (await settingsOf()).find((setting) => setting.key === "TOKEN");
    expect(token?.configured).toBe(true);
    expect(token?.source).toBe("stored");
    expect(token?.value).toBeUndefined();
  });

  test("a secret declared with a default does not leak it on the listing either", async () => {
    write(
      "leaky.ts",
      `export default {
         name: "leaky",
         description: "declares a secret with a default",
         settings: [{ key: "TOKEN", label: "Token", secret: true, default: "hunter2" }],
         setup() {}
       };`,
    );
    await boot();
    expect(await (await get("/plugins")).text()).not.toContain("hunter2");
  });
});
