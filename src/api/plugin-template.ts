/**
 * The two things a plugins screen with nothing on it has to be able to hand
 * over: **a file to start from**, and **the documentation**.
 *
 * 🔴 They are string constants rather than files read off disk, and that is the
 * point. `plugins/README.md` lives in the repository, and the repository is not
 * in the image — the Dockerfile copies `src`, `drizzle` and two JSON files and
 * nothing else. A route that read it from the working directory would work in
 * development and 404 in the only place it matters. This module ships inside
 * `src`, so it ships everywhere `src` does.
 *
 * 📌 The same rule is why the **built-in plugins** live in `src/plugins/builtin`
 * rather than in the repository's `plugins/` folder: they are seeded into
 * `DATA_DIR/plugins` at boot, which means the server has to be able to read
 * them.
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
 * is no build step, no \`package.json\` and no \`npm install\`.
 *
 * Saving from **Settings → Plugins** writes the file and **reloads the runtime**
 * — no restart. Dropping the file in by hand works too; that one needs a
 * restart, or a save from the editor, to be picked up.
 *
 * ⚠️ A plugin CasaTube has not seen before arrives **enabled**, so \`setup\` runs
 * as soon as it loads. The switch on that screen is what turns it off, and the
 * choice is remembered in \`DATA_DIR/plugin-state.json\`.
 *
 * ⚠️ And a plugin runs **in-process, with CasaTube's own privileges**. \`needs\`
 * below is a contract for the interface, not a sandbox: only \`network\` is
 * really withheld. Read what you save.
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

  /**
   * What this plugin needs configured, so Settings can draw a **form** for it
   * instead of you having to know which environment variables to set.
   *
   * Static, like \`matches\`, and read at the same moment — so the form exists
   * before \`setup\` has ever run, which is the only way a plugin can be
   * configured before it is switched on.
   *
   *   key         the name in \`config\`. An environment variable name.
   *   label       the form label, for someone who has not read this file
   *   description one or two sentences: what it is for, where to get it
   *   secret      🔴 never returned by the API. Stored, used, never echoed.
   *   default     what \`config\` holds when nothing else does
   *   required    shown as a warning; nothing is enforced — an unconfigured
   *               plugin must still behave
   *   type        text | number | boolean | url | select  (a hint for the form)
   *   options     for \`select\`
   *
   * ⚠️ Every value arrives as a **string**, booleans and numbers included,
   * because the layer underneath is the process environment. Compare against
   * \`"true"\`; parse the numbers yourself.
   *
   * The order, highest first: what was typed in Settings, then the \`config\`
   * block in \`DATA_DIR/plugin-state.json\`, then the environment, then
   * \`default\`. Nothing ever writes to the environment, which is why Settings
   * can put a value back to it with one button.
   */
  settings: [
    {
      key: "MY_PLUGIN_URL",
      label: "Where to POST",
      description: "The endpoint this plugin talks to.",
      type: "url",
      required: true,
      placeholder: "http://something.local:8080/hook",
    },
    // { key: "MY_PLUGIN_TOKEN", label: "Token", secret: true },
  ],

  setup({ on, log, config /*, fetch, addProvider */ }) {
    /**
     * \`config\` is frozen: the process environment plus any per-plugin block in
     * \`DATA_DIR/plugin-state.json\`. Read it defensively — a plugin that is not
     * configured should say so once and then do nothing, rather than fail one
     * download per video.
     */
    const target = typeof config.MY_PLUGIN_URL === "string" ? config.MY_PLUGIN_URL.trim() : "";
    if (target === "") {
      log("not configured (set it in Settings); doing nothing");
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
| \`settings\` | no | What you need configured. Settings draws a form from it. |

## Settings

\`\`\`ts
settings: [
  { key: "JELLYFIN_URL", label: "Jellyfin URL", type: "url", required: true },
  { key: "JELLYFIN_TOKEN", label: "API key", secret: true, required: true },
  { key: "TIMEOUT_MS", label: "Timeout (ms)", type: "number", default: "10000" },
]
\`\`\`

Declared like \`matches\`, and read at the same moment — so the form exists
**before \`setup\` has ever run**, which is the only way a plugin can be
configured before it is switched on.

| | |
|---|---|
| \`key\` | The name in \`config\`. An environment variable name. |
| \`label\` / \`description\` | Written for whoever is filling the form in. |
| \`secret\` | 🔴 **Never returned by the API.** Stored, used, never echoed back. |
| \`default\` | What \`config\` holds when no layer above supplies a value. |
| \`required\` | Shown as a warning. Nothing is enforced — an unconfigured plugin must still behave. |
| \`type\` | \`text\` \| \`number\` \| \`boolean\` \| \`url\` \| \`select\` — a hint for the form. |
| \`options\` | For \`select\`. |

**The order, highest first:** what was typed in Settings → the \`config\` block in
\`DATA_DIR/plugin-state.json\` → the process environment → \`default\`. Nothing
ever writes to the environment, which is why one button in Settings can put a
value back to it.

⚠️ Every value is a **string**, booleans and numbers included, because the layer
underneath is the environment and an environment variable is a string.

⚠️ Values are stored in \`DATA_DIR/casatube.db\` **unencrypted** — as exposed as
the same token in a compose file, which is where it lived before.

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
\`needs: ["network"]\`, \`config\` frozen (see **Settings** above for the layers),
\`log\` writing to both the server log and this plugin's log in the UI.

⚠️ \`log\` output **is returned by the API** and shown on the Plugins screen.
Nothing on the server can redact what a plugin chose to print, so do not log a
token you asked for as a secret.

## Editing from here

Settings → Plugins has an editor. Saving writes the file and **reloads the
runtime** — no restart — and answers with how that plugin came back: \`active\`,
or \`error\` with the reason. A file that does not compile is recorded against
itself and everything else stays loaded.

🔴 That makes running code on this server one text box away, so the warning
below matters more rather than less.

## Capabilities are a UI contract, not a sandbox

\`needs\` is shown to you before you enable a plugin, the way a phone shows
permissions. **Today only \`network\` is actually withheld** — leave it out and
the \`fetch\` handed to \`setup\` throws. \`library:read\`, \`library:write\`,
\`cookies\` and \`subprocess\` are declaration only.

And it stops a *well-behaved* plugin, not a determined one: an in-process
TypeScript module can import Bun and Node APIs directly, read your cookies file
and run anything this process can run. Bun has no permission flags underneath to
hold the line. Treat \`needs\` as documentation you are allowed to be suspicious
of, and read a plugin before you save it.

---

⚠️ This is the short version, bundled with the server. The full reference —
pattern matching, hook ordering with \`before\`/\`after\`, capabilities, and the
annotated built-ins in \`src/plugins/builtin/\` — is \`plugins/README.md\` in the
CasaTube repository.
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

/**
 * Capabilities that are genuinely withheld today.
 *
 * One set, so the warning below cannot drift from `plugin-runtime.ts`. Anything
 * not in here is declaration only: shown to the user, and nothing held back.
 */
const ENFORCED: ReadonlySet<string> = new Set(["network"]);

/**
 * What the server says every time a plugin is saved.
 *
 * 🔴 It is generated by the server rather than written into the dialog, because
 * an editor is exactly what makes this warning matter more. Before it, running
 * code inside CasaTube meant getting a file onto the server's filesystem. Now it
 * is a text box on a page anybody on the network can open, and the honest
 * sentence — from PLAN §5 and `plugins/README.md` — is that **capabilities are
 * a UI contract, not a sandbox**. Saying it once in a README that ships
 * somewhere else would be the same silence this project keeps finding.
 *
 * ⚠️ It is returned on **every** save, not just the first. A warning that
 * appears once is a warning shown to whoever set the machine up, and not to the
 * person editing a plugin a year later.
 */
export function saveWarning(needs: readonly string[] = []): string {
  const declaration =
    needs.length === 0
      ? "It declares no capabilities, which withholds nothing"
      : `It declares ${needs.join(", ")} — of those, ${
          needs.filter((need) => ENFORCED.has(need)).join(", ") || "none"
        } is actually withheld from a plugin that does not ask, and the rest are declaration only`;

  return (
    "This code now runs inside CasaTube, in the same process and with the same privileges: " +
    "it can read the library, the cookies file, and anything else this server can reach. " +
    `${declaration}. \`needs\` is a UI contract, not a sandbox — an in-process module can import Bun and ` +
    "Node APIs directly whatever it declares, and nothing here inspects what the code does. " +
    "A syntax error is caught and shown against this plugin alone; a plugin that means harm is not."
  );
}
