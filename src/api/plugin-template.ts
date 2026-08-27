/**
 * The two things a plugins screen with nothing on it has to be able to hand
 * over: **a file to start from**, and **the documentation**.
 *
 * 🔴 They are string constants rather than files read off disk, and that is the
 * point. `plugins/README.md` and `plugins/jellyfin.ts` live in the repository,
 * and the repository is not in the image — the Dockerfile copies `src`,
 * `drizzle` and two JSON files and nothing else. A route that read them from
 * the working directory would work in development and 404 in the only place it
 * matters. This module ships inside `src`, so it ships everywhere `src` does.
 *
 * ⚠️ `plugins/README.md` is still the full reference and still the source of
 * truth for the contract. What is here is the condensed version, and it says so
 * at the bottom: **if the hook table changes, both have to change.**
 *
 * `__PLUGINS_DIR__` is substituted at serve time so the answer to "where does
 * the file go" is this installation's actual path, not a placeholder someone
 * has to translate.
 */

const DIR_PLACEHOLDER = "__PLUGINS_DIR__";

/** The starter plugin, commented — what the download button hands over. */
const TEMPLATE = `/**
 * A CasaTube plugin, annotated — copy it, rename it, make it yours.
 *
 * ## Where this file goes
 *
 *     __PLUGINS_DIR__/my-plugin.ts
 *
 * One file, any name ending in \`.ts\`. Bun imports TypeScript directly, so there
 * is no build step, no \`package.json\` and no \`npm install\`. Drop the file in
 * and restart CasaTube: the plugin appears in Settings → Plugins with
 * everything it declares on display.
 *
 * ⚠️ A plugin CasaTube has not seen before arrives **enabled** — \`setup\` runs
 * at that restart. The switch on that screen is what turns it off, and the
 * choice is remembered in \`DATA_DIR/plugin-state.json\`.
 *
 * ## The two halves, which is the whole design
 *
 * - **The manifest** (\`name\`, \`description\`, \`matches\`, \`hooks\`, \`needs\`) is
 *   static data. CasaTube reads it *without calling \`setup\`*, which is what
 *   lets the download window tell you which plugins would act on a URL you just
 *   pasted and what each one asks for, before any of their code has run.
 * - **\`setup\`** is the code. It runs when the plugin is enabled, and everything
 *   it is allowed to do arrives as an argument — nothing is imported.
 */

/**
 * Type-only, so it is erased before the file ever runs and the path does not
 * have to resolve from the plugins directory. It is here purely so an editor
 * can check this object against the contract. Delete the line and the plugin
 * still works.
 */
// import type { Plugin } from "casatube";

const plugin = {
  /** Unique. Letters, digits, \`.\`, \`-\`, \`_\`. The API and \`before\`/\`after\` use it. */
  name: "my-plugin",

  /** One line, shown next to the toggle. Write it for the person deciding. */
  description: "Says hello when a download finishes",

  /**
   * The URLs this plugin claims.
   *
   *   ["youtube.com"]        — that host and its subdomains
   *   ["*.vimeo.com"]        — subdomains only, not vimeo.com itself
   *   ["https://ex.org/*"]   — anything with / or :// is globbed on the whole URL
   *   []                     — everything
   *
   * A plugin that acts on the *result* rather than the *source* — a media
   * server refresh, a notifier — belongs on \`[]\`. Claiming \`youtube.com\` there
   * means it silently stops working the day something is downloaded elsewhere.
   */
  matches: [],

  /**
   * Capabilities. Ask for the least you need: \`fetch\` is handed to \`setup\` only
   * if \`"network"\` is declared here, and this list is what the user is shown
   * before enabling you.
   */
  needs: ["network"],

  /**
   * ⚠️ A gate, not documentation. \`on("job:completed", …)\` without a matching
   * entry here is refused and logged — \`kind\` lives only in this declaration,
   * so an undeclared hook is one the runtime does not know how to run.
   *
   * The points:
   *   url:resolve       (url) => string          before a provider is chosen
   *   job:queued        (job) => void            durable and waiting
   *   probe:complete    (info, plan) => plan     media read, plan chosen
   *   download:complete (job, file) => void      bytes on disk
   *   job:completed     (job) => void            finished, in the library
   *   job:failed        (job, error) => void     gave up
   *
   * And the two kinds:
   *   observe   — runs in parallel, never awaited, CANNOT fail the job
   *   transform — runs in order, awaited, may replace the value, and a throw
   *               FAILS THE JOB with your plugin named on it
   *
   * Only make a hook a transform when a failure genuinely means the download
   * should not proceed.
   */
  hooks: [{ at: "job:completed", kind: "observe" }],

  setup({ on, log, config /*, fetch, addProvider */ }) {
    /**
     * \`config\` is frozen: the process environment plus any per-plugin block in
     * \`DATA_DIR/plugin-state.json\`. Read it defensively — a plugin that is not
     * configured should say so once and then do nothing, rather than fail one
     * download per video.
     */
    const target = typeof config.MY_PLUGIN_URL === "string" ? config.MY_PLUGIN_URL.trim() : "";
    if (target === "") {
      log("not configured (set MY_PLUGIN_URL); doing nothing");
      return;
    }

    on("job:completed", async (job) => {
      // \`log\` goes to the server log and to this plugin's own log in the UI.
      log(\`finished: \${job.title ?? job.url}\`);

      // Declared \`needs: ["network"]\` above? Then \`fetch\` is yours:
      //
      //   const response = await fetch(target, {
      //     method: "POST",
      //     headers: { "content-type": "application/json" },
      //     body: JSON.stringify({ title: job.title, file: job.outputFile }),
      //     signal: AbortSignal.timeout(10_000),
      //   });
      //   if (!response.ok) throw new Error(\`\${target} answered \${response.status}\`);
      //
      // Throw as loudly as you like inside an observer: the runtime catches it,
      // records it against this plugin, and the job stays done — because it is
      // done. The file is on disk and marking it failed would be a lie.
    });
  },
};

export default plugin;
`;

