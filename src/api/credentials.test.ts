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

function mount(key: string | null = KEY) {
  const store = new CredentialStore({ db, key, tempDir: dir, warn: () => {} });
  return new Elysia({ prefix: "/api" }).use(credentialRoutes({ credentials: store }));
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
