/**
 * The two language lists — audio and subtitles — at the size real videos have.
 *
 * 🔴 **The problem this exists to solve is 150 rows.** A YouTube video carries
 * automatic captions in well over a hundred languages and, increasingly, dozens
 * of dubbed audio tracks. Rendered as a plain column those lists stretch the
 * page to several screens, bury every other decision below them, and make
 * "which ones did I pick?" a scrolling exercise. So both lists get the same
 * four things:
 *
 * 1. **Their own scroll box.** Fixed height, `overscroll-contain`, so the list
 *    is a control on the page rather than the shape of the page.
 * 2. **A search field**, matching the language name *and* the tag (`eng`),
 *    because people type both.
 * 3. **Filters**, for subtitles: all / manual / automatic.
 * 4. **The selection, always visible** — as chips above the box, and by sorting
 *    ticked rows to the top of whatever is showing.
 *
 * ⚠️ A filter never hides something that is ticked. Losing a selection behind a
 * filter is how a form ends up downloading something nobody can see it agreed
 * to; `visible = matchesSearch && (matchesFilter || isSelected)` is the rule.
 *
 * ⚠️ **Audio and subtitles remain two independent lists (R7).** They share this
 * file because they share a *shape*, not a state: neither reads the other's
 * tags, and "English audio, Spanish subtitles" stays expressible.
 */
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AudioOption, SubtitleOption } from "../../../api/options";
import { toggleTag } from "./choices";
import { ChoiceCard, SwitchRow, TrackRow, type OptionBadge } from "./OptionBits";

/**
 * `es-419` is not a language anyone searches for.
 *
 * 🔴 The options arrive labelled with the code the provider used — `es-419`,
 * `zh-Hans`, `pt-BR` — and a search box over 154 of those is a search box for
 * people who already know the answer. `Intl.DisplayNames` turns them into
 * "Latin American Spanish" with no table to maintain and nothing to keep in
 * step with the server.
 *
 * ⚠️ This is a **label**, not a reading of the media, so it does not belong on
 * the server (R3 cuts the other way here): the request still carries the tag
 * the server sent, and the code is still shown next to the name — renaming the
 * row is exactly as far as this goes.
 *
 * ⚠️ Wrapped and cached because `DisplayNames` throws on a malformed tag, and a
 * provider is perfectly capable of sending one.
 */
/**
 * Built once for the life of the module — never per row, and there are 154.
 *
 * ⚠️ The `let`-plus-`try` shape is deliberate: the constructor has to sit at
 * module scope (one instance, not one per call) *and* be guarded, because
 * `DisplayNames` did not exist before Safari 14.1 and the iPad is the machine
 * this is read on.
 */
let NAMES: Intl.DisplayNames | null = null;
try {
  NAMES = new Intl.DisplayNames(["en"], { type: "language" });
} catch {
  NAMES = null;
}

const NAME_CACHE = new Map<string, string>();

function languageName(code: string): string {
  const cached = NAME_CACHE.get(code);
  if (cached !== undefined) return cached;
  let name = code;
  try {
    name = NAMES?.of(code) ?? code;
  } catch {
    name = code;
  }
  NAME_CACHE.set(code, name);
  return name;
}

/** Both list kinds present the same handful of facts to the shell. */
interface Entry {
  key: string;
  tag: string;
  label: string;
  detail?: string;
  badges: OptionBadge[];
  selectable: boolean;
  hint?: string;
  /** Everything this row can be found by: the name, the provider's code, the tag. */
  terms: string;
}

function matches(entry: Entry, query: string): boolean {
  if (query === "") return true;
  return entry.terms.includes(query.toLowerCase());
}

/** The three strings a row answers to, lower-cased once. */
function termsOf(name: string, code: string, tag: string): string {
  return `${name} ${code} ${tag}`.toLowerCase();
}

/**
 * The scroll box, the search field and the chips — everything that is true of a
 * long list of languages regardless of which of the two it is.
 */
