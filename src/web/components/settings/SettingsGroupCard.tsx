/**
 * A group of settings as one card, and the banner that counts what is waiting.
 *
 * The five groups come from the server with the settings (`SETTING_GROUPS`), so
 * a group added to the catalogue appears here without this file being touched —
 * and, more to the point, the sentence explaining *when a change takes effect*
 * travels with the group instead of being re-typed on the screen where it can
 * quietly stop matching the code.
 *
 * 🔴 **`restartPending` is a fact about the whole set**, which is why the banner
 * takes the list rather than living inside a row. "Two changes are waiting for a
 * restart" cannot be assembled from components that each only know about
 * themselves — and a stored change nobody knows is stored is the same silence as
 * a control that does nothing.
 */
import { RotateCw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ResolvedSetting, SettingGroup } from "../../../core/app-settings";
import { SettingRow } from "./SettingRow";
import { displayValue, pendingSettings, settingsOf } from "./setting-view";

export function SettingsGroupCard({
  group,
  settings,
  footer,
}: {
  group: SettingGroup;
  settings: readonly ResolvedSetting[];
  footer?: React.ReactNode;
}) {
  const rows = settingsOf(settings, group.id);
  if (rows.length === 0) return null;

  return (
    <Card>
      {/* ⚠️ `CardHeader` is a grid, so the description is a second row rather
          than a flex sibling — see docs/DISCOVERIES.md. */}
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{group.label}</CardTitle>
        <p className="text-sm text-muted-foreground">{group.description}</p>
      </CardHeader>
      <CardContent>
        {rows.map((setting) => (
          <SettingRow key={setting.key} setting={setting} />
        ))}
        {footer}
      </CardContent>
    </Card>
  );
}

/**
 * What is stored, what is running, and the fact that they disagree.
 *
 * There is no restart button and there is not going to be one: the process
 * cannot restart itself into a new port from inside the request that asked, and
 * a button that pretended to would be the failure mode this screen exists to
 * remove. It names the container instead, which is the thing that really does
 * it.
 */
export function RestartBanner({ settings }: { settings: readonly ResolvedSetting[] }) {
  const pending = pendingSettings(settings);
  if (pending.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-warning/30 bg-warning/10 p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-warning">
        <RotateCw className="size-4 shrink-0" aria-hidden />
        {pending.length === 1
          ? "One change is saved and not in force yet."
          : `${pending.length} changes are saved and not in force yet.`}
      </p>
      <ul className="mt-1.5 space-y-0.5 text-xs break-words text-warning">
        {pending.map((setting) => (
          <li key={setting.key}>
            <strong>{setting.label}</strong> — running {displayValue(setting, setting.runningValue)}, stored{" "}
            {displayValue(setting, setting.value)}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Restart CasaTube to apply them (<code className="font-mono">docker compose restart</code>, or however this
        server is started). Nothing is lost by waiting: the values are stored, and the queue is unaffected.
      </p>
    </div>
  );
}
