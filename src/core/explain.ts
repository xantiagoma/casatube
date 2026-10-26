/**
 * A sentence for the failures a person can act on, out of the text a
 * downloader printed.
 *
 * 🔴 The raw text is never thrown away — it is what a bug report needs — but it
 * must not be the first thing on screen. A failed Analyze used to show
 * `Unable to download webpage: <urlopen error [Errno -2] Name or service not
 * known> (caused by TransportError(...))`, which says "DNS is broken on the
 * server" to the three people who already know urllib.
 *
 * Only failures whose meaning is unambiguous get a sentence; everything else
 * returns `null` and the caller shows the original. A wrong explanation is worse
 * than none — the plausible story that fits the symptom is the expensive kind.
 *
 * ⚠️ Pure and dependency-free on purpose: the browser imports it too, to explain
 * a job's last error in the queue. Nothing here may reach for the server.
 */

interface Rule {
  test: RegExp;
  /** `host` mid-sentence, `Host` to start one: "the site" and "The site" when unknown. */
  say(host: string, Host: string): string;
}

const RULES: readonly Rule[] = [
  {
    // glibc's and musl's wording, macOS's, Windows', and Python's errno form.
    test: /name or service not known|temporary failure in name resolution|nodename nor servname|getaddrinfo failed|no address associated with hostname|\[errno -[235]\]/i,
    say: (host) =>
      `Could not look up ${host}. The server running CasaTube has no working DNS or internet connection right now.`,
  },
  {
    test: /network is unreachable|no route to host|\[errno 101\]|\[errno 113\]/i,
    say: () => "The server running CasaTube cannot reach the internet right now.",
  },
  {
    test: /connection refused|\[errno 111\]/i,
    say: (_host, Host) => `${Host} refused the connection.`,
  },
  {
    test: /timed out|\[errno 110\]/i,
    say: (_host, Host) => `${Host} did not answer in time. It may be slow or down; trying again later often works.`,
  },
  {
    test: /connection reset|remote end closed connection|\[errno 104\]|incompleteread/i,
    say: (_host, Host) => `${Host} dropped the connection partway. Trying again usually works.`,
  },
  {
    test: /certificate_verify_failed|ssl: |tlsv1 alert|wrong version number/i,
    say: (host) =>
      `The secure connection to ${host} failed. A wrong clock or missing CA certificates on the server are the usual causes.`,
  },
  {
    test: /http error 404/i,
    say: (_host, Host) => `${Host} says this page does not exist (404). Check the link.`,
  },
  {
    test: /http error 403/i,
    say: (_host, Host) => `${Host} refused access (403). It may need a login, or be blocking this server.`,
  },
  {
    test: /http error 5\d\d/i,
    say: (_host, Host) => `${Host} had an error of its own (5xx). Trying again later usually works.`,
  },
];

/** The host to name in a sentence, or `null` when the URL will not parse. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * A plain sentence for `detail`, or `null` when the failure is not one of the
 * well-understood kinds — in which case show `detail` itself.
 */
export function explainFailure(detail: string, url?: string): string | null {
  for (const rule of RULES) {
    if (rule.test.test(detail)) {
      const host = hostOf(url);
      return rule.say(host ?? "the site", host ?? "The site");
    }
  }
  return null;
}
