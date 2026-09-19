/**
 * The credential store, against a real database **file**.
 *
 * Not `:memory:` — PLAN §19 and the trap list in WORKLOG both say so, and here
 * the reason is specific rather than ritual: the claim being tested is "the
 * secret is encrypted **at rest**", and "at rest" means bytes on a disk. The
 * assertion that matters reads the raw column back out of SQLite and looks for
 * the plaintext in it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";

import {
  ANY_SCOPE,
  COOKIE_HONESTY,
  CredentialStore,
  credentialsKeyFromEnv,
  hostOf,
  keyFingerprint,
  normaliseScope,
  parseNetscapeCookies,
  scopeMatchesHost,
  scopeSpecificity,
  seal,
  unseal,
  warnIfUnprotected,
  type CredentialSecret,
} from "./credentials";
import { appDbPath, closeDb, openDb, type Db } from "./db";
import { credentials } from "./schema";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-credentials-"));
  db = openDb({ path: appDbPath(dir) });
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "a-long-random-passphrase-for-tests";

function store(key: string | null = KEY, warn: (line: string) => void = () => {}) {
  return new CredentialStore({ db, key, tempDir: dir, warn });
}

/** A jar that is exactly what a browser extension exports. */
function jar(domain = ".youtube.com", expiry = 4_102_444_800): string {
  return [
    "# Netscape HTTP Cookie File",
    "# This is a generated file! Do not edit.",
    "",
    `${domain}\tTRUE\t/\tTRUE\t${expiry}\tSID\tsecret-session-value`,
    `#HttpOnly_${domain}\tTRUE\t/\tTRUE\t0\tHSID\tanother-secret`,
  ].join("\n");
}

// --- Scopes -----------------------------------------------------------------

describe("scopes", () => {
  test("normalises the four things people actually paste", () => {
    const cases: Array<[string, string]> = [
      ["youtube.com", "youtube.com"],
      ["  YouTube.COM  ", "youtube.com"],
      ["https://www.youtube.com/watch?v=x", "www.youtube.com"],
      [".odysee.com", "*.odysee.com"],
      ["*.odysee.com", "*.odysee.com"],
      ["youtube.com:443", "youtube.com"],
      ["youtube.com.", "youtube.com"],
      ["*", "*"],
    ];
    for (const [input, expected] of cases) {
      const result = normaliseScope(input);
      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) expect(result.value).toBe(expected);
    }
  });

  test("refuses a wildcard that is not a leading label", () => {
    const bad = normaliseScope("you*tube.com");
    expect(Result.isError(bad)).toBe(true);
    if (Result.isError(bad)) expect(bad.error.field).toBe("scope");
  });

  test("refuses an empty scope", () => {
    expect(Result.isError(normaliseScope("   "))).toBe(true);
  });

  test("a wildcard covers the apex as well as subdomains", () => {
    expect(scopeMatchesHost("*.odysee.com", "odysee.com")).toBe(true);
    expect(scopeMatchesHost("*.odysee.com", "player.odysee.com")).toBe(true);
    expect(scopeMatchesHost("*.odysee.com", "notodysee.com")).toBe(false);
    expect(scopeMatchesHost("youtube.com", "www.youtube.com")).toBe(false);
    expect(scopeMatchesHost(ANY_SCOPE, "anything.test")).toBe(true);
  });

  test("specificity: more labels wins, and an exact host beats its own wildcard", () => {
    const ranked = ["*", "*.youtube.com", "youtube.com", "*.www.youtube.com", "www.youtube.com"];
    const scores = ranked.map(scopeSpecificity);
    expect(scores).toEqual([0, 4, 5, 6, 7]);
  });

  test("hostOf survives something that is not a URL", () => {
    expect(hostOf("https://www.youtube.com/watch?v=x")).toBe("www.youtube.com");
    expect(hostOf("not a url")).toBeNull();
  });
});

// --- Netscape cookies -------------------------------------------------------

