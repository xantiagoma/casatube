/**
 * A plugin's configuration, as a form the plugin itself described.
 *
 * `jellyfin.ts` used to read `JELLYFIN_URL` and `JELLYFIN_TOKEN` out of the
 * environment and, when they were absent, log one line and do nothing. Correct,
 * and useless: the only way to learn *which* variables to set was to read the
 * source of a file that was not on the screen. Now the manifest declares them —
 * label, description, secret, default — and this draws the rows.
 *
 * ## The three rules the rows obey
 *
 * 🔴 **A secret's value never arrives from the server**, so it cannot be shown
 * and it cannot be prefilled. The row reports whether one is set and where it
 * came from, and the field is empty until someone types a replacement. Same
 * rule as the cookies file (PLAN §12).
 *
 * 🔴 **Only what was touched is sent.** The body is a patch, and an untouched
 * field is absent from it. Sending the whole record would make "I did not
 * change the token" indistinguishable from "clear the token" — which, for a
 * secret whose field is always blank, would wipe it on every save.
 *
 * 🔴 **Revert sends `null`**, and it is offered only when there is something
 * underneath to fall back to. The layer below — the environment variable, or
 * the plugin's own default — was never written to, so reverting is just
 * deleting the stored value and asking again. A button offering "use the
 * environment value" where no such value exists would silently empty the field,
 * so the label names whichever layer will actually answer.
 */
import { useEffect, useRef, useState } from "react";
import { Info, Loader2, RotateCcw, Save, Settings2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ResolvedSetting, SettingSource } from "../../../core/plugin-settings";
import { usePluginSettings, useSavePluginSettings } from "../../data/plugins";
import { ErrorState } from "../common/Bits";

export interface PluginSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plugin's manifest name — settings belong to the manifest, not to the file. */
  name: string | null;
}

/** Where a value came from, in words. The badge on every row. */
const SOURCE_LABEL: Record<SettingSource, string> = {
  stored: "set here",
  file: "plugin-state.json",
  environment: "environment",
  default: "default",
  unset: "not set",
};

/** What the revert button will actually do, named after the layer that answers next. */
function revertLabel(fallback: SettingSource): string {
  switch (fallback) {
    case "environment":
      return "Use the environment value";
    case "file":
      return "Use the value from plugin-state.json";
    case "default":
      return "Use the default";
    default:
      // Nothing underneath: honest about it being a clear rather than a revert.
      return "Clear";
  }
}

/** A `null` in the patch means "cleared"; a string means "set to this". */
type Patch = Record<string, string | null>;

function currentValue(setting: ResolvedSetting, patch: Patch): string {
  const edited = patch[setting.key];
  if (edited !== undefined) return edited ?? "";
  // ⚠️ A secret has no `value`, ever. An empty field is what "set, but not
  // shown" looks like, and the badge beside it is what says so.
  return setting.value ?? "";
}

