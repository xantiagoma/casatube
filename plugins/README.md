# Writing a CasaTube plugin

A plugin is **one file** in `DATA_DIR/plugins/`. Bun imports TypeScript
directly, so for most plugins there is no build step, no `package.json`, and no
`npm install` — you write a `.ts` file, drop it in, and restart.

This directory holds the reference plugin, [`jellyfin.ts`](jellyfin.ts). Copy it
somewhere else and change it; it is meant to be read.

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

### Configuration

`config` is the process environment (PLAN section 12: everything is an
environment variable) merged with a per-plugin block in
`DATA_DIR/plugin-state.json`:

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

The choice is persisted in `DATA_DIR/plugin-state.json` and survives a restart.

---

## Testing a plugin

`src/core/plugin-runtime.test.ts` writes plugin files into a temporary directory
and loads them exactly as the server would. The bottom of that file does it to
`jellyfin.ts` itself, against a stub Jellyfin — copy the pattern:

```ts
const runtime = createPluginRuntime({ dir, config: { JELLYFIN_URL: "…" }, log: () => {} });
await runtime.load();
await runtime.run("job:completed", job);
await runtime.observersIdle();     // observers are not awaited; this is how a test waits
expect(runtime.list()[0]?.log.join("\n")).toContain("…");
```
