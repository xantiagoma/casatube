/**
 * The scheduler — the thing that makes a subscription unattended (PLAN §7,
 * phase 4: *a new channel upload is enqueued unattended*).
 *
 * It is deliberately dull. It wakes up, asks which sources are due, checks a
 * few of them slowly, and goes back to sleep. Every interesting decision —
 * what counts as new, what gets queued — belongs to `sources.ts`; this file
 * only decides *when*, and its whole job is to not be greedy about it.
 *
 * ## Why a timer of our own and not `Bun.cron`
 *
 * Bun can schedule work from a cron expression, and it is the wrong shape here
 * for three separate reasons:
 *
 * 1. **The interval is per source and lives in the database.** `intervalMinutes`
 *    is a column the user edits at runtime. A cron expression is a fixed
 *    calendar; expressing "six hours after *this* source was last checked"
 *    would mean one cron entry per source, rewritten on every edit — a second
 *    copy of state that the database already holds.
 * 2. **A calendar synchronises the burst we are trying to avoid.** Everything
 *    sharing a six-hourly cron slot fires at the same instant. What we want is
 *    the opposite:
 *    checks smeared out, which comes from a relative deadline plus spacing, not
 *    from a slot.
 * 3. **A cron string cannot be advanced by a test.** The clock here is injected
 *    and every pass can be driven by hand, which is what lets non-overlap and
 *    spacing be *proved* rather than asserted in a comment.
 *
 * ## Not overlapping with itself, by construction
 *
 * Two mechanisms, and the first is the one that matters. The next tick is
 * scheduled **after** a pass finishes (`setTimeout` chained, never
 * `setInterval`), so a slow pass cannot have a second one queued behind it —
 * `setInterval` would keep firing into a busy scheduler and stack the passes up.
 * A `running` flag then covers the other entrance: a manual "check now" arriving
 * mid-pass is refused with `null` rather than run concurrently, because two
 * passes over the same due list is exactly the double-check `source_seen` has to
 * defend against, and defending is more expensive than not attacking.
 */
import { Result } from "better-result";

import type { Source } from "./types";
import type { CheckResult, SourceManager } from "./sources";

// --- Defaults ---------------------------------------------------------------

/**
 * How often to *look*. Not how often a source is checked — that is
 * `intervalMinutes`, and it is measured in hours.
 *
 * A minute is cheap: a tick that finds nothing due is one indexed read of a
 * table with tens of rows. Its only job is to be fine-grained enough that a
 * six-hour interval is not rounded into a seven-hour one.
 */
export const DEFAULT_TICK_MS = 60_000;

/**
 * ⚠️ Distance between two sources inside one pass.
 *
 * Twenty subscriptions coming due together must not become twenty listings in
 * the same second: that is a burst of requests from one IP, which is the
 * failure mode PLAN §4.3 is written about. Thirty seconds turns a pass over
 * five sources into a two-minute trickle, which nobody is waiting on anyway.
 */
export const DEFAULT_SOURCE_SPACING_MS = 30_000;

/**
 * How many sources one pass will check.
 *
 * With the spacing above, an unbounded pass over forty due sources would run
 * for twenty minutes and hold the scheduler shut the whole time. The remainder
 * is not lost — it is still due, and the next tick starts with it, because
 * `due()` returns the longest-waiting first.
 */
export const DEFAULT_MAX_SOURCES_PER_PASS = 5;

// --- Contract ---------------------------------------------------------------

export interface PassResult {
  startedAt: string;
  finishedAt: string;
  /** Sources that were due when the pass began. */
  due: number;
  /** Of those, the ones this pass got to. */
  checked: CheckResult[];
  /** Due but left for the next tick by `maxSourcesPerPass`, or by a stop. */
  deferred: number;
  failures: { sourceId: string; tag: string }[];
}

export interface SchedulerStatus {
  running: boolean;
  /** A pass is happening right now. */
  inFlight: boolean;
  tickMs: number;
  sourceSpacingMs: number;
  maxSourcesPerPass: number;
  /** When the timer next fires. Null while stopped. */
  nextPassAt: string | null;
  lastPassAt: string | null;
  lastPass: PassResult | null;
  /** Sources due at this instant. */
  dueNow: number;
  /** The earliest a source becomes due. Null when there are no enabled sources. */
  nextSourceDueAt: string | null;
  sources: number;
}

export interface SchedulerOptions {
  manager: SourceManager;
  tickMs?: number;
  sourceSpacingMs?: number;
  maxSourcesPerPass?: number;
  /** Injectable clock — the tests never wait six hours. */
  now?: () => Date;
  /** Injectable delay, so spacing can be observed instead of endured. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onError?: (sourceId: string, error: unknown) => void;
  log?: (line: string) => void;
}

/** The real one: a timer that resolves early when the scheduler is stopped. */
export function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

// --- The scheduler ----------------------------------------------------------

export class SourceScheduler {
  private readonly manager: SourceManager;
  private readonly tickMs: number;
  private readonly sourceSpacingMs: number;
  private readonly maxSourcesPerPass: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly onError: (sourceId: string, error: unknown) => void;
  private readonly log: (line: string) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inFlight: Promise<PassResult> | null = null;
  private abort: AbortController | null = null;
  private nextPassAt: Date | null = null;
  private lastPassAt: Date | null = null;
  private lastPass: PassResult | null = null;

  constructor(options: SchedulerOptions) {
    this.manager = options.manager;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.sourceSpacingMs = options.sourceSpacingMs ?? DEFAULT_SOURCE_SPACING_MS;
    this.maxSourcesPerPass = options.maxSourcesPerPass ?? DEFAULT_MAX_SOURCES_PER_PASS;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? realSleep;
    this.onError = options.onError ?? (() => {});
    this.log = options.log ?? (() => {});
  }

