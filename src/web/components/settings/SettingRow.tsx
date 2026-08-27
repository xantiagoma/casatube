/**
 * One setting, with everything needed to act on it.
 *
 * 🔴 **The row answers four questions, always, in this order**: what is this,
 * where is its value coming from, which environment variable sets it, and what
 * would putting it back mean. The old screen answered none of them — it printed
 * a number and a sentence saying no endpoint could write it, which stopped
 * being true hours after it was written.
 *
 * ## The three rules the row obeys
 *
 * 🔴 **The environment variable is named whether or not it is set.** That is
 * the half of the question that was impossible to answer from the app: an
 * unset variable used to be invisible, so the only way to learn what to put in
 * the compose file was to read the server's source.
 *
 * 🔴 **A restart-scoped write says so, and shows both numbers.** `runningValue`
 * is what the process is really using and `value` is what is stored; a row that
 * showed only the second would be a control that lies about having worked. The
 * amber strip is the honest version and it names both.
 *
 * 🔴 **Reset is offered only when something is underneath.** `resetsTo` arrives
 * resolved from the server, so the button names the layer that will actually
 * answer — the variable, or the code default — instead of promising a fallback
 * that does not exist.
 *
 * ⚠️ No `useEffect` anywhere in this file, deliberately. The draft is cleared
 * from the mutation's own `onSuccess` callback, because "reset local state when
 * a prop changes" written as an effect with a mutation in its dependency list
 * is an infinite render loop — see docs/DISCOVERIES.md. There is nothing to
 * synchronise: with no draft, the row renders the server's value.
 */
import { useState } from "react";
import { Code2, Loader2, Lock, RotateCcw, Terminal, TriangleAlert, UserPen, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ResolvedSetting, SettingValue } from "../../../core/app-settings";
import { formatDateTime } from "../../data/format";
import { useResetSetting, useSaveSetting } from "../../data/settings";
import {
  addLanguages,
  displayValue,
  envSentence,
  optionLabel,
  parseNumberInput,
  pendingSentence,
  rangeHint,
  resetLabel,
  sameValue,
  SOURCE_CLASS,
  SOURCE_LABEL,
  sourceSentence,
} from "./setting-view";

/** The icon per origin: colour is never the only difference between the three. */
const SOURCE_ICON = { default: Code2, env: Terminal, user: UserPen } as const;

function SourceBadge({ setting }: { setting: ResolvedSetting }) {
  const Icon = SOURCE_ICON[setting.source];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        SOURCE_CLASS[setting.source],
      )}
    >
      <Icon className="size-3" aria-hidden />
      {SOURCE_LABEL[setting.source]}
    </span>
  );
}

