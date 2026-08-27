/**
 * Refresh Jellyfin's library when a download finishes.
 *
 * The first observing plugin, and the one that proves the seam is worth having:
 * PLAN §5 says the media-server refresh is a plugin, **not code welded into the
 * worker**. Nothing in the core knows what Jellyfin is, which is what lets
 * someone on Plex or Emby change this file — from Settings, in the browser —
 * without touching a line of CasaTube.
 *
 * ## What this one demonstrates
 *
 * - `matches: []` — a plugin about the *result*, not the *source*.
 * - `settings` with a **secret**: the token is never returned by the API.
 * - one setting shadowing another name, which is why `setting()` takes a list.
 * - an observer that **throws on purpose**: the runtime catches it, records it
 *   in this plugin's log, and the job stays done — because it is done. The
 *   video is on disk and marking it failed would be a lie.
 */
import type { Plugin } from "../../core/plugins";

/** Anything slower than this is a server that is not going to answer. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The first of these keys that has a value, trimmed.
 *
 * ⚠️ Only `JELLYFIN_*` is declared in `settings`, so only those get form rows —
 * but `MEDIA_SERVER_*` (PLAN §12) is still read, because it was documented
 * before this form existed and silently ignoring a variable someone set is
 * exactly the failure this project keeps finding. Declared settings are what
 * the UI can *offer*; they are not a list of what a plugin may read.
 */
function setting(config: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function number(config: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const raw = setting(config, key);
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const jellyfin: Plugin = {
  name: "jellyfin",
  description: "Tells Jellyfin to scan its library when a download completes",

  /**
   * Empty: this one applies to everything.
   *
   * A refresh is about where the file landed, not where it came from — a plugin
   * that claimed `youtube.com` would silently stop refreshing the day someone
   * downloaded from anywhere else.
   */
  matches: [],

  /** One HTTP call and nothing more. Ask for anything else and you should be asked why. */
  needs: ["network"],

  hooks: [{ at: "job:completed", kind: "observe" }],

  /**
   * 🔴 What used to be a comment at the top of this file.
   *
   * Before this existed, the only way to learn that `JELLYFIN_TOKEN` was the
   * variable to set was to read the source — the plugin logged "not
   * configured" and did nothing, which is correct behaviour and a useless
   * interface. Declaring them is what lets Settings draw the form.
   */
  settings: [
    {
      key: "JELLYFIN_URL",
      label: "Jellyfin URL",
      description: "Where Jellyfin answers, as CasaTube can reach it — a container name is fine.",
      type: "url",
      required: true,
      placeholder: "http://jellyfin.local:8096",
    },
    {
      key: "JELLYFIN_TOKEN",
      label: "API key",
      description: "Jellyfin → Dashboard → API Keys → New. It is stored on the server and never sent back here.",
      secret: true,
      required: true,
    },
    {
      key: "JELLYFIN_TIMEOUT_MS",
      label: "Timeout (ms)",
      description: "How long to wait for the scan request before giving up.",
      type: "number",
      default: String(DEFAULT_TIMEOUT_MS),
    },
  ],

  setup({ on, fetch, log, config }) {
    const base = setting(config, "JELLYFIN_URL", "MEDIA_SERVER_URL")?.replace(/\/+$/, "");
    const token = setting(config, "JELLYFIN_TOKEN", "MEDIA_SERVER_TOKEN");
    const timeoutMs = number(config, "JELLYFIN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

    if (!base || !token) {
      // Unconfigured is the normal state for anyone who does not run Jellyfin.
      // One line saying so, then nothing — no hook registered, no failed call
      // per download, nothing in the way. The form is where it gets fixed, and
      // saving it re-runs this `setup` with the new values.
      log("not configured (set the Jellyfin URL and API key in Settings); doing nothing");
      return;
    }

    on("job:completed", async (job) => {
      const response = await fetch(`${base}/Library/Refresh`, {
        method: "POST",
        headers: {
          // Jellyfin's own header, inherited from Emby. The alternative is an
          // `Authorization: MediaBrowser Token="..."` line, which is the same
          // credential dressed differently.
          "X-Emby-Token": token,
          // Jellyfin answers 400 to a POST with no content type, even though
          // this endpoint takes no body.
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        // Thrown, not swallowed: the runtime catches it, keeps the job done,
        // and records it here. A silent no-op would be the worse failure —
        // a library that quietly stops updating.
        throw new Error(`Jellyfin answered ${response.status} ${response.statusText}`);
      }

      // A successful refresh is 204. Nothing to read, and the scan itself is
      // asynchronous inside Jellyfin — all we can honestly report is that it
      // was asked.
      log(`asked Jellyfin to scan after "${job.title ?? job.url}"`);
    });
  },
};

export default jellyfin;
