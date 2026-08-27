/**
 * Settings.
 *
 * 🔴 **Most of this screen is read-only, and that is the honest rendering of
 * the system rather than an unfinished form.** PLAN §12 puts server
 * configuration in the environment: paths, the cookies file, the poll interval
 * and the download defaults are read at boot, and there is no endpoint that
 * writes them back. A form that pretended otherwise would be a control that
 * silently does nothing — the failure mode this project exists to avoid.
 *
 * What *is* editable here is editable because a real endpoint backs it: the
 * plugin toggles (`POST /api/plugins/:name/enable`), the notification purge
 * (`DELETE /api/notifications`), and the theme, which belongs to this browser.
 *
 * ⚠️ **Authentication is shown and disabled on purpose.** PLAN §18 defers it as
 * a decision, not an oversight: anyone on the LAN can enqueue downloads and
 * browse the library, and that stops being acceptable the moment CasaTube is
 * exposed beyond it. Hiding the section would hide the decision.
 */
import { useState } from "react";
import {
  CircleAlert,
  Info,
  Lock,
  Monitor,
  Moon,
  Puzzle,
  Sun,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState } from "../components/common/Bits";
import { PageHeader } from "../components/layout/AppShell";
import { formatBytes, formatDateTime } from "../data/format";
import { useTrash } from "../data/library";
import { usePurgeNotifications } from "../data/notifications";
import { usePlugins, useTogglePlugin } from "../data/plugins";
import { useJobDefaults } from "../data/queries";
import { useHealth, useStorage } from "../data/stats";
import { useTheme, type ThemeChoice } from "../data/theme";
import type { VideoCodecPreference } from "../../core/types";

/** A read-only field, with the reason it is read-only attached once per card. */
function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs font-medium">{value}</span>
    </div>
  );
}