/** A note that is a problem: the amber strip both warnings share. */
function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 p-2 text-[11px] break-words text-warning">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** The chips-and-a-box control for a list of language tags. */
function LanguagesField({
  id,
  tags,
  disabled,
  onChange,
}: {
  id: string;
  tags: readonly string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState("");

  function commit() {
    if (text.trim() === "") return;
    onChange(addLanguages(tags, text));
    setText("");
  }

  return (
    <div className="space-y-1.5">
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-secondary py-0.5 pr-1 pl-2 text-xs font-medium text-secondary-foreground"
            >
              {tag}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${tag}`}
                className="grid size-4 place-items-center rounded-full hover:bg-foreground/10 disabled:opacity-50"
                onClick={() => onChange(tags.filter((item) => item !== tag))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={id}
          value={text}
          disabled={disabled}
          placeholder="en, es, pt-BR"
          autoComplete="off"
          spellCheck={false}
          className="flex-1"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds a tag; it must not submit anything enclosing this.
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || text.trim() === ""} onClick={commit}>
          Add
        </Button>
      </div>
    </div>
  );
}

/** A draft is a string for the text-ish kinds and a tag list for `languages`. */
type Draft = string | string[];

export function SettingRow({ setting }: { setting: ResolvedSetting }) {
  const save = useSaveSetting();
  const reset = useResetSetting();
  const [draft, setDraft] = useState<Draft | null>(null);

  const id = `setting-${setting.key}`;
  const busy = save.isPending || reset.isPending;
  const reset_ = resetLabel(setting);

  /** What the field shows when nothing has been typed into it. */
  const stored = setting.kind === "languages" ? ((setting.value as string[] | null) ?? []) : displayValueForField(setting);
  const shown: Draft = draft ?? stored;
  const dirty = draft !== null && !sameValue(draft, stored);

  function commit(value: SettingValue) {
    save.mutate({ key: setting.key, value }, { onSuccess: () => setDraft(null) });
  }

  /** Turn what is in the field into the value the API takes. `null` = refuse. */
  function commitDraft() {
    if (setting.kind === "languages") return commit(Array.isArray(shown) ? shown : []);
    const text = typeof shown === "string" ? shown : "";
    if (setting.kind === "integer") {
      const parsed = parseNumberInput(text);
      // The server owns the range; this only refuses what is not a number at
      // all, which would otherwise be sent as `null` and rejected as a type.
      if (parsed === null) return;
      return commit(parsed);
    }
    return commit(text);
  }

  return (
    <div className="border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Label htmlFor={id} className="text-sm font-medium">
          {setting.label}
        </Label>
        <span className="flex flex-wrap items-center gap-1.5">
          {setting.effect === "restart" ? (
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-[10px] font-normal"
              title={setting.restartReason ?? undefined}
            >
              needs restart
            </Badge>
          ) : null}
          {setting.editable ? null : (
            <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-normal">
              <Lock className="size-2.5" aria-hidden />
              read-only
            </Badge>
          )}
          <SourceBadge setting={setting} />
        </span>
      </div>

      <p className="mt-0.5 text-xs text-muted-foreground">{setting.description}</p>

      {/* --- The control, or the value when there cannot be one -------------- */}
      <div className="mt-2">
        {!setting.editable ? (
          <p className="rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs break-all">
            {displayValue(setting, setting.value)}
          </p>
        ) : setting.kind === "boolean" ? (
          <div className="flex items-center gap-2">
            <Switch
              id={id}
              checked={setting.value === true}
              disabled={busy}
              aria-label={setting.label}
              onCheckedChange={(next) => commit(next)}
            />
            <span className="text-xs text-muted-foreground">{setting.value === true ? "on" : "off"}</span>
          </div>
        ) : setting.kind === "enum" ? (
          <Select
            value={typeof setting.value === "string" ? setting.value : ""}
            disabled={busy}
            onValueChange={(next) => commit(next)}
          >
            <SelectTrigger id={id} className="w-full">
              <SelectValue placeholder="Choose…">{optionLabel(setting, setting.value)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(setting.options ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : setting.kind === "languages" ? (
          <LanguagesField
            id={id}
            tags={Array.isArray(shown) ? shown : []}
            disabled={busy}
            onChange={(next) => setDraft(next)}
          />
        ) : (
          <Input
            id={id}
            value={typeof shown === "string" ? shown : ""}
            type={setting.kind === "integer" ? "number" : "text"}
            inputMode={setting.kind === "integer" ? "numeric" : undefined}
            min={setting.min ?? undefined}
            max={setting.max ?? undefined}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && dirty) {
                event.preventDefault();
                commitDraft();
              }
            }}
          />
        )}
      </div>

      {/* Save/Discard appear only once something has been typed: a row nobody
          is editing is a row with no decisions on it. Booleans and enums save
          on change, so they never grow these. */}
      {dirty ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => commitDraft()}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
            Discard
          </Button>
          {setting.effect === "restart" ? (
            <span className="text-[11px] text-muted-foreground">{setting.restartReason}</span>
          ) : null}
        </div>
      ) : null}

      {/* --- Where the value comes from, and where reset would send it ------- */}
      {/* ⚠️ `break-all` on both, and it is not cosmetic: a path is one
          unbreakable word, and one of those sets the *min-content* width of the
          whole grid column — which is how a card 560 px wide became 785 and
          pushed its own badges off the side of an iPad. */}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all">{setting.envVar}</code>
        <span className="break-all text-muted-foreground">{envSentence(setting)}</span>
        {rangeHint(setting) !== null && setting.kind === "integer" ? (
          <span className="text-muted-foreground">· {rangeHint(setting)}</span>
        ) : null}
      </div>
      {sourceSentence(setting) !== null ? (
        <p className="mt-1 text-[11px] break-words text-muted-foreground">
          {sourceSentence(setting)}
          {/* When it was saved, from the row the server stored — the answer to
              "did that click actually land?" for a value that looks unchanged. */}
          {setting.source === "user" && setting.updatedAt !== null
            ? ` Saved ${formatDateTime(setting.updatedAt)}.`
            : ""}
        </p>
      ) : null}

      {reset_ !== null ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 h-auto min-h-7 gap-1.5 px-2 py-1 text-left text-xs break-all whitespace-normal"
          disabled={busy}
          onClick={() => reset.mutate(setting.key, { onSuccess: () => setDraft(null) })}
        >
          {reset.isPending ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="size-3" aria-hidden />
          )}
          {reset_}
        </Button>
      ) : null}

      {/* --- The two things that used to be invisible ------------------------ */}
      {setting.envInvalid ? (
        <Warn>
          <code className="font-mono">{setting.envVar}</code> is set to something this build cannot read, so it is
          being <strong>ignored</strong> — the value above is what is really in force. Fix the variable or leave it
          out; a stored value here beats it either way.
        </Warn>
      ) : null}

      {setting.pendingRestart ? (
        <Warn>
          {pendingSentence(setting)} {setting.restartReason}
        </Warn>
      ) : null}

      {!setting.editable && setting.editableReason !== null ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/60 p-2 text-[11px] break-words text-muted-foreground">
          <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{setting.editableReason}</span>
        </p>
      ) : null}

      {save.isError ? <p className="mt-2 text-[11px] text-destructive">{save.error.message}</p> : null}
      {reset.isError ? <p className="mt-2 text-[11px] text-destructive">{reset.error.message}</p> : null}
    </div>
  );
}

/** The stored value as the text field shows it. */
function displayValueForField(setting: ResolvedSetting): string {
  if (setting.value === null) return "";
  if (typeof setting.value === "string") return setting.value;
  if (typeof setting.value === "number") return String(setting.value);
  return "";
}
