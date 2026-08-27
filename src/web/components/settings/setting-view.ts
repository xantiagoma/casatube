/**
 * The sentences the settings rows are made of, as pure functions.
 *
 * 🔴 **Every one of these answers a question the old read-only screen could
 * not.** Which variable sets this? Where is the value coming from right now?
 * What would a reset put back? Is the number on screen the one the process is
 * actually using? None of that is styling, so none of it is in the component —
 * it is here, where it can be asserted without a browser.
 *
 * ⚠️ Nothing here re-derives precedence. `source`, `resetsTo`, `runningValue`
 * and `pendingRestart` arrive already resolved from `core/app-settings.ts`,
 * which is the only implementation of the rule (user > environment > default).
 * A second one in the browser is a second answer to "why is this 720p".
 */
import type { ResolvedSetting, SettingSource, SettingValue } from "../../../core/app-settings";

/** The three origins, in the words the badges use. */
export const SOURCE_LABEL: Record<SettingSource, string> = {
  default: "code default",
  env: "environment",
  user: "set here",
};

/**
 * How each origin looks.
 *
 * 🔴 Colour is the *second* signal, never the only one: every badge carries its
 * word and its own icon, and the row states the origin in a sentence underneath
 * as well. A reader who cannot separate a tinted pill from a grey one still
 * gets the answer.
 *
 * ⚠️ They also differ in **weight**, not only in hue: grey wash, tinted wash,
 * then a *solid* pill. Two tinted washes a few degrees apart on the colour wheel
 * are nearly the same badge in a dark theme — measured by looking at one — and
 * "the environment set this" versus "I set this" is the single most important
 * distinction on the screen.
 *
 * The tokens are the theme's, so light and dark are both handled by definition:
 * `muted` for the value nobody chose, `accent` for one the environment supplied,
 * `primary` for one that was chosen on this screen.
 */
export const SOURCE_CLASS: Record<SettingSource, string> = {
  default: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
  env: "bg-accent text-accent-foreground ring-1 ring-inset ring-accent-foreground/25",
  user: "bg-primary text-primary-foreground ring-1 ring-inset ring-primary",
};

/** Structural equality — the arrays are language lists, so order matters. */
export function sameValue(a: SettingValue | null, b: SettingValue | null): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

/**
 * A value, as one short string.
 *
 * ⚠️ `null` is not "empty": for a secret it means the server refused to send it
 * (PLAN §12), and the honest rendering of that is what it is *configured* to be,
 * not a blank. Anywhere else `null` is a value that does not exist.
 */
export function displayValue(setting: ResolvedSetting, value: SettingValue | null): string {
  if (value === null) {
    if (setting.secret) return setting.configured ? "configured" : "not set";
    return "—";
  }
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  if (typeof value === "string") return value === "" ? "empty" : value;
  return String(value);
}

/** An enum's option label, for the control. Falls back to the raw value. */
export function optionLabel(setting: ResolvedSetting, value: SettingValue | null): string {
  const match = setting.options?.find((option) => option.value === value);
  return match?.label ?? displayValue(setting, value);
}

/**
 * What the environment variable is doing — the half of the question Santi could
 * not answer from the old screen.
 *
 * 🔴 **The variable is named whether or not it is set**, so this never returns
 * nothing: "not set" is an answer, and it is the one that tells you what to put
 * in the compose file.
 *
 * ⚠️ The *raw* text of an unreadable variable never leaves the server, so this
 * says the variable is being ignored without quoting what it says. Claiming a
 * value we were not sent would be worse than the silence it replaces.
 */
export function envSentence(setting: ResolvedSetting): string {
  if (setting.envInvalid) return "is set to something this build cannot read, so it is being ignored";
  if (setting.secret) {
    return setting.source === "env"
      ? "is set — its value is never sent to this screen"
      : "is not set";
  }
  if (setting.envValue === null) return "is not set";
  return `= ${displayValue(setting, setting.envValue)}`;
}

