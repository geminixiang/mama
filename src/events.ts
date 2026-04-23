import { Cron } from "croner";
import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  watch,
} from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import type { Bot, BotEvent } from "./adapter.js";
import * as log from "./log.js";

// ============================================================================
// Event Types
// ============================================================================

export interface ImmediateEvent {
  type: "immediate";
  platform: string;
  channelId: string;
  /** Creator userId — routes tool execution to this user's vault when fired. */
  userId?: string;
  text: string;
}

export interface OneShotEvent {
  type: "one-shot";
  platform: string;
  channelId: string;
  userId?: string;
  text: string;
  at: string; // ISO 8601 with timezone offset
}

export interface PeriodicEvent {
  type: "periodic";
  platform: string;
  channelId: string;
  userId?: string;
  text: string;
  schedule: string; // cron syntax
  timezone: string; // IANA timezone
}

export type MamaEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

export interface PeriodicEventInfo {
  filename: string;
  platform: string;
  channelId: string;
  text: string;
  schedule: string;
  timezone: string;
  nextRun: string | null; // ISO 8601
}

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;

export class EventsWatcher {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private crons: Map<string, Cron> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private startTime: number;
  private watcher: FSWatcher | null = null;
  private knownFiles: Set<string> = new Set();

  constructor(
    private eventsDir: string,
    private botsByPlatform: Record<string, Bot>,
  ) {
    this.startTime = Date.now();
  }

  /**
   * Start watching for events. Call this after platform bots are initialized.
   */
  start(): void {
    // Ensure events directory exists
    if (!existsSync(this.eventsDir)) {
      mkdirSync(this.eventsDir, { recursive: true });
    }

    log.logInfo(`Events watcher starting, dir: ${this.eventsDir}`);

    // Scan existing files
    this.scanExisting();

    // Watch for changes
    this.watcher = watch(this.eventsDir, (_eventType, filename) => {
      if (!filename || !filename.endsWith(".json")) return;
      this.debounce(filename, () => this.handleFileChange(filename));
    });

    log.logInfo(`Events watcher started, tracking ${this.knownFiles.size} files`);
  }

  /**
   * Stop watching and cancel all scheduled events.
   */
  stop(): void {
    // Stop fs watcher
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Cancel all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Cancel all scheduled timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Cancel all cron jobs
    for (const cron of this.crons.values()) {
      cron.stop();
    }
    this.crons.clear();

    this.knownFiles.clear();
    log.logInfo("Events watcher stopped");
  }

  /**
   * Return all active periodic (cron) events with their next run time.
   */
  getPeriodicEvents(): PeriodicEventInfo[] {
    const results: PeriodicEventInfo[] = [];
    for (const [filename, cron] of this.crons) {
      const filePath = join(this.eventsDir, filename);
      try {
        const content = readFileSync(filePath, "utf-8");
        const data = this.parseEvent(content, filename);
        if (!data || data.type !== "periodic") {
          continue;
        }
        const next = cron.nextRun();
        results.push({
          filename,
          platform: data.platform,
          channelId: data.channelId,
          text: data.text,
          schedule: data.schedule,
          timezone: data.timezone,
          nextRun: next?.toISOString() ?? null,
        });
      } catch {
        // File may have been deleted or corrupted, skip
      }
    }
    return results;
  }

