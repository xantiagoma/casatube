/**
 * `/api/settings`, over HTTP, against a real database file.
 *
 * The routes are mounted on their own: they read and write one table and
 * nothing else, so standing up the whole application to prove it would make the
 * test slower and less specific rather than more honest.
 *
 * ⚠️ A file, never `:memory:` — the reset and restart-scoped assertions are
 * about what survives, and an in-memory database cannot say.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppSettingsStore, SETTING_DEFINITIONS, type ResolvedSetting } from "../core/app-settings";
import { closeDb, openDb, type Db } from "../core/db";
import { applyStoredSettings, settingRoutes } from "./settings";
import { loadConfig } from "./config";

let dir: string;
let db: Db;
let settings: AppSettingsStore;
let app: ReturnType<typeof build>;

function build(): Elysia {
  return new Elysia({ prefix: "/api" }).use(settingRoutes({ settings })) as unknown as Elysia;
}

function mount(env: Record<string, string | undefined> = {}): void {
  settings = new AppSettingsStore({ db, env });
  app = build();
}

async function get(path: string): Promise<Response> {
  return app.handle(new Request(`http://local${path}`));
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://local${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const put = (key: string, value: unknown): Promise<Response> => send("PUT", `/api/settings/${key}`, { value });
const reset = (key: string): Promise<Response> => send("DELETE", `/api/settings/${key}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-settings-api-"));
  db = openDb({ path: join(dir, "casatube.db") });
  mount();
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/settings", () => {
  test("lists every setting, with its group and its variable", async () => {
    const response = await get("/api/settings");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settings: ResolvedSetting[];
      groups: { id: string }[];
      restartPending: boolean;
    };

    expect(body.settings).toHaveLength(SETTING_DEFINITIONS.length);
    expect(body.restartPending).toBe(false);
    // 🔴 The question the read-only screen could not answer. Every one of them.
    for (const setting of body.settings) {
      expect(setting.envVar).not.toBe("");
      expect(["user", "env", "default"]).toContain(setting.source);
      expect(["live", "restart"]).toContain(setting.effect);
    }
    // Every setting belongs to a group the same response describes.
    const groups = new Set(body.groups.map((group) => group.id));
    expect(body.settings.every((setting) => groups.has(setting.group))).toBe(true);
  });

  test("carries the merged download defaults, so nothing re-derives them", async () => {
    mount({ DEFAULT_MAX_RESOLUTION: "720" });
    const body = (await (await get("/api/settings")).json()) as { preferences: { maxResolution: number } };
    expect(body.preferences.maxResolution).toBe(720);
  });

  test("⚠️ never sends the cookies path, only whether one is configured", async () => {
    mount({ COOKIES_FILE: "/data/cookies.txt" });
    const raw = await (await get("/api/settings")).text();

    expect(raw).not.toContain("/data/cookies.txt");
    expect(raw).toContain("COOKIES_FILE");
    const body = JSON.parse(raw) as { settings: ResolvedSetting[] };
    const cookies = body.settings.find((setting) => setting.key === "server.cookiesFile")!;
    expect(cookies.value).toBeNull();
    expect(cookies.configured).toBe(true);
  });
});

describe("PUT /api/settings/:key", () => {
  test("writes, and answers with the setting as it now resolves", async () => {
    const response = await put("downloads.maxResolution", 720);
    expect(response.status).toBe(200);

    const body = (await response.json()) as ResolvedSetting;
    expect(body.value).toBe(720);
    expect(body.source).toBe("user");
    expect(body.pendingRestart).toBe(false);
    expect(body.updatedAt).not.toBeNull();
  });

  test("a live setting is in force on the very next read", async () => {
    await put("downloads.videoCodec", "av1");
    const body = (await (await get("/api/settings")).json()) as { preferences: { videoCodec: string } };
    expect(body.preferences.videoCodec).toBe("av1");
  });

  test("🔴 a restart setting answers 200 and says it is not in force yet", async () => {
    await settings.captureRunning();
    const body = (await (await put("server.port", 9000)).json()) as ResolvedSetting;

    expect(body.value).toBe(9000);
    expect(body.runningValue).toBe(8520);
    expect(body.pendingRestart).toBe(true);
    expect(body.restartReason).toContain("bound once");

    const snapshot = (await (await get("/api/settings")).json()) as { restartPending: boolean };
    expect(snapshot.restartPending).toBe(true);
  });

  test("a refused value is a 422 naming the rule, and writes nothing", async () => {
    const response = await put("downloads.maxResolution", 99999);
    expect(response.status).toBe(422);

    const body = (await response.json()) as { tag: string; message: string; retryable: boolean };
    expect(body.tag).toBe("InvalidSettingValue");
    expect(body.message).toContain("Must be at most 4320");
    expect(body.retryable).toBe(false);

    const after = (await (await get("/api/settings")).json()) as { settings: ResolvedSetting[] };
    const setting = after.settings.find((s) => s.key === "downloads.maxResolution")!;
    expect(setting.source).toBe("default");
  });

  test("a setting that cannot be written says why, rather than 404ing", async () => {
    const response = await put("server.dataDir", "/elsewhere");
    expect(response.status).toBe(422);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("inside this directory");
  });

  test("an unknown key is a 404", async () => {
    expect((await put("downloads.nonsense", 1)).status).toBe(404);
  });
});

describe("DELETE /api/settings/:key — reset", () => {
  test("says which layer the value fell back to", async () => {
    mount({ DEFAULT_MAX_RESOLUTION: "720" });
    await put("downloads.maxResolution", 2160);

    const body = (await (await reset("downloads.maxResolution")).json()) as ResolvedSetting;
    expect(body.value).toBe(720);
    expect(body.source).toBe("env");
    expect(body.userValue).toBeNull();
    expect(body.resetsTo).toBeNull();
  });

  test("falls back to the code's default when nothing else is set", async () => {
    await put("downloads.subtitleLanguages", ["es"]);
    const body = (await (await reset("downloads.subtitleLanguages")).json()) as ResolvedSetting;
    expect(body.value).toEqual(["en"]);
    expect(body.source).toBe("default");
  });

  test("is idempotent", async () => {
    expect((await reset("downloads.sponsorblock")).status).toBe(200);
    expect((await reset("downloads.sponsorblock")).status).toBe(200);
  });

  test("an unknown key is a 404", async () => {
    expect((await reset("downloads.nonsense")).status).toBe(404);
  });
});

describe("applyStoredSettings — the boot half of a restart-scoped setting", () => {
  test("a stored override wins over the environment at the next boot", async () => {
    await put("server.port", 9000);
    await put("library.trashRetentionDays", 7);
    await put("playback.hlsMaxSessions", 1);

    const config = await applyStoredSettings(loadConfig({ PORT: "8520" }), settings);
    expect(config.port).toBe(9000);
    expect(config.trashRetentionDays).toBe(7);
    expect(config.hls.maxSessions).toBe(1);
  });

  test("without an override, the environment is left exactly as it was", async () => {
    const base = loadConfig({ PORT: "9999", LIBRARY_DIR: "/mnt/media", DATA_DIR: "/srv/data" });
    const config = await applyStoredSettings(base, settings);
    expect(config).toEqual(base);
  });

  test("⚠️ tempDir keeps its derived default rather than being flattened", async () => {
    // Reported honestly too: with `derivedDefaults` the screen shows the path
    // the worker really uses, not the `""` placeholder in the catalogue.
    const reported = new AppSettingsStore({ db, env: {}, derivedDefaults: { "server.tempDir": "/srv/data/tmp" } });
    const shown = (await reported.list()).find((setting) => setting.key === "server.tempDir")!;
    expect(shown.value).toBe("/srv/data/tmp");
    expect(shown.defaultValue).toBe("/srv/data/tmp");
    expect(shown.source).toBe("default");

    // `TEMP_DIR` defaults to `${DATA_DIR}/tmp`, which no static default in the
    // catalogue can express. Applying the catalogue's empty default here would
    // move every in-flight download to "".
    const base = loadConfig({ DATA_DIR: "/srv/data" });
    expect(base.tempDir).toBe("/srv/data/tmp");
    expect((await applyStoredSettings(base, settings)).tempDir).toBe("/srv/data/tmp");

    await put("server.tempDir", "/scratch");
    expect((await applyStoredSettings(base, settings)).tempDir).toBe("/scratch");
  });

  test("an emptied binary path means 'on PATH', not an empty command", async () => {
    const base = loadConfig({ YTDLP_BIN: "/opt/yt-dlp/yt-dlp" });
    expect((await applyStoredSettings(base, settings)).ytdlpBinary).toBe("/opt/yt-dlp/yt-dlp");

    await put("server.ytdlpBinary", "");
    expect((await applyStoredSettings(base, settings)).ytdlpBinary).toBeUndefined();
  });
});
