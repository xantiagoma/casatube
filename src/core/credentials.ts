/**
 * Credentials — per provider, per site, sealed at rest, one-way through the API.
 *
 * ## Why this exists
 *
 * PLAN §12 shipped exactly one way to authenticate: a single `COOKIES_FILE`
 * environment variable, global to the process. That is enough for one YouTube
 * account and nothing else. Age-gated video, members-only uploads and the
 * *"Sign in to confirm you're not a bot"* challenge all need a session, and the
 * sites that need one do not agree on what a session **is** — YouTube wants a
 * cookie jar, some sites want a username and a password, others want an API
 * key. A single file cannot express that, and neither can a single variable.
 *
 * So a credential has three parts:
 *
 * - a **scope** — the host it applies to (`youtube.com`, `*.odysee.com`, or `*`
 *   for everything). Resolution is **most specific wins**, so a jar for
 *   `youtube.com` beats a catch-all without anyone having to remove the
 *   catch-all.
 * - a **type** — `cookies`, `password`, `apiKey` or `custom`.
 * - the **secret** itself, which is the part that never comes back out.
 *
 * ## 🔴 One-way by construction, not by discipline
 *
 * `list()` and `get()` return {@link CredentialMetadata}, a type that has no
 * field the secret could travel in. Reading a secret needs {@link
 * CredentialStore.acquire}, which hands it straight to a subprocess and takes
 * it back again. There is no method that returns a secret to a caller who could
 * serialise it, so "an endpoint that returns cookies" is not something a future
 * route can do by accident — it would have to be written on purpose, against
 * the shape of this module.
 *
 * ## ⚠️ Cookies are a mitigation, not a fix (PLAN §15)
 *
 * A YouTube cookie jar **expires within hours**, and replaying it from an IP
 * other than the one that created it is itself a signal that gets accounts
 * challenged. That is why {@link parseNetscapeCookies} extracts the soonest
 * expiry and stores it as metadata: the UI can say "these expired yesterday"
 * instead of letting a stale jar look like a broken downloader. See
 * {@link COOKIE_HONESTY}, which is the sentence the API repeats out loud.
 */
import { randomUUIDv7 } from "bun";
import { and, eq, sql } from "drizzle-orm";
import { Result } from "better-result";

import type { Db } from "./db";
import { InvalidCredential, NotFound } from "./errors";
import { credentials } from "./schema";

// --- Vocabulary -------------------------------------------------------------

/**
 * ⚠️ A tuple, not `readonly CredentialType[]`: the HTTP layer feeds this to
 * `t.UnionEnum`, which needs the literal members to type the route. An
 * annotation widens them back to `string` and the route loses its shape.
 */
export const CREDENTIAL_TYPES = ["cookies", "password", "apiKey", "custom"] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/**
 * The secret, in the one shape it is ever held in memory.
 *
 * A discriminated union rather than four columns: the sealed blob is a single
 * JSON string, so adding a type later changes this union and nothing about the
 * storage, the encryption or the migration.
 */
export type CredentialSecret =
  | { type: "cookies"; cookies: string }
  | { type: "password"; username: string; password: string }
  | { type: "apiKey"; apiKey: string }
  | { type: "custom"; data: Record<string, string> };

/**
 * Non-secret facts *about* a secret — everything the UI needs to tell two
 * credentials apart and to know whether one is still worth anything.
 *
 * 📌 `username` is here on purpose. It is not the secret (the password is), and
 * without it a list of two `password` credentials for the same site is two
 * identical rows. The password has no field to travel in, here or anywhere.
 */
export interface CredentialMeta {
  /** cookies: how many cookie lines the jar carries. */
  cookieCount?: number;
  /** cookies: the domains it covers, deduped and sorted. */
  domains?: string[];
  /**
   * cookies: the soonest non-session expiry, ISO.
   *
   * ⚠️ Usually **hours** away for a YouTube jar. This is the field that lets a
   * screen say so before a download fails at minute twenty.
   */
  expiresAt?: string;
  /** cookies: how many entries are session cookies (expiry `0`, no deadline). */
  sessionCookies?: number;
  /** password: which account. See the note above — not the secret. */
  username?: string;
  /** apiKey / custom: which fields exist. **Never their values.** */
  fields?: string[];
}

/** Everything about a credential except the one thing that matters. */
export interface CredentialMetadata {
  id: string;
  scope: string;
  type: CredentialType;
  label: string | null;
  /** `true` when the stored bytes are AES-GCM, `false` when they are plaintext. */
  encrypted: boolean;
  /**
   * Which `CREDENTIALS_KEY` sealed this, as a short non-reversible fingerprint.
   *
   * It exists so "the key changed" is a diagnosable state rather than a
   * decryption error with no explanation — see {@link CredentialStore.test}.
   */
  keyId: string | null;
  meta: CredentialMeta;
  createdAt: string;
  updatedAt: string;
  /** When a download last used it. Null means it has never been exercised. */
  lastUsedAt: string | null;
}

/**
 * The sentence the API repeats wherever a cookie credential is involved.
 *
 * Written once, here, because PLAN §15 is blunt about it and a warning that
 * lives in one screen's copy is a warning the next screen forgets.
 */
export const COOKIE_HONESTY =
  "Cookies expire within hours, and replaying them from an IP other than the one that " +
  "created them is itself a signal. They are a mitigation, not a fix.";

// --- Scopes -----------------------------------------------------------------

/** `*` — the catch-all scope, the least specific thing that can match. */
export const ANY_SCOPE = "*";

