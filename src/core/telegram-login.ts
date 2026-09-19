/**
 * Signing in to Telegram from a screen instead of a terminal.
 *
 * 🔴 **This is the only place in CasaTube that holds state between requests, and
 * it is not a shortcut.** Telegram's `phoneCodeHash` belongs to the connection
 * that asked for the code and dies with it, so "send me a code" and "here is the
 * code" *must* share one live MTProto client. There is no stateless version of
 * this, and pretending otherwise would mean a login that always fails on the
 * second step.
 *
 * Everything that follows is about keeping that honest:
 *
 * - A pending login **expires**, because it is a socket somebody walked away
 *   from. Telegram's own code expires too; ours goes first.
 * - There is a **cap**. Each pending login is a connection, and a form that can
 *   be submitted repeatedly must not be a way to open fifty.
 * - It **does not survive a restart**, and the API says so rather than answering
 *   "unknown login" to someone who did nothing wrong. A login lost to a restart
 *   is a login to start again — no rows written, nothing half-done, which is why
 *   holding this in memory is acceptable where holding a *job* would not be
 *   (PLAN §17 rule 3).
 *
 * ⚠️ The code and the two-step password are never logged, never returned, and
 * never stored. They exist for the length of one call.
 */
import { Result } from "better-result";

import { NotFound, TelegramLoginFailed } from "./errors";

/** How long a half-finished login is kept before its connection is dropped. */
export const DEFAULT_LOGIN_TTL_MS = 5 * 60_000;

/**
 * How many logins may be pending at once.
 *
 * Three, not one: a person who mistyped a phone number should be able to start
 * again without waiting for the first to expire. Not thirty: each one is a live
 * connection to Telegram.
 */
export const DEFAULT_MAX_PENDING = 3;

/** ⚠️ The error lives in `core/errors.ts` with the rest of the taxonomy. */
export type TelegramLoginError = TelegramLoginFailed | NotFound;

/**
 * The client this needs, and nothing more.
 *
 * Named as an interface so the whole flow can be driven by a fake. Every
 * decision in this file — expiry, the cap, which refusal means what — is
 * reachable without a network, and a test that had to sign in to Telegram to
 * reach them would be a test nobody runs.
 */
export interface TelegramLoginClient {
  sendCode(phone: string): Promise<void>;
  /** `password-needed` when the account has two-step verification on. */
  signIn(code: string): Promise<"done" | "password-needed">;
  checkPassword(password: string): Promise<void>;
  /** The session string, once signed in. */
  session(): string;
  /** Something a person recognises: `@name`, or a phone number. */
  account(): Promise<string>;
  close(): Promise<void>;
}

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

/** What a step answers with. `done` is the only one that carries a secret. */
export type TelegramLoginStep =
  | { state: "code-needed"; loginId: string; expiresAt: string }
  | { state: "password-needed"; loginId: string; expiresAt: string }
  | { state: "done"; account: string; session: string; apiId: number; apiHash: string };

interface Pending {
  id: string;
  client: TelegramLoginClient;
  apiId: number;
  apiHash: string;
  expiresAt: number;
}

export interface TelegramLoginOptions {
  connect(credentials: TelegramCredentials): Promise<TelegramLoginClient>;
  ttlMs?: number;
  maxPending?: number;
  now?: () => number;
  newId?: () => string;
}

/**
 * Read a Telegram error into something a screen can act on.
 *
 * ⚠️ `FLOOD_WAIT_x` carries the wait in its name and nowhere else. Losing the
 * number turns "wait 42 seconds" into "it failed", and the person retries
 * immediately, which extends the wait.
 */
export function readTelegramError(cause: unknown): TelegramLoginFailed {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = /\b([A-Z][A-Z0-9_]{3,})\b/.exec(message)?.[1] ?? "UNKNOWN";
  const wait = /FLOOD_WAIT_(\d+)/.exec(message)?.[1];
  return new TelegramLoginFailed({
    code,
    detail: message,
    ...(wait === undefined ? {} : { retryAfterSeconds: Number(wait) }),
  });
}

export class TelegramLoginManager {
  readonly #pending = new Map<string, Pending>();
  readonly #connect: TelegramLoginOptions["connect"];
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(options: TelegramLoginOptions) {
    this.#connect = options.connect;
    this.#ttlMs = options.ttlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => Bun.randomUUIDv7());
  }

  /** How many logins are waiting on a code or a password. For tests and shutdown. */
  pending(): number {
    this.#sweep();
    return this.#pending.size;
  }

