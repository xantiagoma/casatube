/**
 * The bell.
 *
 * 🔴 Persisted, not ephemeral. A toast that fired while the tab was closed
 * never happened; these are rows, and they are still here on the next load
 * (PLAN §15). The count comes from the table rather than from the page being
 * shown, so "3" never means "3 of the thirty waiting".
 */
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, Trash2, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatRelative } from "../../data/format";
import {
  useClearRead,
  useDismissNotification,
  useMarkAllRead,
  useMarkRead,
  useNotifications,
} from "../../data/notifications";

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
  const dismiss = useDismissNotification();
  const clearRead = useClearRead();

  const unread = list.data?.unreadCount ?? 0;
  const items = list.data?.notifications ?? [];
  const read = items.length - items.filter((item) => !item.readAt).length;

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
        <div className="flex flex-wrap items-center justify-between gap-1 border-b px-3 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          <div className="ml-auto flex items-center gap-0.5">
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
            {/* ⚠️ Bounded by *read*, not by age. After dealing with forty
                notifications what is wanted is an empty list, and "older than
                30 days" is not that — while an unread row is the only one still
                doing a job, so it stays. */}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={read === 0 || clearRead.isPending}
              onClick={() => clearRead.mutate()}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Clear read
            </Button>
          </div>
        </div>

        <ScrollArea viewportClassName="max-h-96">
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
                  /*
                   * ⚠️ The row is a `<div>` with **two** buttons side by side,
                   * not one button with another inside it. Nesting them is
                   * invalid HTML and, in practice, a hit target inside a hit
                   * target where the outer one swallows the tap — the same
                   * reason the library's selection tick is a `<span>`.
                   */
                  <li
                    key={item.id}
                    className={cn(
                      "group/row flex items-start gap-1 transition-colors hover:bg-accent/50",
                      !item.readAt && "bg-primary/5",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!item.readAt) markRead.mutate(item.id);
                      }}
                      className="flex min-w-0 flex-1 gap-2.5 py-2.5 pl-3 text-left"
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
                    {/* 🔴 Always in the layout, never revealed by hover alone:
                        on a touch screen there is no hover, and a control that
                        only exists under a pointer does not exist on the iPad
                        this is read on. Hover only changes how loud it is. */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="mt-1.5 mr-1 size-7 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/row:opacity-100 hover:text-destructive focus-visible:opacity-100"
                      aria-label={`Dismiss “${item.title}”`}
                      disabled={dismiss.isPending && dismiss.variables === item.id}
                      onClick={() => dismiss.mutate(item.id)}
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
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
