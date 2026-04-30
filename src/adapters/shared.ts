/**
 * Helpers shared across platform adapters.
 *
 * The agent runner is platform-agnostic: it hands strings and structured tool
 * results to each adapter, which decides how to split, format, and route them.
 * The split/normalize logic itself doesn't differ across platforms — only the
 * markup wrappers — so it lives here once.
 */

import * as log from "../log.js";

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

export class ChannelQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  constructor(private readonly name: string = "") {}

  enqueue(work: () => Promise<void>): void {
    this.queue.push(work);
    this.processNext();
  }

  size(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const work = this.queue.shift()!;
    try {
      await work();
    } catch (err) {
      log.logWarning(
        `${this.name ? this.name + " " : ""}queue error`,
        err instanceof Error ? err.message : String(err),
      );
    }
    this.processing = false;
    this.processNext();
  }
}

// ============================================================================
// Exponential backoff retry utility
// ============================================================================

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      let isRateLimited = false;
      if ("code" in lastError && lastError.code === "rate_limited") {
        isRateLimited = true;
      }
      if ("data" in lastError) {
        const data = (lastError as { data?: { error?: string; response?: { status?: number } } })
          .data;
        if (data?.error === "rate_limited" || data?.response?.status === 429) {
          isRateLimited = true;
        }
      }

      if (isRateLimited) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        log.logWarning(
          `Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw lastError;
    }
  }
  throw lastError;
}

/**
 * Split `text` into chunks no larger than `limit`, appending a continuation
 * marker (e.g. `_(continued 1)_`) at the end of every part except the last.
 *
 * Each adapter passes its own `formatContinuation` so the marker uses the
 * platform's italic / emphasis convention.
 */
export function splitText(
  text: string,
  limit: number,
  formatContinuation: (partNum: number) => string,
): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  let partNum = 1;
  while (remaining.length > 0) {
    const suffixReserve = formatContinuation(partNum).length + 8;
    const chunkLimit = Math.max(1, limit - suffixReserve);
    const chunk = remaining.slice(0, chunkLimit);
    remaining = remaining.slice(chunkLimit);
    const suffix = remaining.length > 0 ? `\n${formatContinuation(partNum)}` : "";
    parts.push(chunk + suffix);
    partNum++;
  }
  return parts;
}

/**
 * Render tool-call args for human display. Drops `label` (already in the
 * heading) and folds `path` + `offset`/`limit` into a single `path:start-end`
 * line. Pure data normalization with no platform-specific markup.
 */
export function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const lines: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (key === "label" || key === "offset" || key === "limit") continue;

    if (key === "path" && typeof value === "string") {
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      lines.push(
        offset !== undefined && limit !== undefined
          ? `${value}:${offset}-${offset + limit}`
          : value,
      );
      continue;
    }

    lines.push(typeof value === "string" ? value : JSON.stringify(value));
  }

  return lines.join("\n");
}