describe("Netscape cookies.txt", () => {
  test("accepts a real jar, counts it, and finds the soonest expiry", () => {
    const parsed = parseNetscapeCookies(jar(".youtube.com", 1_800_000_000));
    expect(Result.isOk(parsed)).toBe(true);
    if (!Result.isOk(parsed)) return;
    // Two cookies: the plain one and the #HttpOnly_ one, which is NOT a comment.
    expect(parsed.value.count).toBe(2);
    expect(parsed.value.sessionCookies).toBe(1);
    expect(parsed.value.domains).toEqual(["youtube.com"]);
    expect(parsed.value.expiresAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  test("rejects a jar whose tabs were turned into spaces, and says so", () => {
    const mangled = jar().replace(/\t/g, "    ");
    const parsed = parseNetscapeCookies(mangled);
    expect(Result.isError(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      expect(parsed.error.field).toBe("cookies");
      expect(parsed.error.detail).toContain("spaces, not tabs");
    }
  });

  test("rejects the wrong number of fields", () => {
    const short = "youtube.com\tTRUE\t/\tTRUE\t0\tSID";
    const parsed = parseNetscapeCookies(short);
    expect(Result.isError(parsed)).toBe(true);
    if (Result.isError(parsed)) expect(parsed.error.detail).toContain("6 tab-separated");
  });

  test("rejects a non-boolean flag and a non-numeric expiry", () => {
    const flag = "youtube.com\tYES\t/\tTRUE\t0\tSID\tv";
    const expiry = "youtube.com\tTRUE\t/\tTRUE\tsoon\tSID\tv";
    for (const [text, needle] of [
      [flag, "TRUE or FALSE"],
      [expiry, "whole number of seconds"],
    ] as const) {
      const parsed = parseNetscapeCookies(text);
      expect(Result.isError(parsed)).toBe(true);
      if (Result.isError(parsed)) expect(parsed.error.detail).toContain(needle);
    }
  });

  test("rejects a file of nothing but comments", () => {
    const parsed = parseNetscapeCookies("# Netscape HTTP Cookie File\n\n# nothing here\n");
    expect(Result.isError(parsed)).toBe(true);
    if (Result.isError(parsed)) expect(parsed.error.detail).toContain("no cookie lines");
  });

  test("rejects an empty file", () => {
    expect(Result.isError(parseNetscapeCookies("   \n "))).toBe(true);
  });
});

// --- Sealing ----------------------------------------------------------------

describe("encryption", () => {
  const secret: CredentialSecret = { type: "apiKey", apiKey: "sk-do-not-leak-me" };

  test("round-trips", async () => {
    const sealed = await seal(secret, KEY);
    expect(sealed.protection).toBe("aes-256-gcm");
    expect(sealed.blob).not.toContain("sk-do-not-leak-me");

    const opened = await unseal(sealed.blob, KEY);
    expect(Result.isOk(opened)).toBe(true);
    if (Result.isOk(opened)) expect(opened.value).toEqual(secret);
  });

  test("the same secret seals differently every time", async () => {
    const a = await seal(secret, KEY);
    const b = await seal(secret, KEY);
    expect(a.blob).not.toBe(b.blob);
  });

  test("the wrong key fails, and says which problem it is", async () => {
    const sealed = await seal(secret, KEY);
    const opened = await unseal(sealed.blob, "a-different-passphrase-entirely");
    expect(Result.isError(opened)).toBe(true);
    if (Result.isError(opened)) expect(opened.error.detail).toContain("CREDENTIALS_KEY does not match");
  });

  test("no key at all fails rather than returning nothing", async () => {
    const sealed = await seal(secret, KEY);
    const opened = await unseal(sealed.blob, null);
    expect(Result.isError(opened)).toBe(true);
    if (Result.isError(opened)) expect(opened.error.detail).toContain("not set");
  });

  test("with no key it stores plaintext and admits it", async () => {
    const sealed = await seal(secret, null);
    expect(sealed.protection).toBe("plaintext");
    expect(sealed.keyId).toBeNull();
    const opened = await unseal(sealed.blob, null);
    expect(Result.isOk(opened)).toBe(true);
    if (Result.isOk(opened)) expect(opened.value).toEqual(secret);
  });

  test("a plaintext blob still opens once a key has been configured", async () => {
    // The upgrade path: the key arrives after some credentials already exist.
    const sealed = await seal(secret, null);
    const opened = await unseal(sealed.blob, KEY);
    expect(Result.isOk(opened)).toBe(true);
  });

  test("the key fingerprint identifies a key without being the key", () => {
    const id = keyFingerprint(KEY);
    expect(id).toHaveLength(8);
    expect(id).toBe(keyFingerprint(KEY));
    expect(id).not.toBe(keyFingerprint(`${KEY}!`));
    expect(KEY).not.toContain(id);
  });

  test("warnIfUnprotected is loud, and silent when there is a key", () => {
    const lines: string[] = [];
    expect(warnIfUnprotected(null, (line) => lines.push(line))).toBe(true);
    expect(lines.join("\n")).toContain("PLAIN TEXT");
    expect(lines.join("\n")).toContain("CREDENTIALS_KEY");

    lines.length = 0;
    expect(warnIfUnprotected(KEY, (line) => lines.push(line))).toBe(false);
    expect(lines).toHaveLength(0);
  });

  test("credentialsKeyFromEnv treats blank as absent", () => {
    expect(credentialsKeyFromEnv({ CREDENTIALS_KEY: "   " })).toBeNull();
    expect(credentialsKeyFromEnv({})).toBeNull();
    expect(credentialsKeyFromEnv({ CREDENTIALS_KEY: "x" })).toBe("x");
  });
});

// --- The store --------------------------------------------------------------

describe("CredentialStore", () => {
  test("what lands on disk is not the secret", async () => {
    const created = await store().create({
      scope: "youtube.com",
      secret: { type: "cookies", cookies: jar() },
    });
    expect(Result.isOk(created)).toBe(true);

    // Straight out of the column, which is the only place "at rest" means
    // anything. A file database, deliberately: see the header.
    const rows = await db.select({ secret: credentials.secret }).from(credentials);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secret).not.toContain("secret-session-value");
    expect(rows[0]?.secret).toContain("aes-256-gcm");
  });

  test("with no key the same write is plaintext, and the metadata says so", async () => {
    const warnings: string[] = [];
    const created = await store(null, (line) => warnings.push(line)).create({
      scope: "youtube.com",
      secret: { type: "cookies", cookies: jar() },
    });
    expect(Result.isOk(created)).toBe(true);
    if (Result.isOk(created)) expect(created.value.encrypted).toBe(false);

    const rows = await db.select({ secret: credentials.secret }).from(credentials);
    expect(rows[0]?.secret).toContain("plaintext");
    expect(warnings.join("\n")).toContain("PLAIN TEXT");
  });

  test("🔴 list() has no field a secret could travel in", async () => {
    const s = store();
    await s.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });
    await s.create({
      scope: "*.odysee.com",
      label: "main account",
      secret: { type: "password", username: "santi", password: "hunter2-and-then-some" },
    });

    const listed = await s.list();
    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain("secret-session-value");
    expect(serialised).not.toContain("hunter2-and-then-some");
    // The username is metadata on purpose — two password credentials for one
    // site are otherwise indistinguishable. The password is not.
    expect(serialised).toContain("santi");
  });

  test("metadata describes a jar without quoting it", async () => {
    const created = await store().create({
      scope: "youtube.com",
      secret: { type: "cookies", cookies: jar(".youtube.com", 1_800_000_000) },
    });
    if (!Result.isOk(created)) throw new Error("expected ok");
    expect(created.value.meta.cookieCount).toBe(2);
    expect(created.value.meta.domains).toEqual(["youtube.com"]);
    expect(created.value.meta.sessionCookies).toBe(1);
    expect(created.value.meta.expiresAt).toBe(new Date(1_800_000_000_000).toISOString());
    expect(created.value.encrypted).toBe(true);
    expect(created.value.lastUsedAt).toBeNull();
  });

  test("an invalid jar is refused before anything is written", async () => {
    const created = await store().create({
      scope: "youtube.com",
      secret: { type: "cookies", cookies: "not a cookie file at all" },
    });
    expect(Result.isError(created)).toBe(true);
    const rows = await db.select({ id: credentials.id }).from(credentials);
    expect(rows).toHaveLength(0);
  });

  test("a second write for the same scope and type replaces the first", async () => {
    const s = store();
    const first = await s.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });
    if (!Result.isOk(first)) throw new Error("expected ok");
    const second = await s.create({
      scope: "https://youtube.com/",
      secret: { type: "cookies", cookies: `${jar()}\nyoutube.com\tTRUE\t/\tTRUE\t0\tX\ty` },
    });
    if (!Result.isOk(second)) throw new Error("expected ok");

    expect(second.value.id).toBe(first.value.id);
    expect(second.value.createdAt).toBe(first.value.createdAt);
    expect(second.value.meta.cookieCount).toBe(3);
    expect(await s.list()).toHaveLength(1);
  });

  test("a different type for the same scope is a different credential", async () => {
    const s = store();
    await s.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });
    await s.create({
      scope: "youtube.com",
      secret: { type: "password", username: "a", password: "bbbbbbbb" },
    });
    expect(await s.list()).toHaveLength(2);
  });

  test("delete removes it, and a second delete is a NotFound", async () => {
    const s = store();
    const created = await s.create({ scope: "*", secret: { type: "apiKey", apiKey: "k123456" } });
    if (!Result.isOk(created)) throw new Error("expected ok");

    expect(Result.isOk(await s.delete(created.value.id))).toBe(true);
    const again = await s.delete(created.value.id);
    expect(Result.isError(again)).toBe(true);
    if (Result.isError(again)) expect(again.error._tag).toBe("NotFound");
  });

  test("password and API key and custom all validate their own emptiness", async () => {
    const s = store();
    const cases: CredentialSecret[] = [
      { type: "password", username: "  ", password: "x" },
      { type: "password", username: "a", password: "" },
      { type: "apiKey", apiKey: "  " },
      { type: "custom", data: {} },
    ];
    for (const secret of cases) {
      expect(Result.isError(await s.create({ scope: "*", secret }))).toBe(true);
    }
  });
});

