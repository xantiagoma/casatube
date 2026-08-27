/**
 * The sentences the settings rows are made of.
 *
 * There is no DOM harness in this repo, which is exactly why the wording lives
 * in `setting-view.ts` instead of inline in the component: **what a row claims**
 * is the part that can be wrong in a way nobody notices, and it is checkable
 * here in milliseconds.
 *
 * 🔴 Three of these assert an *absence*: an unset variable still gets named, a
 * secret's value never appears in any string, and no reset is offered when there
 * is nothing underneath. Each one is a way the old screen was silent.
 */
import { describe, expect, test } from "bun:test";

import type { ResolvedSetting } from "../../../core/app-settings";
import {
  addLanguages,
  displayValue,
  envSentence,
  optionLabel,
  parseLanguageInput,
  parseNumberInput,
  pendingSentence,
  pendingSettings,
  rangeHint,
  resetLabel,
  sameValue,
  settingsOf,
  sourceSentence,
} from "./setting-view";

function setting(over: Partial<ResolvedSetting> = {}): ResolvedSetting {
  return {
    key: "downloads.maxResolution",
    group: "downloads",
    label: "Maximum resolution",
    description: "The ceiling a job downloads at when nothing else is stated.",
    kind: "integer",
    envVar: "DEFAULT_MAX_RESOLUTION",
    value: 1080,
    source: "default",
    defaultValue: 1080,
    envValue: null,
    envInvalid: false,
    userValue: null,
    updatedAt: null,
    resetsTo: null,
    effect: "live",
    restartReason: null,
    runningValue: 1080,
    pendingRestart: false,
    editable: true,
    editableReason: null,
    configured: true,
    secret: false,
    options: null,
    min: 144,
    max: 4320,
    ...over,
  };
}

describe("displayValue", () => {
  test("says on and off rather than true and false", () => {
    const boolean = setting({ kind: "boolean" });
    expect(displayValue(boolean, true)).toBe("on");
    expect(displayValue(boolean, false)).toBe("off");
  });

  test("an empty language list is 'none', not an empty string", () => {
    const languages = setting({ kind: "languages" });
    expect(displayValue(languages, [])).toBe("none");
    expect(displayValue(languages, ["en", "es"])).toBe("en, es");
  });

  test("an empty string is named, because a blank on screen reads as broken", () => {
    expect(displayValue(setting({ kind: "string" }), "")).toBe("empty");
  });

  test("🔴 a secret reports whether one is configured, never a value", () => {
    const secret = setting({ kind: "string", secret: true, value: null });
    expect(displayValue({ ...secret, configured: true }, null)).toBe("configured");
    expect(displayValue({ ...secret, configured: false }, null)).toBe("not set");
  });
});

describe("envSentence", () => {
  test("⚠️ an unset variable still gets a sentence — that is the whole point", () => {
    expect(envSentence(setting())).toBe("is not set");
  });

  test("a set variable is quoted with its value", () => {
    expect(envSentence(setting({ envValue: 720, source: "env", value: 720 }))).toBe("= 720");
  });

  test("🔴 an unreadable variable says it is being ignored", () => {
    // `PORT=banana`: the server falls through to the default and reports it.
    const broken = setting({ key: "server.port", envVar: "PORT", envInvalid: true, envValue: null });
    expect(envSentence(broken)).toContain("ignored");
  });

  test("a secret says whether it is set without saying what it is", () => {
    const cookies = setting({
      key: "server.cookiesFile",
      envVar: "COOKIES_FILE",
      secret: true,
      source: "env",
      value: null,
      envValue: null,
    });
    expect(envSentence(cookies)).toBe("is set — its value is never sent to this screen");
    expect(envSentence({ ...cookies, source: "default" })).toBe("is not set");
  });
});

describe("sourceSentence", () => {
  test("an override names the variable it is sitting on top of", () => {
    const overridden = setting({ source: "user", value: 720, userValue: 720, envValue: 2160 });
    expect(sourceSentence(overridden)).toContain("DEFAULT_MAX_RESOLUTION still says 2160");
  });

  test("an override with no variable underneath names the code default instead", () => {
    const overridden = setting({ source: "user", value: 720, userValue: 720, envValue: null });
    expect(sourceSentence(overridden)).toContain("code default (1080)");
  });

  test("⚠️ a plain default gets no sentence — the badge beside it already says so", () => {
    expect(sourceSentence(setting())).toBeNull();
  });

  test("an environment value says so and still reports the default", () => {
    expect(sourceSentence(setting({ source: "env", value: 720, envValue: 720 }))).toBe(
      "Read from DEFAULT_MAX_RESOLUTION. The code default is 1080.",
    );
  });
});