function TrackList({
  idPrefix,
  ariaLabel,
  entries,
  selected,
  onToggle,
  onClearAll,
  filters,
  searchPlaceholder,
  emptyHint,
}: {
  idPrefix: string;
  ariaLabel: string;
  entries: Entry[];
  selected: Set<string>;
  onToggle(tag: string): void;
  onClearAll(): void;
  /** Optional filter strip. `test` decides membership; the count comes from it. */
  filters?: { value: string; label: string; test(entry: Entry): boolean }[];
  searchPlaceholder: string;
  emptyHint: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const active = filters?.find((option) => option.value === filter);

  const visible = useMemo(() => {
    const kept = entries.filter(
      (entry) => matches(entry, query) && (!active || active.test(entry) || selected.has(entry.tag)),
    );
    // Ticked first, original order otherwise. The list is already ordered by the
    // server (`api/options.ts`) and that order is worth keeping — this only
    // lifts what is chosen to where it can be seen.
    return kept
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const pick = Number(selected.has(b.entry.tag)) - Number(selected.has(a.entry.tag));
        return pick !== 0 ? pick : a.index - b.index;
      })
      .map(({ entry }) => entry);
  }, [entries, query, active, selected]);

  const chosen = entries.filter((entry) => selected.has(entry.tag));
  // 🔴 Long enough to be worth searching, short enough that a search box on a
  // three-row list would be noise.
  const searchable = entries.length > 8;

  return (
    <div className="space-y-2">
      {(searchable || filters) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {searchable && (
            <div className="relative min-w-0 flex-1">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={`Search ${ariaLabel}`}
                autoComplete="off"
                className="h-9 pr-8 pl-8"
              />
              {query !== "" && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          )}
          {filters && (
            <div
              role="radiogroup"
              aria-label={`${ariaLabel} filter`}
              className="flex shrink-0 gap-1 rounded-lg bg-muted p-0.5"
            >
              {filters.map((option) => {
                const count = entries.filter((entry) => option.test(entry)).length;
                const on = option.value === filter;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setFilter(option.value)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}{" "}
                    <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 🔴 What is already chosen, without going to look for it. The rows are
          sorted to the top too, but a filter or a search can still be hiding
          one, and this cannot. */}
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Selected:</span>
          {chosen.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => onToggle(entry.tag)}
              aria-label={`Remove ${entry.label}`}
              className="group"
            >
              <Badge
                variant="secondary"
                className="gap-1 border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
              >
                {entry.label}
                <X className="size-3 opacity-60 group-hover:opacity-100" aria-hidden />
              </Badge>
            </button>
          ))}
          {chosen.length > 1 && (
            <button
              type="button"
              onClick={onClearAll}
              className="ml-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* ⚠️ `data-vaul-no-drag`: inside the mobile drawer a downward drag on the
          content is a dismiss gesture, and this box has to keep its own. */}
      <div
        data-vaul-no-drag
        className="max-h-64 space-y-1 overflow-y-auto overscroll-contain rounded-lg border bg-muted/20 p-1.5"
      >
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyHint}</p>
        ) : (
          visible.map((entry) => (
            <TrackRow
              key={entry.key}
              id={`${idPrefix}-${entry.key}`}
              label={entry.label}
              {...(entry.detail ? { detail: entry.detail } : {})}
              badges={entry.badges}
              checked={selected.has(entry.tag)}
              disabled={!entry.selectable}
              {...(entry.hint ? { hint: entry.hint } : {})}
              onToggle={() => onToggle(entry.tag)}
            />
          ))
        )}
      </div>

      <p className="text-xs text-muted-foreground tabular-nums">
        {visible.length === entries.length
          ? `${entries.length} language${entries.length === 1 ? "" : "s"}`
          : `${visible.length} of ${entries.length} languages`}
        {chosen.length > 0 ? ` · ${chosen.length} selected` : " · none selected"}
      </p>
    </div>
  );
}

