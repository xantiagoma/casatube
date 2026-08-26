/**
 * The frame every screen sits in: rail, header, content.
 *
 * The connection indicator in the header is the one piece of chrome that is
 * load-bearing rather than decorative. When the SSE stream drops, the queue
 * keeps rendering from the React Query cache and polling takes over — that is
 * correct, and it is also indistinguishable from "live" unless something says
 * so. This says so.
 */
import { useState, type ReactNode } from "react";
import { Outlet } from "@tanstack/react-router";
import { Menu, Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useHealth } from "../../data/stats";
import { useTheme } from "../../data/theme";
import { useJobStream, type ConnectionState } from "../../data/stream";
import { NotificationBell } from "./NotificationBell";
import { SidebarContent } from "./Sidebar";

const CONNECTION: Record<ConnectionState, { label: string; dot: string; hint: string }> = {
  connecting: {
    label: "Connecting",
    dot: "bg-warning",
    hint: "Opening the event stream. The queue is already safe on the server.",
  },
  live: {
    label: "Live",
    dot: "bg-success",
    hint: "The server is pushing queue updates as they happen.",
  },
  reconnecting: {
    label: "Reconnecting",
    dot: "bg-warning animate-pulse",
    hint: "The stream dropped, so the queue is being polled instead. Nothing was lost — jobs run on the server.",
  },
};

function ThemeToggle() {
  const { choice, cycle } = useTheme();
  const Icon = choice === "system" ? Monitor : choice === "light" ? Sun : Moon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={cycle} aria-label={`Theme: ${choice}`}>
          <Icon className="size-4.5" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Theme: {choice}</TooltipContent>
    </Tooltip>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const stream = useJobStream();
  const health = useHealth();
  const connection = CONNECTION[stream.connection];
  const online = health.isSuccess;

  return (
    <div className="flex min-h-dvh bg-background">
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 border-r transition-[width] duration-200 md:block",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <SidebarContent
          collapsed={collapsed}
          onCollapse={() => setCollapsed(true)}
          version={health.data?.version}
        />
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute bottom-3 left-1/2 size-8 -translate-x-1/2"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
          >
            <Menu className="size-4" aria-hidden />
          </Button>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-md sm:px-5">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                <Menu className="size-5" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SidebarContent onNavigate={() => setMobileOpen(false)} version={health.data?.version} />
            </SheetContent>
          </Sheet>

          <div className="flex-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hidden items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium sm:inline-flex">
                <span className={cn("size-1.5 rounded-full", online ? connection.dot : "bg-destructive")} />
                {online ? connection.label : "Server offline"}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {online ? connection.hint : "The server is not answering. Jobs are unaffected — they live on it, not here."}
            </TooltipContent>
          </Tooltip>

          <NotificationBell />
          <ThemeToggle />
        </header>

        <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-4 sm:px-5 sm:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