describe("resetLabel", () => {
  test("🔴 nothing to reset to means no button at all", () => {
    expect(resetLabel(setting({ resetsTo: null }))).toBeNull();
  });

  test("names the variable and what it would put back", () => {
    const stored = setting({ source: "user", value: 720, resetsTo: { source: "env", value: 2160 } });
    expect(resetLabel(stored)).toBe("Reset to DEFAULT_MAX_RESOLUTION (2160)");
  });

  test("names the code default when that is the layer underneath", () => {
    const stored = setting({ source: "user", value: 720, resetsTo: { source: "default", value: 1080 } });
    expect(resetLabel(stored)).toBe("Reset to the code default (1080)");
  });

  test("a withheld value leaves the layer named and the value out", () => {
    const stored = setting({ secret: true, resetsTo: { source: "env", value: null } });
    expect(resetLabel(stored)).toBe("Reset to DEFAULT_MAX_RESOLUTION");
  });
});

describe("pending restarts", () => {
  const port = setting({
    key: "server.port",
    label: "HTTP port",
    envVar: "PORT",
    kind: "integer",
    effect: "restart",
    value: 9000,
    source: "user",
    runningValue: 8520,
    pendingRestart: true,
    restartReason: "The socket is bound once, as the process starts.",
  });

  test("🔴 the sentence carries both numbers, not just the stored one", () => {
    const said = pendingSentence(port);
    expect(said).toContain("Running now: 8520");
    expect(said).toContain("After a restart: 9000");
  });

  test("only the settings that actually disagree are counted", () => {
    expect(pendingSettings([setting(), port])).toEqual([port]);
    expect(pendingSettings([setting()])).toHaveLength(0);
  });
});

describe("grouping", () => {
  test("keeps catalogue order within a group", () => {
    const rows = [
      setting({ key: "downloads.a" }),
      setting({ key: "server.port", group: "server" }),
      setting({ key: "downloads.b" }),
    ];
    expect(settingsOf(rows, "downloads").map((row) => row.key)).toEqual(["downloads.a", "downloads.b"]);
    expect(settingsOf(rows, "server").map((row) => row.key)).toEqual(["server.port"]);
  });
});

describe("language tags", () => {
  test("commas, spaces and newlines all separate", () => {
    expect(parseLanguageInput("en, es\npt-BR  fr")).toEqual(["en", "es", "fr", "pt-br"]);
  });

  test("de-duplicated and sorted, the way the server stores them", () => {
    expect(parseLanguageInput("es,en,es")).toEqual(["en", "es"]);
    expect(addLanguages(["es"], "en, es")).toEqual(["en", "es"]);
  });

  test("nothing typed adds nothing", () => {
    expect(parseLanguageInput("  ")).toEqual([]);
    expect(addLanguages(["en"], "")).toEqual(["en"]);
  });
});

describe("numbers", () => {
  test("⚠️ an empty field is not zero", () => {
    expect(parseNumberInput("")).toBeNull();
    expect(parseNumberInput("banana")).toBeNull();
    expect(parseNumberInput(" 720 ")).toBe(720);
  });

  test("the range hint follows whatever the definition states", () => {
    expect(rangeHint(setting())).toBe("144–4320");
    expect(rangeHint(setting({ min: 100, max: null }))).toBe("at least 100");
    expect(rangeHint(setting({ min: null, max: 8 }))).toBe("at most 8");
    expect(rangeHint(setting({ min: null, max: null }))).toBeNull();
  });
});

describe("the small pieces", () => {
  test("equality is structural for the language lists", () => {
    expect(sameValue(["en", "es"], ["en", "es"])).toBe(true);
    expect(sameValue(["en", "es"], ["es", "en"])).toBe(false);
    expect(sameValue(["en"], "en")).toBe(false);
    expect(sameValue(720, 720)).toBe(true);
  });

  test("an enum shows the option's own words, and falls back to the raw value", () => {
    const codec = setting({
      kind: "enum",
      value: "auto",
      options: [{ value: "auto", label: "auto — H.264 first" }],
    });
    expect(optionLabel(codec, "auto")).toBe("auto — H.264 first");
    expect(optionLabel(codec, "av1")).toBe("av1");
  });
});
