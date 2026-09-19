/**
 * The login flow, driven by a fake client.
 *
 * Every decision this file makes — expiry, the cap, which refusal is retryable,
 * what happens to a connection when a step fails — is reachable without a
 * network, which is the whole reason `TelegramLoginClient` is an interface. A
 * test that had to sign in to Telegram to reach them is a test nobody runs, and
 * the interesting cases (a code typed wrong, a form abandoned halfway) are
 * exactly the ones a real login makes expensive to reproduce.
 */
import { describe, expect, test } from "bun:test";
import { Result } from "better-result";

import {
  readTelegramError,
  TelegramLoginManager,
  type TelegramLoginClient,
  type TelegramLoginStep,
} from "./telegram-login";

const CREDENTIALS = { apiId: 123456, apiHash: "0123456789abcdef0123456789abcdef" };

interface FakeOptions {
  /** Thrown by `sendCode`. */
  sendCodeFails?: Error;
  /** `signIn`'s answer, or an error to throw. */
  signIn?: "done" | "password-needed" | Error;
  checkPasswordFails?: Error;
  accountFails?: Error;
}

function fakeClient(calls: string[], options: FakeOptions = {}): TelegramLoginClient {
  return {
    async sendCode(phone) {
      calls.push(`sendCode:${phone}`);
      if (options.sendCodeFails) throw options.sendCodeFails;
    },
    async signIn(code) {
      calls.push(`signIn:${code}`);
      if (options.signIn instanceof Error) throw options.signIn;
      return options.signIn ?? "done";
    },
    async checkPassword(password) {
      calls.push(`checkPassword:${password.length}`);
      if (options.checkPasswordFails) throw options.checkPasswordFails;
    },
    session() {
      return "1BQAN-session-string";
    },
    async account() {
      if (options.accountFails) throw options.accountFails;
      return "@santi";
    },
    async close() {
      calls.push("close");
    },
  };
}

function manager(options: FakeOptions = {}, extra: { ttlMs?: number; maxPending?: number; now?: () => number } = {}) {
  const calls: string[] = [];
  let id = 0;
  const instance = new TelegramLoginManager({
    connect: async () => fakeClient(calls, options),
    newId: () => `login-${++id}`,
    ...extra,
  });
  return { instance, calls };
}

