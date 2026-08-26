/**
 * Serving the browser client.
 *
 * The bundle is built by `Bun.build` from the HTML entrypoint and kept **in
 * memory**. That is a decision, not a shortcut: `bun src/server.ts` is then the
 * whole story — no separate build step to forget, no `dist/` that can be stale
 * relative to the source, and one artefact for the image to copy (PLAN §14).
 * The cost is a few hundred milliseconds at startup, once.
 *
 * ⚠️ **The catch-all is load-bearing** (PLAN §8): client-side routing means any
 * non-`/api` path has to answer with `index.html`, or a deep link reloads into
 * a 404. It is registered last and refuses `/api/*` explicitly, so a mistyped
 * endpoint gets an honest JSON 404 instead of a page that looks like it worked.
 */
import { Elysia } from "elysia";
import { basename, resolve } from "node:path";

import type { AppContext } from "./context";

const WEB_DIR = resolve(import.meta.dir, "../web");
const ENTRYPOINT = resolve(WEB_DIR, "index.html");

interface Asset {
  body: ArrayBuffer;
  type: string;
}

export interface ClientBundle {
  html: string;
  /** Keyed by filename, which is content-hashed by the bundler. */
  assets: Map<string, Asset>;
  builtAt: number;
  /** Present when the build failed; the page then shows this instead of nothing. */
  error?: string;
}

/** A page that says what broke. A blank 500 teaches nobody anything. */
function errorPage(detail: string): string {
  const escaped = detail.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
  return `<!doctype html><html><head><meta charset="utf-8"><title>CasaTube — build failed</title>
<style>body{font:14px/1.6 ui-monospace,monospace;background:#111;color:#eee;padding:2rem}
pre{white-space:pre-wrap;background:#000;padding:1rem;border-radius:8px;border:1px solid #333}</style>
</head><body><h1>The client bundle failed to build</h1><pre>${escaped}</pre>
<p>The API is still up — this is the browser bundle only.</p></body></html>`;
}

export async function buildClient(options: { dev?: boolean } = {}): Promise<ClientBundle> {
  const dev = options.dev ?? false;

  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [ENTRYPOINT],
      target: "browser",
      minify: !dev,
      sourcemap: dev ? "inline" : "none",
      // Absolute, because the catch-all serves this HTML at arbitrary depths:
      // a relative `./main.js` under `/jobs/abc` would resolve to
      // `/jobs/main.js` and 404. This is the same bug as the missing catch-all,
      // one level down.
      publicPath: "/assets/",
      naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
      // React reads this to drop its development-only checks. Without it the
      // browser gets the dev build, warnings and all.
      define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    });
  } catch (cause) {
    const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    return { html: errorPage(detail), assets: new Map(), builtAt: Date.now(), error: detail };
  }

  if (!built.success) {
    const detail = built.logs.map((log) => String(log.message ?? log)).join("\n") || "unknown build failure";
    return { html: errorPage(detail), assets: new Map(), builtAt: Date.now(), error: detail };
  }

  const assets = new Map<string, Asset>();
  let html = "";

  for (const artifact of built.outputs) {
    const name = basename(artifact.path);
    if (name.endsWith(".html")) {
      html = await artifact.text();
      continue;
    }
    assets.set(name, { body: await artifact.arrayBuffer(), type: artifact.type });
  }

  if (html === "") {
    const detail = "the build produced no HTML entrypoint";
    return { html: errorPage(detail), assets: new Map(), builtAt: Date.now(), error: detail };
  }

  return { html, assets, builtAt: Date.now() };
}

export function webRoutes(ctx: AppContext, initial: ClientBundle) {
  let bundle = initial;

  async function page(): Promise<Response> {
    // In dev the source changes under a running server and `bun --watch` does
    // not see files the server never imported. Rebuilding per page load keeps
    // a reload honest; in the image this branch never runs.
    if (ctx.config.dev) bundle = await buildClient({ dev: true });
    return new Response(bundle.html, {
      status: bundle.error ? 500 : 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  return new Elysia()
    .get("/assets/:file", ({ params, status }) => {
      const asset = bundle.assets.get(params.file);
      if (!asset) return status(404, { tag: "NotFound", message: "No such asset.", retryable: false });
      return new Response(asset.body, {
        headers: {
          "content-type": asset.type,
          // Safe because the filename carries a hash of the contents: a new
          // build is a new URL, so nothing can be served stale.
          "cache-control": ctx.config.dev ? "no-store" : "public, max-age=31536000, immutable",
        },
      });
    })
    .get("/", () => page())
    /**
     * Everything else is the client — except `/api`, which must fail as an API.
     * Answering an unknown endpoint with HTML is how a typo turns into an hour
     * of debugging a parse error.
     */
    .get("/*", ({ path, status }) => {
      if (path === "/api" || path.startsWith("/api/")) {
        return status(404, { tag: "NotFound", message: `No such endpoint: ${path}`, retryable: false });
      }
      return page();
    });
}
