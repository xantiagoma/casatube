/**
 * Settings.
 *
 * 🔴 **The configuration is editable, and every control says what it is really
 * doing.** `GET/PUT/DELETE /api/settings` resolves each of the twenty-five
 * settings through one rule — **user override > environment variable > code
 * default** — and reports which of the three won. So each row names its
 * environment variable *whether or not anything sets it* (the question this
 * screen could not answer before), says where the current value came from,
 * offers a reset that names the layer underneath, and refuses to pretend:
 *
 * - a variable the server could not read is shown as **ignored** rather than
 *   silently falling through to the default;
 * - a write to one of the eighteen restart-scoped settings is shown as
 *   **stored and not in force**, next to the value the process is really using;
 * - the two settings that cannot be overridden at all (`DATA_DIR`, the cookies
 *   file) are shown with the reason, not hidden.
 *
 * The rows and the sentences live in `components/settings/` — `SettingRow` for
 * one setting, `SettingsGroupCard` for a group, `setting-view.ts` for the
 * wording, which is where it can be tested without a browser.
 *
 * What else is editable here is editable because a real endpoint backs it: the
 * **credentials** (`POST`/`DELETE /api/credentials`, one-way — a secret goes in
 * and no route can send one back), the plugin toggles (`POST /api/plugins/:name/enable`), **the plugins themselves**
 * — source and settings, `PUT /api/plugins/source` and
 * `PUT /api/plugins/:name/settings`, each of which reloads the runtime — the
 * notification purge (`DELETE /api/notifications`), and the theme, which
 * belongs to this browser.
 *
 * ⚠️ **Authentication is shown and disabled on purpose.** PLAN §18 defers it as
 * a decision, not an oversight: anyone on the LAN can enqueue downloads and
 * browse the library, and that stops being acceptable the moment CasaTube is
 * exposed beyond it. Hiding the section would hide the decision.
 */
import { useEffect, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import {
  BookOpen,
  CircleAlert,
  Download,
  FilePlus2,
  FolderOpen,
  Info,
  Lock,
  Monitor,
  Moon,
  Pencil,
  Puzzle,
  Settings2,
  Sun,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState } from "../components/common/Bits";
import { PageHeader } from "../components/layout/AppShell";
import { CredentialsCard } from "../components/settings/CredentialsCard";
import { PluginEditorDialog } from "../components/settings/PluginEditorDialog";
import { PluginSettingsDialog } from "../components/settings/PluginSettingsDialog";
import { RestartBanner, SettingsGroupCard } from "../components/settings/SettingsGroupCard";
import { formatBytes, formatDateTime } from "../data/format";
import { useTrash } from "../data/library";
import { usePurgeNotifications } from "../data/notifications";
import { PLUGIN_TEMPLATE_URL, usePluginDocs, usePlugins, useTogglePlugin } from "../data/plugins";
import { useSettings } from "../data/settings";
import { useHealth, useStorage } from "../data/stats";
import { useTheme, type ThemeChoice } from "../data/theme";
import type { SettingGroupId } from "../../core/app-settings";
import type { SettingsSection } from "../search-params";

/** A read-only field, with the reason it is read-only attached once per card. */
function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {/* ⚠️ `break-all`, not `truncate`, and it is a layout fix rather than a
          taste one: a filesystem path is a single unbreakable word, and inside a
          **wrapping** flex row Chrome gives such an item a min-content
          contribution of its whole width — `min-w-0` and `flex-1` together do
          not stop it (measured: the row's min-content stayed 785 px). One long
          library path was therefore making the entire Settings grid 1095 px wide
          inside an 820 px iPad. Letting the text break collapses that to one
          character, and it also means the whole path is readable rather than
          cut off. */}
      <span className="min-w-0 flex-1 text-right font-mono text-xs font-medium break-all">{value}</span>
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
 * What a job gets when nothing else is said — now a form.
 *
 * 🔴 This card used to print seven values and a sentence explaining that no
 * endpoint could write them back. That was true when it was written and stopped
 * being true the same day: `downloads.*` is the one **live** group, so a value
 * saved here is in force for the very next job, with no restart and nothing to
 * reload. The rows are `SettingRow`s like every other group; only the footnote
 * below is particular to this one.
 *
 * ⚠️ The codec note stays, and stays *here*: "no H.264 above 1080p" is a fact
 * about one video and this screen is looking at none, so the caveat that belongs
 * on an analyzed URL is not repeated on a default.
 */
function DefaultsFootnote() {
  return (
    <ServerOwned>
      These are the starting point, not a cage: the download form sends whatever it is showing, so a per-download
      choice still wins. Audio and subtitle languages stay independent, and the codec is a preselection — a
      named one gives up resolution rather than being swapped for another codec behind your back.
    </ServerOwned>
  );
}

/**
 * Where the files actually are, and what is in the bin.
 *
 * ⚠️ This is deliberately **not** the settings for those paths — those are rows
 * in the Server and Library cards, with their variables and their reset buttons.
 * What is here is the running state: the path the process is really using (which
 * differs from the stored one until a restart) and how much is sitting in the
 * trash, neither of which is a setting at all.
 */
function PathsCard() {
  const storage = useStorage();
  const trash = useTrash();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Storage in use</CardTitle>
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
          What the running process is using, which is the point: change{" "}
          <code>LIBRARY_DIR</code>, <code>TEMP_DIR</code> or <code>TRASH_RETENTION_DAYS</code> in the cards above
          and these keep showing the old paths until a restart — that disagreement is the honest one.
        </ServerOwned>
      </CardContent>
    </Card>
  );
}