function ServerOwned({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 flex items-start gap-1.5 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Static: rebuilding three objects on every render buys nothing. */
const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function ThemeCard() {
  const { choice, resolved, set } = useTheme();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Appearance</CardTitle>
      </CardHeader>
      <CardContent>
        <Label className="mb-2 block">Theme</Label>
        <div className="flex overflow-hidden rounded-lg border">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => set(option.value)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
                  choice === option.value ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Currently rendering {resolved}. “System” follows the device, including when it switches at sunset.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The default codec preference, in the same words the download form uses.
 *
 * ⚠️ No caveat here, and that is not an omission: "no H.264 above 1080p" is a
 * fact about one video, and this screen is looking at no video at all. The
 * caveat belongs where a URL has been analyzed.
 */
const CODEC_LABELS: Record<VideoCodecPreference, string> = {
  auto: "auto — H.264 first, direct play on most TVs",
  efficient: "efficient — AV1/VP9 first, smaller files, may transcode",
  h264: "H.264 — direct play on most TVs",
  vp9: "VP9 — smaller than H.264, widely supported",
  hevc: "HEVC — small, decoders are uneven",
  av1: "AV1 — smallest files, may transcode without a GPU",
};

function DefaultsCard() {
  const defaults = useJobDefaults();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Download defaults</CardTitle>
      </CardHeader>
      <CardContent>
        {defaults.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : defaults.isError ? (
          <ErrorState error={defaults.error} what="Defaults" retry={() => void defaults.refetch()} />
        ) : (
          <>
            <div className="divide-y">
              <ReadOnly label="Maximum resolution" value={`${defaults.data.resolved.maxResolution}p`} />
              <ReadOnly
                label="Video codec"
                value={CODEC_LABELS[defaults.data.resolved.videoCodec] ?? defaults.data.resolved.videoCodec}
              />
              <ReadOnly label="Original audio only" value={String(defaults.data.resolved.originalOnly)} />
              <ReadOnly
                label="Audio languages"
                value={defaults.data.resolved.audioLanguages.join(", ") || "whatever the source calls original"}
              />
              <ReadOnly
                label="Subtitle languages"
                value={defaults.data.resolved.subtitleLanguages.join(", ") || "none"}
              />
              <ReadOnly label="Subtitles" value={defaults.data.resolved.embedSubtitles ? "embedded" : "sidecar files"} />
              <ReadOnly label="SponsorBlock" value={String(defaults.data.resolved.sponsorblock)} />
            </div>
            <ServerOwned>
              These are what a job gets when the form sends nothing. They come from the server and there is no
              endpoint that writes them back — change them per download in the form, which does travel with the
              job. Audio and subtitle languages stay independent (R7), and the codec is a preselection: a named
              one gives up resolution rather than being swapped for another codec behind your back.
            </ServerOwned>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PathsCard() {
  const storage = useStorage();
  const trash = useTrash();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Storage paths</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          <ReadOnly label="Library" value={storage.data?.library.path ?? "…"} />
          <ReadOnly label="Temp" value={storage.data?.temp.path ?? "…"} />
          <ReadOnly
            label="Trash retention"
            value={trash.data ? `${trash.data.retentionDays} day(s)` : "…"}
          />
          <ReadOnly
            label="In the trash"
            value={trash.data ? `${trash.data.entries.length} item(s) · ${formatBytes(trash.data.bytes)}` : "…"}
          />
        </div>
        <ServerOwned>
          Paths come from the environment at boot (PLAN §12): <code>LIBRARY_DIR</code>, <code>TEMP_DIR</code>,{" "}
          <code>TRASH_RETENTION_DAYS</code>. Changing one is a restart, not a form.
        </ServerOwned>
      </CardContent>
    </Card>
  );
}

function PluginsCard() {
  const plugins = usePlugins();
  const toggle = useTogglePlugin();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Plugins</CardTitle>
        <p className="text-sm text-muted-foreground">
          Each one declares what it matches and where it hooks in, and that declaration is readable before any of
          its code runs.
        </p>
      </CardHeader>
      <CardContent>
        {plugins.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : plugins.isError ? (
          <ErrorState error={plugins.error} what="Plugins" retry={() => void plugins.refetch()} />
        ) : plugins.data.plugins.length === 0 ? (
          <EmptyState
            icon={<Puzzle className="size-6" aria-hidden />}
            title="No plugins installed"
            hint="Drop a plugin file into the data directory's plugins folder and restart."
          />
        ) : (
          <ul className="divide-y">
            {plugins.data.plugins.map((plugin) => (
              <li key={plugin.name} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {plugin.name}
                    <Badge
                      variant="secondary"
                      className={cn(
                        "px-1.5 py-0 text-[10px]",
                        plugin.state === "active" && "bg-success/12 text-success",
                        plugin.state === "error" && "bg-destructive/12 text-destructive",
                      )}
                    >
                      {plugin.state}
                    </Badge>
                    <span className="font-mono text-[10px] text-muted-foreground">{plugin.file}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{plugin.description}</p>

                  {plugin.matches && plugin.matches.length > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Matches: <code>{plugin.matches.join(", ")}</code>
                    </p>
                  ) : null}
                  {plugin.hooks && plugin.hooks.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Hooks: {plugin.hooks.map((hook) => `${hook.at} (${hook.kind})`).join(", ")}
                    </p>
                  ) : null}
                  {plugin.needs && plugin.needs.length > 0 ? (
                    <p className="text-xs text-muted-foreground">Needs: {plugin.needs.join(", ")}</p>
                  ) : null}
                  {plugin.providers.length > 0 ? (
                    <p className="text-xs text-muted-foreground">Providers: {plugin.providers.join(", ")}</p>
                  ) : null}
                  {plugin.error ? (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
                      <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                      {plugin.error}
                    </p>
                  ) : null}
                </div>

                <Switch
                  checked={plugin.enabled}
                  aria-label={`${plugin.name} enabled`}
                  disabled={toggle.isPending}
                  onCheckedChange={(next) => toggle.mutate({ name: plugin.name, enabled: next })}
                />
              </li>
            ))}
          </ul>
        )}
        {toggle.isError ? <p className="mt-2 text-xs text-destructive">{toggle.error.message}</p> : null}
      </CardContent>
    </Card>
  );
}

function NotificationsCard() {
  const purge = usePurgeNotifications();
  const [days, setDays] = useState(30);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Notifications</CardTitle>
        <p className="text-sm text-muted-foreground">
          Notifications are rows in the database, so one that fires while the tab is closed is still there when it
          opens. There is nothing to switch on.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="purge-days">Clear read notifications older than</Label>
            <div className="flex items-center gap-2">
              <Input
                id="purge-days"
                type="number"
                min={0}
                max={3650}
                value={days}
                onChange={(event) => setDays(Math.max(0, Number(event.target.value) || 0))}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
          </div>
          <Button variant="outline" disabled={purge.isPending} onClick={() => purge.mutate({ olderThanDays: days })}>
            Clear
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Unread notifications are never removed by this — the one nobody has read is the only one still doing a
          job.
        </p>
        {purge.data ? (
          <p className="text-xs text-success">
            Removed {purge.data.deleted} notification(s) created before {formatDateTime(purge.data.before)}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SystemCard() {
  const health = useHealth();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">System</CardTitle>
      </CardHeader>
      <CardContent>
        {health.isError ? (
          <p className="text-sm text-destructive">The server is not answering.</p>
        ) : (
          <div className="divide-y">
            <ReadOnly label="Version" value={health.data?.version ?? "…"} />
            <ReadOnly label="Providers" value={health.data?.providers.join(", ") ?? "…"} />
            <ReadOnly label="Open event streams" value={String(health.data?.watchers ?? "…")} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuthCard() {
  return (
    <Card className="border-dashed opacity-90">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="size-4" aria-hidden />
          Authentication
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            Deferred
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <strong>Anyone on this network can enqueue downloads and browse the library.</strong> PLAN §18 defers
            authentication deliberately — it is not a blocker for a self-hosted LAN tool, and it becomes blocking
            the moment CasaTube is reachable from outside. This section is shown, and disabled, so the decision
            stays visible.
          </span>
        </p>

        <fieldset disabled className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium">Require sign-in</span>
              <span className="block text-xs text-muted-foreground">Not implemented.</span>
            </span>
            <Switch checked={false} aria-label="Require sign-in (not implemented)" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auth-user">Username</Label>
            <Input id="auth-user" value="" placeholder="—" readOnly />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auth-key">API key</Label>
            <Input id="auth-key" value="" placeholder="—" readOnly />
          </div>
        </fieldset>
      </CardContent>
    </Card>
  );
}

export function Settings() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="What this browser controls, what the server owns, and what is deliberately not here yet."
      />

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-4">
          <ThemeCard />
          <SystemCard />
          <NotificationsCard />
        </div>
        <div className="space-y-4">
          <DefaultsCard />
          <PathsCard />
        </div>
        <div className="space-y-4">
          <PluginsCard />
          <AuthCard />
        </div>
      </div>
    </>
  );
}
