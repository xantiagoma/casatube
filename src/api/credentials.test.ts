/**
 * The credentials endpoints, over real HTTP shapes and a real database file.
 *
 * 🔴 The load-bearing assertion in this file is negative: **the secret never
 * appears in a response.** It is checked by serialising every response body and
 * searching for the exact bytes that were posted, rather than by inspecting the
 * fields we happen to expect — a positive check ("`credentials[0].secret` is
 * undefined") passes happily against a body that leaked the jar under a
 * different name.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";

import { CredentialStore } from "../core/credentials";
import { appDbPath, closeDb, openDb, type Db } from "../core/db";
import { credentialRoutes } from "./credentials";
import { TelegramLoginManager } from "../core/telegram-login";

let dir: string;
let db: Db;
/** Only what the tests use — annotating this as `Elysia` fixes the prefix at "". */
let app: { handle(request: Request): Promise<Response> };

const KEY = "a-long-random-passphrase-for-tests";
const COOKIE_VALUE = "the-session-cookie-nobody-may-see";
const PASSWORD = "hunter2-and-then-some";

function jar(domain = ".youtube.com", expiry = 4_102_444_800): string {
  return [
    "# Netscape HTTP Cookie File",
    `${domain}\tTRUE\t/\tTRUE\t${expiry}\tSID\t${COOKIE_VALUE}`,
  ].join("\n");
}

function mount(key: string | null = KEY, telegramLogin?: TelegramLoginManager) {
  const store = new CredentialStore({ db, key, tempDir: dir, warn: () => {} });
  return new Elysia({ prefix: "/api" }).use(
    credentialRoutes({ credentials: store, ...(telegramLogin === undefined ? {} : { telegramLogin }) }),
  );
}

/** A login client that signs in without a network. See `telegram-login.test.ts`. */
function fakeTelegram(options: { needsPassword?: boolean; codeFails?: Error } = {}): TelegramLoginManager {
  return new TelegramLoginManager({
    newId: () => "login-1",
    connect: async () => ({
      async sendCode() {},
      async signIn() {
        if (options.codeFails) throw options.codeFails;
        return options.needsPassword === true ? "password-needed" : "done";
      },
      async checkPassword() {},
      session: () => "1BQAN-a-real-looking-session-string",
      account: async () => "@santi",
      async close() {},
    }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "casatube-credentials-api-"));
  db = openDb({ path: appDbPath(dir) });
  app = mount();
});

