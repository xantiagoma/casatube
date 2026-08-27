/**
 * How a credential reads, as pure functions.
 *
 * There is no DOM harness in this repo, so anything worth asserting has to be
 * a function over data rather than a paragraph inside a component — the same
 * arrangement `components/jobs/job-order.ts` uses, and for the same reason.
 *
 * What is worth asserting here is not layout. It is the **sentences**: a jar
 * whose soonest cookie expired two hours ago must not read as fine, a scope of
 * `*` must not read as a site, and a row must say enough that two credentials
 * for the same site are told apart. `meta` is the only material for that —
 * `cookieCount`, `domains`, `expiresAt`, `sessionCookies`, `username`,
 * `fields` — and without it two rows for youtube.com are the same row twice.
 */
import type { CredentialMeta, CredentialMetadata, CredentialType } from "../../../core/credentials";

/** The tones the card paints with. Same vocabulary as `components/status.ts`. */
export type CredentialTone = "ok" | "warn" | "danger" | "muted";

/**
 * The four types, in the order a form should offer them.
 *
 * 🔴 Derived from `TYPE_LABEL`'s keys rather than imported from
 * `core/credentials`. `CREDENTIAL_TYPES` is a **value** there, and a value
 * import out of `core/` drags the whole module — `bun:sqlite`, drizzle, the
 * `bun` builtin — into the browser bundle, which then fails to build. `tsc` is
 * perfectly happy with it; only `Bun.build` notices, and it says
 * *"Bundle failed"*. See docs/DISCOVERIES.md.
 *
 * The exhaustiveness is not lost: `TYPE_LABEL` is a `Record<CredentialType, …>`,
 * so a fifth type added to core is a compile error here.
 */
export const CREDENTIAL_TYPE_ORDER: CredentialType[] = ["cookies", "password", "apiKey", "custom"];

export const TYPE_LABEL: Record<CredentialType, string> = {
  cookies: "Cookies",
  password: "Username & password",
  apiKey: "API key",
  custom: "Custom",
};

/**
 * What each type is *for*, in one line.
 *
 * ⚠️ `apiKey` and `custom` say that nothing built in consumes them. They are
 * stored and resolved, and yt-dlp has nowhere to put an API key — so a form
 * that offered them silently would be offering a control with no effect, which
 * is the failure this project keeps writing down.
 */
export const TYPE_HINT: Record<CredentialType, string> = {
  cookies:
    "A Netscape cookies.txt exported from a signed-in browser. This is what answers age gates, members-only videos and “Sign in to confirm you’re not a bot”.",
  password:
    "For sites where yt-dlp accepts a login. It reaches yt-dlp as --username / --password.",
  apiKey:
    "Stored and resolved for this scope, but no built-in provider reads one — yt-dlp has nowhere to put an API key. A plugin provider can.",
  custom:
    "Any set of named fields, for a plugin provider that knows what to do with them. yt-dlp ignores these.",
};

/**
 * A scope, in words.
 *
 * The strings matter more than they look: `*` is the row that answers for
 * every site nothing more specific matched, and calling it “*” on screen makes
 * a fallback look like a site.
 */
export function describeScope(scope: string): string {
  if (scope === "*") return "every site — the fallback, used when nothing more specific matches";
  if (scope.startsWith("*.")) {
    const host = scope.slice(2);
    return `${host} and every subdomain of it`;
  }
  return `${scope} exactly — a subdomain of it does not match`;
}

/** A span of milliseconds as "3 h", "12 min", "2 d". Coarse on purpose. */
export function humanSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  // ⚠️ Rounded, not floored: the server's own check says "expires in 4.0
  // hour(s)" for the same instant, and a row reading "3 h" beside it looks
  // like one of the two is wrong.
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export interface ExpiryLine {
  tone: CredentialTone;
  text: string;
}

/**
 * What the jar's soonest expiry means right now.
 *
 * 🔴 The thresholds are deliberately impatient. A YouTube jar is usually hours
 * from expiring the moment it is pasted, so "expires in 4 h" is the **normal**
 * state and has to be visible rather than reassuring — a green row for
 * something that will stop working before the evening is the silence this
 * screen exists to break.
 *
 * `null` is a real answer: a non-cookie credential has no expiry, and saying
 * nothing is better than inventing "never expires" for a password that a site
 * may revoke at any moment.
 */