/**
 * Turn what a person typed into a scope we can match against.
 *
 * Deliberately forgiving about the four things people actually paste: a whole
 * URL, a leading dot (the Netscape cookie convention), a port, and capitals.
 * Deliberately strict about everything else — a scope that silently matched
 * nothing would be a credential that silently never applies, which is the worst
 * possible failure for this feature.
 */
export function normaliseScope(input: string): Result<string, InvalidCredential> {
  let raw = input.trim().toLowerCase();
  if (raw === "") {
    return Result.err(new InvalidCredential({ field: "scope", detail: "a scope cannot be empty" }));
  }
  if (raw === ANY_SCOPE) return Result.ok(ANY_SCOPE);

  // A pasted URL: keep the host and drop everything around it.
  if (raw.includes("://")) {
    try {
      raw = new URL(raw).hostname;
    } catch {
      return Result.err(
        new InvalidCredential({ field: "scope", detail: `not a host or a URL: ${input}` }),
      );
    }
  }
  // A path, a port, or the Netscape leading dot.
  raw = raw.split("/")[0] ?? "";
  raw = raw.split(":")[0] ?? "";
  raw = raw.replace(/\.$/, "");
  if (raw.startsWith(".")) raw = `*${raw}`;

  const host = raw.startsWith("*.") ? raw.slice(2) : raw;
  if (host === "") {
    return Result.err(new InvalidCredential({ field: "scope", detail: "a scope cannot be empty" }));
  }
  if (host.includes("*")) {
    return Result.err(
      new InvalidCredential({
        field: "scope",
        detail: `a wildcard is only allowed as a leading "*." — got ${input}`,
      }),
    );
  }
  if (!/^[a-z0-9._-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    return Result.err(
      new InvalidCredential({ field: "scope", detail: `not a valid host: ${input}` }),
    );
  }
  return Result.ok(raw);
}

/** Does this scope apply to this host? `*.a.com` covers `a.com` and every subdomain. */
export function scopeMatchesHost(scope: string, host: string): boolean {
  const target = host.trim().toLowerCase().replace(/\.$/, "");
  if (scope === ANY_SCOPE) return true;
  if (scope.startsWith("*.")) {
    const base = scope.slice(2);
    return target === base || target.endsWith(`.${base}`);
  }
  return target === scope;
}

/**
 * How specific a scope is. Higher wins.
 *
 * Two labels of the answer: **more labels matched is more specific**, and an
 * exact host beats the wildcard over the same host. So
 * `www.youtube.com` (7) > `*.www.youtube.com` (6) > `youtube.com` (5) >
 * `*.youtube.com` (4) > `*` (0).
 *
 * The odd/even encoding is what keeps those two rules from needing a
 * tie-breaker: doubling the label count leaves exactly one gap per level, and
 * the exact-match bit fills it.
 */
export function scopeSpecificity(scope: string): number {
  if (scope === ANY_SCOPE) return 0;
  const wildcard = scope.startsWith("*.");
  const host = wildcard ? scope.slice(2) : scope;
  const labels = host.split(".").filter((part) => part !== "").length;
  return labels * 2 + (wildcard ? 0 : 1);
}

/** The host a job's URL points at, or `null` when it is not a URL at all. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

// --- Netscape cookies.txt ---------------------------------------------------

/**
 * What a jar turned out to contain. Counts and domains, never a value.
 */
export interface CookieJarSummary {
  count: number;
  domains: string[];
  /** Soonest non-session expiry, ISO. Absent when every cookie is a session one. */
  expiresAt?: string;
  sessionCookies: number;
  /** Entries already past their expiry at parse time. */
  expired: number;
}

const NETSCAPE_HTTPONLY_PREFIX = "#HttpOnly_";

/**
 * Validate a Netscape `cookies.txt` — the only cookie format yt-dlp reads.
 *
 * 🔴 This runs **before** the credential is stored, and that is the whole
 * point. A jar that was pasted out of a browser extension with tabs mangled
 * into spaces fails at minute twenty of an 800 MB download, three layers away
 * from the paste that caused it. A rejection at the moment of pasting costs a
 * second and says what is wrong.
 *
 * The format, one line per cookie, seven **tab**-separated fields:
 *
 * ```
 * domain  includeSubdomains  path  secure  expiry  name  value
 * ```
 *
 * ⚠️ `#HttpOnly_` is a real prefix on the domain field, not a comment — Chrome
 * and Firefox both write it, and treating it as a comment silently drops every
 * session cookie in the file, which are precisely the ones that authenticate.
 */
export function parseNetscapeCookies(text: string): Result<CookieJarSummary, InvalidCredential> {
  if (text.trim() === "") {
    return Result.err(
      new InvalidCredential({ field: "cookies", detail: "the cookie file is empty" }),
    );
  }

  const lines = text.split(/\r?\n/);
  const domains = new Set<string>();
  let count = 0;
  let sessionCookies = 0;
  let expired = 0;
  let soonest: number | null = null;
  const nowSeconds = Math.floor(Date.now() / 1000);

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const httpOnly = line.startsWith(NETSCAPE_HTTPONLY_PREFIX);
    if (line.startsWith("#") && !httpOnly) continue;

    const at = `line ${index + 1}`;
    const fields = (httpOnly ? line.slice(NETSCAPE_HTTPONLY_PREFIX.length) : line).split("\t");

    if (fields.length !== 7) {
      // The single most common paste failure, and it deserves its own sentence:
      // copying out of a terminal or a text editor turns the tabs into runs of
      // spaces, and "7 fields" is then a mystery rather than a hint.
      const detail =
        fields.length === 1 && /\s{2,}| /.test(line)
          ? `${at} is separated by spaces, not tabs — this file was probably ` +
            "copied through something that reformatted it. Export it again and " +
            "upload the file rather than pasting it."
          : `${at} has ${fields.length} tab-separated field(s), the format needs 7`;
      return Result.err(new InvalidCredential({ field: "cookies", detail }));
    }

    const [domain, includeSubdomains, path, secure, expiry, name] = fields as [
      string, string, string, string, string, string, string,
    ];

    for (const [label, value] of [
      ["include-subdomains", includeSubdomains],
      ["secure", secure],
    ] as const) {
      if (!/^(true|false)$/i.test(value.trim())) {
        return Result.err(
          new InvalidCredential({
            field: "cookies",
            detail: `${at}: the ${label} field must be TRUE or FALSE, got "${value}"`,
          }),
        );
      }
    }
    if (!/^-?\d+$/.test(expiry.trim())) {
      return Result.err(
        new InvalidCredential({
          field: "cookies",
          detail: `${at}: the expiry field must be a whole number of seconds, got "${expiry}"`,
        }),
      );
    }
    if (domain.trim() === "" || name.trim() === "" || path.trim() === "") {
      return Result.err(
        new InvalidCredential({
          field: "cookies",
          detail: `${at}: domain, path and name cannot be empty`,
        }),
      );
    }

    count += 1;
    domains.add(domain.trim().toLowerCase().replace(/^\./, ""));
    const seconds = Number.parseInt(expiry, 10);
    if (seconds <= 0) {
      sessionCookies += 1;
    } else {
      if (seconds < nowSeconds) expired += 1;
      if (soonest === null || seconds < soonest) soonest = seconds;
    }
  }

  if (count === 0) {
    return Result.err(
      new InvalidCredential({
        field: "cookies",
        detail:
          "no cookie lines found — every line was blank or a comment. A Netscape " +
          "cookie file has one tab-separated cookie per line.",
      }),
    );
  }

  return Result.ok({
    count,
    domains: [...domains].sort(),
    sessionCookies,
    expired,
    ...(soonest === null ? {} : { expiresAt: new Date(soonest * 1000).toISOString() }),
  });
}

