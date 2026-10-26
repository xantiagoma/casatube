/**
 * Which plugins would act on the URL that was just analyzed.
 *
 * 🔴 This is the screen PLAN §5 describes and the reason
 * `GET /api/plugins/applicable?url=` exists: *"a plugin is not a black box that
 * quietly runs on everything"*. It declares the hosts it claims, and because
 * `matches` is static metadata the server can answer out of manifests alone —
 * no `setup()`, no hook, no network, no plugin code at all. So asking is free
 * and asking is safe, which is why it happens on analysis rather than behind a
 * button.
 *
 * ## 🔴 The switch turns a plugin off for this download, and only off
 *
 * PLAN §5 wants two things: a **global default** per plugin, and a
 * **per-download override**. Both exist now — Settings drives the first,
 * `POST /api/jobs` carries `pluginsOff` for the second, and the worker
 * dispatches through `runWith(job.pluginsOff, …)`.
 *
 * ⚠️ **There is no per-download "on", and the asymmetry is real rather than
 * unfinished.** A plugin that is off server-wide is never activated: its
 * `setup()` does not run, so it registers no hooks and there is nothing to
 * dispatch to. Drawing that switch would be a control that moves and changes
 * nothing — the failure `docs/DISCOVERIES.md` already records twice
 * (`MAX_CONCURRENT_DOWNLOADS`, `LOG_LEVEL`). So an off plugin shows as off,
 * with the link to the one place that can change it.
 *
 * ⚠️ The list mixes plugins that are **on** with plugins that are **off**:
 * `applicableTo` answers "claims this URL", not "will run". Every row says
 * which, because the difference is the whole point of showing it.
 */
import { Link } from "@tanstack/react-router";
import { Loader2, Plug, Settings2, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Capability, HookDeclaration, HookPoint } from "../../../core/plugins";
import type { PluginStatus } from "../../../core/plugin-runtime";
import { useApplicablePlugins } from "../../data/plugins";

/**
 * What each lifecycle point means, in the words of the thing it affects.
 *
 * The `at` strings are the pipeline's vocabulary (`url:resolve`,
 * `probe:complete`) and they are precise and unreadable. What a person needs to
 * know is *when* it happens and *whether it can change the file they get*.
 */
const WHEN: Record<HookPoint, string> = {
  "url:resolve": "before a provider is chosen",
  "job:queued": "when the job is queued",
  "probe:complete": "after the media is analyzed",
  "download:complete": "when the file finishes downloading",
  "job:completed": "when the job finishes",
  "job:failed": "if the job fails",
};

const TRANSFORMS: Record<HookPoint, string> = {
  "url:resolve": "can rewrite the URL",
  "job:queued": "can change the job",
  "probe:complete": "can change what gets downloaded",
  "download:complete": "can change the outcome",
  "job:completed": "can change the outcome",
  "job:failed": "can change the outcome",
};

/**
 * One hook, as a sentence.
 *
 * 🔴 The `kind` is not decoration and it is the half worth reading. A
 * *transforming* hook is awaited, can replace the value, and **fails the job if
 * it throws**; an *observing* one runs beside the job and can never fail it
 * (PLAN §5). Those are different risks and they are told apart here in words,
 * not in a badge someone has to learn.
 */
/** Everything that makes two declarations different — identity, not decoration. */
function hookId(hook: HookDeclaration): string {
  return `${hook.at}|${hook.kind}|${hook.before ?? ""}|${hook.after ?? ""}`;
}

function hookSentence(hook: HookDeclaration): string {
  const when = WHEN[hook.at] ?? hook.at;
  return hook.kind === "transform"
    ? `${TRANSFORMS[hook.at] ?? "can change the outcome"}, ${when}`
    : `runs ${when}, and cannot fail the download`;
}

/**
 * What a capability lets a plugin reach.
 *
 * ⚠️ Worded as a request, never as a guarantee. PLAN §5 is explicit that this
 * is a UI contract and not a sandbox: only `network` is really withheld today,
 * and an in-process module can import Bun directly whatever it declared. So
 * "asks for" is the honest verb — being able to *see* that a notifier wants
 * only the network, and that something wanting your cookies is worth a second
 * look, is the whole value on offer.
 */
