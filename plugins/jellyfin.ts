/**
 * Refresh the Jellyfin library when a download finishes.
 *
 * This is the first observing plugin, and it is here to prove the seam is worth
 * having: PLAN section 5 says the media-server refresh is a plugin, **not code
 * welded into the worker**. Nothing in the core knows what Jellyfin is, and
 * that is what lets someone using Plex or Emby swap this file for their own
 * without touching a line of CasaTube.
 *
 * It observes, so it can never fail a job. If the refresh fails — the server is
 * down, the token expired, the URL is wrong — the video on disk is still
 * downloaded and still correct, and marking the job failed would be a lie. The
 * failure is thrown, the runtime catches it, and it shows up in this plugin's
 * log where it belongs.
 *
 * ## Installing
 *
 * Copy this file into `DATA_DIR/plugins/` and set either pair of variables:
 *
 * ```
 * JELLYFIN_URL=http://jellyfin.local:8096
 * JELLYFIN_TOKEN=...            # Dashboard -> API Keys -> New
 * ```
 *
 * `MEDIA_SERVER_URL` / `MEDIA_SERVER_TOKEN` (PLAN section 12) work too, so the
 * documented variable names do not need to change to use this.
 *
 * ## The import is type-only, on purpose
 *
 * `import type` is erased before the file ever runs, so this line costs nothing
 * at runtime and the path does not have to resolve from `DATA_DIR/plugins/`. It
 * is here purely so an editor can check the object against the contract. Delete
 * it and the plugin still works.
 */
import type { Plugin } from "../src/core/plugins";

/** Anything slower than this is a server that is not going to answer. */
const TIMEOUT_MS = 10_000;

function setting(config: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

const jellyfin: Plugin = {
  name: "jellyfin",
  description: "Tells Jellyfin to scan its library when a download completes",

  /**
   * Empty: this one applies to everything.
   *
   * A refresh is about where the file landed, not where it came from — a
   * plugin that claimed `youtube.com` would silently stop refreshing the day
   * someone downloaded from anywhere else.
   */
  matches: [],

  /** One HTTP call and nothing more. Ask for anything else and you should be asked why. */
  needs: ["network"],

  hooks: [{ at: "job:completed", kind: "observe" }],

  setup({ on, fetch, log, config }) {
    const base = setting(config, "JELLYFIN_URL", "MEDIA_SERVER_URL")?.replace(/\/+$/, "");
    const token = setting(config, "JELLYFIN_TOKEN", "MEDIA_SERVER_TOKEN");

    if (!base || !token) {
      // Unconfigured is the normal state for anyone who does not run Jellyfin.
      // One line saying so, then nothing — no hook registered, no failed call
      // per download, nothing in the way.
      log("not configured (set JELLYFIN_URL and JELLYFIN_TOKEN); doing nothing");
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        // Thrown, not swallowed: the runtime catches it, keeps the job done,
        // and records it here. A silent no-op would be the worse failure -
        // a library that quietly stops updating.
        throw new Error(`Jellyfin answered ${response.status} ${response.statusText}`);
      }

      // A successful refresh is 204. Nothing to read, and the scan itself is
      // asynchronous inside Jellyfin - all we can honestly report is that it
      // was asked.
      log(`asked Jellyfin to scan after "${job.title ?? job.url}"`);
    });
  },
};

export default jellyfin;
