/**
 * Subscriptions and the scheduler that services them.
 *
 * ⚠️ `useAddSource` is the one call in the app that talks to the network before
 * it answers — the server enumerates the source and records its back catalogue
 * as seen before the row is safe. So it is slow, it can fail with the
 * provider's own error, and the form has to say "checking the source…" rather
 * than pretending it was instant.
 *
 * 🔴 Leaving `includeExisting` out means **nothing from the past is
 * downloaded**. That is the safe default and the form must not quietly change
 * it: asking for the back catalogue is an explicit number, never a checkbox
 * that means "everything".
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type { AddSourceResult, CheckResult } from "../../core/sources";
import type { SchedulerStatus, PassResult } from "../../core/scheduler";
import type { Preferences, Source } from "../../core/types";
import { api, unwrap } from "./client";
import { keys } from "./keys";

export interface SourceListing {
  sources: Source[];
  at: string;
}

export function useSources(): UseQueryResult<SourceListing, Error> {
  return useQuery({
    queryKey: keys.sources,
    queryFn: async () => unwrap(await api.api.sources.get()),
    refetchInterval: 30_000,
  });
}

export interface AddSourceRequest {
  url: string;
  name?: string;
  destination: string;
  preferences?: Preferences;
  intervalMinutes?: number;
  enabled?: boolean;
  includeExisting?: { limit: number };
}

export function useAddSource() {
  const client = useQueryClient();
  return useMutation<AddSourceResult, Error, AddSourceRequest>({
    mutationFn: async (request) => unwrap(await api.api.sources.post(request)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.sources });
      void client.invalidateQueries({ queryKey: keys.jobs });
      void client.invalidateQueries({ queryKey: keys.scheduler });
    },
  });
}

export interface UpdateSourceRequest {
  id: string;
  patch: {
    name?: string;
    destination?: string;
    intervalMinutes?: number;
    enabled?: boolean;
    preferences?: Preferences;
  };
}

export function useUpdateSource() {
  const client = useQueryClient();
  return useMutation<Source, Error, UpdateSourceRequest>({
    mutationFn: async ({ id, patch }) => unwrap(await api.api.sources({ id }).patch(patch)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.sources });
      void client.invalidateQueries({ queryKey: keys.scheduler });
    },
  });
}

export function useRemoveSource() {
  const client = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.sources({ id }).delete()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.sources });
      void client.invalidateQueries({ queryKey: keys.scheduler });
    },
  });
}

/**
 * Check one source now.
 *
 * `force: true` because the button exists to answer "is this thing working?",
 * and a disabled source is the one you most want to be able to ask.
 */
export function useCheckSource() {
  const client = useQueryClient();
  return useMutation<CheckResult, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.sources({ id }).check.post({ force: true })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.sources });
      void client.invalidateQueries({ queryKey: keys.jobs });
    },
  });
}

export function useScheduler(): UseQueryResult<SchedulerStatus, Error> {
  return useQuery({
    queryKey: keys.scheduler,
    queryFn: async () => unwrap(await api.api.scheduler.get()),
    // The next pass is a moving target; a stale "in 4 minutes" is a lie by 3.
    refetchInterval: 15_000,
  });
}

/** ⚠️ 409 when a pass is already in flight — the server refuses to start a second. */
export function useRunScheduler() {
  const client = useQueryClient();
  return useMutation<PassResult, Error, void>({
    mutationFn: async () => unwrap(await api.api.scheduler.run.post()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.scheduler });
      void client.invalidateQueries({ queryKey: keys.sources });
      void client.invalidateQueries({ queryKey: keys.jobs });
    },
  });
}