  /**
   * Begin ticking. Idempotent — calling it twice does not give you two timers.
   *
   * The first tick is a whole `tickMs` away rather than immediate: a restart
   * loop would otherwise mean a listing request every time the process comes
   * up, and nothing here is urgent enough to pay for that.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.arm();
    this.log("scheduler started");
  }

  /**
   * Stop ticking, and ask the pass in flight to wind down.
   *
   * The abort is cooperative: it cuts the waits between sources short so a
   * shutdown is not held up by spacing, and the pass stops before starting
   * another source. A check already talking to the network is handed the same
   * signal and gives up with it.
   */
  stop(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextPassAt = null;
    this.abort?.abort();
    this.log("scheduler stopped");
  }

  isStarted(): boolean {
    return this.started;
  }

  isRunning(): boolean {
    return this.inFlight !== null;
  }

  /** Resolves once whatever is in flight has finished. For a clean shutdown. */
  async drain(): Promise<void> {
    await this.inFlight?.catch(() => {});
  }

  /**
   * Run one pass now.
   *
   * @returns the pass, or **`null` when one is already in flight**. Refusing is
   * the point: the caller learns that its request was not run, rather than
   * getting a second concurrent sweep of the same due list.
   */
  runPass(): Promise<PassResult> | null {
    if (this.inFlight !== null) return null;

    const abort = new AbortController();
    this.abort = abort;
    const pass = this.pass(abort.signal).finally(() => {
      this.inFlight = null;
      this.abort = null;
    });
    this.inFlight = pass;
    return pass;
  }

  async status(): Promise<SchedulerStatus> {
    const all = await this.manager.list();
    const at = this.now();
    const due = all.filter((s) => s.enabled && this.manager.nextDueAt(s).getTime() <= at.getTime());
    const upcoming = all
      .filter((s) => s.enabled)
      .map((s) => this.manager.nextDueAt(s).getTime())
      .sort((a, b) => a - b);

    return {
      running: this.started,
      inFlight: this.inFlight !== null,
      tickMs: this.tickMs,
      sourceSpacingMs: this.sourceSpacingMs,
      maxSourcesPerPass: this.maxSourcesPerPass,
      nextPassAt: this.nextPassAt ? this.nextPassAt.toISOString() : null,
      lastPassAt: this.lastPassAt ? this.lastPassAt.toISOString() : null,
      lastPass: this.lastPass,
      dueNow: due.length,
      nextSourceDueAt: upcoming.length > 0 ? new Date(upcoming[0]!).toISOString() : null,
      sources: all.length,
    };
  }

  // --- internals ------------------------------------------------------------

  /**
   * Arm the next tick.
   *
   * Chained, not periodic: this is only ever called once a pass is over, which
   * is what makes "the scheduler never overlaps itself" a property of the
   * control flow rather than of a flag someone has to remember to check.
   */
  private arm(): void {
    if (!this.started) return;
    this.nextPassAt = new Date(this.now().getTime() + this.tickMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      const pass = this.runPass();
      // `null` means a manual check is already running. It will have swept the
      // due list; re-arm and look again next tick.
      if (pass === null) {
        this.arm();
        return;
      }
      void pass.catch(() => {}).finally(() => this.arm());
    }, this.tickMs);
    // A pending tick must not keep the process alive on its own — the server
    // decides when to exit, and an idle scheduler is not a reason to stay up.
    this.timer.unref?.();
  }

  private async pass(signal: AbortSignal): Promise<PassResult> {
    const startedAt = this.now();
    this.lastPassAt = startedAt;

    const due = await this.manager.due(startedAt);
    const batch = due.slice(0, this.maxSourcesPerPass);
    const checked: CheckResult[] = [];
    const failures: { sourceId: string; tag: string }[] = [];
    let reached = 0;

    for (const source of batch) {
      if (signal.aborted) break;
      // ⚠️ The spacing goes *before* each source but the first: a pass with one
      // due source is immediate, and every additional one costs a gap. Putting
      // it after would make the last source delay the end of the pass for
      // nobody's benefit.
      if (reached > 0) {
        await this.sleep(this.sourceSpacingMs, signal);
        if (signal.aborted) break;
      }
      reached += 1;
      await this.checkOne(source, signal, checked, failures);
    }

    const result: PassResult = {
      startedAt: startedAt.toISOString(),
      finishedAt: this.now().toISOString(),
      due: due.length,
      checked,
      deferred: due.length - reached,
      failures,
    };
    this.lastPass = result;
    if (checked.length > 0 || failures.length > 0) {
      const queued = checked.reduce((total, c) => total + c.enqueued.length, 0);
      this.log(`pass: ${reached}/${due.length} source(s), ${queued} item(s) queued, ${failures.length} failure(s)`);
    }
    return result;
  }

  /**
   * One source, and its failure kept local.
   *
   * A source that is blocked, renamed or plain broken must not end the pass:
   * the other subscriptions have nothing to do with it, and a pass that stops
   * at the first bad channel is a pass that never reaches the good ones.
   */
  private async checkOne(
    source: Source,
    signal: AbortSignal,
    checked: CheckResult[],
    failures: { sourceId: string; tag: string }[],
  ): Promise<void> {
    try {
      const result = await this.manager.check(source.id, { signal });
      if (Result.isError(result)) {
        failures.push({ sourceId: source.id, tag: result.error._tag });
        this.onError(source.id, result.error);
      } else {
        checked.push(result.value);
      }
    } catch (cause) {
      // A throw from here is a defect, not a provider failure. It is still not
      // a reason to abandon the remaining sources.
      failures.push({ sourceId: source.id, tag: "Unexpected" });
      this.onError(source.id, cause);
    }
  }
}