const NEEDS: Record<Capability, string> = {
  network: "the network",
  "library:read": "reading your library",
  "library:write": "writing to your library",
  cookies: "your saved cookies",
  subprocess: "running programs",
};

function PluginRow({
  plugin,
  skipped,
  onSkip,
}: {
  plugin: PluginStatus;
  /** Opted out of, for this download. Meaningless unless the plugin is on. */
  skipped: boolean;
  /** Absent where there is nothing to decide — the queue row, for instance. */
  onSkip?: (skip: boolean) => void;
}) {
  const on = plugin.state === "active";
  const willRun = on && !skipped;
  // ⚠️ Deduplicated, and the composite is also the React key. A manifest may
  // declare the same point twice — `on()` can be called more than once at one
  // moment — and two identical sentences read as two different things
  // happening. The alternative, an array index as the key, is the thing a
  // manifest reload would get wrong.
  const hooks = [...new Map((plugin.hooks ?? []).map((hook) => [hookId(hook), hook])).values()];
  const needs = plugin.needs ?? [];
  const missing = plugin.missingSettings.length > 0;
  const matches = plugin.matches ?? [];
  const claim =
    matches.length === 0
      ? null
      : matches.length > 4
        ? `${matches.slice(0, 4).join(", ")} and ${matches.length - 4} more`
        : matches.join(", ");

  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2.5",
        willRun ? "border-primary/40 bg-primary/5" : "bg-muted/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("text-sm font-medium", !willRun && "text-muted-foreground")}>{plugin.name}</span>
        <Badge
          variant="secondary"
          className={cn(
            "px-1.5 py-0 text-[10px] font-medium",
            willRun ? "bg-success/12 text-success" : "bg-muted text-muted-foreground",
          )}
        >
          {!on
            ? "Off for every download"
            : skipped
              ? "Off for this download"
              : "On — it will run"}
        </Badge>

        {/* 🔴 Only where there is something to decide. A plugin that is off
            server-wide has no hooks registered at all, so a switch offering to
            turn it on for one download would be a switch over nothing — the
            row says where it *can* be turned on instead. */}
        {onSkip && on ? (
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span>Run for this download</span>
            <Switch
              checked={!skipped}
              onCheckedChange={(next) => onSkip(!next)}
              aria-label={`Run ${plugin.name} for this download`}
            />
          </label>
        ) : null}
      </div>

      <p className="mt-0.5 text-xs text-muted-foreground">{plugin.description}</p>

      {/* ⚠️ An **empty** `matches` is not "matches nothing": `manifestMatches`
          reads it as no restriction, which is how the Jellyfin refresh and the
          webhook — plugins about the *result*, not the source — apply to every
          download. Saying "claims this URL" of those would be wrong in a way
          that is impossible to spot from the outside. */}
      <p className="mt-1 text-xs text-muted-foreground">
        {claim === null ? "Applies to every download." : `Claims ${claim}.`}
      </p>

      {hooks.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {hooks.map((hook) => (
            <li key={hookId(hook)} className="text-xs">
              <span className={cn("font-medium", hook.kind === "transform" ? "text-warning" : "text-muted-foreground")}>
                {hook.kind === "transform" ? "Changes" : "Watches"}
              </span>{" "}
              <span className="text-muted-foreground">— {hookSentence(hook)}.</span>
            </li>
          ))}
        </ul>
      ) : null}

      {plugin.providers.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Handles the download itself, as {plugin.providers.join(", ")}.
        </p>
      ) : null}

      {needs.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Asks for {needs.map((need) => NEEDS[need] ?? need).join(", ")}.
        </p>
      ) : null}

      {/* 🔴 An enabled plugin with a required setting missing is *listed as
          active* and does nothing — the exact silence `PluginStatus` carries
          `missingSettings` to break. It matters most here, where someone is
          about to rely on it. */}
      {willRun && missing ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            On, but not configured — {plugin.missingSettings.join(", ")} {plugin.missingSettings.length === 1 ? "has" : "have"}{" "}
            no value, so it will do nothing.
          </span>
        </p>
      ) : null}
    </li>
  );
}

