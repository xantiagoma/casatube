/**
 * The credentials endpoints — the write-only half of `core/credentials.ts`.
 *
 * ## 🔴 The one rule
 *
 * **No response from this file ever contains a secret.** Not the cookie jar,
 * not the password, not the API key, not a prefix of any of them, not "the
 * first four characters so you can tell which one it is". Writing is one
 * directional: a secret goes in through `POST` and the only way it comes out
 * again is into a yt-dlp subprocess.
 *
 * That is enforced by shape rather than by care. Every route here answers with
 * {@link CredentialMetadata}, which has no field a secret could travel in, and
 * the store's read methods never load the `secret` column in the first place —
 * so there is no variable in scope for a future handler to return by accident.
 * An endpoint that hands back cookies is a leak waiting to happen, and the way
 * to not have one is to make it impossible to write casually.
 *
 * ## Why there is a `test` endpoint and why it never touches the network
 *
 * "Does this credential work?" splits into two questions with opposite fixes:
 * *is the credential wrong* and *is the site refusing us*. A test that made a
 * request would answer both at once — and would spend the IP budget (PLAN §4.3)
 * to do it, from the same address the downloads go out of, which is the exact
 * resource a bot challenge is punishing. So the test settles only what can be
 * settled locally: does it decrypt with the key running now, is it the right
 * shape, do the jar's domains actually cover the scope it is filed under, has
 * it already expired. That is enough to catch every mistake a person makes
 * while pasting, which is what a test button is for.
 *
 * ## ⚠️ The honesty requirement (PLAN §15)
 *
 * Cookies expire within hours and replaying them from another IP is itself a
 * signal. Every response that involves a cookie credential carries
 * {@link COOKIE_HONESTY} verbatim, and every response says whether encryption
 * is actually on — because the Settings screen claims *"Cookies are encrypted
 * at rest"*, and that sentence has to be either true or contradicted here.
 */
import { Elysia, t } from "elysia";
import { Result } from "better-result";

import {
  COOKIE_HONESTY,
  CREDENTIALS_KEY_ENV,
  CREDENTIAL_TYPES,
  type CredentialSecret,
  type CredentialStore,
} from "../core/credentials";
import { InvalidCredential, TelegramLoginUnavailable } from "../core/errors";
import type { TelegramLoginManager, TelegramLoginStep } from "../core/telegram-login";
import { TELEGRAM_SCOPE } from "../providers/telegram";
import { fail } from "./errors";

/** Roughly two hundred times the largest cookie jar anyone has ever exported. */
const MAX_COOKIES_BYTES = 1_000_000;

/**
 * The write shape.
 *
 * Flat rather than a discriminated union of four objects, because Eden derives
 * the frontend's types from this and a TypeBox union arrives in the browser as
 * something a form cannot bind to field by field. The combination is checked in
 * the handler instead, where the error can name the missing field.
 */
const createBody = t.Object({
  /**
   * Host, pattern or `*`. A pasted URL, a leading dot and a port are all
   * accepted and normalised — see `normaliseScope`.
   */
  scope: t.String({ minLength: 1, maxLength: 253 }),
  /**
   * ⚠️ `{ default: undefined }` for the reason in docs/DISCOVERIES.md:
   * `t.UnionEnum` otherwise sets `default: values[0]`, which would turn a
   * missing `type` into a silent `"cookies"` instead of a validation error.
   */
  type: t.UnionEnum([...CREDENTIAL_TYPES], { default: undefined }),
  /** Free text, for telling two accounts on the same site apart. */
  label: t.Optional(t.String({ maxLength: 200 })),
  /** `type: "cookies"` — a Netscape `cookies.txt`, validated before it is stored. */
  cookies: t.Optional(t.String({ maxLength: MAX_COOKIES_BYTES })),
  /** `type: "password"`. */
  username: t.Optional(t.String({ maxLength: 400 })),
  password: t.Optional(t.String({ maxLength: 4000 })),
  /** `type: "apiKey"`. */
  apiKey: t.Optional(t.String({ maxLength: 4000 })),
  /** `type: "custom"` — whatever a plugin provider expects. */
  data: t.Optional(t.Record(t.String(), t.String())),
});

type CreateBody = typeof createBody.static;

/**
 * Pick the secret out of the flat body, or say which field is missing.
 *
 * ⚠️ Every failure message here names a **field**, never a value. The body of
 * this request is the one place in the application where a plaintext credential
 * exists in an HTTP layer; nothing derived from it may be echoed back.
 */
