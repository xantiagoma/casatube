/**
 * `/api/plugins` — what is installed, what it asks for, and what it would do.
 *
 * The interesting endpoint is `GET /api/plugins/applicable?url=`. PLAN section 5
 * says a plugin is not a black box that quietly runs on everything: it declares
 * `matches`, that declaration is readable **before any of its code runs**, and
 * so the download window can paste a URL, show which plugins would act on it,
 * what each one would do, and leave the choice to the user.
 *
 * That is the whole reason this route exists rather than a settings page: the
 * recommendation comes from `matches`, and the decision stays with the person.
 *
 * The routes take the runtime directly instead of `AppContext`. A plugin
 * registry is not a database or a queue, and passing it explicitly is what lets
 * a test stand these endpoints up over a temporary directory with no
 * SQLite file anywhere near it.
 */
import { Elysia, status, t } from "elysia";
import { Result } from "better-result";

import { NotFound } from "../core/errors";
import type { PluginRuntime, PluginStatus } from "../core/plugin-runtime";
import { fail } from "./errors";
import { PLUGIN_TEMPLATE_FILENAME, pluginDocs, pluginTemplate } from "./plugin-template";

/**
 * A plugin as the browser sees it.
 *
 * Deliberately the manifest and the state, and nothing else: `config` is not
 * here, because a plugin's config comes from the environment and a media-server
 * token is exactly the kind of thing PLAN section 12 says is never echoed back
 * through the API.
 */
export interface PluginView extends PluginStatus {}

export interface PluginListing {
  plugins: PluginView[];
  /**
   * The absolute directory a plugin file goes in.
   *
   * 🔴 Part of the listing rather than something the browser guesses, because
   * an empty list is exactly when it is needed: "No plugins installed" with no
   * path is a dead end, and the path depends on `DATA_DIR`, which only the
   * server knows.
   */
  dir: string;
}

export interface ApplicableListing {
  url: string;
  /** Every plugin that would act on this URL, enabled or not. */
  plugins: PluginView[];
}

/**
 * @param dir The plugins directory, for the three answers a screen with no
 * plugins on it needs to give: where the file goes, what to start from, and
 * where the documentation is. The runtime knows it and does not expose it, so
 * it is passed in beside it.
 */
export function pluginRoutes(runtime: PluginRuntime, dir = "") {
  return (
    new Elysia({ prefix: "/plugins" })
      /** Everything found, broken ones included — a plugin that failed to load is the one you most need to see. */
      .get("/", (): PluginListing => ({ plugins: runtime.list(), dir }))

      /**
       * A starter plugin, as a file to save.
       *
       * 🔴 A download rather than a snippet to copy out of a `<pre>`: the thing
       * being asked for is a file in a directory, and handing over the file is
       * one step instead of three. `Content-Disposition` carries the name, so
       * what lands in ~/Downloads is already called `casatube-plugin.ts`.
       *
       * `text/plain` on purpose — a browser must never be tempted to do
       * anything with this but save it.
       */
      .get(
        "/template",
        () =>
          new Response(pluginTemplate(dir === "" ? "DATA_DIR/plugins" : dir), {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "content-disposition": `attachment; filename="${PLUGIN_TEMPLATE_FILENAME}"`,
            },
          }),
      )

      /**
       * The documentation, served rather than linked.
       *
       * A link to a file in the repository is a link a running server cannot
       * honour — the image has no repository in it. See `plugin-template.ts`.
       */
      .get("/docs", () => ({
        markdown: pluginDocs(dir === "" ? "DATA_DIR/plugins" : dir),
        filename: PLUGIN_TEMPLATE_FILENAME,
        dir,
      }))

      /**
       * Which plugins would act on this URL.
       *
       * Answered entirely from static manifests, so asking costs nothing and
       * runs none of the plugins. Broken plugins are excluded: they cannot act
       * on anything, and offering the user a toggle for one would be a lie.
       */
      .get(
        "/applicable",
        ({ query }): ApplicableListing => ({
          url: query.url,
          plugins: runtime.applicableTo(query.url),
        }),
        { query: t.Object({ url: t.String({ minLength: 1 }) }) },
      )

      /**
       * Turn one on. This is what runs its `setup()` for the first time, which
       * is why it can fail: a plugin whose setup throws reports it here rather
       * than at a boot nobody was watching.
       */
      .post(
        "/:name/enable",
        async ({ params }) => toggle(await runtime.enable(params.name), params.name),
        { params: t.Object({ name: t.String() }) },
      )

      /** Turn one off. Its hooks stop being dispatched and its providers stop claiming URLs. */
      .post(
        "/:name/disable",
        async ({ params }) => toggle(await runtime.disable(params.name), params.name),
        { params: t.Object({ name: t.String() }) },
      )
  );
}

/**
 * The runtime answers with a plain string when it cannot do it, because it has
 * no business knowing about HTTP. This is the boundary that gives that string a
 * status code — PLAN section 10 rule 5.
 */
function toggle(outcome: Result<PluginStatus, string>, name: string) {
  if (Result.isOk(outcome)) return outcome.value;
  // "No such plugin" is a 404 in the shared taxonomy; anything else is a plugin
  // that exists but is in no state to be switched on, which is a conflict.
  if (outcome.error.startsWith("no plugin named")) {
    return fail(new NotFound({ what: "plugin", id: name }));
  }
  return status(409, { tag: "PluginUnavailable", message: outcome.error, retryable: false });
}