function SettingRow({
  setting,
  patch,
  onSet,
}: {
  setting: ResolvedSetting;
  patch: Patch;
  onSet: (key: string, value: string | null) => void;
}) {
  const value = currentValue(setting, patch);
  const touched = setting.key in patch;
  const id = `plugin-setting-${setting.key}`;
  // Reverting only makes sense against a value that is actually stored here —
  // or one this form has just typed and not yet saved.
  const canRevert = setting.source === "stored" || (touched && patch[setting.key] !== null);

  return (
    <div className="space-y-1.5 border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label htmlFor={id} className="text-sm font-medium">
          {setting.label}
          {setting.required ? <span className="ml-1 text-destructive">*</span> : null}
        </Label>
        <span className="flex items-center gap-1.5">
          {setting.secret ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              secret
            </Badge>
          ) : null}
          <Badge
            variant="secondary"
            className={cn(
              "px-1.5 py-0 text-[10px]",
              setting.source === "unset" && setting.required && "bg-warning/15 text-warning",
              setting.source === "stored" && "bg-primary/10 text-primary",
            )}
          >
            {SOURCE_LABEL[setting.source]}
          </Badge>
        </span>
      </div>

      {setting.type === "boolean" ? (
        <div className="flex items-center gap-2">
          <Switch
            id={id}
            checked={value === "true"}
            aria-label={setting.label}
            onCheckedChange={(next) => onSet(setting.key, next ? "true" : "false")}
          />
          <span className="text-xs text-muted-foreground">{value === "true" ? "on" : "off"}</span>
        </div>
      ) : setting.type === "select" ? (
        <Select value={value} onValueChange={(next) => onSet(setting.key, next)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {(setting.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label ?? option.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          type={setting.secret ? "password" : setting.type === "number" ? "number" : "text"}
          inputMode={setting.type === "number" ? "numeric" : undefined}
          autoComplete={setting.secret ? "new-password" : "off"}
          spellCheck={false}
          placeholder={
            setting.secret && setting.configured && !touched
              ? "a value is set — type to replace it"
              : (setting.placeholder ?? setting.default ?? "")
          }
          onChange={(event) => onSet(setting.key, event.target.value)}
        />
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          <code className="font-mono">{setting.key}</code>
          {setting.description ? ` — ${setting.description}` : ""}
        </p>
        {canRevert ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => onSet(setting.key, null)}
          >
            <RotateCcw className="size-3" aria-hidden />
            {revertLabel(setting.fallback)}
          </Button>
        ) : null}
      </div>

      {setting.source === "stored" && setting.fallback !== "unset" && setting.fallbackValue !== undefined ? (
        <p className="text-[11px] text-muted-foreground">
          The {SOURCE_LABEL[setting.fallback]} still says <code className="font-mono">{setting.fallbackValue}</code>{" "}
          — nothing here changed it.
        </p>
      ) : null}
    </div>
  );
}

export function PluginSettingsDialog({ open, onOpenChange, name }: PluginSettingsDialogProps) {
  const settings = usePluginSettings(open ? name : null);
  const save = useSavePluginSettings();
  const [patch, setPatch] = useState<Patch>({});

  /**
   * 🔴 `save` is deliberately absent from the dependency list, and reached
   * through a ref instead.
   *
   * A React Query mutation result is a new object every render, so listing it
   * here runs the effect every render — and this effect calls `setPatch`, which
   * causes a render. That is an infinite loop, and React ends it by replacing
   * the whole screen with an error boundary ("Maximum update depth exceeded").
   * Found by opening this dialog in a browser; the compiler had no opinion.
   */
  const resetSave = useRef<() => void>(() => undefined);
  resetSave.current = save.reset;

  useEffect(() => {
    // A fresh form per opening, and per plugin. Carrying an unsaved edit from
    // one plugin's dialog into another's is the kind of thing nobody notices
    // until it is saved.
    setPatch({});
    resetSave.current();
  }, [open, name]);

  function onSet(key: string, value: string | null) {
    setPatch((current) => ({ ...current, [key]: value }));
  }

  const rows = settings.data?.settings ?? [];
  const dirty = Object.keys(patch).length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="size-4" aria-hidden />
            {name} settings
          </DialogTitle>
          <DialogDescription>
            Declared by the plugin itself, so this form exists before its code has ever run. Saving re-runs the
            plugin's <code>setup</code> with the new values.
          </DialogDescription>
        </DialogHeader>

        {settings.isPending ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading…
          </p>
        ) : settings.isError ? (
          <ErrorState error={settings.error} what="These settings" retry={() => void settings.refetch()} />
        ) : rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            This plugin declares no settings. Anything it reads comes from the environment — which is a plugin
            worth adding a <code>settings</code> block to.
          </p>
        ) : (
          <div className="scrollbar-thin max-h-[52vh] overflow-y-auto pr-1">
            {rows.map((setting) => (
              <SettingRow key={setting.key} setting={setting} patch={patch} onSet={onSet} />
            ))}
          </div>
        )}

        <p className="flex items-start gap-1.5 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            A value set here beats the environment variable of the same name, and the variable is left exactly as
            it is — which is what the revert buttons put back. Values are stored on the server, in the same
            database as everything else, <strong>unencrypted</strong>: a token here is as exposed as the same
            token in a compose file.
          </span>
        </p>

        {save.isError ? <p className="text-xs text-destructive">{save.error.message}</p> : null}
        {save.isSuccess && !dirty ? <p className="text-xs text-success">Saved, and the plugin was reloaded.</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            className="gap-1.5"
            disabled={!dirty || save.isPending || name === null}
            onClick={() => {
              if (name === null) return;
              // Only the touched keys. See the header.
              save.mutate({ name, values: patch }, { onSuccess: () => setPatch({}) });
            }}
          >
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Save className="size-4" aria-hidden />
            )}
            Save and reload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