/** Where a plugin is really switched on or off. */
function SettingsLink({ className }: { className?: string }) {
  return (
    <Link
      to="/settings"
      search={{ section: "plugins" }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent",
        className,
      )}
    >
      <Settings2 className="size-3.5" aria-hidden />
      Manage plugins in Settings
    </Link>
  );
}

/**
 * The step in the download panel.
 *
 * ⚠️ It **never fails the form**. This is context, not a decision the download
 * depends on: if the request errors the panel says so in one quiet line and
 * everything else still queues. Analysing is already optional (the worker
 * analyses again anyway); knowing which plugins apply is more optional still.
 */
export function ApplicablePlugins({
  url,
  off,
  onOff,
}: {
  url: string;
  /** Plugin names this download has opted out of. */
  off: readonly string[];
  onOff: (next: string[]) => void;
}) {
  const applicable = useApplicablePlugins(url);

  const toggle = (name: string, skip: boolean): void => {
    const next = new Set(off);
    if (skip) next.add(name);
    else next.delete(name);
    onOff([...next]);
  };

  if (applicable.isPending) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Checking which plugins claim this URL…
      </p>
    );
  }

  if (applicable.isError) {
    return (
      <p className="text-xs text-muted-foreground">
        Could not read the plugin list ({applicable.error.message}). Nothing about the download changes — this panel
        only reports what is installed.
      </p>
    );
  }

  const plugins = applicable.data.plugins;
  const on = plugins.filter((plugin) => plugin.state === "active");
  const running = on.filter((plugin) => !off.includes(plugin.name));

  if (plugins.length === 0) {
    return (
      <div className="space-y-2.5">
        <p className="text-xs text-muted-foreground">
          No installed plugin applies to this download, so it goes straight through the provider. Plugins declare the
          hosts they act on, which is how this can be answered without running any of them.
        </p>
        <SettingsLink />
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <ul className="space-y-2">
        {plugins.map((plugin) => (
          <PluginRow
            key={plugin.name}
            plugin={plugin}
            skipped={off.includes(plugin.name)}
            onSkip={(skip) => toggle(plugin.name, skip)}
          />
        ))}
      </ul>

      <div className="rounded-lg border border-dashed p-3">
        <p className="text-xs font-medium">
          {running.length === 0
            ? "None of these will run for this download."
            : running.length === plugins.length
              ? "All of these will run for this download."
              : `${running.length} of ${plugins.length} will run for this download.`}
        </p>
        {/* 🔴 The asymmetry, said plainly rather than left to be discovered by
            looking for a switch that is not there. */}
        <p className="mt-1 text-xs text-muted-foreground">
          A switch here turns a plugin off for <em>this</em> download only, and the choice is stored on the job — a
          retry next week still respects it. Turning one <em>on</em> is a server-wide setting: a plugin that is off
          was never started, so there are no hooks for one download to reach.
        </p>
        <SettingsLink className="mt-2" />
      </div>
    </div>
  );
}

/**
 * The same fact in one line, for the analyzed row on the card.
 *
 * It exists so the panel is not the only place this is discoverable: the row is
 * what someone sees without opening anything, and "2 plugins run on this
 * download" is the prompt to go and look.
 */
export function ApplicablePluginsBadge({ url }: { url: string }) {
  const applicable = useApplicablePlugins(url);
  const plugins = applicable.data?.plugins ?? [];
  // ⚠️ Only the ones that will *do* something. A fresh install ships Jellyfin and
  // a webhook enabled but unconfigured, and counting those made every plain
  // YouTube link say "2 plugins apply" about two plugins that do nothing. The
  // panel still lists every one, with why it is idle.
  const working = plugins.filter((plugin) => plugin.state === "active" && plugin.missingSettings.length === 0);
  if (working.length === 0) return null;

  return (
    <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Plug className="size-3 shrink-0" aria-hidden />
      {working.length === 1 ? `${working[0]!.name} runs on this download` : `${working.length} plugins run on this download`}
    </span>
  );
}
