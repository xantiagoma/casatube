/**
 * Plugins: what is installed, what it declares, and whether it is on.
 *
 * The manifest is readable before any of the plugin's code runs, which is what
 * lets this list say what a plugin *would* do rather than only what it is
 * called. Broken plugins are listed too — a plugin that failed to load is the
 * one you most need to see.
 *
 * ⚠️ `config` never comes back from the server (PLAN §12: a media-server token
 * is not echoed through the API), so the panel shows declarations and state and
 * offers no way to edit secrets.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type { PluginStatus } from "../../core/plugin-runtime";
import { api, unwrap } from "./client";
import { keys } from "./keys";

export interface PluginListing {
  plugins: PluginStatus[];
  /** Where a plugin file goes on this server — the answer an empty list needs. */
  dir: string;
}

/**
 * The starter plugin, as a file.
 *
 * A plain URL rather than an Eden call because the browser is doing the
 * fetching: this is the `href` of a download link, and the server sends it with
 * `Content-Disposition`, so it lands already named. Same shape as
 * `libraryFileUrl` in `library.ts`, and here for the same reason — the folder
 * that knows the API is this one (R3).
 */
export const PLUGIN_TEMPLATE_URL = "/api/plugins/template";

export function usePlugins(): UseQueryResult<PluginListing, Error> {
  return useQuery({
    queryKey: keys.plugins,
    queryFn: async () => unwrap(await api.api.plugins.get()),
    retry: 0,
  });
}

export interface PluginDocs {
  markdown: string;
  filename: string;
  dir: string;
}

/**
 * The documentation, served by the API rather than linked to a file.
 *
 * ⚠️ It cannot be a link to `plugins/README.md`: the repository is not in the
 * image, so that link 404s exactly where someone is most likely to click it.
 * The server holds a condensed copy and hands it over — see
 * `api/plugin-template.ts`.
 *
 * Fetched only when the dialog opens: it is a few kilobytes nobody needs on the
 * way past.
 */
export function usePluginDocs(enabled: boolean): UseQueryResult<PluginDocs, Error> {
  return useQuery({
    queryKey: keys.pluginDocs,
    queryFn: async () => unwrap(await api.api.plugins.docs.get()),
    enabled,
    // It changes when the server is upgraded, and not otherwise.
    staleTime: Number.POSITIVE_INFINITY,
    retry: 0,
  });
}

/** ⚠️ Enabling runs the plugin's `setup()` for the first time, so it can fail. */
export function useTogglePlugin() {
  const client = useQueryClient();
  return useMutation<PluginStatus, Error, { name: string; enabled: boolean }>({
    mutationFn: async ({ name, enabled }) =>
      unwrap(enabled ? await api.api.plugins({ name }).enable.post() : await api.api.plugins({ name }).disable.post()),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.plugins }),
  });
}