// --- Resolution -------------------------------------------------------------

describe("resolution by scope", () => {
  test("🔴 the most specific scope wins", async () => {
    const s = store();
    await s.create({ scope: "*", secret: { type: "cookies", cookies: jar(".anything.test") } });
    await s.create({ scope: "*.youtube.com", secret: { type: "cookies", cookies: jar() } });
    await s.create({
      scope: "www.youtube.com",
      secret: { type: "cookies", cookies: jar(".www.youtube.com") },
    });

    const exact = await s.resolve("https://www.youtube.com/watch?v=x");
    expect(exact?.scope).toBe("www.youtube.com");

    // No exact row for `music.youtube.com`, so the wildcard over the parent wins.
    const wildcard = await s.resolve("https://music.youtube.com/watch?v=x");
    expect(wildcard?.scope).toBe("*.youtube.com");

    // Nothing about this host at all, so the catch-all is the answer.
    const catchAll = await s.resolve("https://vimeo.com/1");
    expect(catchAll?.scope).toBe("*");
  });

  test("with no catch-all an unmatched host resolves to nothing", async () => {
    const s = store();
    await s.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });
    expect(await s.resolve("https://vimeo.com/1")).toBeNull();
    expect(await s.resolve("not a url")).toBeNull();
  });

  test("resolution can be narrowed by type", async () => {
    const s = store();
    await s.create({ scope: "*", secret: { type: "cookies", cookies: jar(".anything.test") } });
    await s.create({
      scope: "youtube.com",
      secret: { type: "apiKey", apiKey: "a-key-for-something-else" },
    });
    // The API key is the more specific row and still must not shadow the jar:
    // yt-dlp has nowhere to put an API key.
    const forYtdlp = await s.resolve("https://youtube.com/watch?v=x", ["cookies", "password"]);
    expect(forYtdlp?.type).toBe("cookies");
  });
});

