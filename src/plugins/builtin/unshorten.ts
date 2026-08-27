/**
 * Follow a shortened link to whatever it really points at, before a provider is
 * asked about it.
 *
 * ## What this one demonstrates — the transforming half of the contract
 *
 * - `kind: "transform"` at `url:resolve`: it runs **in order**, it is
 *   **awaited**, and what it returns **replaces** the URL the rest of the
 *   pipeline sees.
 * - `matches` with real hosts, so it is dispatched for `t.co` and never for
 *   `youtube.com` — the manifest is read before any of this code runs, which is
 *   how the download window can say in advance that this plugin would act.
 * - the rule that makes a transform safe: **returning nothing leaves the value
 *   unchanged**, so every failure below ends in `return url`.
 *
 * 🔴 **Why this one catches everything.** A transform that throws *fails the
 * job*, with this plugin's name on it. A dead shortener is not a reason to
 * refuse a download — yt-dlp can very often resolve the link itself — so every
 * error here becomes a log line and the original URL. The only honest place for
 * a transform to throw is where continuing would produce the wrong file, and a
 * redirect that could not be followed is not that.
 *
 * ⚠️ **`matches` cannot be a setting.** It is static metadata, read before this
 * file is executed, which is the whole reason the UI can list applicable
 * plugins without running anything. So a shortener that is not in the list
 * below is added by *editing the list* — which is one click in Settings now
 * that there is an editor — rather than by a text box that would look like it
 * worked and change nothing.
 */
import type { Plugin } from "../../core/plugins";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_HOPS = 5;

function number(config: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const raw = config[key];
  const parsed = typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const unshorten: Plugin = {
  name: "unshorten",
  description: "Resolves shortened links to their destination before a provider is chosen",

  /**
   * The hosts this plugin claims. A bare host also covers its subdomains, so
   * `bit.ly` includes `www.bit.ly`.
   *
   * ⚠️ `youtu.be` is **deliberately absent**: it is not a redirector, it is
   * YouTube's own canonical short form, and yt-dlp handles it directly. Sending
   * it through a redirect chase would spend a request to learn nothing.
   */
  matches: ["bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd", "rb.gy", "adf.ly", "*.adfly.com"],

  needs: ["network"],

  hooks: [{ at: "url:resolve", kind: "transform" }],

  settings: [
    {
      key: "UNSHORTEN_TIMEOUT_MS",
      label: "Timeout (ms)",
      description: "How long to wait for the redirect chain. On a timeout the original URL is kept.",
      type: "number",
      default: String(DEFAULT_TIMEOUT_MS),
    },
    {
      key: "UNSHORTEN_MAX_HOPS",
      label: "Maximum redirects",
      description: "A cap, so a shortener pointing at itself cannot loop for ever.",
      type: "number",
      default: String(DEFAULT_MAX_HOPS),
    },
    {
      key: "UNSHORTEN_METHOD",
      label: "Request method",
      description:
        "HEAD asks for the headers only and is enough for almost every shortener. Some answer 405 to it — those need GET.",
      type: "select",
      default: "HEAD",
      options: [
        { value: "HEAD", label: "HEAD — headers only" },
        { value: "GET", label: "GET — for shorteners that refuse HEAD" },
      ],
    },
  ],

  setup({ on, fetch, log, config }) {
    const timeoutMs = number(config, "UNSHORTEN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    const maxHops = number(config, "UNSHORTEN_MAX_HOPS", DEFAULT_MAX_HOPS);
    const method = config.UNSHORTEN_METHOD === "GET" ? "GET" : "HEAD";

    on("url:resolve", async (url) => {
      let current = url;

      for (let hop = 0; hop < maxHops; hop += 1) {
        let response: Response;
        try {
          response = await fetch(current, {
            method,
            // 🔴 `manual`, not `follow`. Following automatically would work, but
            // it would also hide the hop count — and a shortener chain that goes
            // through six trackers is something worth being able to see in the
            // log, and worth being able to cap.
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (cause) {
          // See the header: a transform that throws fails the job.
          log(`could not follow ${current}: ${cause instanceof Error ? cause.message : String(cause)}`);
          return url;
        }

        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || location === null) {
          if (current !== url) log(`${url} → ${current}`);
          return current;
        }

        let next: string;
        try {
          // Relative `Location` headers are legal and common. Resolving against
          // the URL we just asked for is what a browser does.
          next = new URL(location, current).toString();
        } catch {
          log(`ignoring an unreadable redirect from ${current}: ${location}`);
          return current === url ? url : current;
        }

        if (next === current) {
          log(`${current} redirects to itself; keeping it`);
          return current;
        }
        current = next;
      }

      log(`gave up after ${maxHops} redirects from ${url}; keeping ${current}`);
      return current;
    });
  },
};

export default unshorten;
