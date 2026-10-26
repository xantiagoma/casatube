/**
 * The navigation rail from the reference design.
 *
 * On a phone or a narrow iPad it becomes a sheet rather than shrinking into
 * something unreadable — PLAN §8 says the dense panels may degrade to
 * full-screen views, and the sidebar is the first of them.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import {
  CalendarClock,
  ChevronLeft,
  Download,
  HardDrive,
  LayoutGrid,
  Library as LibraryIcon,
  ListVideo,
  Rss,
  Settings as SettingsIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import icon from "../../assets/icon-192.png";

interface Item {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  /** Also light up for these prefixes. */
  match?: string;
}

interface Group {
  title: string;
  items: Item[];
}

export const NAV: Group[] = [
  {
    title: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutGrid },
      { to: "/downloads", label: "Downloads", icon: Download },
      { to: "/queue", label: "Queue", icon: ListVideo },
    ],
  },
  {
    title: "Library",
    items: [{ to: "/library", label: "Library", icon: LibraryIcon }],
  },
  {
    title: "Automation",
    items: [
      { to: "/sources", label: "Sources", icon: Rss },
      { to: "/scheduler", label: "Scheduler", icon: CalendarClock },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/storage", label: "Storage", icon: HardDrive },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

export function SidebarContent({
  collapsed = false,
  onNavigate,
  onCollapse,
  version,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
  onCollapse?: () => void;
  version?: string;
}) {
  const path = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn("flex items-center gap-2.5 px-4 py-4", collapsed && "justify-center px-2")}>
        {/* The app icon itself, so the sidebar, the browser tab and the
            CasaOS tile are the same mark. Decorative: the name sits beside it. */}
        <img src={icon} alt="" width={36} height={36} className="size-9 shrink-0" />
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-foreground">CasaTube</span>
            <span className="block truncate text-xs text-muted-foreground">Media Downloader</span>
          </span>
        )}
        {!collapsed && onCollapse ? (
          <Button
            variant="ghost"
            size="icon"
            className="hidden size-7 shrink-0 lg:inline-flex"
            onClick={onCollapse}
            aria-label="Collapse sidebar"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-4">
        {NAV.map((group) => (
          <div key={group.title} className="mb-4">
            {!collapsed && (
              <p className="px-3 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {group.title}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      onClick={onNavigate}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        collapsed && "justify-center px-2",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4.5 shrink-0" aria-hidden />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {!collapsed && (
        <div className="border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">
            CasaTube {version ? `v${version}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
