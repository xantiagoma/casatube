/**
 * POST a small JSON body somewhere when a job finishes — or fails.
 *
 * The generic notifier: Home Assistant, ntfy, Gotify, Discord through a proxy,
 * or a shell script behind `nc`. Anything that can receive an HTTP POST.
 *
 * ## What this one demonstrates — the parts the other two do not
 *
 * - **Two hook points from one plugin**, `job:completed` and `job:failed`. They
 *   are separate declarations with separate handlers, and the runtime keeps
 *   them apart; declaring the *same* point twice is what it refuses.
 * - **`job:failed` at all** — the case a media-server refresh has no opinion
 *   about, and the one anybody actually wants a phone notification for.
 * - **A select, a boolean and a secret** in one form, so the shapes the
 *   settings UI has to render are all exercised by something real.
 * - **The unconfigured path**: no URL, one log line, no hook registered. A
 *   plugin that is not set up must cost nothing per download, not fail once per
 *   video.
 *
 * ⚠️ Every value arrives as a **string**, including the boolean, because the
 * layer underneath is the process environment and an environment variable is a
 * string. `INCLUDE_FILE` is therefore compared against `"true"`, not used as a
 * condition.
 */
import type { Plugin } from "../../core/plugins";

const DEFAULT_TIMEOUT_MS = 10_000;

function text(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function number(config: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const raw = text(config, key);
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const webhook: Plugin = {
  name: "webhook",
  description: "POSTs a JSON summary to a URL of your choosing when a job finishes or fails",

  /** Like the media-server refresh: about the outcome, not about the source. */
  matches: [],

  needs: ["network"],

  hooks: [
    { at: "job:completed", kind: "observe" },
    { at: "job:failed", kind: "observe" },
  ],

  settings: [
    {
      key: "WEBHOOK_URL",
      label: "Webhook URL",
      description: "Where the POST goes. The body is JSON.",
      type: "url",
      required: true,
      placeholder: "http://homeassistant.local:8123/api/webhook/casatube",
    },
    {
      key: "WEBHOOK_TOKEN",
      label: "Bearer token",
      description: "Optional. Sent as `Authorization: Bearer …`. Stored on the server and never sent back here.",
      secret: true,
    },
    {
      key: "WEBHOOK_EVENTS",
      label: "Send on",
      description: "Which outcomes are worth a notification.",
      type: "select",
      default: "both",
      options: [
        { value: "both", label: "Completed and failed" },
        { value: "completed", label: "Completed only" },
        { value: "failed", label: "Failed only" },
      ],
    },
    {
      key: "WEBHOOK_INCLUDE_FILE",
      label: "Include the file path",
      description: "Off by default: the path says where your library lives, and a webhook goes somewhere else.",
      type: "boolean",
      default: "false",
    },
    {
      key: "WEBHOOK_TIMEOUT_MS",
      label: "Timeout (ms)",
      type: "number",
      default: String(DEFAULT_TIMEOUT_MS),
    },
  ],

  setup({ on, fetch, log, config }) {
    const url = text(config, "WEBHOOK_URL");
    if (url === undefined) {
      log("not configured (set the webhook URL in Settings); doing nothing");
      return;
    }

    const token = text(config, "WEBHOOK_TOKEN");
    const events = text(config, "WEBHOOK_EVENTS") ?? "both";
    const includeFile = text(config, "WEBHOOK_INCLUDE_FILE") === "true";
    const timeoutMs = number(config, "WEBHOOK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

    /**
     * ⚠️ An arrow, not a `function` declaration, and that is not style.
     * A declaration is hoisted, so TypeScript cannot keep the narrowing that
     * `url` is a string by the time it is called — the guard above is undone by
     * the shape of the code below it.
     */
    const send = async (payload: Record<string, unknown>): Promise<void> => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Thrown on purpose. This is an observer, so the runtime catches it, the
      // job stays done, and the reason lands in this plugin's log where someone
      // debugging a silent webhook will look for it.
      if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
    };

    // 🔴 Registered conditionally. A hook that runs and then decides it has
    // nothing to do is a hook that still shows up in the ordering and still
    // costs a promise per job; not registering it is the honest version of "I
    // was told not to send these".
    if (events === "both" || events === "completed") {
      on("job:completed", async (job) => {
        await send({
          event: "job:completed",
          id: job.id,
          url: job.url,
          title: job.title,
          destination: job.destination,
          duration: job.duration,
          ...(includeFile ? { file: job.outputFile } : {}),
        });
        log(`notified ${url} that "${job.title ?? job.url}" finished`);
      });
    }

    if (events === "both" || events === "failed") {
      on("job:failed", async (job, error) => {
        await send({ event: "job:failed", id: job.id, url: job.url, title: job.title, error });
        log(`notified ${url} that "${job.title ?? job.url}" failed`);
      });
    }
  },
};

export default webhook;