afterEach(() => {
  closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://local/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function addCookies(scope = "youtube.com", cookies = jar()): Promise<string> {
  const response = await request("POST", "/credentials", { scope, type: "cookies", cookies });
  expect(response.status).toBe(201);
  const body = await json(response);
  return (body.credential as { id: string }).id;
}

describe("POST /api/credentials", () => {
  test("stores a jar and answers with metadata only", async () => {
    const response = await request("POST", "/credentials", {
      scope: "https://www.youtube.com/",
      type: "cookies",
      label: "personal account",
      cookies: jar(),
    });
    expect(response.status).toBe(201);

    const body = await json(response);
    // 🔴 The whole point of this file.
    expect(JSON.stringify(body)).not.toContain(COOKIE_VALUE);

    const credential = body.credential as Record<string, unknown>;
    expect(credential.scope).toBe("www.youtube.com");
    expect(credential.type).toBe("cookies");
    expect(credential.label).toBe("personal account");
    expect(credential.encrypted).toBe(true);
    expect(credential.secret).toBeUndefined();
    expect((credential.meta as Record<string, unknown>).cookieCount).toBe(1);
    // PLAN §15, on every cookie response.
    expect(String(body.notice)).toContain("mitigation, not a fix");
  });

  test("🔴 a mangled cookies.txt is rejected immediately, with the reason", async () => {
    const response = await request("POST", "/credentials", {
      scope: "youtube.com",
      type: "cookies",
      cookies: jar().replace(/\t/g, "    "),
    });
    expect(response.status).toBe(422);
    const body = await json(response);
    expect(body.tag).toBe("InvalidCredential");
    expect(String(body.message)).toContain("spaces, not tabs");
    expect(body.retryable).toBe(false);

    const listed = await json(await request("GET", "/credentials"));
    expect(listed.credentials).toHaveLength(0);
  });

  test("a bad scope is rejected and names the field", async () => {
    const response = await request("POST", "/credentials", {
      scope: "you*tube.com",
      type: "cookies",
      cookies: jar(),
    });
    expect(response.status).toBe(422);
    expect(String((await json(response)).message)).toContain("scope");
  });

  test("a password credential missing half of itself names the missing half", async () => {
    const response = await request("POST", "/credentials", {
      scope: "example.test",
      type: "password",
      username: "santi",
    });
    expect(response.status).toBe(422);
    expect(String((await json(response)).message)).toContain("password");
  });

  test("an unknown type does not fall back to a default", async () => {
    // The `t.UnionEnum` default trap in docs/DISCOVERIES.md: without
    // `default: undefined`, a missing `type` would silently become "cookies".
    const response = await request("POST", "/credentials", { scope: "a.test" });
    expect(response.status).toBe(422);
  });

  test("posting the same scope and type again replaces rather than duplicates", async () => {
    const first = await addCookies();
    const second = await addCookies("youtube.com", `${jar()}\nyoutube.com\tTRUE\t/\tTRUE\t0\tX\ty`);
    expect(second).toBe(first);

    const listed = await json(await request("GET", "/credentials"));
    expect(listed.credentials).toHaveLength(1);
  });
});

describe("GET /api/credentials", () => {
  test("🔴 no secret in the listing, for any type", async () => {
    await addCookies();
    await request("POST", "/credentials", {
      scope: "*.odysee.com",
      type: "password",
      username: "santi",
      password: PASSWORD,
    });
    await request("POST", "/credentials", { scope: "*", type: "apiKey", apiKey: "sk-leak-me-not" });
    await request("POST", "/credentials", {
      scope: "vimeo.com",
      type: "custom",
      data: { token: "a-custom-token-value" },
    });

    const response = await request("GET", "/credentials");
    const text = await response.text();
    for (const secret of [COOKIE_VALUE, PASSWORD, "sk-leak-me-not", "a-custom-token-value"]) {
      expect(text).not.toContain(secret);
    }

    const body = JSON.parse(text) as Record<string, unknown>;
    const listed = body.credentials as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(4);
    // Custom and apiKey advertise their field *names*, never their values.
    const custom = listed.find((row) => row.type === "custom");
    expect((custom?.meta as { fields?: string[] }).fields).toEqual(["token"]);
  });

  test("ordered most specific first — the order they are resolved in", async () => {
    await addCookies("*", jar(".anything.test"));
    await addCookies("*.youtube.com");
    await addCookies("www.youtube.com", jar(".www.youtube.com"));

    const body = await json(await request("GET", "/credentials"));
    const scopes = (body.credentials as Array<{ scope: string }>).map((row) => row.scope);
    expect(scopes).toEqual(["www.youtube.com", "*.youtube.com", "*"]);
  });

  test("says whether encryption is actually on", async () => {
    const on = await json(await request("GET", "/credentials"));
    const encryption = on.encryption as Record<string, unknown>;
    expect(encryption.enabled).toBe(true);
    expect(encryption.algorithm).toBe("aes-256-gcm");
    expect(encryption.warning).toBeNull();

    app = mount(null);
    const off = await json(await request("GET", "/credentials"));
    const without = off.encryption as Record<string, unknown>;
    expect(without.enabled).toBe(false);
    expect(without.algorithm).toBeNull();
    expect(String(without.warning)).toContain("plain text");
  });
});

describe("DELETE /api/credentials/:id", () => {
  test("removes it, and says so twice only once", async () => {
    const id = await addCookies();
    const first = await request("DELETE", `/credentials/${id}`);
    expect(first.status).toBe(200);
    expect((await json(first)).deleted).toBe(true);

    const second = await request("DELETE", `/credentials/${id}`);
    expect(second.status).toBe(404);
    expect((await json(second)).tag).toBe("NotFound");
  });
});

describe("POST /api/credentials/:id/test", () => {
  test("reports on a healthy jar without returning it", async () => {
    const id = await addCookies();
    const response = await request("POST", `/credentials/${id}/test`);
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).not.toContain(COOKIE_VALUE);

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.scope).toBe("youtube.com");
    const names = (body.checks as Array<{ name: string }>).map((check) => check.name);
    expect(names).toEqual(["readable", "format", "scope", "expiry"]);
    expect(String(body.warnings)).toContain("mitigation, not a fix");
  });

  test("fails a jar filed under the wrong site", async () => {
    const id = await addCookies("odysee.com", jar(".youtube.com"));
    const body = await json(await request("POST", `/credentials/${id}/test`));
    expect(body.ok).toBe(false);
    const scope = (body.checks as Array<{ name: string; ok: boolean }>).find(
      (check) => check.name === "scope",
    );
    expect(scope?.ok).toBe(false);
  });

  test("testing something that does not exist is a 404", async () => {
    const response = await request("POST", "/credentials/nope/test");
    expect(response.status).toBe(404);
  });
});


// --- Signing in to Telegram from a screen (2026-09-19) -----------------------