  /**
   * Ask Telegram to send a code.
   *
   * ⚠️ The connection is closed if `sendCode` fails. A rejected phone number
   * that left a socket open would be a socket per typo.
   */
  async start(
    credentials: TelegramCredentials,
    phone: string,
  ): Promise<Result<TelegramLoginStep, TelegramLoginError>> {
    this.#sweep();

    if (this.#pending.size >= this.#maxPending) {
      // The oldest is the one least likely to still be wanted.
      const oldest = [...this.#pending.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (oldest !== undefined) await this.#drop(oldest.id, "making room for a new login");
    }

    let client: TelegramLoginClient;
    try {
      client = await this.#connect(credentials);
    } catch (cause) {
      return Result.err(readTelegramError(cause));
    }

    try {
      await client.sendCode(phone);
    } catch (cause) {
      await client.close().catch(() => {});
      return Result.err(readTelegramError(cause));
    }

    const id = this.#newId();
    const expiresAt = this.#now() + this.#ttlMs;
    this.#pending.set(id, { id, client, apiId: credentials.apiId, apiHash: credentials.apiHash, expiresAt });

    return Result.ok({ state: "code-needed", loginId: id, expiresAt: new Date(expiresAt).toISOString() });
  }

  /**
   * Submit the code.
   *
   * 🔴 A wrong code does **not** drop the login. Telegram lets the same
   * `phoneCodeHash` be retried, and closing the connection here would mean a
   * typo costs a new SMS — which is also how a person walks into a flood wait.
   */
  async code(loginId: string, code: string): Promise<Result<TelegramLoginStep, TelegramLoginError>> {
    const entry = this.#alive(loginId);
    if (Result.isError(entry)) return entry;

    let outcome: "done" | "password-needed";
    try {
      outcome = await entry.value.client.signIn(code);
    } catch (cause) {
      return Result.err(readTelegramError(cause));
    }

    if (outcome === "password-needed") {
      return Result.ok({
        state: "password-needed",
        loginId,
        expiresAt: new Date(entry.value.expiresAt).toISOString(),
      });
    }
    return this.#finish(entry.value);
  }

  /** Submit the two-step password. A wrong one is retryable for the same reason. */
  async password(loginId: string, password: string): Promise<Result<TelegramLoginStep, TelegramLoginError>> {
    const entry = this.#alive(loginId);
    if (Result.isError(entry)) return entry;

    try {
      await entry.value.client.checkPassword(password);
    } catch (cause) {
      return Result.err(readTelegramError(cause));
    }
    return this.#finish(entry.value);
  }

  /** Give up on a login, closing its connection. Unknown ids are not an error. */
  async cancel(loginId: string): Promise<void> {
    await this.#drop(loginId, "cancelled");
  }

  /** Close everything. For shutdown. */
  async stop(): Promise<void> {
    for (const id of [...this.#pending.keys()]) await this.#drop(id, "shutting down");
  }

  async #finish(entry: Pending): Promise<Result<TelegramLoginStep, TelegramLoginError>> {
    try {
      const account = await entry.client.account();
      const session = entry.client.session();
      // 🔴 Dropped from the map *before* the caller can store anything: the
      // connection has done its job, and a signed-in client left lying around is
      // an authorised session nobody is watching.
      this.#pending.delete(entry.id);
      await entry.client.close().catch(() => {});
      return Result.ok({
        state: "done",
        account,
        session,
        apiId: entry.apiId,
        apiHash: entry.apiHash,
      });
    } catch (cause) {
      await this.#drop(entry.id, "failed after signing in");
      return Result.err(readTelegramError(cause));
    }
  }

  #alive(loginId: string): Result<Pending, NotFound> {
    this.#sweep();
    const entry = this.#pending.get(loginId);
    if (entry === undefined) return Result.err(new NotFound({ what: "telegram login", id: loginId }));
    return Result.ok(entry);
  }

  #sweep(): void {
    const at = this.#now();
    for (const entry of [...this.#pending.values()]) {
      if (entry.expiresAt <= at) void this.#drop(entry.id, "expired");
    }
  }

  async #drop(loginId: string, _why: string): Promise<void> {
    const entry = this.#pending.get(loginId);
    if (entry === undefined) return;
    this.#pending.delete(loginId);
    // ⚠️ Never rethrown. A connection that cannot be closed is already gone as
    // far as we are concerned, and failing here would leave the entry in the map.
    await entry.client.close().catch(() => {});
  }
}

/**
 * The real client, imported when one is needed.
 *
 * ⚠️ Written against teleproto's lower-level calls rather than `client.start()`,
 * which is built for a terminal: it takes callbacks and *asks* for the code, so
 * it cannot be driven by two HTTP requests arriving minutes apart.
 */
export async function connectForLogin(credentials: TelegramCredentials): Promise<TelegramLoginClient> {
  const { TelegramClient, Api, sessions, errors } = await import("teleproto");
  const client = new TelegramClient(new sessions.StringSession(""), credentials.apiId, credentials.apiHash, {
    connectionRetries: 3,
  });
  await client.connect();

  let phoneNumber = "";
  let phoneCodeHash = "";

  return {
    async sendCode(phone) {
      phoneNumber = phone;
      const sent = await client.sendCode(
        { apiId: credentials.apiId, apiHash: credentials.apiHash },
        phone,
      );
      phoneCodeHash = sent.phoneCodeHash;
    },

    async signIn(code) {
      try {
        await client.invoke(
          new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code }),
        );
        return "done";
      } catch (cause) {
        // The one refusal that is not a failure: the account has two-step
        // verification, and the password is the next step rather than a problem.
        if (cause instanceof errors.SessionPasswordNeededError) return "password-needed";
        throw cause;
      }
    },

    async checkPassword(password) {
      await client.signInWithPassword(
        { apiId: credentials.apiId, apiHash: credentials.apiHash },
        {
          password: async () => password,
          onError: (error: Error) => {
            throw error;
          },
        },
      );
    },

    session() {
      return String(client.session.save());
    },

    async account() {
      const me = (await client.getMe()) as { username?: string; firstName?: string; phone?: string };
      return me.username ? `@${me.username}` : (me.firstName ?? me.phone ?? "account");
    },

    async close() {
      await client.disconnect();
    },
  };
}