// --- Handing it to a subprocess ---------------------------------------------

describe("acquire", () => {
  test("writes a 0600 cookie file and deletes it on release", async () => {
    const s = store();
    await s.create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });

    const lease = await s.acquire("https://youtube.com/watch?v=x");
    expect(lease).not.toBeNull();
    if (!lease?.cookiesFile) throw new Error("expected a cookie file");

    const mode = statSync(lease.cookiesFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const parentMode = statSync(join(lease.cookiesFile, "..")).mode & 0o777;
    expect(parentMode).toBe(0o700);

    const contents = await readFile(lease.cookiesFile, "utf8");
    expect(contents).toContain("secret-session-value");
    expect(contents.endsWith("\n")).toBe(true);

    await lease.release();
    expect(await Bun.file(lease.cookiesFile).exists()).toBe(false);
  });

  test("a password lease carries the password to redact and no file", async () => {
    const s = store();
    await s.create({
      scope: "example.test",
      secret: { type: "password", username: "santi", password: "hunter2-and-then-some" },
    });
    const lease = await s.acquire("https://example.test/video/1");
    expect(lease?.username).toBe("santi");
    expect(lease?.password).toBe("hunter2-and-then-some");
    expect(lease?.cookiesFile).toBeUndefined();
    expect(lease?.redact).toEqual(["hunter2-and-then-some"]);
    await lease?.release();
  });

  test("using a credential records when, and only then", async () => {
    const s = store();
    const created = await s.create({
      scope: "youtube.com",
      secret: { type: "cookies", cookies: jar() },
    });
    if (!Result.isOk(created)) throw new Error("expected ok");
    expect(created.value.lastUsedAt).toBeNull();

    const lease = await s.acquire("https://youtube.com/watch?v=x");
    await lease?.release();

    const after = await s.get(created.value.id);
    if (!Result.isOk(after)) throw new Error("expected ok");
    expect(after.value.lastUsedAt).not.toBeNull();
  });

  test("a credential sealed with another key warns and yields nothing", async () => {
    await store().create({ scope: "youtube.com", secret: { type: "cookies", cookies: jar() } });

    const warnings: string[] = [];
    const rotated = store("a-completely-different-key", (line) => warnings.push(line));
    const lease = await rotated.acquire("https://youtube.com/watch?v=x");

    // 🔴 Null rather than a throw: a download without credentials may still
    // work, and failing here would blame yt-dlp for a key problem.
    expect(lease).toBeNull();
    expect(warnings.join("\n")).toContain("could not be opened");
  });

  test("an API key lease carries the key, and nothing that looks like a file", async () => {
    const s = store();
    await s.create({ scope: "*", secret: { type: "apiKey", apiKey: "sk-not-for-a-command-line" } });

    // ⚠️ Asked for by name. `acquire(url)` alone still sees only the two types a
    // yt-dlp command line can carry — that default *is* the old guard.
    expect(await s.acquire("https://youtube.com/watch?v=x")).toBeNull();

    const lease = await s.acquire("https://youtube.com/watch?v=x", ["apiKey"]);
    expect(lease?.type).toBe("apiKey");
    expect(lease?.apiKey).toBe("sk-not-for-a-command-line");
    expect(lease?.cookiesFile).toBeUndefined();
    expect(lease?.password).toBeUndefined();
    // Redacted from any log line that manages to echo it.
    expect(lease?.redact).toEqual(["sk-not-for-a-command-line"]);
    await lease?.release();
  });

  test("🔴 a custom credential arrives whole, which is the only way a provider can use one", async () => {
    // A Telegram session is an api_id, an api_hash and a session string: not a
    // cookie jar, not a password, and not expressible as either. `custom` is
    // what the store has for that, and until now `acquire` answered `null` for
    // it — so it could be saved, listed as present, and never used.
    const s = store();
    await s.create({
      scope: "t.me",
      secret: {
        type: "custom",
        data: { apiId: "123456", apiHash: "0".repeat(32), session: "1BQANOTEwLjU1LjE" },
      },
    });

    expect(await s.acquire("https://t.me/c/1234567890/42")).toBeNull();

    const lease = await s.acquire("https://t.me/c/1234567890/42", ["custom"]);
    expect(lease?.type).toBe("custom");
    expect(lease?.data).toEqual({
      apiId: "123456",
      apiHash: "0".repeat(32),
      session: "1BQANOTEwLjU1LjE",
    });
    // ⚠️ Every value, not the ones that look secret: the store is not in a
    // position to decide which half of what a provider hid is harmless.
    expect(lease?.redact.sort()).toEqual(["0".repeat(32), "123456", "1BQANOTEwLjU1LjE"].sort());
    await lease?.release();
  });
});

