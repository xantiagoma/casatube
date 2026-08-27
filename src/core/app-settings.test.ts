/**
 * Precedence, reset, and the live/restart distinction — against a real file.
 *
 * ⚠️ **`:memory:` is not used anywhere in here.** Two of these tests close the
 * database and reopen it against the same path, which is the only way to prove
 * that a stored override survives a restart — and surviving a restart is the
 * entire claim a restart-scoped setting makes. With an in-memory database that
 * assertion would pass by not being tested.
 *
 * 📌 Two of the tests below exist to check the *instrument* rather than the
 * feature: `an environment variable that cannot be parsed is reported, not
 * obeyed` and `a stored value that no longer validates is ignored`. Both were
 * written by breaking the code on purpose first and confirming they failed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AppSettingsStore,
  SETTING_DEFINITIONS,
  parseEnvValue,
  settingDefinition,
  validateValue,
} from "./app-settings";
import { closeDb, openDb, type Db } from "./db";
import { settings as settingsTable } from "./schema";
import { DEFAULT_PREFERENCES } from "./types";

let dir: string;
let db: Db;

const dbPath = (): string => join(dir, "casatube.db");

function store(env: Record<string, string | undefined> = {}): AppSettingsStore {
  return new AppSettingsStore({ db, env });
}

/** The value, or the failure's detail — so a test can assert on either. */
function unwrap<T>(result: Result<T, { _tag: string; detail?: string }>): T {
  if (Result.isError(result)) throw new Error(`expected ok, got ${result.error._tag}`);
  return result.value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-settings-"));
  db = openDb({ path: dbPath() });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("precedence: user > environment > default", () => {
  test("with nothing set, the code's default wins and says so", async () => {
    const resolved = unwrap(await store().resolve("downloads.maxResolution"));

    expect(resolved.value).toBe(DEFAULT_PREFERENCES.maxResolution);
    expect(resolved.source).toBe("default");
    expect(resolved.envValue).toBeNull();
    expect(resolved.userValue).toBeNull();
    // The whole point of the exercise: the variable is named even when unset.
    expect(resolved.envVar).toBe("DEFAULT_MAX_RESOLUTION");
  });

  test("an environment variable beats the default", async () => {
    const resolved = unwrap(await store({ DEFAULT_MAX_RESOLUTION: "720" }).resolve("downloads.maxResolution"));

    expect(resolved.value).toBe(720);
    expect(resolved.source).toBe("env");
    expect(resolved.envValue).toBe(720);
    expect(resolved.defaultValue).toBe(1080);
  });

  test("a user override beats the environment variable", async () => {
    const settings = store({ DEFAULT_MAX_RESOLUTION: "720" });
    await settings.set("downloads.maxResolution", 2160);

    const resolved = unwrap(await settings.resolve("downloads.maxResolution"));
    expect(resolved.value).toBe(2160);
    expect(resolved.source).toBe("user");
    expect(resolved.userValue).toBe(2160);
    // ⚠️ The two it beat are still reported. A screen that could not show what
    // is underneath could not explain what a reset would do.
    expect(resolved.envValue).toBe(720);
    expect(resolved.defaultValue).toBe(1080);
  });

  test("all three layers at once, on one setting", async () => {
    // The same key resolved three times, with only the layers changing.
    expect(unwrap(await store().resolve("downloads.sponsorblock")).source).toBe("default");
    expect(unwrap(await store({ DEFAULT_SPONSORBLOCK: "false" }).resolve("downloads.sponsorblock")).value).toBe(false);

    const settings = store({ DEFAULT_SPONSORBLOCK: "false" });
    await settings.set("downloads.sponsorblock", true);
    const resolved = unwrap(await settings.resolve("downloads.sponsorblock"));
    expect(resolved.value).toBe(true);
    expect(resolved.source).toBe("user");
  });

  test("an override equal to the default is still an override", async () => {
    // 🔴 "Pinned to 1080" and "following whatever the default is" are different
    // states. Collapsing them would silently un-pin a deliberate choice the day
    // someone changes DEFAULT_MAX_RESOLUTION in the environment.
    const settings = store();
    await settings.set("downloads.maxResolution", DEFAULT_PREFERENCES.maxResolution);

    const resolved = unwrap(await settings.resolve("downloads.maxResolution"));
    expect(resolved.source).toBe("user");
    expect(resolved.resetsTo).toEqual({ source: "default", value: 1080 });
  });

  test("an environment variable that cannot be parsed is reported, not obeyed", async () => {
    const resolved = unwrap(await store({ PORT: "banana" }).resolve("server.port"));

    // Same fall-back `api/config.ts` has always had — but now it is visible.
    expect(resolved.value).toBe(8520);
    expect(resolved.source).toBe("default");
    expect(resolved.envValue).toBeNull();
    expect(resolved.envInvalid).toBe(true);
  });

  test("an out-of-range environment variable is out of range, not clamped", async () => {
    // 70000 is not a port. Clamping it to 65535 would be a number nobody chose.
    const resolved = unwrap(await store({ PORT: "70000" }).resolve("server.port"));
    expect(resolved.envInvalid).toBe(true);
    expect(resolved.value).toBe(8520);
  });
});

describe("reset", () => {
  test("falls back to the environment variable, and says which", async () => {
    const settings = store({ DEFAULT_MAX_RESOLUTION: "720" });
    await settings.set("downloads.maxResolution", 2160);

    const before = unwrap(await settings.resolve("downloads.maxResolution"));
    expect(before.resetsTo).toEqual({ source: "env", value: 720 });

    const after = unwrap(await settings.clear("downloads.maxResolution"));
    expect(after.value).toBe(720);
    expect(after.source).toBe("env");
    expect(after.userValue).toBeNull();
    // Nothing left to reset to.
    expect(after.resetsTo).toBeNull();
  });

  test("falls back to the code default when no variable is set", async () => {
    const settings = store();
    await settings.set("downloads.subtitleLanguages", ["es", "fr"]);
    expect(unwrap(await settings.resolve("downloads.subtitleLanguages")).resetsTo).toEqual({
      source: "default",
      value: ["en"],
    });

    const after = unwrap(await settings.clear("downloads.subtitleLanguages"));
    expect(after.value).toEqual(["en"]);
    expect(after.source).toBe("default");
  });

  test("really removes the row, so nothing can resurrect it", async () => {
    const settings = store();
    await settings.set("downloads.embedSubtitles", true);
    expect(await db.select().from(settingsTable)).toHaveLength(1);

    await settings.clear("downloads.embedSubtitles");
    expect(await db.select().from(settingsTable)).toHaveLength(0);
  });

  test("resetting something that was never set is not an error", async () => {
    const after = unwrap(await store().clear("downloads.sponsorblock"));
    expect(after.source).toBe("default");
    expect(after.resetsTo).toBeNull();
  });

  test("an unknown key is NotFound on both write and reset", async () => {
    const settings = store();
    const written = await settings.set("downloads.nope", 1);
    const cleared = await settings.clear("downloads.nope");
    expect(Result.isError(written) && written.error._tag).toBe("NotFound");
    expect(Result.isError(cleared) && cleared.error._tag).toBe("NotFound");
  });
});

describe("it survives a restart", () => {
  test("the override is still there after the database is closed and reopened", async () => {
    await store().set("downloads.maxResolution", 480);
    closeDb(db);

    // A different process would see exactly this: the same file, a new handle.
    db = openDb({ path: dbPath() });
    const resolved = unwrap(await store().resolve("downloads.maxResolution"));
    expect(resolved.value).toBe(480);
    expect(resolved.source).toBe("user");
  });

  test("a stored value that no longer validates is ignored, not served", async () => {
    // A build that tightened the range would otherwise go on serving a number
    // the API itself would now refuse — the setting would be un-writable and
    // un-resettable to anything the code accepts.
    await db.insert(settingsTable).values({ key: "downloads.maxResolution", value: 99999 });

    const resolved = unwrap(await store({ DEFAULT_MAX_RESOLUTION: "720" }).resolve("downloads.maxResolution"));
    expect(resolved.value).toBe(720);
    expect(resolved.source).toBe("env");
    expect(resolved.userValue).toBeNull();
  });

  test("a plugin's row in the same table is not mistaken for a setting", async () => {
    await db.insert(settingsTable).values({ key: "plugin.config:whatever", value: { token: "x" } });
    const all = await store().list();
    expect(all).toHaveLength(SETTING_DEFINITIONS.length);
    expect(all.every((setting) => setting.source === "default")).toBe(true);
  });
});

describe("live versus restart", () => {
  test("a live setting is in force immediately", async () => {
    const settings = store();
    await settings.captureRunning();

    await settings.set("downloads.maxResolution", 720);
    const resolved = unwrap(await settings.resolve("downloads.maxResolution"));

    expect(resolved.effect).toBe("live");
    expect(resolved.pendingRestart).toBe(false);
    // ⚠️ Not the boot snapshot's 1080. A live setting is running whatever it
    // resolves to right now, and saying otherwise would be the reverse of the
    // lie the restart flag exists to prevent.
    expect(resolved.runningValue).toBe(720);
    // And the thing that actually consumes it agrees.
    expect((await settings.preferences()).maxResolution).toBe(720);
  });

  test("🔴 a restart setting is stored, and does not pretend to be in force", async () => {
    const settings = store();
    await settings.captureRunning(); // the process booted on 8520

    const resolved = unwrap(await settings.set("server.port", 9000));

    expect(resolved.effect).toBe("restart");
    expect(resolved.value).toBe(9000); // stored, and real
    expect(resolved.runningValue).toBe(8520); // what the socket is on
    expect(resolved.pendingRestart).toBe(true);
    expect(resolved.restartReason).toContain("bound once");

    const snapshot = await settings.snapshot();
    expect(snapshot.restartPending).toBe(true);
  });

  test("resetting a restart setting back to the running value clears the pending flag", async () => {
    const settings = store();
    await settings.captureRunning();
    await settings.set("server.port", 9000);
    expect(unwrap(await settings.resolve("server.port")).pendingRestart).toBe(true);

    const after = unwrap(await settings.clear("server.port"));
    expect(after.pendingRestart).toBe(false);
    expect(after.value).toBe(8520);
  });

  test("after the restart, the stored value *is* the running value", async () => {
    await store().set("server.port", 9000);
    closeDb(db);

    db = openDb({ path: dbPath() });
    const rebooted = store();
    await rebooted.captureRunning(); // this is what `main()` does at boot

    const resolved = unwrap(await rebooted.resolve("server.port"));
    expect(resolved.value).toBe(9000);
    expect(resolved.runningValue).toBe(9000);
    expect(resolved.pendingRestart).toBe(false);
  });

  test("every restart-scoped setting explains why", () => {
    for (const definition of SETTING_DEFINITIONS) {
      if (definition.effect !== "restart") continue;
      expect(definition.restartReason ?? "").not.toBe("");
    }
  });

  test("🔴 every live setting has something that re-reads it, and this is the list", () => {
    // `live` is a promise to the person on the Settings screen: saving this
    // changes behaviour now. It can only be kept by a reader that goes back to
    // the store, so the list is spelled out here rather than derived — a new
    // `live` setting has to be added to it deliberately, next to the note
    // saying where the re-read happens.
    //
    //   downloads.*                 — api/jobs.ts reads settings.preferences()
    //                                 on every POST /api/jobs.
    //   notifications.retentionDays — core/notification-retention.ts calls
    //   notifications.maxEntries      policyFromSettings() on every sweep.
    const live = SETTING_DEFINITIONS.filter((d) => d.effect === "live").map((d) => d.key);
    expect(live.filter((key) => !key.startsWith("downloads."))).toEqual([
      "notifications.retentionDays",
      "notifications.maxEntries",
    ]);
    expect(live).toHaveLength(9);
  });
});

describe("what cannot be written, and why", () => {
  test("DATA_DIR is refused with the reason, not with a 404", async () => {
    const written = await store().set("server.dataDir", "/somewhere");
    expect(Result.isError(written)).toBe(true);
    if (Result.isError(written) && written.error._tag === "InvalidSettingValue") {
      expect(written.error.detail).toContain("inside this directory");
    } else {
      throw new Error("expected InvalidSettingValue");
    }
    // It is still listed, and still names its variable.
    const resolved = unwrap(await store().resolve("server.dataDir"));
    expect(resolved.editable).toBe(false);
    expect(resolved.envVar).toBe("DATA_DIR");
  });

  test("⚠️ the cookies path never leaves the server, only whether one is set", async () => {
    const withOne = unwrap(await store({ COOKIES_FILE: "/data/cookies.txt" }).resolve("server.cookiesFile"));
    expect(withOne.value).toBeNull();
    expect(withOne.envValue).toBeNull();
    expect(withOne.configured).toBe(true);

    const without = unwrap(await store().resolve("server.cookiesFile"));
    expect(without.configured).toBe(false);
    // The variable name is not a secret, and it is the useful half.
    expect(without.envVar).toBe("COOKIES_FILE");
  });

  test("neither MAX_CONCURRENT_DOWNLOADS nor LOG_LEVEL is offered", () => {
    // They are in the Dockerfile and in docker-compose.yml and are read by
    // nothing. A control for them would change a number and no behaviour.
    const vars = SETTING_DEFINITIONS.map((d) => d.envVar);
    expect(vars).not.toContain("MAX_CONCURRENT_DOWNLOADS");
    expect(vars).not.toContain("LOG_LEVEL");
  });
});

describe("values are refused, never coerced", () => {
  test.each([
    ["downloads.maxResolution", "1080p", "Expected a number."],
    ["downloads.maxResolution", 100, "Must be at least 144."],
    ["downloads.maxResolution", 9000, "Must be at most 4320."],
    ["downloads.maxResolution", 1080.5, "Expected a whole number."],
    ["downloads.sponsorblock", "true", "Expected true or false."],
    ["downloads.videoCodec", "h265", "Expected one of"],
    ["downloads.subtitleLanguages", "en,es", "Expected a list"],
    ["downloads.subtitleLanguages", ["../etc"], "language tag"],
    ["library.libraryDir", "   ", "Cannot be empty"],
  ])("%s rejects %p", async (key, value, detail) => {
    const written = await store().set(key as string, value);
    expect(Result.isError(written)).toBe(true);
    if (Result.isError(written) && written.error._tag === "InvalidSettingValue") {
      expect(written.error.detail).toContain(detail as string);
    } else {
      throw new Error("expected InvalidSettingValue");
    }
    // And nothing was written.
    expect(await db.select().from(settingsTable)).toHaveLength(0);
  });

  test("a binary path may be emptied, because empty means 'on PATH'", async () => {
    const resolved = unwrap(await store().set("server.ytdlpBinary", ""));
    expect(resolved.value).toBe("");
    expect(resolved.source).toBe("user");
  });

  test("language lists are sorted and de-duplicated on the way in", async () => {
    // The same normalisation `resolvePreferences` does, for the same reason:
    // ["en","es"] and ["es","en"] are one request and must not fingerprint as
    // two.
    const resolved = unwrap(await store().set("downloads.audioLanguages", ["ES", "en", " es ", "pt-BR"]));
    expect(resolved.value).toEqual(["en", "es", "pt-br"]);
  });
});

describe("the resolved download defaults", () => {
  test("are what a job with no preferences gets", async () => {
    const settings = store({ DEFAULT_SUBTITLE_LANGUAGES: "es,en" });
    await settings.set("downloads.videoCodec", "h264");
    await settings.set("downloads.originalOnly", false);

    const preferences = await settings.preferences();
    expect(preferences).toEqual({
      originalOnly: false, // user
      audioLanguages: [], // default
      subtitleLanguages: ["en", "es"], // environment, sorted
      maxResolution: 1080, // default
      videoCodec: "h264", // user
      sponsorblock: true, // default
      embedSubtitles: false, // default
    });
  });

  test("every Preferences field has a setting behind it", async () => {
    const settings = store();
    const keys = new Set(SETTING_DEFINITIONS.filter((d) => d.group === "downloads").map((d) => d.key));
    // If a field were missing, `preferences()` would silently keep serving
    // DEFAULT_PREFERENCES for it and the screen would show a control that is
    // not there.
    expect(keys.size).toBe(Object.keys(DEFAULT_PREFERENCES).length);
    expect(await settings.preferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("parsing an environment string", () => {
  const bool = settingDefinition("downloads.sponsorblock")!;
  const languages = settingDefinition("downloads.subtitleLanguages")!;

  test.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["off", false],
  ])("%p reads as %p", (raw, expected) => {
    expect(parseEnvValue(bool, raw as string)).toBe(expected as boolean);
  });

  test("anything else is not a boolean and does not pretend to be one", () => {
    // ⚠️ `null`, not `false`. Reading "maybe" as "off" is a decision nobody made.
    expect(parseEnvValue(bool, "maybe")).toBeNull();
  });

  test("an empty language list is a real answer, not an unset variable", () => {
    // `DEFAULT_SUBTITLE_LANGUAGES=""` means "download no subtitles", which is
    // not the same as leaving the variable out and inheriting `["en"]`.
    expect(parseEnvValue(languages, "")).toEqual([]);
    expect(parseEnvValue(languages, undefined)).toBeNull();
    expect(parseEnvValue(languages, "es, EN ,es")).toEqual(["en", "es"]);
  });

  test("validation and env parsing agree about what a tag is", () => {
    expect(parseEnvValue(languages, "not a tag")).toBeNull();
    expect(Result.isError(validateValue(languages, ["not a tag"]))).toBe(true);
  });
});
