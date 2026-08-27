/**
 * The broom that stops `notifications` growing for ever.
 *
 * The table had a manual `DELETE /api/notifications` and nothing that ever
 * called it, which meant retention existed as a button rather than as a
 * behaviour — and the button spares unread rows, so a bell nobody opens grew
 * without limit. This is the unattended half.
 *
 * ## It reads its policy every pass, on purpose
 *
 * `notifications.retentionDays` and `notifications.maxEntries` are `live`
 * settings, and a value captured in the constructor would make the Settings
 * form appear to work while changing nothing until the next restart — the
 * failure `api/jobs.ts` already documents for the download defaults.
 *
 * ## Shape borrowed from `SourceScheduler`, and for the same reason
 *
 * A chained `setTimeout` rather than `setInterval`: the next pass is armed once
 * the previous one has finished, so a slow sweep on a cold database cannot have
 * a second one stacked behind it. There is no cooperative abort here because a
 * pass is a handful of statements rather than a walk over the network.
 */
import {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_RETENTION_DAYS,
  describeRetention,
  type NotificationStore,
  type RetentionOutcome,
  type RetentionPolicy,
} from "./notifications";

/**
 * How often to sweep.
 *
 * Six hours, not six minutes. Nothing here is urgent — the ceiling is a bound
 * on growth, not a limit that must hold at every instant — and a sweep is a
 * `COUNT` plus, almost always, no deletes at all.
 */
export const DEFAULT_SWEEP_MS = 6 * 60 * 60 * 1_000;

export interface NotificationRetentionOptions {
  store: NotificationStore;
  /** Read fresh on every pass. See the header. */
  policy: () => Promise<RetentionPolicy>;
  sweepMs?: number;
  /** Where a sweep that removed something is reported. */
  log?: (line: string) => void;
  /** A failed sweep must not take the process with it. */
  onError?: (error: unknown) => void;
}

export class NotificationRetention {
  private readonly store: NotificationStore;
  private readonly policy: () => Promise<RetentionPolicy>;
  private readonly sweepMs: number;
  private readonly log: (line: string) => void;
  private readonly onError: (error: unknown) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inFlight: Promise<RetentionOutcome> | null = null;
  private last: RetentionOutcome | null = null;

  constructor(options: NotificationRetentionOptions) {
    this.store = options.store;
    this.policy = options.policy;
    this.sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
    this.log = options.log ?? (() => {});
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Begin sweeping. Idempotent.
   *
   * ⚠️ The first sweep is armed rather than run: an upgrade that suddenly finds
   * 40,000 rows to remove should not do it in the same breath as binding the
   * port. It happens `sweepMs` later, with the server already answering.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.arm();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Resolves once a sweep in flight has finished. For a clean shutdown. */
  async drain(): Promise<void> {
    await this.inFlight?.catch(() => {});
  }

  lastOutcome(): RetentionOutcome | null {
    return this.last;
  }

  /**
   * Sweep now.
   *
   * @returns the outcome, or **`null` when a sweep is already in flight** —
   * two concurrent sweeps would both compute an excess from the same `COUNT`
   * and between them delete twice it.
   */
  sweep(): Promise<RetentionOutcome> | null {
    if (this.inFlight !== null) return null;
    const pass = this.pass().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = pass;
    return pass;
  }

  private async pass(): Promise<RetentionOutcome> {
    const outcome = await this.store.enforceRetention(await this.policy());
    this.last = outcome;
    const line = describeRetention(outcome);
    if (line !== undefined) this.log(`notifications ${line}`);
    return outcome;
  }

  private arm(): void {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      void (async () => {
        try {
          await this.sweep();
        } catch (error) {
          this.onError(error);
        } finally {
          this.arm();
        }
      })();
    }, this.sweepMs);
    // A pending sweep is not a reason for the process to stay alive.
    this.timer.unref?.();
  }
}

/** The policy as the settings store holds it, with the code's answer behind it. */
export async function policyFromSettings(read: (key: string) => Promise<unknown>): Promise<RetentionPolicy> {
  const int = async (key: string, fallback: number): Promise<number> => {
    const value = await read(key);
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    retentionDays: await int("notifications.retentionDays", DEFAULT_RETENTION_DAYS),
    maxEntries: await int("notifications.maxEntries", DEFAULT_MAX_ENTRIES),
  };
}
