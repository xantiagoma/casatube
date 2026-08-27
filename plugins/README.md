# Writing a CasaTube plugin

A plugin is **one file** in `DATA_DIR/plugins/`. Bun imports TypeScript
directly, so for most plugins there is no build step, no `package.json`, and no
`npm install` — you write a `.ts` file and it loads.

Two ways in:

- **Settings → Plugins → New**, which writes the file and **reloads the
  runtime**. No restart, and a file that does not compile comes back as an
  `error` row with the reason on it.
- **Putting the file there yourself**, which needs a restart (or any save from
  the editor, which reloads everything).

⚠️ The editor makes running code on the server one text box away. The section
[Capabilities](#capabilities-a-ui-contract-not-a-sandbox) at the bottom is not
boilerplate: **a plugin runs in-process with CasaTube's full privileges**, and
nothing here inspects what it does.

## The plugins that ship

Three, and they are copied into `DATA_DIR/plugins/` on first boot so they are
yours to edit or delete. The sources live in
[`src/plugins/builtin/`](../src/plugins/builtin/) — under `src` rather than
here, because the repository is not in the Docker image and the server has to be
able to read them.

| | Kind | What it demonstrates |
|---|---|---|
| [`jellyfin.ts`](../src/plugins/builtin/jellyfin.ts) | observer | `matches: []`, a **secret** setting, an observer that throws on purpose |
| [`unshorten.ts`](../src/plugins/builtin/unshorten.ts) | **transform** | `matches` with real hosts, replacing the value, and why a failure must not fail the job |
| [`webhook.ts`](../src/plugins/builtin/webhook.ts) | observer | two hook points at once, `job:failed`, and a select / boolean / number form |

**An edited built-in is never written over.** The seeder records the SHA-256 of
exactly what it wrote; if the file still matches, an upgrade replaces it, and if
you have changed it, the upgrade is skipped and **says so in the boot log**. One
you delete stays deleted.

---

## The shortest useful plugin

```ts
export default {
  name: "adfly-bypass",
  description: "Resolves adf.ly links to their target",
  matches: ["adf.ly", "*.adfly.com"],
  needs: ["network"],
  hooks: [{ at: "url:resolve", kind: "transform" }],

  setup({ on, fetch, log }) {
    on("url:resolve", async (url) => {
      const response = await fetch(url, { redirect: "follow" });
      log(`unshortened to ${response.url}`);
      return response.url;
    });
  },
};
```

Two halves, and the split is the whole design:

- **The manifest** (`name`, `description`, `matches`, `hooks`, `needs`) is
  static data. CasaTube reads it **without calling `setup`**, which is what lets
  the download window show you which plugins would act on a URL you just pasted,
  what each one asks for, and a toggle for each.
- **`setup`** is the code. It runs only when the plugin is enabled, and
  everything it can do arrives as an argument.

`registerPlugin()` from `src/core/plugins.ts` is optional sugar — it is the
identity function, there to give you type checking. It is a *value* import, so
it only works for a plugin that lives inside the repo or a bundle. A plugin
dropped into `DATA_DIR/plugins/` should use a **type-only** import instead,
which is erased before the file ever runs:

```ts
import type { Plugin } from "casatube";   // erased at runtime; point it anywhere your editor likes

const plugin: Plugin = { /* … */ };
export default plugin;
```

Or skip the import entirely and export a plain object. Both work.

---

## The manifest

| Field | Required | What it does |
|---|---|---|
| `name` | yes | Unique. Letters, digits, `.`, `-`, `_`. It is the id used by the API and by `before`/`after`. |
| `description` | yes | One line, shown next to the toggle. Write it for the person deciding. |
| `matches` | no | Hosts or patterns this plugin claims. **Absent or empty means "everything".** |
| `hooks` | no | Every hook you intend to register, with its kind. See below. |
| `needs` | no | Capabilities requested. Shown at install time. |
| `settings` | no | What you need configured. Settings draws a form from it. |

### `matches`

Read **before any of your code runs**, and enforced at dispatch: if your plugin
did not claim a URL, its hooks are not called for that URL.

| Pattern | Matches |
|---|---|
| `youtube.com` | `youtube.com` and any subdomain (`www.youtube.com`) |
| `*.vimeo.com` | subdomains only — **not** `vimeo.com` itself |
| `https://example.org/*` | anything with a `/` or `://` is globbed against the **whole URL** |
| `*` | everything |
| `[]` or absent | everything |

A plugin that acts on the *result* rather than the *source* — a media-server
refresh, a notifier — should use `[]`. Claiming `youtube.com` there would mean
it silently stopped working the day someone downloaded from anywhere else.

### `hooks` is a gate, not documentation

Every hook you register with `on()` must be declared in `hooks` first.
`on("url:resolve", …)` without a matching declaration is **refused and logged**.

This is not bureaucracy: `kind` lives only in the declaration, so an undeclared
hook is one the runtime cannot run — it does not know whether a failure should
fail the job. And it is what keeps the manifest an honest description of what
the plugin actually does.

---

## Hook points

| Point | Signature | When |
|---|---|---|
| `url:resolve` | `(url) => string` | Before a provider is chosen. Return a different URL to replace it. |
| `job:queued` | `(job) => void` | The job is durable and waiting. |
| `probe:complete` | `(info, plan) => DownloadPlan` | The media has been read and a plan chosen. Return a plan to replace it. |
| `download:complete` | `(job, file) => void` | Bytes are on disk, before post-processing. |
| `job:completed` | `(job) => void` | Finished, in the library. |
| `job:failed` | `(job, error) => void` | Gave up. |

### The two kinds, and the difference that matters

|  | `transform` | `observe` |
|---|---|---|
| Can change the outcome | yes | no |
| Execution | in order, one after another, awaited | in parallel, **not awaited** |
| On failure | **fails the job** | logged against the plugin, job continues |
| Use for | unshortening a URL, adjusting selection | refreshing a media server, notifying |

**An observer can never fail a job.** If the Jellyfin refresh fails, the video is
downloaded and correct; marking the job failed would be a lie. Throw as loudly
as you like inside an observer — the runtime catches it, records it on your
plugin's log, and the job stays done.

The inverse is just as deliberate: if your transform throws, the job fails with
`PluginHookFailed` naming your plugin. Only make a hook a transform when a
failure genuinely means the download should not proceed.

A transform that returns nothing leaves the value unchanged, so a hook that only
inspects is safe to write as a transform.

### Order

Hooks at one point run in file order (the plugins directory, sorted), then in
the order you declared them. Override it explicitly:

```ts
hooks: [{ at: "url:resolve", kind: "transform", after: "adfly-bypass" }]
```

`before` and `after` name **another plugin**. A name that matches nothing at
that point is ignored — that includes `before: "provider:resolve"`, which names
CasaTube's own step rather than a plugin. Order is never left to load order
alone, and a cycle falls back to file order rather than refusing to run.

---

## What `setup` is handed

```ts
setup({ on, addProvider, fetch, log, config }) { … }
```

| | |
|---|---|
| `on(at, fn)` | Register a hook. Must be declared in `hooks`. |
| `addProvider(provider)` | Add a provider **ahead of** the built-in yt-dlp one, so it is asked first. |
| `fetch` | The global `fetch`, **only if you declared `needs: ["network"]`**. |
| `log(line)` | Goes to the server log and to your plugin's own log in the UI. |
| `config` | Frozen. Environment variables, plus any per-plugin overrides. |

Nothing is imported. That is what makes the dependency question mostly go away:
a URL unshortener and a media-server notifier need `fetch` and nothing else.

⚠️ **`log` output is returned by the API** and rendered on the Plugins screen.
Nothing on the server can redact what a plugin chose to print, so never log a
value you declared as a `secret`.

### Configuration: declare it, and the UI draws the form

```ts
settings: [
  { key: "JELLYFIN_URL",   label: "Jellyfin URL", type: "url", required: true },
  { key: "JELLYFIN_TOKEN", label: "API key",      secret: true, required: true },
  { key: "TIMEOUT_MS",     label: "Timeout (ms)", type: "number", default: "10000" },
]
```

| Field | What it does |
|---|---|
| `key` | The name in `config`. Must be a valid environment variable name — the environment is one of the layers below, and a key that could not be one would make the revert button meaningless. |
| `label`, `description` | Written for whoever is filling the form in, not for you. |
| `secret` | 🔴 **Never returned by the API.** The form reports "set" or "not set" and a box to replace it; the value itself never crosses the wire. Same rule as the cookies file (PLAN §12). |
| `default` | What `config` holds when nothing above supplies a value. |
| `required` | Shown as a warning, and reported on the listing as `missingSettings`. Nothing is enforced — an unconfigured plugin must still behave. |
| `type` | `text` \| `number` \| `boolean` \| `url` \| `select`. A hint for the form. |
| `options` | For `select`: `[{ value, label }]`. |

Declared like `matches`, and read at the same moment, so **the form exists
before `setup` has ever run** — which is the only way a plugin can be configured
before it is switched on.

#### The four layers, highest first

| | |
|---|---|
| **stored** | What was typed into Settings → Plugins. |
| **file** | The `config` block in `DATA_DIR/plugin-state.json` (below). |
| **environment** | The process environment — PLAN §12. |
| **default** | What your manifest declares. |

🔴 **Nothing ever writes to the environment.** That is what makes the "use the
environment value" button honest: it deletes the stored value and the variable,
untouched all along, answers again.

⚠️ **Every value is a string**, booleans and numbers included, because the layer
underneath is the environment. Compare against `"true"`; parse your own numbers.
A setting that arrived as a `number` from the UI and a `string` from a compose
file would work until somebody moved it.

⚠️ **Blank is unset.** `FOO=` in a compose file is how someone says "I am not
setting this", so an empty string never shadows a `default`.

⚠️ Stored values live in `DATA_DIR/casatube.db`, **unencrypted**. A token there
is exactly as exposed as the same token in a compose file, which is where it was
before. Back up `DATA_DIR` accordingly.

The hand-edited file layer still works and is still read:

```json
{
  "plugins": {
    "jellyfin": {
      "enabled": true,
      "config": { "JELLYFIN_URL": "http://jellyfin.local:8096" }
    }
  }
}
```

📌 `config` is the **whole environment** plus your declared settings, not the
declared settings alone. A plugin may read a variable its manifest never
mentions — `jellyfin.ts` still accepts `MEDIA_SERVER_URL` — and there is no
sandbox here that could stop it if it wanted to.

Read it defensively. **A plugin that is not configured should say so once and do
nothing** — not fail a download per video. `jellyfin.ts` shows the shape: if the
URL or token is missing, it logs one line and registers no hook at all.

### Adding a provider

```ts
setup({ addProvider }) {
  addProvider({
    name: "fancy",
    supports: (url) => url.includes("fancy.example"),
    probe: async (url, signal) => { /* … */ },
    fetch: async (plan, ctx) => { /* … */ },
  });
}
```

Providers from plugins are asked **before** yt-dlp, which always answers last
and cannot be removed. Disabling the plugin stops its provider claiming URLs.

---

## Capabilities: a UI contract, **not a sandbox**

`needs` declares what a plugin asks for: `network`, `library:read`,
`library:write`, `cookies`, `subprocess`. The host injects what you declared and
shows the list at install time, the way a phone shows permissions.

🔴 **This section got more important, not less, when the editor arrived.**
Installing a plugin used to mean getting a file onto the server. It is now a
text box on a page anybody on the network can open — so CasaTube repeats the
paragraph below, generated by the server, on every single save.

**Be clear about what that enforces, because it is less than it looks:**

- Withholding a capability works for a **well-behaved** plugin. Leave out
  `network` and the `fetch` you are handed throws instead of making a request.
  A ported plugin that only uses what it is given genuinely cannot reach the
  network.
- It does **not** stop a plugin that does not want to be stopped. A plugin is an
  in-process TypeScript module: it can `import { $ } from "bun"`, open a socket
  with `node:net`, read `node:fs`, or call `globalThis.fetch` directly. Bun has
  no Deno-style permission flags to fall back on, so there is nothing underneath
  this contract holding the line.
- Only `network` is actually gated today. `library:read`, `library:write`,
  `cookies` and `subprocess` are **declarations only** — they are shown to the
  user and nothing is withheld for them, because the API surface they would gate
  is not injected yet.

So: **a plugin runs with CasaTube's full privileges.** It can read the library,
read your cookies file, and run anything the process can run. That is acceptable
for a self-hosted tool whose plugins you write or read yourself. It stops being
acceptable the moment you install one from a stranger, and *that* is when this
should become process isolation — not before.

Treat `needs` as documentation you can be suspicious of: a notifier asking for
`cookies` is a reason to read the file before you install it.

---

## When you need a build step

If your plugin genuinely needs a library, bundle it and drop the single output
file in:

```bash
bun build plugin.ts --outfile plugin.js --target bun
```

This is the Obsidian and VS Code model, chosen over running `npm install` at
load time (the Node-RED model), which brings version conflicts, slow startup,
and a supply-chain surface that activates on load rather than on build.

You do **not** need this for anything that only uses `fetch`, the standard
library, or Bun's own APIs. Those are the majority.

---

## How CasaTube loads your file

1. Every `.ts`, `.mts`, `.js` and `.mjs` in `DATA_DIR/plugins/` is read, sorted
   by filename. Files starting with `.` or `_`, `.d.ts` files, and anything with
   `.test.` in the name are skipped.
2. The module is imported and its **default export** (or a named `plugin`
   export) is validated against the manifest rules.
3. `setup()` is called **only for enabled plugins**.

Saving from the editor — or saving a plugin's settings — runs all three again.
That is a **reload, not a restart**: a plugin whose `setup` holds a timer or a
connection gets a fresh one, and the previous generation's providers stop
claiming URLs.

⚠️ **A query string does not bust Bun's module cache.** Each file is therefore
imported through a throwaway sibling copy named `.casatube-reload-…`, which is
deleted immediately. It is invisible to the loader and refused by the editor, so
it can never become a plugin of its own — see `docs/DISCOVERIES.md` for the
afternoon that bought this.

⚠️ **The one honest caveat about step 2.** Reading an ES module's export means
importing it, which evaluates the file's **top level**. "The manifest is read
before the plugin runs" is true of everything a plugin is supposed to do —
hooks, capabilities, providers — but a file that opens a connection at the top
level has already opened it. Keep your top level to declarations. There is no
parser stopping you.

### A broken plugin cannot break the others

A syntax error, a missing default export, an unknown hook point, a duplicate
name, a `setup` that throws — each is recorded against that one plugin, which
appears in the UI in the `error` state with the reason attached, and everything
else loads normally. A plugin whose `setup` throws is left **fully
unregistered**: any hooks it managed to register before throwing are dropped,
because running them would mean running against state its setup never finished
building.

---

## The API

| | |
|---|---|
| `GET /api/plugins` | Everything found, with manifests, state, and each plugin's recent log. Broken ones included. |
| `GET /api/plugins/applicable?url=…` | The plugins that would act on this URL. Answered from manifests alone, so asking costs nothing. |
| `POST /api/plugins/:name/enable` | Turn one on. This is what runs its `setup` for the first time, so it can report a setup failure. |
| `POST /api/plugins/:name/disable` | Turn one off. Hooks stop being dispatched, providers stop claiming URLs. |
| `GET /api/plugins/template` | The annotated starter, as a file. |
| `GET /api/plugins/docs` | The condensed reference, served by the server itself. |
| `GET /api/plugins/source?file=…` | One file's source, **by filename**. |
| `PUT /api/plugins/source` | Create or replace a file, then reload. `{ file, source, overwrite? }`. |
| `DELETE /api/plugins/source?file=…` | Remove a file, then reload. |
| `GET /api/plugins/:name/settings` | Declared settings, resolved through every layer. Secrets redacted. |
| `PUT /api/plugins/:name/settings` | `{ values }` — a **patch**. `null` clears a key, which is the revert button. Then reload. |

The enable/disable choice is persisted in `DATA_DIR/plugin-state.json`; setting
values are rows in the `settings` table. Both survive a restart.

🔴 **Files are addressed by filename, never by plugin name.** A file that does
not parse has no manifest and therefore no name — and it is exactly the file
somebody needs to open.

⚠️ `PUT /api/plugins/source` answers **200 for a plugin that does not compile**.
The write happened; the failure is in `saved.state` and `saved.error`. Reporting
it as a failed request would claim nothing was written, and the listing that
comes back with it shows every other plugin still loaded.

Every save carries a `warning` describing what has just been given permission to
run. It is returned on **every** save, not the first: a warning shown once is a
warning shown to whoever set the machine up, not to whoever is editing a plugin
a year later.

---

## Testing a plugin

`src/core/plugin-runtime.test.ts` writes plugin files into a temporary directory
and loads them exactly as the server would. The bottom of that file does it to
`src/plugins/builtin/jellyfin.ts` itself, against a stub Jellyfin — copy the
pattern. `src/core/plugin-builtins.test.ts` seeds all three built-ins and
asserts every one of them loads, which is the check that stops a default plugin
failing on somebody else's first boot:

```ts
const runtime = createPluginRuntime({ dir, config: { JELLYFIN_URL: "…" }, log: () => {} });
await runtime.load();
await runtime.run("job:completed", job);
await runtime.observersIdle();     // observers are not awaited; this is how a test waits
expect(runtime.list()[0]?.log.join("\n")).toContain("…");
```