// --- Sealing ----------------------------------------------------------------

const SEAL_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const PLAINTEXT = "plaintext";
/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. ~95 ms in Bun, cached per salt. */
const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface Sealed {
  blob: string;
  protection: typeof ALGORITHM | typeof PLAINTEXT;
  keyId: string | null;
}

/**
 * A short, non-reversible fingerprint of the key material.
 *
 * Stored beside each credential so that a changed `CREDENTIALS_KEY` reports
 * itself as *"sealed with a different key"* rather than as a decryption failure
 * with no cause. It is a hash of a hash of the key with a fixed domain string —
 * eight hex characters, which identifies a key without narrowing it.
 */
export function keyFingerprint(key: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("casatube/credentials/key-id ");
  hasher.update(key);
  return hasher.digest("hex").slice(0, 8);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

/**
 * Derived keys, by (key fingerprint, salt).
 *
 * PBKDF2 at 210k iterations is ~95 ms, and a credential is opened on **every**
 * probe, listing and download. Without this cache, authentication would cost a
 * tenth of a second per subprocess for no security gain: the salt is already
 * stored in plain sight next to the ciphertext, so remembering the key it
 * derives reveals nothing the row does not, and `deriveKey` marks the result
 * non-extractable so it cannot be read back out of the process either.
 *
 * ⚠️ Bounded. An unbounded map here would grow by one entry per credential
 * write for the life of the process.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();
const KEY_CACHE_MAX = 64;

/**
 * Derive the AES key from the passphrase and this credential's salt.
 *
 * PBKDF2 rather than a bare hash of the environment variable, because
 * `CREDENTIALS_KEY` is a **passphrase a person typed**, not 32 bytes of
 * entropy. Stretching is what makes the database alone worth little if it
 * leaks without the environment it ran in.
 */
function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const cacheKey = `${keyFingerprint(passphrase)}:${toBase64(salt)}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;

  const derived = (async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      // Not extractable: nothing, including our own code, can export these bytes.
      false,
      ["encrypt", "decrypt"],
    );
  })();

  if (keyCache.size >= KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next();
    if (!oldest.done) keyCache.delete(oldest.value);
  }
  keyCache.set(cacheKey, derived);
  // A failed derivation must not be remembered as the answer for this salt.
  void derived.catch(() => keyCache.delete(cacheKey));
  return derived;
}

/**
 * Seal a secret. With no passphrase this **stores plaintext and says so** —
 * `protection` reads `plaintext`, the metadata reports `encrypted: false`, and
 * the caller is expected to have warned out loud. Pretending to encrypt with a
 * key that does not exist would be worse than not encrypting: it would make a
 * screen say "encrypted at rest" and be lying.
 */
export async function seal(secret: CredentialSecret, passphrase: string | null): Promise<Sealed> {
  const json = JSON.stringify(secret);
  if (passphrase === null || passphrase === "") {
    return {
      blob: [SEAL_VERSION, PLAINTEXT, toBase64(new TextEncoder().encode(json))].join("."),
      protection: PLAINTEXT,
      keyId: null,
    };
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(json),
    ),
  );

  return {
    blob: [SEAL_VERSION, ALGORITHM, toBase64(salt), toBase64(iv), toBase64(ciphertext)].join("."),
    protection: ALGORITHM,
    keyId: keyFingerprint(passphrase),
  };
}

/**
 * Open a sealed blob.
 *
 * ⚠️ Fails rather than falling back. A plaintext blob opened while a key is
 * configured is fine (it predates the key); a sealed blob with no key, or with
 * the wrong one, is a *state the operator has to know about* — the honest
 * answer is an error naming the cause, not an empty credential that makes
 * yt-dlp look broken.
 */
export async function unseal(
  blob: string,
  passphrase: string | null,
): Promise<Result<CredentialSecret, InvalidCredential>> {
  const parts = blob.split(".");
  const [version, protection] = parts;
  if (version !== SEAL_VERSION) {
    return Result.err(
      new InvalidCredential({ field: "secret", detail: `unknown seal version "${version}"` }),
    );
  }

  if (protection === PLAINTEXT) {
    const [, , payload] = parts;
    if (payload === undefined) {
      return Result.err(new InvalidCredential({ field: "secret", detail: "truncated secret" }));
    }
    return parseSecret(new TextDecoder().decode(fromBase64(payload)));
  }

  if (protection !== ALGORITHM) {
    return Result.err(
      new InvalidCredential({ field: "secret", detail: `unknown protection "${protection}"` }),
    );
  }
  if (passphrase === null || passphrase === "") {
    return Result.err(
      new InvalidCredential({
        field: "secret",
        detail:
          "this credential is encrypted and CREDENTIALS_KEY is not set. Set it to the " +
          "value that was used when the credential was saved.",
      }),
    );
  }

  const [, , saltB64, ivB64, ciphertextB64] = parts;
  if (saltB64 === undefined || ivB64 === undefined || ciphertextB64 === undefined) {
    return Result.err(new InvalidCredential({ field: "secret", detail: "truncated secret" }));
  }

  try {
    const key = await deriveKey(passphrase, fromBase64(saltB64));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(ivB64) as BufferSource },
      key,
      fromBase64(ciphertextB64) as BufferSource,
    );
    return parseSecret(new TextDecoder().decode(plain));
  } catch {
    // AES-GCM authenticates, so this is not "corrupt bytes" — it is the wrong
    // key, essentially always.
    return Result.err(
      new InvalidCredential({
        field: "secret",
        detail:
          "could not decrypt: CREDENTIALS_KEY does not match the key this credential " +
          "was saved with. Restore the old key, or delete and re-add the credential.",
      }),
    );
  }
}

function parseSecret(json: string): Result<CredentialSecret, InvalidCredential> {
  try {
    return Result.ok(JSON.parse(json) as CredentialSecret);
  } catch {
    return Result.err(
      new InvalidCredential({ field: "secret", detail: "the stored secret is not valid JSON" }),
    );
  }
}

// --- Handing a secret to a subprocess ---------------------------------------

/**
 * A credential, materialised for exactly one yt-dlp invocation.
 *
 * The shape is a *lease*, not a value, because a cookie jar has to become a
 * **file on disk** for yt-dlp to read it and that file must not outlive the
 * run. `release()` is what deletes it, and every caller is expected to call it
 * from a `finally`.
 */
export interface CredentialLease {
  id: string;
  type: CredentialType;
  scope: string;
  /** A 0600 Netscape cookie file, alive only until `release()`. */
  cookiesFile?: string;
  username?: string;
  /** ⚠️ Reaches yt-dlp as `--password`, and therefore appears in `ps`. */
  password?: string;
  /**
   * Every secret string this lease carries, for scrubbing log lines.
   *
   * yt-dlp does not echo credentials, but its stderr is forwarded verbatim into
   * the job log and the job log is shown in a browser. One accidental echo from
   * a future yt-dlp is all it would take.
   */
  redact: string[];
  /**
   * `type: "apiKey"` — the key itself.
   *
   * Never a command-line argument anywhere: unlike `password`, which yt-dlp
   * takes as `--password` and therefore leaks into `ps`, an API key is only ever
   * read in-process by the provider that asked for it.
   */
  apiKey?: string;
  /**
   * `type: "custom"` — every field, as stored.
   *
   * 🔴 This is what a provider with more than one secret needs: a Telegram
   * session is an `api_id`, an `api_hash` and a session string, and none of
   * them is a cookie jar or a password. The shape is deliberately open, because
   * the store cannot know what a provider will want and inventing four named
   * fields for it would be four fields the next provider does not fit either.
   */
  data?: Record<string, string>;
  release(): Promise<void>;
}

/**
 * What `providers/ytdlp.ts` depends on — and **all** it depends on.
 *
 * A one-method interface rather than the store itself, so the provider never
 * sees a database, a decrypt function or a list of credentials. That is also
 * what keeps the import type-only in the provider: the value never crosses the
 * seam, only the shape does (see the import-cycle entry in DISCOVERIES).
 */
export interface CredentialResolver {
  /**
   * The best credential for this URL, materialised, or `null` if there is none.
   *
   * `types` defaults to the two a yt-dlp command line can carry. A provider
   * with its own kind of secret — a Telegram session, an API key — names it.
   */
  acquire(url: string, types?: readonly CredentialType[]): Promise<CredentialLease | null>;
}

// --- The store --------------------------------------------------------------

export interface CredentialStoreOptions {
  db: Db;
  /**
   * The passphrase. Defaults to `CREDENTIALS_KEY`; `null` means "store
   * plaintext and be loud about it".
   */
  key?: string | null;
  /** Where cookie files are materialised. Defaults to the OS temp directory. */
  tempDir?: string;
  now?: () => Date;
  newId?: () => string;
  /** Where the plaintext warning goes. Defaults to `console.warn`. */
  warn?: (line: string) => void;
}

export interface CreateCredential {
  scope: string;
  label?: string | null;
  secret: CredentialSecret;
}

/** One line of a {@link CredentialReport}. */
export interface CredentialCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The answer to "is this credential any use?", **without touching the network**.
 *
 * Deliberately offline: the point of a test button is to separate "the
 * credential is wrong" from "the site refused us", and a test that makes a
 * request to the site cannot do that — it fails for both reasons at once, and
 * it spends the IP budget (PLAN §4.3) to do it. What can be settled locally is
 * settled locally: does it decrypt, is it the right shape, does the jar's
 * domain list actually cover the scope it claims, has it already expired.
 */
export interface CredentialReport {
  id: string;
  scope: string;
  type: CredentialType;
  ok: boolean;
  checks: CredentialCheck[];
  /** True but worth saying — an imminent expiry, a plaintext store. */
  warnings: string[];
}

/** The environment variable that turns "at rest" into a true statement. */
export const CREDENTIALS_KEY_ENV = "CREDENTIALS_KEY";

export function credentialsKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env[CREDENTIALS_KEY_ENV];
  return value !== undefined && value.trim() !== "" ? value : null;
}

/**
 * The startup warning, in one place so it says the same thing everywhere.
 *
 * ⚠️ It is deliberately three lines and deliberately unconditional when the key
 * is missing. The Settings mockup says *"Cookies are encrypted at rest"*; if
 * nothing shouts here, that sentence becomes false the moment somebody pastes a
 * jar, and nobody finds out.
 */
export function warnIfUnprotected(
  key: string | null,
  log: (line: string) => void = (line) => console.warn(line),
): boolean {
  if (key !== null) return false;
  log("[casatube] ⚠️  CREDENTIALS_KEY is not set.");
  log("[casatube] ⚠️  Cookies, passwords and API keys will be stored IN PLAIN TEXT");
  log(`[casatube] ⚠️  in the database. Set ${CREDENTIALS_KEY_ENV} to a long random string to encrypt them.`);
  return true;
}

const COOKIE_FILE_MODE = 0o600;
const COOKIE_DIR_MODE = 0o700;

export class CredentialStore implements CredentialResolver {
  private readonly db: Db;
  private readonly key: string | null;
  private readonly tempDir: string | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly warn: (line: string) => void;

  constructor(options: CredentialStoreOptions) {
    this.db = options.db;
    this.key = options.key === undefined ? credentialsKeyFromEnv() : options.key;
    this.tempDir = options.tempDir;
    this.now = options.now ?? (() => new Date());
    // v7: time-ordered, so two credentials written in the same millisecond
    // still come back in the order they were created.
    this.newId = options.newId ?? (() => randomUUIDv7());
    this.warn = options.warn ?? ((line) => console.warn(line));
  }

  /** Whether secrets written from now on will actually be encrypted. */
  encryptionEnabled(): boolean {
    return this.key !== null;
  }

  /** The fingerprint of the key in force, or null when there is none. */
  keyId(): string | null {
    return this.key === null ? null : keyFingerprint(this.key);
  }

  // --- Writing --------------------------------------------------------------

  /**
   * Store a credential.
   *
   * ⚠️ **`(scope, type)` is unique, so this replaces.** Pasting a fresh
   * YouTube jar is the single most common thing anyone will do with this
   * feature — they expire in hours — and the alternative is a table that
   * accumulates dead jars for the same site while resolution has to guess which
   * one is meant. Replacing keeps "most specific wins" a total order.
   */
  async create(input: CreateCredential): Promise<Result<CredentialMetadata, InvalidCredential>> {
    const scope = normaliseScope(input.scope);
    if (Result.isError(scope)) return scope;

    const meta = describeSecret(input.secret);
    if (Result.isError(meta)) return meta;

    if (this.key === null) {
      this.warn(
        `[casatube] ⚠️  storing a ${input.secret.type} credential for ${scope.value} ` +
          `IN PLAIN TEXT — ${CREDENTIALS_KEY_ENV} is not set`,
      );
    }

    const sealed = await seal(input.secret, this.key);
    const at = this.now().toISOString();
    const existing = await this.db
      .select({ id: credentials.id, createdAt: credentials.createdAt })
      .from(credentials)
      .where(and(eq(credentials.scope, scope.value), eq(credentials.type, input.secret.type)))
      .limit(1);

    const previous = existing[0];
    const row = {
      id: previous?.id ?? this.newId(),
      scope: scope.value,
      type: input.secret.type,
      label: input.label ?? null,
      secret: sealed.blob,
      protection: sealed.protection,
      keyId: sealed.keyId,
      meta: meta.value,
      // A replacement keeps the original creation time: the credential for this
      // site is the same credential, refreshed. `updatedAt` is what moved.
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
      // 🔴 Reset. A new jar has never been used, and carrying the old
      // `lastUsedAt` forward would make an untried paste look proven.
      lastUsedAt: null,
    };

    if (previous) {
      await this.db.update(credentials).set(row).where(eq(credentials.id, previous.id));
    } else {
      await this.db.insert(credentials).values(row);
    }
    return Result.ok(toMetadata(row));
  }

  async delete(id: string): Promise<Result<{ id: string }, NotFound>> {
    const removed = await this.db
      .delete(credentials)
      .where(eq(credentials.id, id))
      .returning({ id: credentials.id });
    const row = removed[0];
    if (!row) return Result.err(new NotFound({ what: "credential", id }));
    return Result.ok({ id: row.id });
  }

  // --- Reading (metadata only) ---------------------------------------------

  /**
   * 🔴 Every column **except** `secret`, listed one by one.
   *
   * Not `select()` with an omission afterwards: a `SELECT *` that is filtered
   * in TypeScript puts the plaintext in a variable a future `return` could
   * reach, and the whole design of this module is that no such variable exists
   * outside `acquire`.
   */
  private get columns() {
    return {
      id: credentials.id,
      scope: credentials.scope,
      type: credentials.type,
      label: credentials.label,
      protection: credentials.protection,
      keyId: credentials.keyId,
      meta: credentials.meta,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
      lastUsedAt: credentials.lastUsedAt,
    };
  }

  /** Most specific scope first, then most recently updated. */
  async list(): Promise<CredentialMetadata[]> {
    const rows = await this.db.select(this.columns).from(credentials);
    return rows
      .map(toMetadata)
      .sort(
        (a, b) =>
          scopeSpecificity(b.scope) - scopeSpecificity(a.scope) ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
  }

  async get(id: string): Promise<Result<CredentialMetadata, NotFound>> {
    const rows = await this.db
      .select(this.columns)
      .from(credentials)
      .where(eq(credentials.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return Result.err(new NotFound({ what: "credential", id }));
    return Result.ok(toMetadata(row));
  }

  /**
   * Which credential a URL would use, as metadata.
   *
   * Answers the question a download form wants to ask — *"will this URL be
   * authenticated, and by what?"* — without opening anything.
   */
  async resolve(
    url: string,
    types: readonly CredentialType[] = CREDENTIAL_TYPES,
  ): Promise<CredentialMetadata | null> {
    const host = hostOf(url);
    if (host === null) return null;
    const wanted = new Set(types);
    const candidates = (await this.list()).filter(
      (row) => wanted.has(row.type) && scopeMatchesHost(row.scope, host),
    );
    // `list()` already sorts most-specific-first, so the head is the winner.
    return candidates[0] ?? null;
  }

  // --- Using ----------------------------------------------------------------

  /**
   * Materialise the best credential for a URL, for one subprocess.
   *
   * 🔴 **The default is narrow on purpose, and it is a guard rather than a
   * shortcut.** Only the two types yt-dlp can actually use are considered: a
   * stored API key has nowhere to go on a command line, and picking one here
   * would shadow a cookie jar that *would* have worked. A caller that knows
   * what to do with another type asks for it — `acquire(url, ["custom"])` —
   * which keeps the promise ("yt-dlp is never handed a key") as a default
   * instead of as a prohibition that made the other two types unusable by
   * anything at all.
   *
   * ⚠️ Where the promise is really kept is `withCredentials` in
   * `providers/ytdlp.ts`: it copies exactly `cookiesFile`, `username` and
   * `password` onto its options, so a field it never reads cannot reach argv.
   * `credentials.test.ts` asserts that over the built arguments, which is a
   * claim about the thing that matters rather than about a proxy for it.
   */
  async acquire(
    url: string,
    types: readonly CredentialType[] = ["cookies", "password"],
  ): Promise<CredentialLease | null> {
    const chosen = await this.resolve(url, types);
    if (chosen === null) return null;

    const rows = await this.db
      .select({ secret: credentials.secret })
      .from(credentials)
      .where(eq(credentials.id, chosen.id))
      .limit(1);
    const blob = rows[0]?.secret;
    if (blob === undefined) return null;

    const opened = await unseal(blob, this.key);
    if (Result.isError(opened)) {
      // Loud, but not fatal: a download without credentials may still work, and
      // failing the job here would blame yt-dlp for a key problem.
      this.warn(
        `[casatube] ⚠️  credential ${chosen.id} (${chosen.scope}) could not be opened: ` +
          opened.error.detail,
      );
      return null;
    }

    const secret = opened.value;
    await this.markUsed(chosen.id);

    if (secret.type === "cookies") {
      const file = await writeCookieFile(secret.cookies, this.tempDir);
      return {
        id: chosen.id,
        type: chosen.type,
        scope: chosen.scope,
        cookiesFile: file.path,
        // The jar itself is never logged, but individual cookie *values* could
        // in principle be echoed by an extractor error.
        redact: [],
        release: file.release,
      };
    }
    if (secret.type === "password") {
      return {
        id: chosen.id,
        type: chosen.type,
        scope: chosen.scope,
        username: secret.username,
        password: secret.password,
        redact: [secret.password],
        release: async () => {},
      };
    }
    /**
     * 🔴 These two returned `null` until now, and it was a **deliberate guard**,
     * not an oversight: *"an API key is never handed to yt-dlp"*, enforced by
     * refusing to materialise one at all.
     *
     * The promise is worth keeping and this was the wrong place to keep it. It
     * is already kept where it can be *proved* — `withCredentials` in
     * `providers/ytdlp.ts` copies exactly three fields onto its options
     * (`cookiesFile`, `username`, `password`), so a field it never reads cannot
     * reach argv. Enforcing it a second time here only meant that a credential
     * the store validated, sealed, stored and **listed as present** could never
     * be used by anything — including the `custom` type that `api/credentials.ts`
     * documents as "whatever a provider expects".
     *
     * ⚠️ So the guard moved rather than disappeared: `credentials.test.ts` now
     * asserts the real invariant — a lease carrying a key produces yt-dlp
     * arguments that contain none of it — which is a claim about the thing that
     * matters instead of about a proxy for it.
     */
    if (secret.type === "apiKey") {
      return {
        id: chosen.id,
        type: chosen.type,
        scope: chosen.scope,
        apiKey: secret.apiKey,
        redact: [secret.apiKey],
        release: async () => {},
      };
    }
    return {
      id: chosen.id,
      type: chosen.type,
      scope: chosen.scope,
      data: { ...secret.data },
      // ⚠️ Every value, not the ones that look secret. A `custom` credential is
      // whatever a provider needed to keep out of the database in plaintext, so
      // the store is not in a position to decide which half of it is harmless.
      // Short values are skipped by `scrub` itself, which is where that judgement
      // belongs.
      redact: Object.values(secret.data),
      release: async () => {},
    };
  }

  private async markUsed(id: string): Promise<void> {
    await this.db
      .update(credentials)
      .set({ lastUsedAt: this.now().toISOString() })
      .where(eq(credentials.id, id));
  }

  // --- Testing --------------------------------------------------------------

  /**
   * Check a credential against its own scope, offline. See {@link CredentialReport}.
   */
  async test(id: string): Promise<Result<CredentialReport, NotFound>> {
    const metadata = await this.get(id);
    if (Result.isError(metadata)) return metadata;
    const meta = metadata.value;

    const checks: CredentialCheck[] = [];
    const warnings: string[] = [];

    if (!meta.encrypted) {
      warnings.push(
        `This credential is stored in plain text. Set ${CREDENTIALS_KEY_ENV} and save it again to encrypt it.`,
      );
    } else if (meta.keyId !== null && meta.keyId !== this.keyId()) {
      warnings.push(
        `It was sealed with a different ${CREDENTIALS_KEY_ENV} (${meta.keyId}) than the one running now.`,
      );
    }

    const rows = await this.db
      .select({ secret: credentials.secret })
      .from(credentials)
      .where(eq(credentials.id, id))
      .limit(1);
    const blob = rows[0]?.secret;
    if (blob === undefined) return Result.err(new NotFound({ what: "credential", id }));

    const opened = await unseal(blob, this.key);
    if (Result.isError(opened)) {
      checks.push({ name: "readable", ok: false, detail: opened.error.detail });
      return Result.ok({ id, scope: meta.scope, type: meta.type, ok: false, checks, warnings });
    }
    checks.push({
      name: "readable",
      ok: true,
      detail: meta.encrypted
        ? "Decrypted with the current key."
        : "Read from the database (not encrypted).",
    });

    const secret = opened.value;
    if (secret.type === "cookies") {
      const jar = parseNetscapeCookies(secret.cookies);
      if (Result.isError(jar)) {
        checks.push({ name: "format", ok: false, detail: jar.error.detail });
        return Result.ok({ id, scope: meta.scope, type: meta.type, ok: false, checks, warnings });
      }
      checks.push(...cookieChecks(jar.value, meta.scope, this.now()));
      warnings.push(COOKIE_HONESTY);
    } else if (secret.type === "password") {
      const ok = secret.username.trim() !== "" && secret.password !== "";
      checks.push({
        name: "complete",
        ok,
        detail: ok
          ? `Username and password are both present (${secret.username}).`
          : "A username and a password are both required.",
      });
      checks.push({
        name: "exposure",
        ok: true,
        detail:
          "yt-dlp takes the password as a command-line argument, so it is visible " +
          "to anything that can read the process list on this host.",
      });
    } else if (secret.type === "apiKey") {
      const ok = secret.apiKey.trim() !== "";
      checks.push({
        name: "complete",
        ok,
        detail: ok ? "An API key is stored." : "The API key is empty.",
      });
      checks.push({
        name: "usable",
        ok: false,
        detail:
          "No built-in provider consumes API keys yet — yt-dlp has nowhere to put " +
          "one. A plugin provider can read it; the yt-dlp downloader will ignore it.",
      });
    } else {
      const fields = Object.keys(secret.data);
      checks.push({
        name: "complete",
        ok: fields.length > 0,
        detail:
          fields.length > 0
            ? `Holds ${fields.length} field(s): ${fields.join(", ")}.`
            : "No fields are stored.",
      });
      checks.push({
        name: "usable",
        ok: false,
        detail: "Custom credentials are only read by plugin providers, never by yt-dlp.",
      });
    }

    return Result.ok({
      id,
      scope: meta.scope,
      type: meta.type,
      ok: checks.every((check) => check.ok || check.name === "usable"),
      checks,
      warnings,
    });
  }
}

/**
 * Does this jar plausibly belong to this scope?
 *
 * ⚠️ **Not** `scopeMatchesHost(scope, domain)`, which is the natural thing to
 * write and is wrong in the most common case there is. A browser exports the
 * YouTube session as domain `.youtube.com` — a *domain cookie*, which by the
 * cookie spec applies to `www.youtube.com` and `music.youtube.com` too. Asking
 * "does the scope cover the domain" rejects a scope of `www.youtube.com`
 * against exactly the jar that would have signed it in, which is a test button
 * that fails on the correct answer.
 *
 * So the relation is checked **both ways**: a cookie domain covers a scope when
 * it is the same host, when the scope sits under it (the domain-cookie case),
 * or when it sits under the scope (a jar exported from `www.` filed under the
 * apex). What is left failing is the case worth failing — a jar from an
 * entirely different site.
 */
function jarCoversScope(domains: readonly string[], scope: string): boolean {
  if (scope === ANY_SCOPE) return true;
  const host = scope.startsWith("*.") ? scope.slice(2) : scope;
  return domains.some(
    (domain) => domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`),
  );
}