function secretFrom(body: CreateBody): Result<CredentialSecret, InvalidCredential> {
  switch (body.type) {
    case "cookies":
      if (body.cookies === undefined) {
        return Result.err(
          new InvalidCredential({
            field: "cookies",
            detail: 'a "cookies" credential needs a Netscape cookies.txt in the "cookies" field',
          }),
        );
      }
      return Result.ok({ type: "cookies", cookies: body.cookies });
    case "password":
      if (body.username === undefined || body.password === undefined) {
        return Result.err(
          new InvalidCredential({
            field: body.username === undefined ? "username" : "password",
            detail: 'a "password" credential needs both "username" and "password"',
          }),
        );
      }
      return Result.ok({ type: "password", username: body.username, password: body.password });
    case "apiKey":
      if (body.apiKey === undefined) {
        return Result.err(
          new InvalidCredential({
            field: "apiKey",
            detail: 'an "apiKey" credential needs the key in the "apiKey" field',
          }),
        );
      }
      return Result.ok({ type: "apiKey", apiKey: body.apiKey });
    case "custom":
      if (body.data === undefined) {
        return Result.err(
          new InvalidCredential({
            field: "data",
            detail: 'a "custom" credential needs an object of fields in "data"',
          }),
        );
      }
      return Result.ok({ type: "custom", data: body.data });
  }
}

/** Only what these routes touch — the same narrowing the other route modules use. */
export interface CredentialRoutesContext {
  credentials: CredentialStore;
  /**
   * The Telegram sign-in flow, when the process has one.
   *
   * Optional for the reason `plugins` is: `createApp` has to stand up in a test
   * without it, and the three routes below simply answer 503 when it is absent
   * rather than pretending a login could be started.
   */
  telegramLogin?: TelegramLoginManager;
}

/**
 * How the API describes the state of encryption.
 *
 * Returned on **every** listing rather than hidden behind a separate endpoint,
 * because the one thing a screen must never do is claim "encrypted at rest"
 * while `CREDENTIALS_KEY` is unset. Making it part of the list makes the true
 * answer unavoidable.
 */
function encryptionState(store: CredentialStore) {
  const enabled = store.encryptionEnabled();
  return {
    enabled,
    algorithm: enabled ? ("aes-256-gcm" as const) : null,
    /** Which key, as a fingerprint. Non-reversible; safe to display. */
    keyId: store.keyId(),
    keyDerivation: enabled ? ("PBKDF2-HMAC-SHA256, 210000 iterations" as const) : null,
    warning: enabled
      ? null
      : `${CREDENTIALS_KEY_ENV} is not set, so secrets are stored in plain text in the ` +
        "database. Set it to a long random string and save each credential again to encrypt it.",
  };
}

/**
 * The last step of a Telegram login: seal the session, answer with metadata.
 *
 * 🔴 The `done` step carries the session string, and this is where it stops. The
 * browser gets an account name and a credential id — never the secret it would
 * have no use for and every reason not to hold (PLAN §12).
 *
 * The earlier steps carry nothing secret, so they pass straight through.
 */
async function finishTelegram(
  store: CredentialStore,
  stepped: Awaited<ReturnType<TelegramLoginManager["code"]>>,
) {
  if (Result.isError(stepped)) return fail(stepped.error);
  const step: TelegramLoginStep = stepped.value;
  if (step.state !== "done") return step;

  const created = await store.create({
    scope: TELEGRAM_SCOPE,
    label: `Telegram — ${step.account}`,
    secret: {
      type: "custom",
      data: { apiId: String(step.apiId), apiHash: step.apiHash, session: step.session },
    },
  });
  if (Result.isError(created)) return fail(created.error);

  return { state: "done" as const, account: step.account, credential: created.value };
}