/** The condensed reference. See the warning in the header. */
const DOCS = `# Writing a CasaTube plugin

A plugin is **one file** in \`__PLUGINS_DIR__\`. Bun imports TypeScript directly,
so for most plugins there is no build step, no \`package.json\` and no
\`npm install\` — you write a \`.ts\` file, drop it in, and restart.

## The shortest useful plugin

\`\`\`ts
export default {
  name: "adfly-bypass",
  description: "Resolves adf.ly links to their target",
  matches: ["adf.ly", "*.adfly.com"],
  needs: ["network"],
  hooks: [{ at: "url:resolve", kind: "transform" }],

  setup({ on, fetch, log }) {
    on("url:resolve", async (url) => {
      const response = await fetch(url, { redirect: "follow" });
      log(\`unshortened to \${response.url}\`);
      return response.url;
    });
  },
};
\`\`\`

Two halves, and the split is the whole design: the **manifest** is static data
that CasaTube reads *without calling \`setup\`*, and **\`setup\`** is the code,
which runs only once the plugin is enabled.

## The manifest

| Field | Required | What it does |
|---|---|---|
| \`name\` | yes | Unique. Letters, digits, \`.\`, \`-\`, \`_\`. |
| \`description\` | yes | One line, shown next to the toggle. |
| \`matches\` | no | Hosts or patterns claimed. Absent or empty means everything. |
| \`hooks\` | no | Every hook you intend to register, with its kind. |
| \`needs\` | no | Capabilities requested. Shown before enabling. |

## Hook points

| Point | Signature | When |
|---|---|---|
| \`url:resolve\` | \`(url) => string\` | Before a provider is chosen. |
| \`job:queued\` | \`(job) => void\` | The job is durable and waiting. |
| \`probe:complete\` | \`(info, plan) => DownloadPlan\` | Media read, plan chosen. |
| \`download:complete\` | \`(job, file) => void\` | Bytes on disk. |
| \`job:completed\` | \`(job) => void\` | Finished, in the library. |
| \`job:failed\` | \`(job, error) => void\` | Gave up. |

## The two kinds

|  | \`transform\` | \`observe\` |
|---|---|---|
| Can change the outcome | yes | no |
| Execution | in order, awaited | in parallel, not awaited |
| On failure | **fails the job** | logged, job continues |
| Use for | unshortening a URL, adjusting selection | refreshing a media server |

## What \`setup\` is handed

\`setup({ on, addProvider, fetch, log, config })\` — \`fetch\` only if you declared
\`needs: ["network"]\`, \`config\` frozen (the environment merged with the
per-plugin block in \`DATA_DIR/plugin-state.json\`), \`log\` writing to both the
server log and this plugin's log in the UI.

---

⚠️ This is the short version, bundled with the server. The full reference —
pattern matching, hook ordering with \`before\`/\`after\`, capabilities, and the
annotated \`jellyfin.ts\` — is \`plugins/README.md\` in the CasaTube repository.
`;

/** The suggested filename. A name, not a title — it lands on a filesystem. */
export const PLUGIN_TEMPLATE_FILENAME = "casatube-plugin.ts";

/** The starter plugin, addressed to this installation's plugins directory. */
export function pluginTemplate(dir: string): string {
  return TEMPLATE.replaceAll(DIR_PLACEHOLDER, dir);
}

/** The condensed reference, addressed to this installation's plugins directory. */
export function pluginDocs(dir: string): string {
  return DOCS.replaceAll(DIR_PLACEHOLDER, dir);
}