/**
 * How to write the first one.
 *
 * 🔴 "No plugins installed" was the whole screen, and it is the one state where
 * the screen has something to teach: a plugin is a file in a directory, and
 * every part of that sentence — which file, which directory, what has to be in
 * it — was missing. The three answers are here, in the order they are needed,
 * and none of them is a link off to somewhere that might not exist.
 *
 * It shows below the list as well as instead of it: the second plugin is
 * written the same way as the first.
 */
function PluginStart({ dir, onNew }: { dir: string; onNew: () => void }) {
  const [reading, setReading] = useState(false);
  const docs = usePluginDocs(reading);
  const where = dir === "" ? "DATA_DIR/plugins" : dir;

  return (
    <div className="rounded-lg border border-dashed p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Puzzle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        Writing one
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        A plugin is <strong>one TypeScript file</strong>. Bun runs it directly — no build step, no
        <code className="mx-1">npm install</code>. It declares what it matches and where it hooks in, and that
        declaration is read before any of its code runs.
      </p>

      <ol className="mt-3 space-y-2.5 text-xs">
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold">
            1
          </span>
          <span className="text-muted-foreground">Write one here, starting from the annotated template</span>
          <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={onNew}>
            <FilePlus2 className="size-3.5" aria-hidden />
            New plugin
          </Button>
        </li>

        <li className="flex items-start gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold">
            2
          </span>
          <span className="text-muted-foreground">
            Save. The file is written and the runtime <strong>reloads</strong> — no restart. A plugin the server
            has not seen before arrives <strong>enabled</strong>, so its <code>setup</code> runs immediately and
            the switch here is what turns it off. A file that does not compile comes back as an{" "}
            <code>error</code> row with the reason, and nothing else stops working.
          </span>
        </li>

        <li className="flex items-start gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold">
            3
          </span>
          <span className="min-w-0">
            <span className="text-muted-foreground">
              Or put the file there yourself — the editor is a convenience, not the only way in:
            </span>
            <span className="mt-1 flex items-start gap-1.5">
              <FolderOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <code className="min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all">
                {where}/my-plugin.ts
              </code>
            </span>
            {/* An anchor with `download`, not a fetch: the browser saves it, and
                the server's Content-Disposition gives it its name. */}
            <Button asChild size="sm" variant="ghost" className="mt-1 h-7 gap-1.5">
              <a href={PLUGIN_TEMPLATE_URL} download="casatube-plugin.ts">
                <Download className="size-3.5" aria-hidden />
                Download casatube-plugin.ts
              </a>
            </Button>
          </span>
        </li>
      </ol>

      <Button size="sm" variant="ghost" className="mt-3 gap-1.5" onClick={() => setReading(true)}>
        <BookOpen className="size-3.5" aria-hidden />
        Read the documentation
      </Button>

      <Dialog open={reading} onOpenChange={setReading}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Writing a CasaTube plugin</DialogTitle>
            <DialogDescription>
              The manifest, the hook points, and what <code>setup</code> is handed. Served by the server itself, so
              it matches the version you are running.
            </DialogDescription>
          </DialogHeader>
          {docs.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : docs.isError ? (
            <ErrorState error={docs.error} what="The documentation" retry={() => void docs.refetch()} />
          ) : (
            <div className="scrollbar-thin max-h-[60vh] overflow-y-auto rounded-lg bg-foreground/[0.04] p-3 dark:bg-black/40">
              <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{docs.data.markdown}</pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The installed plugins, and everything that can be done to one from here.
 *
 * 🔴 The row shows `missingSettings` as a warning of its own. A plugin sitting
 * there marked `active` while doing nothing because a token was never set looks
 * exactly like one that is working — which is the silence this whole screen
 * exists to break.
 */
function PluginsCard() {
  const plugins = usePlugins();
  const toggle = useTogglePlugin();
  /** `undefined` = closed, `null` = a new file, a string = that file. */
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [configuring, setConfiguring] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Plugins</CardTitle>
        <p className="text-sm text-muted-foreground">
          Each one declares what it matches, where it hooks in and what it needs configured — and that declaration
          is readable before any of its code runs.
        </p>
        <CardAction>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing(null)}>
            <FilePlus2 className="size-3.5" aria-hidden />
            New
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {plugins.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : plugins.isError ? (
          <ErrorState error={plugins.error} what="Plugins" retry={() => void plugins.refetch()} />
        ) : plugins.data.plugins.length === 0 ? (
          <div className="space-y-4">
            <EmptyState
              icon={<Puzzle className="size-6" aria-hidden />}
              title="No plugins installed"
              hint="Nothing is hooked into the pipeline. Here is how to change that."
            />
            <PluginStart dir={plugins.data.dir} onNew={() => setEditing(null)} />
          </div>
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
                  {plugin.missingSettings.length > 0 ? (
                    <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                      Loaded, and doing nothing: {plugin.missingSettings.join(", ")} {plugin.missingSettings.length === 1 ? "is" : "are"} not set.
                    </p>
                  ) : null}

                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 px-2 text-xs"
                      onClick={() => setEditing(plugin.file)}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                      Edit
                    </Button>
                    {plugin.settings && plugin.settings.length > 0 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 px-2 text-xs"
                        onClick={() => setConfiguring(plugin.name)}
                      >
                        <Settings2 className="size-3.5" aria-hidden />
                        Settings
                      </Button>
                    ) : null}
                  </div>
                </div>

                <Switch
                  checked={plugin.enabled}
                  aria-label={`${plugin.name} enabled`}
                  /* A file that failed to import cannot be switched on — the
                     server answers 409 — so the switch says so rather than
                     offering an action that is refused. */
                  disabled={toggle.isPending || plugin.state === "error"}
                  onCheckedChange={(next) => toggle.mutate({ name: plugin.name, enabled: next })}
                />
              </li>
            ))}
          </ul>
        )}
        {!plugins.isPending && !plugins.isError && plugins.data.plugins.length > 0 ? (
          <div className="mt-4">
            <PluginStart dir={plugins.data.dir} onNew={() => setEditing(null)} />
          </div>
        ) : null}
        {toggle.isError ? <p className="mt-2 text-xs text-destructive">{toggle.error.message}</p> : null}
      </CardContent>

      <PluginEditorDialog
        open={editing !== undefined}
        onOpenChange={(open) => setEditing(open ? (editing ?? null) : undefined)}
        file={editing ?? null}
      />
      <PluginSettingsDialog
        open={configuring !== null}
        onOpenChange={(open) => setConfiguring(open ? configuring : null)}
        name={configuring}
      />
    </Card>
  );
}

