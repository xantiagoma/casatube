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

async function boot(): Promise<void> {
  runtime = createPluginRuntime({
    dir,
    stateFile: join(root, "plugin-state.json"),
    config: {},
    log: () => {},
  });
  await runtime.load();
  app = new Elysia({ prefix: "/api" }).use(pluginRoutes(runtime));
}

async function get(path: string): Promise<Response> {
  return app.handle(new Request(`http://local/api${path}`));
}

async function post(path: string): Promise<Response> {
  return app.handle(new Request(`http://local/api${path}`, { method: "POST" }));
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

  test("no plugins is an empty list", async () => {
    await boot();
    expect((await (await get("/plugins")).json()) as unknown).toEqual({ plugins: [] });
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
