/**
 * A permit counter for the one stage that is actually scarce.
 *
 * PLAN §17: of the six stages only `download` touches the source, and the
 * source is what rate-limits us. `postprocess` is local ffmpeg and `move` can
 * be minutes of uploading to a network mount — neither is of any interest to
 * YouTube, so a per-job limit would stall the queue while a job uploads without
 * protecting anything.
 *
 * Deliberately not a mutex library: Bun is single-threaded, so there is no
 * shared-memory race to guard. What is needed is scheduling — N in flight —
 * and that is this, in twenty lines.
 */
export class Semaphore {
  #free: number;
  #waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.#free = Math.max(1, permits);
  }

  get available(): number {
    return this.#free;
  }

  get queued(): number {
    return this.#waiting.length;
  }

  /** Run `fn` holding a permit, releasing it however `fn` ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    // Hand the permit straight to a waiter rather than returning it to the
    // pool: releasing and re-acquiring would let a newcomer overtake something
    // that has been waiting.
    if (next) next();
    else this.#free += 1;
  }
}