function NotificationsCard() {
  const purge = usePurgeNotifications();
  const [days, setDays] = useState(30);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Clear notifications now</CardTitle>
        <p className="text-sm text-muted-foreground">
          Notifications are rows in the database, so one that fires while the tab is closed is still there when it
          opens. A sweep already removes old ones every six hours — this is the same broom, held by hand.
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
            <strong>Anyone who can reach this port can enqueue downloads, browse the library and edit plugins.</strong>{" "}
            CasaTube has no login of its own. That is fine on a private network or a VPN; anywhere else, put
            something in front of it —{" "}
            <a
              href="https://github.com/xantiagoma/casatube/blob/main/docs/SECURING.md"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Tailscale, Cloudflare Access or an authenticating proxy
            </a>
            . This section is shown, and disabled, so that stays visible.
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

/**
 * The whole configuration, fetched once.
 *
 * 🔴 **One query for twenty-five settings, and one banner over all of them.**
 * `restartPending` and the merged download preferences are facts about the
 * *set*, so the snapshot is read here and the groups are handed rows — six
 * cards asking six times would each know only about themselves, and the
 * "two changes are waiting" line could not be written at all.
 */
/**
 * Where each `?section=` lands.
 *
 * 🔴 The router validated `section` and nothing read it, so "Configure in
 * Settings → Plugins" opened the page at the top with Plugins a long scroll
 * away in the third column. Each section is now an anchor, and arriving with
 * one scrolls to it.
 */
function useScrollToSection(section: SettingsSection | undefined, ready: boolean): void {
  useEffect(() => {
    if (section === undefined || !ready) return;
    document.getElementById(`settings-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [section, ready]);
}

/** An anchor for `?section=`, offset so the sticky header does not cover it. */
function Anchor({ section, children }: { section: SettingsSection; children: React.ReactNode }) {
  return (
    <div id={`settings-${section}`} className="scroll-mt-20">
      {children}
    </div>
  );
}

export function Settings() {
  const { section } = useSearch({ from: "/settings" });
  const settings = useSettings();
  const snapshot = settings.data ?? null;
  const rows = snapshot?.settings ?? [];

  /** A group card, when the server has told us that group exists. */
  const groupCard = (id: SettingGroupId, footer?: React.ReactNode) => {
    const group = snapshot?.groups.find((candidate) => candidate.id === id);
    return group ? <SettingsGroupCard group={group} settings={rows} footer={footer} /> : null;
  };

  useScrollToSection(section, !settings.isPending);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Every value, where it comes from, and what changing it actually does."
      />

      {settings.isError ? (
        <div className="mb-4">
          <ErrorState error={settings.error} what="The settings" retry={() => void settings.refetch()} />
        </div>
      ) : null}
      <RestartBanner settings={rows} />

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-4">
          {settings.isPending ? (
            <Card>
              <CardContent>
                <p className="text-sm text-muted-foreground">Loading the configuration…</p>
              </CardContent>
            </Card>
          ) : null}
          <Anchor section="downloads">{groupCard("downloads", <DefaultsFootnote />)}</Anchor>
          {groupCard("server")}
          {groupCard("library")}
        </div>
        <div className="space-y-4">
          {groupCard("playback")}
          {groupCard("thumbnails")}
          <Anchor section="storage">
            <PathsCard />
          </Anchor>
          <Anchor section="notifications">
            <div className="space-y-4">
              {groupCard("notifications")}
              <NotificationsCard />
            </div>
          </Anchor>
        </div>
        <div className="space-y-4">
          <Anchor section="general">
            <div className="space-y-4">
              <ThemeCard />
              <SystemCard />
            </div>
          </Anchor>
          <Anchor section="security">
            <CredentialsCard />
          </Anchor>
          <Anchor section="plugins">
            <PluginsCard />
          </Anchor>
          <AuthCard />
        </div>
      </div>
    </>
  );
}