// --- The test endpoint's engine ---------------------------------------------

describe("test", () => {
  test("a healthy jar passes and still carries the honesty warning", async () => {
    const s = store();
    const created = await s.create({
      scope: "youtube.com",
      secret: { type: "cookies", cookies: jar(".youtube.com", 4_102_444_800) },
    });
    if (!Result.isOk(created)) throw new Error("expected ok");

    const report = await s.test(created.value.id);
    if (!Result.isOk(report)) throw new Error("expected ok");
    expect(report.value.ok).toBe(true);
    expect(report.value.checks.map((c) => c.name)).toContain("scope");
    expect(report.value.warnings.join(" ")).toContain(COOKIE_HONESTY);
  });

  test("🔴 a jar exported from the wrong site fails the scope check", async () => {
    const s = store();
    const created = await s.create({
      scope: "odysee.com",
      secret: { type: "cookies", cookies: jar(".youtube.com") },
    });
    if (!Result.isOk(created)) throw new Error("expected ok");

    const report = await s.test(created.value.id);
    if (!Result.isOk(report)) throw new Error("expected ok");
    expect(report.value.ok).toBe(false);
    const scope = report.value.checks.find((c) => c.name === "scope");
    expect(scope?.ok).toBe(false);
    expect(scope?.detail).toContain("wrong site");
  });

  test("🔴 a domain cookie covers the subdomain it was filed under", async () => {
    // The case that a naive "does the scope cover the domain" check gets
    // backwards: a browser exports YouTube as `.youtube.com`, and that jar is
    // exactly what signs `www.youtube.com` in.
    const s = store();
    const created = await s.create({
      scope: "www.youtube.com",
      secret: { type: "cookies", cookies: jar(".youtube.com") },
    });
    if (!Result.isOk(created)) throw new Error("expected ok");

    const report = await s.test(created.value.id);
    if (!Result.isOk(report)) throw new Error("expected ok");
    expect(report.value.checks.find((c) => c.name === "scope")?.ok).toBe(true);
    expect(report.value.ok).toBe(true);
  });

  test("an expired jar fails, and the report says when", async () => {
    const s = store();
    const yesterday = Math.floor(Date.now() / 1000) - 86_400;
    const created = await s.create({
      scope: "youtube.com",
      secret: { type: "cookies", cookies: jar(".youtube.com", yesterday) },
    });
    if (!Result.isOk(created)) throw new Error("expected ok");

    const report = await s.test(created.value.id);
    if (!Result.isOk(report)) throw new Error("expected ok");
    expect(report.value.ok).toBe(false);
    expect(report.value.checks.find((c) => c.name === "expiry")?.detail).toContain("Expired at");
  });

  test("a rotated key is reported as a key problem, not as a broken credential", async () => {
    const created = await store().create({
      scope: "youtube.com",
      secret: { type: "cookies", cookies: jar() },
    });
    if (!Result.isOk(created)) throw new Error("expected ok");

    const report = await store("another-key-entirely").test(created.value.id);
    if (!Result.isOk(report)) throw new Error("expected ok");
    expect(report.value.ok).toBe(false);
    expect(report.value.checks[0]?.name).toBe("readable");
    expect(report.value.checks[0]?.detail).toContain("does not match");
    expect(report.value.warnings.join(" ")).toContain("sealed with a different");
  });

  test("a password credential reports the argv exposure out loud", async () => {
    const s = store();
    const created = await s.create({
      scope: "example.test",
      secret: { type: "password", username: "santi", password: "hunter2-and-then-some" },
    });
    if (!Result.isOk(created)) throw new Error("expected ok");

    const report = await s.test(created.value.id);
    if (!Result.isOk(report)) throw new Error("expected ok");
    expect(report.value.ok).toBe(true);
    expect(JSON.stringify(report.value)).not.toContain("hunter2-and-then-some");
    expect(report.value.checks.find((c) => c.name === "exposure")?.detail).toContain("process list");
  });

  test("a plaintext credential is flagged as one", async () => {
    const s = store(null);
    const created = await s.create({ scope: "*", secret: { type: "apiKey", apiKey: "k123456" } });
    if (!Result.isOk(created)) throw new Error("expected ok");
    const report = await s.test(created.value.id);
    if (!Result.isOk(report)) throw new Error("expected ok");
    expect(report.value.warnings.join(" ")).toContain("plain text");
  });

  test("testing something that is not there is a NotFound", async () => {
    const report = await store().test("nope");
    expect(Result.isError(report)).toBe(true);
  });
});