/**
 * The checks that only a cookie jar can fail.
 *
 * The domain one is the interesting check and the reason this endpoint exists:
 * a jar exported while the wrong tab was focused is a perfectly valid Netscape
 * file full of cookies for a site that is not the one it is filed under, and
 * nothing downstream would ever say so — yt-dlp simply behaves as if it were
 * signed out.
 */
function cookieChecks(jar: CookieJarSummary, scope: string, now: Date): CredentialCheck[] {
  const checks: CredentialCheck[] = [
    {
      name: "format",
      ok: true,
      detail: `Valid Netscape cookie file with ${jar.count} cookie(s).`,
    },
  ];

  const covers = jarCoversScope(jar.domains, scope);
  checks.push({
    name: "scope",
    ok: covers,
    detail: covers
      ? `The jar covers ${scope}.`
      : `None of the cookies belong to ${scope} — the jar holds ${jar.domains.join(", ")}. ` +
        "This was probably exported from the wrong site.",
  });

  if (jar.expiresAt === undefined) {
    checks.push({
      name: "expiry",
      ok: true,
      detail: `Every cookie is a session cookie (${jar.sessionCookies}); none carries a deadline.`,
    });
    return checks;
  }

  const remainingMs = new Date(jar.expiresAt).getTime() - now.getTime();
  const hours = remainingMs / 3_600_000;
  checks.push({
    name: "expiry",
    ok: remainingMs > 0,
    detail:
      remainingMs <= 0
        ? `Expired at ${jar.expiresAt}. Export a fresh jar; this one will not sign anything in.`
        : hours < 24
          ? `The soonest cookie expires in ${hours.toFixed(1)} hour(s), at ${jar.expiresAt}.`
          : `The soonest cookie expires at ${jar.expiresAt}.`,
  });
  if (jar.expired > 0 && remainingMs > 0) {
    checks.push({
      name: "stale-entries",
      ok: true,
      detail: `${jar.expired} of ${jar.count} cookies are already past their expiry.`,
    });
  }
  return checks;
}