export function cookieExpiry(meta: CredentialMeta, now: number): ExpiryLine | null {
  if (meta.expiresAt === undefined) {
    if ((meta.sessionCookies ?? 0) > 0) {
      return {
        tone: "warn",
        text: "Session cookies only — no expiry date in the file, and the site can end them whenever it likes.",
      };
    }
    return null;
  }
  const at = Date.parse(meta.expiresAt);
  if (!Number.isFinite(at)) return null;
  const remaining = at - now;
  if (remaining <= 0) {
    return { tone: "danger", text: `Expired ${humanSpan(-remaining)} ago — paste a fresh export.` };
  }
  if (remaining < 6 * 3_600_000) {
    return { tone: "danger", text: `First cookie expires in ${humanSpan(remaining)}.` };
  }
  if (remaining < 24 * 3_600_000) {
    return { tone: "warn", text: `First cookie expires in ${humanSpan(remaining)}.` };
  }
  return { tone: "ok", text: `First cookie expires in ${humanSpan(remaining)}.` };
}

/** Domains, shortened — a jar can carry a dozen and the row has one line. */
export function formatDomains(domains: string[] | undefined, max = 3): string | null {
  if (!domains || domains.length === 0) return null;
  if (domains.length <= max) return domains.join(", ");
  return `${domains.slice(0, max).join(", ")} +${domains.length - max} more`;
}

/**
 * The facts that make one row different from the next.
 *
 * Everything here is metadata the server derived from the secret and never the
 * secret: how many cookies, which domains, which account, which field names.
 * Without them, two jars filed under youtube.com are two identical lines and
 * there is no way to tell the dead one from the live one.
 */
export function summaryFacts(credential: CredentialMetadata): string[] {
  const meta = credential.meta ?? {};
  const facts: string[] = [];
  switch (credential.type) {
    case "cookies": {
      const count = meta.cookieCount ?? 0;
      facts.push(`${count} cookie${count === 1 ? "" : "s"}`);
      const domains = formatDomains(meta.domains);
      if (domains) facts.push(domains);
      if ((meta.sessionCookies ?? 0) > 0) facts.push(`${meta.sessionCookies} session`);
      break;
    }
    case "password":
      facts.push(meta.username ? `user ${meta.username}` : "no username recorded");
      break;
    case "apiKey":
    case "custom": {
      const fields = meta.fields ?? [];
      // Names only. The values are the secret and never left the server.
      facts.push(fields.length > 0 ? `fields: ${fields.join(", ")}` : "no fields recorded");
      break;
    }
  }
  return facts;
}

/**
 * Does the jar's domain list plausibly cover the scope it is filed under?
 *
 * ⚠️ Checked **both ways**, and that is the whole subtlety: a browser exports
 * the YouTube session as `.youtube.com`, a domain cookie that by the cookie
 * spec applies to `www.youtube.com` too. Asking only "does the scope cover the
 * domain" rejects the jar that would have worked — the mistake `core` made
 * once and wrote down (docs/DISCOVERIES.md).
 *
 * 📌 This is a *hint on the form*, before anything is stored. The authority is
 * the server's own check, which the test button reports.
 */
export function domainsLookRight(domains: string[], scope: string): boolean {
  if (scope === "*" || domains.length === 0) return true;
  const host = (scope.startsWith("*.") ? scope.slice(2) : scope).toLowerCase();
  return domains.some((raw) => {
    const domain = raw.replace(/^\./, "").toLowerCase();
    return domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
  });
}

/**
 * A scope typed into the form, tidied the way the server will tidy it.
 *
 * ⚠️ A *preview*, never a substitute: `normaliseScope` on the server is what
 * actually decides, and this exists so the field can show what a pasted URL
 * will become before it is sent. It deliberately does not reject anything —
 * refusing here would be a second validator drifting from the first.
 */
export function previewScope(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "*") return trimmed;
  let value = trimmed;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//;
  if (scheme.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      return trimmed;
    }
  }
  value = value.split("/")[0] ?? value;
  value = value.replace(/:\d+$/, "");
  if (value.startsWith(".")) value = `*${value}`;
  return value;
}

/**
 * The number of cookie lines a pasted jar appears to hold, for the form's
 * counter — comments and blank lines skipped, `#HttpOnly_` **kept**.
 *
 * 🔴 `#HttpOnly_` starts with `#` and is not a comment: Chrome and Firefox both
 * write it, and skipping those lines drops exactly the cookies that
 * authenticate. Counting them as comments here would make a jar that is about
 * to be rejected look full.
 */
export function countCookieLines(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_")) continue;
    count += 1;
  }
  return count;
}

/**
 * Does this paste look tab-separated?
 *
 * ⚠️ Copying a jar through a terminal or a chat window turns the tabs into runs
 * of spaces, and yt-dlp then behaves as if signed out. The server rejects it
 * with that exact explanation; this is the same warning one step earlier, on
 * the text as it is typed.
 */
export function looksSpaceSeparated(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_")) continue;
    if (trimmed.includes("\t")) return false;
    if (/\s{2,}/.test(trimmed)) return true;
  }
  return false;
}
