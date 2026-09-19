/**
 * Turn a Vidarro share link into the HLS manifest behind it, so yt-dlp can do
 * the rest.
 *
 * ## Why this is a plugin and not a provider
 *
 * 🔴 **yt-dlp needs one thing here, not everything.** It has no Vidarro
 * extractor; its generic fallback reads the page, finds a **Voomly** embed and
 * gives up on it with `Unsupported URL`. But handed the manifest directly it is
 * entirely at home — measured against a real share link, it listed the full
 * ladder:
 *
 * ```
 * 289   240x426    ~75 MB
 * 449   360x640   ~118 MB
 * 653   480x852   ~171 MB
 * 1031  720x1280  ~270 MB
 * ```
 *
 * So the missing piece is twenty lines of extraction, and `url:resolve` is the
 * hook that exists for exactly this: it runs *before a provider is chosen*, and
 * what it returns replaces the URL the rest of the pipeline sees. Writing a
 * provider instead would mean re-implementing HLS, the ladder and the merge that
 * yt-dlp already does well.
 *
 * ## 🔴 The master manifest, never a quality-specific one
 *
 * The page lists `file.m3u8` **and** `file240p.m3u8`, `file360p.m3u8` and so on.
 * Returning one of the suffixed ones would work and would be wrong: it hard-codes
 * a quality, so the resolution ceiling in Preferences would have nothing left to
 * decide and a person who asked for 480p would silently get whatever this file
 * named. The master carries the ladder; handing it over is what keeps the
 * preference meaningful.
 *
 * ⚠️ Only `vidarro.com` is claimed. The Voomly embed URL probably yields the same
 * manifest, but that page has not been tested and a `matches` entry is a promise
 * the download window shows in advance.
 */
import type { Plugin } from "../../core/plugins";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Where Voomly serves media from. Anchored, so an arbitrary URL is not followed. */
const MANIFEST = /https:\/\/media\.voomly\.com\/[A-Za-z0-9/_-]+\/[A-Za-z0-9._-]*\.m3u8/g;

/**
 * The master manifest out of a Vidarro page, or `null`.
 *
 * Exported so the decision that matters — **master, not 720p** — is testable
 * without the network. A variant is recognised by the resolution glued onto its
 * filename: `file720p.m3u8`, `file240p.m3u8`. Anything without one is the master.
 */
export function masterManifest(html: string): string | null {
  const found = [...new Set(html.match(MANIFEST) ?? [])];
  if (found.length === 0) return null;

  const master = found.find((url) => !/\d{3,4}p\.m3u8$/.test(url));
  // ⚠️ Falling back to the first variant rather than to nothing: a page that
  // ships only per-quality manifests is still downloadable, and one quality is
  // better than refusing. The log says which case it was.
  return master ?? found[0] ?? null;
}

function number(config: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const raw = config[key];
  const parsed = typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const vidarro: Plugin = {
  name: "vidarro",
  description: "Resolves a Vidarro share link to the Voomly HLS manifest yt-dlp can download",

  /** A bare host covers its subdomains, so this includes `share.vidarro.com`. */
  matches: ["vidarro.com"],

  needs: ["network"],

  hooks: [{ at: "url:resolve", kind: "transform" }],

  settings: [
    {
      key: "VIDARRO_TIMEOUT_MS",
      label: "Timeout (ms)",
      description: "How long to wait for the share page. On a timeout the original URL is kept.",
      type: "number",
      default: String(DEFAULT_TIMEOUT_MS),
    },
  ],

  setup({ on, fetch, log, config }) {
    const timeoutMs = number(config, "VIDARRO_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

    on("url:resolve", async (url) => {
      /**
       * 🔴 Every failure below returns the **original** URL rather than throwing.
       *
       * A transforming hook that throws fails the job with this plugin's name on
       * it. Handing the URL back instead produces yt-dlp's own `Unsupported URL`,
       * which points at the site rather than at us — and the log line here says
       * what we tried. The only honest place for a transform to throw is where
       * continuing would produce the *wrong file*, and this is not that.
       */
      let html: string;
      try {
        const response = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
          // Vidarro serves the player page to a browser; a bare fetch gets a
          // thinner page on some hosts, and the manifest lives in the player's
          // payload.
          headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
        });
        if (!response.ok) {
          log(`${url} answered ${response.status}; keeping the original URL`);
          return url;
        }
        html = await response.text();
      } catch (cause) {
        log(`could not read ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return url;
      }

      const manifest = masterManifest(html);
      if (manifest === null) {
        log(`no Voomly manifest in ${url}; keeping the original URL`);
        return url;
      }

      if (/\d{3,4}p\.m3u8$/.test(manifest)) {
        // Said out loud, because the resolution ceiling has nothing to act on
        // when only one quality is offered — and silence would make that look
        // like the ceiling being ignored.
        log(`only per-quality manifests on that page; using ${manifest}`);
      } else {
        log(`${url} → ${manifest}`);
      }
      return manifest;
    });
  },
};

export default vidarro;
