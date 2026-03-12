/**
 * Semaphore-based concurrency limiter for LLM API calls.
 *
 * Without a concurrency cap, 200 active users could each fire a simultaneous
 * LLM request.  Most providers enforce requests-per-minute (RPM) and
 * tokens-per-minute (TPM) limits; bursting to 200 parallel calls almost always
 * triggers 429 rate-limit errors and degrades the experience for everyone.
 *
 * The global `llmSemaphore` defaults to 20 concurrent in-flight LLM calls.
 * Each additional request waits in a FIFO queue until a slot opens.  This
 * provides natural back-pressure and keeps API usage within provider limits.
 *
 * Tune `maxConcurrentRuns` in settings.json to match your tier:
 *   - Free/Tier-1:   5–10
 *   - Tier-2:       15–25
 *   - Tier-3+:      30–50
 */

export class Semaphore {
  private count: number;
  private readonly waiting: Array<() => void> = [];

  constructor(count: number) {
    this.count = count;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve();
    } else {
      this.count++;
    }
  }

  /** Acquire, run fn, release — even on throw. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Slots currently available (not counting queued waiters). */
  get available(): number {
    return this.count;
  }

  /** Number of callers currently waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }
}

/** Global LLM concurrency gate — default 20 simultaneous in-flight calls. */
export let llmSemaphore = new Semaphore(20);

/**
 * Replace the global semaphore with a new limit.
 * Call this once at startup, before any runners are created.
 */
export function configureLlmSemaphore(maxConcurrent: number): void {
  llmSemaphore = new Semaphore(Math.max(1, maxConcurrent));
}
