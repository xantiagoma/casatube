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
}

export function usePlugins(): UseQueryResult<PluginListing, Error> {
  return useQuery({
    queryKey: keys.plugins,
    queryFn: async () => unwrap(await api.api.plugins.get()),
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
