/**
 * The credential rows' wording, checked.
 *
 * These are the sentences a person acts on — "expired 2 h ago", "youtube.com
 * and every subdomain", "12 cookies, .youtube.com" — and they are the only part
 * of this screen a test can reach without a DOM. Each one below is a case where
 * the wrong answer is *plausible*: a jar with no `expiresAt` looking permanent,
 * `#HttpOnly_` counted as a comment, a `.youtube.com` jar reading as filed
 * under the wrong site.
 */
import { describe, expect, test } from "bun:test";

import type { CredentialMetadata } from "../../../core/credentials";
import {
  cookieExpiry,
  countCookieLines,
  describeScope,
  domainsLookRight,
  formatDomains,
  humanSpan,
  looksSpaceSeparated,
  previewScope,
  summaryFacts,
} from "./credential-view";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

function credential(over: Partial<CredentialMetadata>): CredentialMetadata {
  return {
    id: "c1",
    scope: "youtube.com",
    type: "cookies",
    label: null,
    encrypted: true,
    keyId: "k1",
    meta: {},
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
    lastUsedAt: null,
    ...over,
  };
}

describe("describeScope", () => {
  test("the catch-all reads as a fallback, not as a site", () => {
    expect(describeScope("*")).toContain("every site");
    expect(describeScope("*")).not.toBe("*");
  });

  test("a wildcard names the subdomains it covers", () => {
    expect(describeScope("*.youtube.com")).toBe("youtube.com and every subdomain of it");
  });

  test("an exact host says that a subdomain does not match", () => {
    expect(describeScope("youtube.com")).toContain("exactly");
  });
});

describe("cookieExpiry", () => {
  test("an expiry in the past is danger and says so in the past tense", () => {
    const line = cookieExpiry({ expiresAt: "2026-08-27T10:00:00.000Z" }, NOW);
    expect(line?.tone).toBe("danger");
    expect(line?.text).toBe("Expired 2 h ago — paste a fresh export.");
  });

  test("hours away is still danger — that is the normal state of a fresh jar", () => {
    const line = cookieExpiry({ expiresAt: "2026-08-27T15:00:00.000Z" }, NOW);
    expect(line?.tone).toBe("danger");
    expect(line?.text).toContain("3 h");
  });

  test("within the day is a warning", () => {
    const line = cookieExpiry({ expiresAt: "2026-08-28T06:00:00.000Z" }, NOW);
    expect(line?.tone).toBe("warn");
  });

  test("a week away is fine", () => {
    expect(cookieExpiry({ expiresAt: "2026-09-03T12:00:00.000Z" }, NOW)?.tone).toBe("ok");
  });

  /** The trap: nothing to expire is not the same as nothing expiring. */
  test("session cookies with no date warn rather than reading as permanent", () => {
    const line = cookieExpiry({ sessionCookies: 4 }, NOW);
    expect(line?.tone).toBe("warn");
    expect(line?.text).toContain("Session cookies only");
  });

  test("no expiry and no session cookies says nothing at all", () => {
    expect(cookieExpiry({}, NOW)).toBeNull();
    expect(cookieExpiry({ username: "santi" }, NOW)).toBeNull();
  });

  test("an unparseable date is silence, not a crash or a wrong claim", () => {
    expect(cookieExpiry({ expiresAt: "soon" }, NOW)).toBeNull();
  });
});