export function credentialRoutes(ctx: CredentialRoutesContext) {
  const store = ctx.credentials;

  return (
    new Elysia()
      /**
       * Metadata for every credential. 🔴 No secrets — see the header.
       *
       * Ordered most-specific-scope first, which is the order they are
       * *resolved* in, so the list reads as the precedence it actually is.
       */
      .get("/credentials", async () => ({
        credentials: await store.list(),
        encryption: encryptionState(store),
        /** ⚠️ PLAN §15. Repeated here so no client has to remember to say it. */
        notice: COOKIE_HONESTY,
        at: new Date().toISOString(),
      }))

      /**
       * Store one. Replaces any existing credential with the same scope **and**
       * type — see the note on the unique index in `core/schema.ts`.
       *
       * A `cookies` body is parsed and validated before anything is written, so
       * a mangled paste is refused here in a second rather than twenty minutes
       * into a download.
       */
      .post(
        "/credentials",
        async ({ body, status }) => {
          const secret = secretFrom(body);
          if (Result.isError(secret)) return fail(secret.error);

          const created = await store.create({
            scope: body.scope,
            ...(body.label === undefined ? {} : { label: body.label }),
            secret: secret.value,
          });
          if (Result.isError(created)) return fail(created.error);

          return status(201, {
            credential: created.value,
            encryption: encryptionState(store),
            ...(body.type === "cookies" ? { notice: COOKIE_HONESTY } : {}),
          });
        },
        { body: createBody },
      )

      /**
       * Signing in to Telegram, in the two round trips it genuinely takes.
       *
       * 🔴 **The session string never comes back to the browser.** The manager
       * hands it over on the last step and *this* route consumes it — sealing it
       * into the store and answering with the credential's metadata. PLAN §12 is
       * flat about secrets not travelling back through the API, and a session
       * string is the most valuable one there is: it is the whole account.
       *
       * ⚠️ A pending login lives in memory and does not survive a restart. The
       * 404 below says that in words, because "unknown login" to someone who
       * typed the code correctly three seconds ago is a bug report waiting to
       * happen.
       */
      .post(
        "/credentials/telegram/start",
        async ({ body }) => {
          if (ctx.telegramLogin === undefined) return fail(
            new TelegramLoginUnavailable({
              detail: "scripts/telegram-session.ts does the same job from a terminal.",
            }),
          );
          /**
           * 🔴 Through `finishTelegram` like the other two, even though `start`
           * can only ever answer `code-needed`.
           *
           * Returning the step directly type-checks and is a hole waiting for a
           * refactor: the manager's `done` variant carries the session string,
           * so a future change that let `start` complete a login would serialise
           * an account into an HTTP response, silently. One exit for all three
           * steps means the session has exactly one path out of the manager —
           * into the store. Eden's derived client type is what pointed this out.
           */
          return finishTelegram(
            store,
            await ctx.telegramLogin.start({ apiId: body.apiId, apiHash: body.apiHash }, body.phone),
          );
        },
        {
          body: t.Object({
            apiId: t.Integer({ minimum: 1 }),
            /** ⚠️ Exactly 32 hex characters. A pasted RSA key is refused here. */
            apiHash: t.String({ pattern: "^[0-9a-fA-F]{32}$" }),
            phone: t.String({ minLength: 5, maxLength: 32 }),
          }),
        },
      )

      .post(
        "/credentials/telegram/code",
        async ({ body }) => {
          if (ctx.telegramLogin === undefined) return fail(
            new TelegramLoginUnavailable({
              detail: "scripts/telegram-session.ts does the same job from a terminal.",
            }),
          );
          const stepped = await ctx.telegramLogin.code(body.loginId, body.code);
          return finishTelegram(store, stepped);
        },
        {
          body: t.Object({
            loginId: t.String({ minLength: 1 }),
            code: t.String({ minLength: 3, maxLength: 16 }),
          }),
        },
      )

      .post(
        "/credentials/telegram/password",
        async ({ body }) => {
          if (ctx.telegramLogin === undefined) return fail(
            new TelegramLoginUnavailable({
              detail: "scripts/telegram-session.ts does the same job from a terminal.",
            }),
          );
          const stepped = await ctx.telegramLogin.password(body.loginId, body.password);
          return finishTelegram(store, stepped);
        },
        {
          body: t.Object({
            loginId: t.String({ minLength: 1 }),
            password: t.String({ minLength: 1, maxLength: 512 }),
          }),
        },
      )

      /** Give up, and close the connection rather than waiting for it to expire. */
      .delete("/credentials/telegram/:loginId", async ({ params }) => {
        await ctx.telegramLogin?.cancel(params.loginId);
        return { cancelled: true };
      })

      .delete("/credentials/:id", async ({ params }) => {
        const removed = await store.delete(params.id);
        if (Result.isError(removed)) return fail(removed.error);
        return { deleted: true, id: removed.value.id };
      })

      /**
       * Check a credential against its own scope — offline. See the header for
       * why this makes no request to the site.
       */
      .post("/credentials/:id/test", async ({ params }) => {
        const report = await store.test(params.id);
        if (Result.isError(report)) return fail(report.error);
        return report.value;
      })
  );
}