  private debounce(filename: string, fn: () => void): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      filename,
      setTimeout(() => {
        this.debounceTimers.delete(filename);
        fn();
      }, DEBOUNCE_MS),
    );
  }

  private scanExisting(): void {
    let files: string[];
    try {
      files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
    } catch (err) {
      log.logWarning("Failed to read events directory", String(err));
      return;
    }

    for (const filename of files) {
      this.handleFile(filename);
    }
  }

  private handleFileChange(filename: string): void {
    const filePath = join(this.eventsDir, filename);

    if (!existsSync(filePath)) {
      // File was deleted
      this.handleDelete(filename);
    } else if (this.knownFiles.has(filename)) {
      // File was modified - cancel existing and re-schedule
      this.cancelScheduled(filename);
      this.handleFile(filename);
    } else {
      // New file
      this.handleFile(filename);
    }
  }

  private handleDelete(filename: string): void {
    if (!this.knownFiles.has(filename)) return;

    log.logInfo(`Event file deleted: ${filename}`);
    this.cancelScheduled(filename);
    this.knownFiles.delete(filename);
  }

  private cancelScheduled(filename: string): void {
    const timer = this.timers.get(filename);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(filename);
    }

    const cron = this.crons.get(filename);
    if (cron) {
      cron.stop();
      this.crons.delete(filename);
    }
  }

  private async handleFile(filename: string): Promise<void> {
    const filePath = join(this.eventsDir, filename);

    // Parse with retries
    let event: MamaEvent | null = null;
    let lastError: Error | null = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const content = await readFile(filePath, "utf-8");
        event = this.parseEvent(content, filename);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < MAX_RETRIES - 1) {
          await this.sleep(RETRY_BASE_MS * 2 ** i);
        }
      }
    }

    if (!event) {
      log.logWarning(
        `Failed to parse event file after ${MAX_RETRIES} retries: ${filename}`,
        lastError?.message,
      );
      this.deleteFile(filename);
      return;
    }

    this.knownFiles.add(filename);

    // Schedule based on type
    switch (event.type) {
      case "immediate":
        this.handleImmediate(filename, event);
        break;
      case "one-shot":
        this.handleOneShot(filename, event);
        break;
      case "periodic":
        this.handlePeriodic(filename, event);
        break;
    }
  }

  private parseEvent(content: string, filename: string): MamaEvent | null {
    const data = JSON.parse(content);

    if (!data.type || !data.channelId || !data.text) {
      throw new Error(`Missing required fields (type, channelId, text) in ${filename}`);
    }

    const platform = this.resolvePlatform(data.platform, filename);

    const userId = typeof data.userId === "string" ? data.userId : undefined;

    switch (data.type) {
      case "immediate":
        return {
          type: "immediate",
          platform,
          channelId: data.channelId,
          userId,
          text: data.text,
        };

      case "one-shot":
        if (!data.at) {
          throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
        }
        return {
          type: "one-shot",
          platform,
          channelId: data.channelId,
          userId,
          text: data.text,
          at: data.at,
        };

      case "periodic":
        if (!data.schedule) {
          throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
        }
        if (!data.timezone) {
          throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
        }
        return {
          type: "periodic",
          platform,
          channelId: data.channelId,
          userId,
          text: data.text,
          schedule: data.schedule,
          timezone: data.timezone,
        };

      default:
        throw new Error(`Unknown event type '${data.type}' in ${filename}`);
    }
  }

  private resolvePlatform(platformValue: unknown, filename: string): string {
    const availablePlatforms = Object.keys(this.botsByPlatform);

    if (typeof platformValue === "string" && platformValue.trim().length > 0) {
      const platform = platformValue.trim().toLowerCase();
      if (!this.botsByPlatform[platform]) {
        throw new Error(
          `Unknown platform '${platformValue}' in ${filename}. Expected one of: ${availablePlatforms.join(", ")}`,
        );
      }
      return platform;
    }

    if (availablePlatforms.length === 1) {
      return availablePlatforms[0];
    }

    throw new Error(
      `Missing required field 'platform' in ${filename}. Available platforms: ${availablePlatforms.join(", ")}`,
    );
  }

  private handleImmediate(filename: string, event: ImmediateEvent): void {
    const filePath = join(this.eventsDir, filename);

    // Check if stale (created before harness started)
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < this.startTime) {
        log.logInfo(`Stale immediate event, deleting: ${filename}`);
        this.deleteFile(filename);
        return;
      }
    } catch {
      // File may have been deleted
      return;
    }

    log.logInfo(`Executing immediate event: ${filename}`);
    this.execute(filename, event);
  }

  private handleOneShot(filename: string, event: OneShotEvent): void {
    const atTime = new Date(event.at).getTime();
    const now = Date.now();

    if (atTime <= now) {
      // Past - delete without executing
      log.logInfo(`One-shot event in the past, deleting: ${filename}`);
      this.deleteFile(filename);
      return;
    }

    const delay = atTime - now;
    log.logInfo(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);

    const timer = setTimeout(() => {
      this.timers.delete(filename);
      log.logInfo(`Executing one-shot event: ${filename}`);
      this.execute(filename, event);
    }, delay);

    this.timers.set(filename, timer);
  }

  private handlePeriodic(filename: string, event: PeriodicEvent): void {
    try {
      const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
        log.logInfo(`Executing periodic event: ${filename}`);
        this.execute(filename, event, false); // Don't delete periodic events
      });

      this.crons.set(filename, cron);

      const next = cron.nextRun();
      log.logInfo(
        `Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`,
      );
    } catch (err) {
      log.logWarning(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
      this.deleteFile(filename);
    }
  }

  private execute(filename: string, event: MamaEvent, deleteAfter: boolean = true): void {
    // Format the message
    let scheduleInfo: string;
    switch (event.type) {
      case "immediate":
        scheduleInfo = "immediate";
        break;
      case "one-shot":
        scheduleInfo = event.at;
        break;
      case "periodic":
        scheduleInfo = event.schedule;
        break;
    }

    const message = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;
    const bot = this.botsByPlatform[event.platform];

    if (!bot) {
      log.logWarning(`No bot configured for event platform '${event.platform}'`, filename);
      if (deleteAfter) {
        this.deleteFile(filename);
      }
      return;
    }

    // Create synthetic BotEvent. Keep a stable channel session key so recurring
    // reminders share context, but use a unique synthetic message id because
    // some adapters treat `ts`/message id as a reply target.
    // `user` falls back to "EVENT" when the event file omits a creator; vault
    // routing then resolves to an empty auto-created entry (no credentials).
    const syntheticEvent: BotEvent = {
      type: "mention",
      channel: event.channelId,
      user: event.userId ?? "EVENT",
      text: message,
      ts: `event:${filename}`,
      sessionKey: event.channelId,
    };

    // Enqueue for processing
    const enqueued = bot.enqueueEvent(syntheticEvent);

    if (enqueued && deleteAfter) {
      // Delete file after successful enqueue (immediate and one-shot)
      this.deleteFile(filename);
    } else if (!enqueued) {
      log.logWarning(`Event queue full, discarded: ${filename}`);
      // Still delete immediate/one-shot even if discarded
      if (deleteAfter) {
        this.deleteFile(filename);
      }
    }
  }

  private deleteFile(filename: string): void {
    const filePath = join(this.eventsDir, filename);
    try {
      unlinkSync(filePath);
    } catch (err) {
      // ENOENT is fine (file already deleted), other errors are warnings
      if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
        log.logWarning(`Failed to delete event file: ${filename}`, String(err));
      }
    }
    this.knownFiles.delete(filename);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create an events watcher for all configured platforms.
 */
export function createEventsWatcher(
  workspaceDir: string,
  botsByPlatform: Record<string, Bot>,
): EventsWatcher {
  const eventsDir = join(workspaceDir, "events");
  return new EventsWatcher(eventsDir, botsByPlatform);
}