describe("summaryFacts", () => {
  test("a cookie row carries count, domains and session cookies", () => {
    const facts = summaryFacts(
      credential({ meta: { cookieCount: 12, domains: [".youtube.com", ".google.com"], sessionCookies: 3 } }),
    );
    expect(facts).toEqual(["12 cookies", ".youtube.com, .google.com", "3 session"]);
  });

  test("one cookie is not '1 cookies'", () => {
    expect(summaryFacts(credential({ meta: { cookieCount: 1 } }))[0]).toBe("1 cookie");
  });

  test("a password row names the account and nothing else", () => {
    const facts = summaryFacts(credential({ type: "password", meta: { username: "santi" } }));
    expect(facts).toEqual(["user santi"]);
  });

  test("a key row names its fields and never a value", () => {
    const facts = summaryFacts(credential({ type: "apiKey", meta: { fields: ["apiKey"] } }));
    expect(facts).toEqual(["fields: apiKey"]);
  });

  /** Two rows of the same type and site must not render identically. */
  test("two jars for the same scope differ on the line that is drawn", () => {
    const a = summaryFacts(credential({ meta: { cookieCount: 12, domains: [".youtube.com"] } }));
    const b = summaryFacts(credential({ meta: { cookieCount: 4, domains: [".youtube.com"] } }));
    expect(a).not.toEqual(b);
  });
});

describe("formatDomains", () => {
  test("a long list is cut with a count of the rest", () => {
    expect(formatDomains(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
  });

  test("nothing to say returns null rather than an empty string", () => {
    expect(formatDomains([])).toBeNull();
    expect(formatDomains(undefined)).toBeNull();
  });
});

describe("domainsLookRight", () => {
  /**
   * The mistake `core` made once: a domain cookie covers its subdomains, so the
   * relation has to be checked in both directions.
   */
  test("a .youtube.com jar covers www.youtube.com", () => {
    expect(domainsLookRight([".youtube.com"], "www.youtube.com")).toBe(true);
  });

  test("a www.youtube.com jar filed under youtube.com also counts", () => {
    expect(domainsLookRight(["www.youtube.com"], "youtube.com")).toBe(true);
  });

  test("a jar from a different site does not", () => {
    expect(domainsLookRight([".odysee.com"], "youtube.com")).toBe(false);
  });

  test("the wildcard scope and the catch-all are never wrong", () => {
    expect(domainsLookRight([".youtube.com"], "*.youtube.com")).toBe(true);
    expect(domainsLookRight([".odysee.com"], "*")).toBe(true);
  });
});

describe("previewScope", () => {
  test("a pasted URL becomes its host", () => {
    expect(previewScope("https://www.youtube.com/watch?v=abc")).toBe("www.youtube.com");
  });

  test("a leading dot becomes the wildcard it means", () => {
    expect(previewScope(".youtube.com")).toBe("*.youtube.com");
  });

  test("a port is dropped and capitals are folded", () => {
    expect(previewScope("Example.COM:8443")).toBe("example.com");
  });

  test("the catch-all survives untouched", () => {
    expect(previewScope("*")).toBe("*");
  });
});

describe("counting a pasted jar", () => {
  const jar = [
    "# Netscape HTTP Cookie File",
    "",
    ".youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\tvalue",
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1790000000\tHSID\tvalue",
  ].join("\n");

  /** 🔴 `#HttpOnly_` is a cookie, and it is the one that authenticates. */
  test("HttpOnly lines are counted and comments are not", () => {
    expect(countCookieLines(jar)).toBe(2);
  });

  test("an empty paste counts nothing", () => {
    expect(countCookieLines("   \n\n")).toBe(0);
  });

  test("tabs are recognised as a well-formed jar", () => {
    expect(looksSpaceSeparated(jar)).toBe(false);
  });

  test("a jar whose tabs became spaces is caught before it is sent", () => {
    expect(looksSpaceSeparated(jar.replace(/\t/g, "    "))).toBe(true);
  });

  test("a comment full of spaces is not mistaken for a mangled cookie", () => {
    expect(looksSpaceSeparated("# Netscape HTTP Cookie File\n")).toBe(false);
  });
});

describe("humanSpan", () => {
  test("reads in the unit that fits", () => {
    expect(humanSpan(45_000)).toBe("45s");
    expect(humanSpan(20 * 60_000)).toBe("20 min");
    expect(humanSpan(5 * 3_600_000)).toBe("5 h");
    expect(humanSpan(5 * 86_400_000)).toBe("5 d");
  });
});