/**
 * One line naming which layer wins, and what the losers still say.
 *
 * ⚠️ `null` for a plain default, and that is a decision about noise rather than
 * about honesty: with twenty-five rows on one screen, "nothing sets it, so it is
 * the code default" repeated eighteen times is a paragraph that pushes the two
 * rows which *do* have something to say off the bottom of an iPad. The badge and
 * the `VAR is not set` line beside it already carry that answer.
 */
export function sourceSentence(setting: ResolvedSetting): string | null {
  switch (setting.source) {
    case "user":
      return setting.envValue !== null
        ? `Overridden here. ${setting.envVar} still says ${displayValue(setting, setting.envValue)}, and nothing on this screen changed it.`
        : `Overridden here. Without this, it would be the code default (${displayValue(setting, setting.defaultValue)}).`;
    case "env":
      return `Read from ${setting.envVar}. The code default is ${displayValue(setting, setting.defaultValue)}.`;
    case "default":
      return null;
  }
}

/**
 * What reset would do, named after the layer that answers next.
 *
 * `null` when there is nothing underneath — the button is not offered at all
 * rather than offered and inert. `resetsTo` arrives resolved, so this is a
 * rendering of the server's answer, not a guess at one.
 */
export function resetLabel(setting: ResolvedSetting): string | null {
  if (setting.resetsTo === null) return null;
  const where = setting.resetsTo.source === "env" ? `${setting.envVar}` : "the code default";
  // A secret's fallback value is withheld, so name the layer and stop there.
  if (setting.resetsTo.value === null) return `Reset to ${where}`;
  return `Reset to ${where} (${displayValue(setting, setting.resetsTo.value)})`;
}

/**
 * The whole of a pending restart, in one sentence.
 *
 * 🔴 The two values are the point. "Waiting for a restart" alone leaves the
 * reader unable to tell which number is in force, which is the same silence as
 * showing the stored value and calling it current.
 */
export function pendingSentence(setting: ResolvedSetting): string {
  return `Saved, and not in force yet. Running now: ${displayValue(setting, setting.runningValue)}. After a restart: ${displayValue(setting, setting.value)}.`;
}

/** Every setting whose stored value is not the one the process is using. */
export function pendingSettings(settings: readonly ResolvedSetting[]): ResolvedSetting[] {
  return settings.filter((setting) => setting.pendingRestart);
}

/** The settings of one group, in catalogue order. */
export function settingsOf(settings: readonly ResolvedSetting[], group: string): ResolvedSetting[] {
  return settings.filter((setting) => setting.group === group);
}

/**
 * Language tags out of whatever was typed.
 *
 * Commas, spaces and newlines all separate — pasting `en, es` and typing
 * `en es` are the same intention, and refusing one of them teaches a rule
 * nobody wants to learn. Lower-cased, de-duplicated and sorted for the same
 * reason the server does it: `["en","es"]` and `["es","en"]` are one request,
 * and two fingerprints for one request is how duplicate detection stops working.
 *
 * ⚠️ It does **not** validate the tags. `validateValue` on the server owns that
 * rule and answers 422 with the sentence it broke; a second grammar here could
 * refuse a tag the server would have taken.
 */
export function parseLanguageInput(text: string): string[] {
  const tags = text
    .split(/[\s,]+/)
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag !== "");
  return [...new Set(tags)].sort();
}

/** Add tags to a list, keeping it in the shape the server would store. */
export function addLanguages(current: readonly string[], text: string): string[] {
  return [...new Set([...current, ...parseLanguageInput(text)])].sort();
}

/**
 * A number typed into an input, as a value the API will accept — or `null`.
 *
 * `null` for anything unparseable rather than `NaN` or a coerced `0`: an empty
 * field is a field being edited, not a request to set the port to nothing.
 */
export function parseNumberInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The range hint under a number field, when the definition states one. */
export function rangeHint(setting: ResolvedSetting): string | null {
  if (setting.min !== null && setting.max !== null) return `${setting.min}–${setting.max}`;
  if (setting.min !== null) return `at least ${setting.min}`;
  if (setting.max !== null) return `at most ${setting.max}`;
  return null;
}
