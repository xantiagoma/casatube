/**
 * Many URLs at once.
 *
 * ⚠️ **There is no bulk endpoint**, and this does not pretend otherwise: it
 * POSTs each URL to `/api/jobs` in turn and reports each answer separately.
 * Sequentially rather than in parallel, because every one of them is a row plus
 * a queue entry in the same SQLite file, and twenty concurrent writers buy
 * nothing on a request that returns in milliseconds.
 *
 * 🔴 Validation here is **syntax only**. Checking twenty URLs for real would be
 * twenty probes, which is the source's patience spent on a form nobody has
 * submitted yet (PLAN §4.3). What it catches is the thing worth catching in
 * bulk: a line that is not a URL, and the same URL pasted twice.
 */
import { useState } from "react";
import { CircleCheck, Info, ListChecks, Loader2, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DEFAULT_PREFERENCES, type Priority } from "../../../core/types";
import { useLocalPref } from "../../data/prefs";
import { useEnqueue, useJobDefaults } from "../../data/queries";
import { DestinationPicker } from "./DestinationPicker";

interface Line {
  url: string;
  problem?: string;
}

type Outcome = { url: string; state: "queued" | "duplicate" | "failed"; detail?: string };

function parse(text: string): Line[] {
  const seen = new Set<string>();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((url) => {
      if (seen.has(url)) return { url, problem: "the same URL appears twice" };
      seen.add(url);
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { url, problem: `${parsed.protocol} is not a URL this can fetch` };
        }
        return { url };
      } catch {
        return { url, problem: "not a URL" };
      }
    });
}

export function BatchAdd() {
  const [text, setText] = useState("");
  const [destination, setDestination] = useLocalPref("destination", "");
  const [priority, setPriority] = useState<Priority>("normal");
  const [validated, setValidated] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [running, setRunning] = useState(false);

  const defaults = useJobDefaults();
  const enqueue = useEnqueue();

  const lines = parse(text);
  const good = lines.filter((line) => line.problem === undefined);
  const bad = lines.filter((line) => line.problem !== undefined);

  async function submit() {
    setRunning(true);
    setOutcomes([]);
    const preferences = defaults.data?.resolved ?? DEFAULT_PREFERENCES;
    const collected: Outcome[] = [];

    for (const line of good) {
      try {
        const result = await enqueue.mutateAsync({
          url: line.url,
          destination,
          preferences,
          priority,
        });
        collected.push({ url: line.url, state: result.outcome });
      } catch (cause) {
        collected.push({
          url: line.url,
          state: "failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
      setOutcomes([...collected]);
    }

    setRunning(false);
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Batch add</CardTitle>
        <CardAction>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          disabled={text === "" || running}
          onClick={() => {
            setText("");
            setOutcomes([]);
            setValidated(false);
          }}
        >
          <Trash2 className="size-3.5" aria-hidden />
          Clear
        </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="batch">URLs, one per line</Label>
          <Textarea
            id="batch"
            value={text}
            rows={5}
            spellCheck={false}
            placeholder={"https://…\nhttps://…"}
            onChange={(event) => {
              setText(event.target.value);
              setValidated(false);
            }}
            className="font-mono text-xs"
          />
          {/* 🔴 "Every URL is queued with the same settings" used to stand here,
              and it is the sentence Santi flagged: on a queue screen it reads as
              a promise about the *result*, and the result is per link. The
              request really is identical for every line — but what comes out is
              whatever each source happens to have, so the honest version names
              which half is shared and points at the form that chooses the other
              half. */}
          <p className="text-xs text-muted-foreground">
            Lines starting with <code>#</code> are ignored. Destination and priority apply to every line —
            download options do not: each job takes the server's defaults and gets whatever that particular link
            actually offers. To choose resolution, codec, audio and subtitles, use the single-URL form on the
            Dashboard.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <DestinationPicker id="batch-destination" value={destination} onChange={setDestination} />
          <div className="space-y-1.5">
            <Label htmlFor="batch-priority">Priority</Label>
            <Select value={priority} onValueChange={(next) => setPriority(next as Priority)}>
              <SelectTrigger id="batch-priority" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="gap-1.5" disabled={lines.length === 0} onClick={() => setValidated(true)}>
            <ListChecks className="size-4" aria-hidden />
            Validate links
          </Button>
          <Button className="gap-1.5" disabled={good.length === 0 || running} onClick={() => void submit()}>
            {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Enqueue {good.length > 0 ? `${good.length} job${good.length === 1 ? "" : "s"}` : "jobs"}
          </Button>
        </div>

        {validated ? (
          <div className="rounded-lg border p-3 text-xs">
            <p className="font-medium">
              {good.length} URL{good.length === 1 ? "" : "s"} look fine
              {bad.length > 0 ? `, ${bad.length} do not` : ""}.
            </p>
            {bad.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {bad.map((line) => (
                  <li key={line.url} className="flex items-start gap-1.5 text-destructive">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span className="min-w-0 break-all">
                      <code>{line.url}</code> — {line.problem}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-1.5 text-muted-foreground">
              Syntax only. Whether the source actually has these is decided when each job is analyzed.
            </p>
          </div>
        ) : null}

        {outcomes.length > 0 ? (
          <ul className="space-y-1 rounded-lg border p-3 text-xs">
            {outcomes.map((outcome) => (
              <li key={outcome.url} className="flex items-start gap-1.5">
                {outcome.state === "queued" ? (
                  <CircleCheck className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
                ) : outcome.state === "duplicate" ? (
                  <Info className="mt-0.5 size-3 shrink-0 text-primary" aria-hidden />
                ) : (
                  <TriangleAlert className="mt-0.5 size-3 shrink-0 text-destructive" aria-hidden />
                )}
                <span className={cn("min-w-0 break-all", outcome.state === "failed" && "text-destructive")}>
                  <code>{outcome.url}</code>
                  {outcome.state === "duplicate" ? " — already downloaded, nothing fetched" : ""}
                  {outcome.detail ? ` — ${outcome.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