function unwrap(result: Result<TelegramLoginStep, unknown>): TelegramLoginStep {
  if (Result.isError(result)) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("the happy path", () => {
  test("code, then done — with the session and the account", async () => {
    const { instance, calls } = manager();

    const started = unwrap(await instance.start(CREDENTIALS, "+573001234567"));
    expect(started.state).toBe("code-needed");
    if (started.state !== "code-needed") return;
    expect(started.loginId).toBe("login-1");
    expect(instance.pending()).toBe(1);

    const finished = unwrap(await instance.code(started.loginId, "12345"));
    expect(finished).toEqual({
      state: "done",
      account: "@santi",
      session: "1BQAN-session-string",
      apiId: CREDENTIALS.apiId,
      apiHash: CREDENTIALS.apiHash,
    });

    // 🔴 The connection is closed and forgotten the moment it has done its job:
    // a signed-in client left in the map is an authorised session nobody watches.
    expect(instance.pending()).toBe(0);
    expect(calls).toEqual(["sendCode:+573001234567", "signIn:12345", "close"]);
  });

  test("two-step verification adds a step and keeps the login alive", async () => {
    const { instance, calls } = manager({ signIn: "password-needed" });

    const started = unwrap(await instance.start(CREDENTIALS, "+57300"));
    const needsPassword = unwrap(await instance.code(started.state === "code-needed" ? started.loginId : "", "12345"));
    expect(needsPassword.state).toBe("password-needed");
    expect(instance.pending()).toBe(1);

    const finished = unwrap(
      await instance.password(needsPassword.state === "password-needed" ? needsPassword.loginId : "", "hunter2"),
    );
    expect(finished.state).toBe("done");
    expect(instance.pending()).toBe(0);
    // ⚠️ The password's *length* is recorded by the fake, never its value — the
    // real client never logs it either.
    expect(calls).toContain("checkPassword:7");
  });
});

describe("what does not drop the login", () => {
  test("🔴 a wrong code is retryable, and does not cost a new SMS", async () => {
    // Telegram lets the same phoneCodeHash be retried. Closing the connection on
    // a typo would mean a new code request — which is how a person walks into a
    // flood wait for mistyping once.
    const { instance } = manager({ signIn: new Error("PHONE_CODE_INVALID") });
    const started = unwrap(await instance.start(CREDENTIALS, "+57300"));
    if (started.state !== "code-needed") return;

    const wrong = await instance.code(started.loginId, "00000");
    expect(Result.isError(wrong) && wrong.error._tag).toBe("TelegramLoginFailed");
    expect(instance.pending()).toBe(1);

    // And the same login still accepts a second attempt.
    const again = await instance.code(started.loginId, "12345");
    expect(Result.isError(again)).toBe(true); // the fake keeps refusing
    expect(instance.pending()).toBe(1);
  });

  test("a wrong two-step password is retryable for the same reason", async () => {
    const { instance } = manager({ signIn: "password-needed", checkPasswordFails: new Error("PASSWORD_HASH_INVALID") });
    const started = unwrap(await instance.start(CREDENTIALS, "+57300"));
    if (started.state !== "code-needed") return;
    await instance.code(started.loginId, "12345");

    const wrong = await instance.password(started.loginId, "nope");
    expect(Result.isError(wrong) && wrong.error._tag).toBe("TelegramLoginFailed");
    expect(instance.pending()).toBe(1);
  });
});

describe("what does drop it", () => {
  test("🔴 a rejected phone number does not leave a socket behind", async () => {
    // A connection per typo is a connection leak with a very easy trigger.
    const { instance, calls } = manager({ sendCodeFails: new Error("PHONE_NUMBER_INVALID") });

    const failed = await instance.start(CREDENTIALS, "not-a-phone");
    expect(Result.isError(failed) && failed.error._tag).toBe("TelegramLoginFailed");
    expect(instance.pending()).toBe(0);
    expect(calls).toContain("close");
  });

  test("🔴 an abandoned login expires, and its connection goes with it", async () => {
    let clock = 1_000;
    const { instance, calls } = manager({}, { ttlMs: 60_000, now: () => clock });

    const started = unwrap(await instance.start(CREDENTIALS, "+57300"));
    if (started.state !== "code-needed") return;
    expect(instance.pending()).toBe(1);

    clock += 60_001;
    expect(instance.pending()).toBe(0);
    expect(calls).toContain("close");

    // And the id is gone rather than silently accepted.
    const late = await instance.code(started.loginId, "12345");
    expect(Result.isError(late) && late.error._tag).toBe("NotFound");
  });

  test("🔴 the cap holds, and it evicts the oldest rather than refusing", async () => {
    // Each pending login is a live connection. A form that can be submitted
    // repeatedly must not be a way to open fifty — but refusing the *new* one
    // would punish the person for their own earlier typo.
    let clock = 1_000;
    const { instance } = manager({}, { maxPending: 2, ttlMs: 600_000, now: () => clock });

    const first = unwrap(await instance.start(CREDENTIALS, "+1"));
    clock += 10;
    unwrap(await instance.start(CREDENTIALS, "+2"));
    clock += 10;
    expect(instance.pending()).toBe(2);

    unwrap(await instance.start(CREDENTIALS, "+3"));
    expect(instance.pending()).toBe(2);
    // The first is the one that went.
    if (first.state !== "code-needed") return;
    expect(Result.isError(await instance.code(first.loginId, "1"))).toBe(true);
  });

  test("cancel closes it, and cancelling something unknown is not an error", async () => {
    const { instance, calls } = manager();
    const started = unwrap(await instance.start(CREDENTIALS, "+57300"));
    if (started.state !== "code-needed") return;

    await instance.cancel(started.loginId);
    expect(instance.pending()).toBe(0);
    expect(calls).toContain("close");
    await instance.cancel("never-existed"); // must not throw
  });

  test("stop closes everything, for shutdown", async () => {
    const { instance, calls } = manager();
    await instance.start(CREDENTIALS, "+1");
    await instance.start(CREDENTIALS, "+2");
    expect(instance.pending()).toBe(2);

    await instance.stop();
    expect(instance.pending()).toBe(0);
    expect(calls.filter((call) => call === "close")).toHaveLength(2);
  });

  test("a failure after signing in does not leave the client open", async () => {
    const { instance, calls } = manager({ accountFails: new Error("AUTH_KEY_UNREGISTERED") });
    const started = unwrap(await instance.start(CREDENTIALS, "+57300"));
    if (started.state !== "code-needed") return;

    const broken = await instance.code(started.loginId, "12345");
    expect(Result.isError(broken)).toBe(true);
    expect(instance.pending()).toBe(0);
    expect(calls).toContain("close");
  });
});

describe("readTelegramError", () => {
  test("🔴 a flood wait keeps its number, because that is the whole message", async () => {
    // The seconds live nowhere but inside the code's name. Losing them turns
    // "wait 42 seconds" into "it failed", and the person retries at once, which
    // extends the wait.
    const flood = readTelegramError(new Error("A wait of 42 seconds is required (caused by FLOOD_WAIT_42)"));
    expect(flood.code).toBe("FLOOD_WAIT_42");
    expect(flood.retryAfterSeconds).toBe(42);
  });

  test("a named refusal keeps its code; anything else is UNKNOWN, not a guess", () => {
    expect(readTelegramError(new Error("PHONE_CODE_INVALID")).code).toBe("PHONE_CODE_INVALID");
    expect(readTelegramError(new Error("socket hang up")).code).toBe("UNKNOWN");
    expect(readTelegramError("a string").code).toBe("UNKNOWN");
    // The detail always survives, so nothing is lost when the code is UNKNOWN.
    expect(readTelegramError(new Error("socket hang up")).detail).toBe("socket hang up");
  });

  test("a flood wait with no number is not read as zero seconds", () => {
    const vague = readTelegramError(new Error("FLOOD_WAIT"));
    expect(vague.retryAfterSeconds).toBeUndefined();
  });
});
