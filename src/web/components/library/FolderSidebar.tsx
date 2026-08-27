/**
 * The library's left column: which folder, and how full the disk is.
 *
 * Lifted out of `screens/Library.tsx` because it is the part of that screen
 * with no relationship to anything else on it — it reads two queries of its
 * own and reports one choice back — and because the screen had grown past the
 * size at which a person can hold it in their head.
 *
 * ⚠️ Its two queries are its own rather than props. Both are shared cache
 * entries (`keys.destinations`, `keys.storage`), so asking for them here costs
 * nothing extra and keeps the folder list from being something the screen has
 * to fetch on its behalf.
 */
import { Folder, FolderOpen } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatBytes, splitPath } from "../../data/format";
import { useDestinations } from "../../data/queries";
import { useStorage } from "../../data/stats";
import { UsageBar } from "../common/Bits";

export function FolderSidebar({
  folder,
  onFolder,
}: {
  /** The selected folder, or `undefined` for everything. */
  folder: string | undefined;
  onFolder(next: string | undefined): void;
}) {
  const folders = useDestinations();
  const storage = useStorage();

  return (
    <aside className="min-w-0 space-y-4">
      <Card className="p-0">
        <CardHeader className="px-3 pt-3 pb-2">
          <CardTitle className="text-sm">Folders</CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <ul className="space-y-0.5">
            <li>
              <button
                type="button"
                onClick={() => onFolder(undefined)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  folder === undefined ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                <FolderOpen className="size-4 shrink-0" aria-hidden />
                <span className="truncate">All media</span>
              </button>
            </li>
            {(folders.data?.folders ?? []).map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() => onFolder(entry.path)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                    folder === entry.path ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                  )}
                  style={{ paddingLeft: `${0.5 + entry.depth * 0.6}rem` }}
                >
                  <Folder className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{splitPath(entry.path).name}</span>
                </button>
              </li>
            ))}
          </ul>
          {/* ⚠️ A dead mount is the normal Tuesday here, and it must not take
              the screen with it: the folder list simply says it is missing and
              the search box still works. */}
          {folders.isError ? (
            <p className="px-2 pt-2 text-xs text-muted-foreground">
              The folder list is unavailable; search still works.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {storage.data?.library.available ? (
        <Card className="p-0">
          <CardHeader className="px-3 pt-3 pb-2">
            <CardTitle className="text-sm">Storage</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <UsageBar usedPercent={storage.data.library.usedPercent} />
            <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              {formatBytes(storage.data.library.usedBytes)} of {formatBytes(storage.data.library.totalBytes)}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </aside>
  );
}
