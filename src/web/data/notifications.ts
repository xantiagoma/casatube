/**
 * The bell.
 *
 * 🔴 Notifications are **rows**, not toasts. A toast that fired while the tab
 * was closed never happened; a row is still there when it opens (PLAN §15).
 * So the bell reads a list, shows an unread count that comes from the *table*
 * rather than from the page it is holding, and marking one read is a request.
 *
 * The list is polled rather than streamed: `GET /api/events` carries queue
 * snapshots and nothing else. Polling a small table every half minute is the
 * right cost for something whose whole point is that it survives.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type { Notification } from "../../core/types";
import { api, unwrap } from "./client";
import { keys } from "./keys";

export interface NotificationListing {
  notifications: Notification[];
  /** From the table, not from this page of it. */
  unreadCount: number;
  at: string;
}

export function useNotifications(unreadOnly = false, limit = 50): UseQueryResult<NotificationListing, Error> {
  return useQuery({
    queryKey: keys.notifications(unreadOnly),
    queryFn: async () =>
      unwrap(await api.api.notifications.get({ query: { limit, ...(unreadOnly ? { unread: true } : {}) } })),
    refetchInterval: 30_000,
  });
}

export function useMarkRead() {
  const client = useQueryClient();
  return useMutation<Notification, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.notifications({ id }).read.post()),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllRead() {
  const client = useQueryClient();
  return useMutation<{ updated: number }, Error, void>({
    mutationFn: async () => unwrap(await api.api.notifications["read-all"].post()),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

/**
 * Dismiss one — `DELETE /api/notifications/:id`.
 *
 * ⚠️ Unread ones included, deliberately. Deciding you do not need a report is
 * the ordinary reason to press the button; the rules that spare unread rows
 * belong to the two *bulk* operations, where "tidy up" must never be able to
 * take the warning nobody has seen.
 */
export function useDismissNotification() {
  const client = useQueryClient();
  return useMutation<Notification, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.notifications({ id }).delete()),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

/** Clear everything already read — `POST /api/notifications/clear-read`. */
export function useClearRead() {
  const client = useQueryClient();
  return useMutation<{ deleted: number }, Error, void>({
    mutationFn: async () => unwrap(await api.api.notifications["clear-read"].post()),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

/**
 * ⚠️ Destructive, and its defaults say so: unread notifications are spared and
 * the cutoff is 30 days unless the caller insists otherwise.
 */
export function usePurgeNotifications() {
  const client = useQueryClient();
  return useMutation<{ deleted: number; before: string }, Error, { olderThanDays?: number; includeUnread?: boolean }>({
    mutationFn: async (options) =>
      unwrap(
        await api.api.notifications.delete(undefined, {
          query: {
            ...(options.olderThanDays !== undefined ? { olderThanDays: options.olderThanDays } : {}),
            ...(options.includeUnread ? { includeUnread: true } : {}),
          },
        }),
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