describe("POST /api/credentials/telegram", () => {
  const START = { apiId: 123456, apiHash: "0123456789abcdef0123456789abcdef", phone: "+573001234567" };

  test("code then done stores a sealed credential scoped to t.me", async () => {
    app = mount(KEY, fakeTelegram());

    const started = (await (await request("POST", "/credentials/telegram/start", START)).json()) as {
      state: string;
      loginId: string;
    };
    expect(started.state).toBe("code-needed");

    const done = (await (
      await request("POST", "/credentials/telegram/code", { loginId: started.loginId, code: "12345" })
    ).json()) as { state: string; account: string; credential: { scope: string; type: string; label: string } };

    expect(done.state).toBe("done");
    expect(done.account).toBe("@santi");
    expect(done.credential.scope).toBe("t.me");
    expect(done.credential.type).toBe("custom");
    expect(done.credential.label).toContain("@santi");

    // And it is in the store, listed, with no secret in the listing.
    const listed = (await (await request("GET", "/credentials")).json()) as {
      credentials: { scope: string; type: string }[];
    };
    expect(listed.credentials.some((row) => row.scope === "t.me" && row.type === "custom")).toBe(true);
  });

  test("🔴 the session string never comes back to the browser", async () => {
    // PLAN §12: secrets do not travel back through the API — and a session string
    // is the most valuable one there is, because it is the whole account.
    app = mount(KEY, fakeTelegram());
    const started = (await (await request("POST", "/credentials/telegram/start", START)).json()) as {
      loginId: string;
    };
    const response = await request("POST", "/credentials/telegram/code", {
      loginId: started.loginId,
      code: "12345",
    });
    const body = await response.text();

    expect(body).not.toContain("1BQAN-a-real-looking-session-string");
    expect(body).not.toContain(START.apiHash);
  });

  test("two-step verification is a third round trip, not a failure", async () => {
    app = mount(KEY, fakeTelegram({ needsPassword: true }));
    const started = (await (await request("POST", "/credentials/telegram/start", START)).json()) as {
      loginId: string;
    };

    const needs = (await (
      await request("POST", "/credentials/telegram/code", { loginId: started.loginId, code: "12345" })
    ).json()) as { state: string };
    expect(needs.state).toBe("password-needed");

    const done = (await (
      await request("POST", "/credentials/telegram/password", { loginId: started.loginId, password: "hunter2" })
    ).json()) as { state: string };
    expect(done.state).toBe("done");
  });

  test("🔴 a flood wait keeps its seconds all the way to the message", async () => {
    // The number lives nowhere but inside Telegram's code name, and without it
    // the client retries at once — which extends the wait.
    app = mount(KEY, fakeTelegram({ codeFails: new Error("caused by FLOOD_WAIT_42") }));
    const started = (await (await request("POST", "/credentials/telegram/start", START)).json()) as {
      loginId: string;
    };

    const response = await request("POST", "/credentials/telegram/code", {
      loginId: started.loginId,
      code: "12345",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { tag: string; message: string; retryable: boolean };
    expect(body.tag).toBe("TelegramLoginFailed");
    expect(body.message).toContain("42 second");
    expect(body.retryable).toBe(true);
  });

  test("a wrong code says so and the login stays usable", async () => {
    app = mount(KEY, fakeTelegram({ codeFails: new Error("PHONE_CODE_INVALID") }));
    const started = (await (await request("POST", "/credentials/telegram/start", START)).json()) as {
      loginId: string;
    };

    const response = await request("POST", "/credentials/telegram/code", {
      loginId: started.loginId,
      code: "00000",
    });
    expect(((await response.json()) as { message: string }).message).toContain("still valid");
  });

  test("an unknown or expired login is a 404, not a 500", async () => {
    app = mount(KEY, fakeTelegram());
    const response = await request("POST", "/credentials/telegram/code", { loginId: "gone", code: "12345" });
    expect(response.status).toBe(404);
  });

  test("🔴 a pasted RSA key is refused by the schema, before any connection", async () => {
    app = mount(KEY, fakeTelegram());
    const response = await request("POST", "/credentials/telegram/start", {
      ...START,
      apiHash: "-----BEGIN RSA PUBLIC KEY-----",
    });
    expect(response.status).toBe(422);
  });

  test("with no flow in this build, the answer says what to use instead", async () => {
    app = mount(KEY); // no manager
    const response = await request("POST", "/credentials/telegram/start", START);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { message: string }).message).toContain("telegram-session.ts");
  });

  test("cancelling is idempotent and needs no flow to be present", async () => {
    app = mount(KEY);
    expect((await request("DELETE", "/credentials/telegram/whatever")).status).toBe(200);
  });
});