// --- Audio ------------------------------------------------------------------

function audioDetail(option: AudioOption): string {
  const parts: string[] = [];
  if (option.variants.length > 1) parts.push(option.variants.join(", "));
  else if (option.variants[0] && option.variants[0] !== option.tag) parts.push(option.variants[0]);
  if (option.codec) parts.push(option.codec);
  if (option.bitrate) parts.push(`${Math.round(option.bitrate)} kbps`);
  if (option.trackCount > 1) parts.push(`${option.trackCount} streams`);
  return parts.join(" · ");
}

function AudioTrackList({
  options,
  selected,
  onToggle,
  onClearAll,
}: {
  options: AudioOption[];
  selected: string[];
  onToggle(tag: string): void;
  onClearAll(): void;
}) {
  const entries: Entry[] = options.map((option) => {
    const name = languageName(option.language);
    // ⚠️ No separate code here: `audioDetail` already opens with the provider's
    // own string when it differs from the tag, and printing `en-US · en-US` was
    // the first version of this line.
    const detail = audioDetail(option);
    return {
      key: `${option.tag}-${option.language}`,
      tag: option.tag,
      label: name,
      terms: termsOf(name, option.language, option.tag),
      ...(detail ? { detail } : {}),
      badges: [
        ...(option.isOriginal ? [{ text: "original", tone: "ok" as const }] : []),
        { text: option.tag },
      ],
      selectable: option.selectable,
      ...(option.selectable ? {} : { hint: "The source did not say what language this is." }),
    };
  });

  return (
    <TrackList
      idPrefix="audio"
      ariaLabel="audio languages"
      entries={entries}
      selected={new Set(selected)}
      onToggle={onToggle}
      onClearAll={onClearAll}
      searchPlaceholder="Search audio languages…"
      emptyHint="No audio language matches that."
    />
  );
}

// --- Subtitles --------------------------------------------------------------

function subtitleBadges(option: SubtitleOption): OptionBadge[] {
  return [
    option.hasManual ? { text: "manual", tone: "ok" as const } : { text: "auto-generated", tone: "warn" as const },
    ...(option.hasManual && option.hasAutomatic ? [{ text: "+ auto" }] : []),
    { text: option.tag },
  ];
}

function SubtitleTrackList({
  options,
  selected,
  onToggle,
  onClearAll,
}: {
  options: SubtitleOption[];
  selected: string[];
  onToggle(tag: string): void;
  onClearAll(): void;
}) {
  /**
   * 🔴 "Manual" is the word for a subtitle a person wrote and uploaded —
   * *authored* — as opposed to the ones the site generates by listening. A
   * language that has both is filed under manual, because that is what would be
   * downloaded: `selectSubtitles` prefers the authored track.
   */
  const entries: Entry[] = options.map((option) => {
    const name = languageName(option.language);
    return {
      key: `${option.tag}-${option.language}`,
      tag: option.tag,
      label: name,
      terms: termsOf(name, option.language, option.tag),
      // The provider's own code stays visible: it is what distinguishes
      // `pt` from `pt-BR`, which the English names do not always do.
      ...(name === option.language ? {} : { detail: option.language }),
      badges: subtitleBadges(option),
      selectable: option.selectable,
      ...(option.selectable ? {} : { hint: "The source did not say what language this is." }),
    };
  });

  const manual = new Set<string>();
  for (const option of options) if (option.hasManual) manual.add(option.tag);

  return (
    <TrackList
      idPrefix="sub"
      ariaLabel="subtitle languages"
      entries={entries}
      selected={new Set(selected)}
      onToggle={onToggle}
      onClearAll={onClearAll}
      filters={[
        { value: "all", label: "All", test: () => true },
        { value: "manual", label: "Manual", test: (entry) => manual.has(entry.tag) },
        { value: "auto", label: "Auto", test: (entry) => !manual.has(entry.tag) },
      ]}
      searchPlaceholder="Search subtitle languages…"
      emptyHint="No subtitle language matches that."
    />
  );
}