/**
 * Derive the non-secret description of a secret — and validate it on the way.
 *
 * This is where a bad `cookies.txt` is refused, which is the one validation
 * that has to happen before the write rather than after it (PLAN §15, and the
 * brief: a file that fails twenty minutes into a download is worse than an
 * immediate rejection).
 */
export function describeSecret(secret: CredentialSecret): Result<CredentialMeta, InvalidCredential> {
  switch (secret.type) {
    case "cookies": {
      const jar = parseNetscapeCookies(secret.cookies);
      if (Result.isError(jar)) return jar;
      return Result.ok({
        cookieCount: jar.value.count,
        domains: jar.value.domains,
        sessionCookies: jar.value.sessionCookies,
        ...(jar.value.expiresAt === undefined ? {} : { expiresAt: jar.value.expiresAt }),
      });
    }
    case "password": {
      if (secret.username.trim() === "") {
        return Result.err(
          new InvalidCredential({ field: "username", detail: "a username is required" }),
        );
      }
      if (secret.password === "") {
        return Result.err(
          new InvalidCredential({ field: "password", detail: "a password is required" }),
        );
      }
      return Result.ok({ username: secret.username, fields: ["username", "password"] });
    }
    case "apiKey": {
      if (secret.apiKey.trim() === "") {
        return Result.err(
          new InvalidCredential({ field: "apiKey", detail: "an API key is required" }),
        );
      }
      return Result.ok({ fields: ["apiKey"] });
    }
    case "custom": {
      const fields = Object.keys(secret.data);
      if (fields.length === 0) {
        return Result.err(
          new InvalidCredential({ field: "data", detail: "a custom credential needs at least one field" }),
        );
      }
      return Result.ok({ fields: fields.sort() });
    }
  }
}

