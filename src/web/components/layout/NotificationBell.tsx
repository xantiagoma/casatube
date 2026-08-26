/**
 * The bell.
 *
 * 🔴 Persisted, not ephemeral. A toast that fired while the tab was closed
 * never happened; these are rows, and they are still here on the next load
 * (PLAN §15). The count comes from the table rather than from the page being
 * shown, so "3" never means "3 of the thirty waiting".
 */
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatRelative } from "../../data/format";
import { useMarkAllRead, useMarkRead, useNotifications } from "../../data/notifications";

const ICON = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
} as const;

const TONE = {
  info: "text-primary",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
} as const;

type Level = keyof typeof ICON;

export function NotificationBell() {
  const list = useNotifications(false, 50);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const unread = list.data?.unreadCount ?? 0;
  const items = list.data?.notifications ?? [];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications (${unread} unread)`}>
          <Bell className="size-4.5" aria-hidden />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid min-w-4.5 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-4.5 font-semibold text-destructive-foreground tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={unread === 0 || markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            <CheckCheck className="size-3.5" aria-hidden />
            Mark all read
          </Button>
        </div>

        <ScrollArea className="max-h-96">
          {list.isError ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              The notification list could not be loaded.
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Nothing yet. Finished and failed jobs report here.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((item) => {
                const level = (item.level in ICON ? item.level : "info") as Level;
                const Icon = ICON[level];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!item.readAt) markRead.mutate(item.id);
                      }}
                      className={cn(
                        "flex w-full gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/50",
                        !item.readAt && "bg-primary/5",
                      )}
                    >
                      <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[level])} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className={cn("truncate text-sm", item.readAt ? "font-normal" : "font-medium")}>
                            {item.title}
                          </span>
                          {!item.readAt && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                        </span>
                        {item.body ? (
                          <span className="mt-0.5 block text-xs break-words text-muted-foreground">{item.body}</span>
                        ) : null}
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {formatRelative(item.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