// --- The two decisions, policy first ----------------------------------------

/**
 * Step two: which audio.
 *
 * 🔴 **The policy comes before the languages, because the policy decides
 * whether there are any languages to pick.** The old form put "Original audio
 * only" in a card *below* the language list — and left the list on screen,
 * greyed out, with no visible cause. Someone reading top to bottom met a
 * disabled control before meeting the switch that disabled it.
 *
 * So it is one question — "original, or languages?" — and the list appears only
 * under the answer that has languages in it. When the answer is "original", the
 * one track that means is named, in one line, instead of a hundred dead rows.
 */
export function AudioPicker({
  options,
  originalOnly,
  audioTags,
  onChange,
}: {
  options: AudioOption[];
  originalOnly: boolean;
  audioTags: string[];
  onChange(next: { originalOnly?: boolean; audioTags?: string[] }): void;
}) {
  const original = options.find((option) => option.isOriginal);

  if (options.length === 0) {
    return <p className="text-sm text-muted-foreground">This source reports no separate audio tracks.</p>;
  }

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Audio policy" className="grid gap-1 sm:grid-cols-2">
        <ChoiceCard
          selected={originalOnly}
          onSelect={() => onChange({ originalOnly: true })}
          label="Original audio only"
          badges={original ? [{ text: original.language, tone: "ok" }] : []}
          implication="Exactly one track: the one the source marks as original."
        />
        <ChoiceCard
          selected={!originalOnly}
          onSelect={() => onChange({ originalOnly: false })}
          label="Choose languages"
          badges={options.length > 1 ? [{ text: `${options.length} available` }] : []}
          implication="Keep one or more dubs. Independent of subtitles (R7)."
        />
      </div>

      {originalOnly ? (
        <p className="text-xs text-muted-foreground">
          {original
            ? `Downloading ${original.language} (${original.tag}) — the track this source marks as original.`
            : "This source marks no track as original; the worker takes its first one."}
        </p>
      ) : (
        <AudioTrackList
          options={options}
          selected={audioTags}
          onToggle={(tag) => onChange({ audioTags: toggleTag(audioTags, tag) })}
          onClearAll={() => onChange({ audioTags: [] })}
        />
      )}
    </div>
  );
}

/**
 * Step three: which subtitles, and how they are delivered.
 *
 * ⚠️ `Embed` comes *after* the languages and inside this step, not in a distant
 * "Download options" card. It is a fact about the subtitles — one file or many
 * — and it means nothing at all when none are selected, which is why it is
 * dimmed and says so rather than sitting there looking like a live control.
 */
export function SubtitlePicker({
  options,
  subtitleTags,
  embedSubtitles,
  onChange,
  onEmbedSubtitles,
}: {
  options: SubtitleOption[];
  subtitleTags: string[];
  embedSubtitles: boolean;
  onChange(next: { subtitleTags: string[] }): void;
  onEmbedSubtitles(next: boolean): void;
}) {
  if (options.length === 0) {
    return <p className="text-sm text-muted-foreground">This source has no subtitles.</p>;
  }

  return (
    <div className="space-y-3">
      <SubtitleTrackList
        options={options}
        selected={subtitleTags}
        onToggle={(tag) => onChange({ subtitleTags: toggleTag(subtitleTags, tag) })}
        onClearAll={() => onChange({ subtitleTags: [] })}
      />
      <div className={cn(subtitleTags.length === 0 && "opacity-60")}>
        <SwitchRow
          title="Embed the subtitles in the file"
          hint={
            subtitleTags.length === 0
              ? "Nothing selected above, so this changes nothing."
              : "Off writes sidecar files, which every media server reads and you can replace later."
          }
          checked={embedSubtitles}
          onChange={onEmbedSubtitles}
        />
      </div>
    </div>
  );
}