interface Row {
  id: string;
  scope: string;
  type: string;
  label: string | null;
  protection: string;
  keyId: string | null;
  meta: CredentialMeta;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

function toMetadata(row: Row): CredentialMetadata {
  return {
    id: row.id,
    scope: row.scope,
    type: row.type as CredentialType,
    label: row.label,
    encrypted: row.protection === ALGORITHM,
    keyId: row.keyId,
    meta: row.meta ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * Write a cookie jar somewhere yt-dlp can read it and nobody else can.
 *
 * 🔴 The directory is created with `mkdtemp` at 0700 and the file at 0600, and
 * both are removed by `release()`. The mode is set with `Bun.write`'s file
 * mode... which does not exist — so the file is opened through `node:fs` with
 * an explicit mode instead, because a jar written 0644 into a shared temp
 * directory is a credential handed to every process on the host.
 */
async function writeCookieFile(
  contents: string,
  tempDir?: string,
): Promise<{ path: string; release: () => Promise<void> }> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = await mkdtemp(join(tempDir ?? tmpdir(), "casatube-cookies-"));
  // ⚠️ mkdtemp is 0700 already on every platform we run on, but saying so
  // explicitly costs one syscall and removes the assumption.
  const { chmod } = await import("node:fs/promises");
  await chmod(dir, COOKIE_DIR_MODE);

  const path = join(dir, "cookies.txt");
  // yt-dlp is tolerant of a missing trailing newline; a jar that ends mid-line
  // is not something we should be creating either way.
  await writeFile(path, contents.endsWith("\n") ? contents : `${contents}\n`, {
    mode: COOKIE_FILE_MODE,
  });
  // `writeFile`'s mode applies only when it creates the file, so on the
  // (impossible here) reuse path it would be silently ignored. One more syscall
  // for a guarantee that does not depend on that.
  await chmod(path, COOKIE_FILE_MODE);

  return {
    path,
    release: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The count, for a health endpoint that must not name anything. */
export async function countCredentials(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(credentials);
  return rows[0]?.n ?? 0;
}
