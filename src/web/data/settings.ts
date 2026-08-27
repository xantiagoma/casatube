/**
 * Application settings: read the snapshot, write one override, remove one.
 *
 * 🔴 **The server owns every one of these values, including after a write.**
 * A `PUT` answers with the setting *as it now resolves* — which is not always
 * what was sent: a restart-scoped write comes back with `pendingRestart: true`
 * and `runningValue` still holding what the process is really using. So nothing
 * here writes the sent value into the cache; the snapshot is invalidated and
 * the server says what happened. Optimism would produce exactly the lie this
 * screen exists to prevent ("saved" beside a number nothing is using).
 *
 * ⚠️ **A live write moves `/api/jobs/defaults` too.** The `downloads.*` group
 * *is* the download defaults, and `useJobDefaults` holds them with
 * `staleTime: Infinity` — so without invalidating it, saving 720p here would
 * leave the download form on the dashboard starting from 1080p until the tab
 * was reloaded. That is the whole point of the group being live.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type { ResolvedSetting, SettingsSnapshot, SettingValue } from "../../core/app-settings";
import { api, unwrap } from "./client";
import { keys } from "./keys";

export type { ResolvedSetting, SettingsSnapshot, SettingValue };

/**
 * Every setting, its source, and whether anything is waiting for a restart.
 *
 * `staleTime: 0` because the environment and the running process can disagree
 * with the table at any moment — a second tab saving, or an operator restarting
 * with a new variable — and a stale snapshot here is a screen confidently
 * naming the wrong source.
 */
export function useSettings(): UseQueryResult<SettingsSnapshot, Error> {
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () => unwrap(await api.api.settings.get()),
    staleTime: 0,
    retry: 0,
  });
}

export interface SaveSetting {
  key: string;
  value: SettingValue;
}

/** Write an override. The answer is the setting as the server now resolves it. */
export function useSaveSetting() {
  const client = useQueryClient();
  return useMutation<ResolvedSetting, Error, SaveSetting>({
    mutationFn: async ({ key, value }) =>
      unwrap(await api.api.settings({ key }).put({ value })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.settings });
      void client.invalidateQueries({ queryKey: keys.jobDefaults });
    },
  });
}

/**
 * Remove the override.
 *
 * ⚠️ `DELETE` is a reset, not a delete: the setting is a definition in the code
 * and cannot go away. What goes away is the stored value, and the response says
 * where the setting landed — which is why the button that calls this can name
 * the layer it is falling back to.
 */
export function useResetSetting() {
  const client = useQueryClient();
  return useMutation<ResolvedSetting, Error, string>({
    mutationFn: async (key) => unwrap(await api.api.settings({ key }).delete()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.settings });
      void client.invalidateQueries({ queryKey: keys.jobDefaults });
    },
  });
}
