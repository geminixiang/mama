import { describe, expect, test, vi } from "vitest";
import type { BotHandler } from "../src/adapter.js";
import { SlackBot } from "../src/adapters/slack/bot.js";

/**
 * Test the stop command resolution logic in SlackBot.
 *
 * The resolveStopTarget method is private, so we test it indirectly by
 * accessing it via the class prototype. The key scenario:
 * - Top-level mention starts a run with sessionKey = channelId
 * - Bot replies in a thread under the user's message
 * - User says "stop" in that thread → event has thread_ts
 * - thread sessionKey = channelId:thread_ts is NOT running
 * - channel sessionKey = channelId IS running
 * - Stop should target channelId
 */

function makeHandler(runningKeys: string[] = []): BotHandler {
  const running = new Set(runningKeys);
  return {
    isRunning: vi.fn((key: string) => running.has(key)),
    getRunningSessions: vi.fn().mockReturnValue([]),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNew: vi.fn(),
  };
}

function makeBot(handler: BotHandler): SlackBot {
  // We only need the handler for resolveStopTarget, but the constructor
  // requires more. We'll create a minimal instance with just enough to test.
  // Access the private method via prototype binding.
  const bot = Object.create(SlackBot.prototype);
  bot.handler = handler;
  return bot;
}

describe("stop command resolution in threads", () => {
  test("stop in thread targets thread session when thread is running", () => {
    const handler = makeHandler(["C123:1000.0001"]);
    const bot = makeBot(handler);
    const target = (bot as any).resolveStopTarget("C123", "1000.0001");
    expect(target).toBe("C123:1000.0001");
  });

  test("stop in thread falls back to channel session when thread is not running", () => {
    // Top-level run is in progress (sessionKey = channelId)
    // User says stop in the bot's reply thread (thread_ts present)
    // Thread session (C123:1000.0001) is NOT running
    // Channel session (C123) IS running
    const handler = makeHandler(["C123"]);
    const bot = makeBot(handler);
    const target = (bot as any).resolveStopTarget("C123", "1000.0001");
    expect(target).toBe("C123");
  });

  test("stop in thread returns null when nothing is running", () => {
    const handler = makeHandler([]);
    const bot = makeBot(handler);
    const target = (bot as any).resolveStopTarget("C123", "1000.0001");
    expect(target).toBeNull();
  });

  test("stop at top level targets channel session", () => {
    const handler = makeHandler(["C123"]);
    const bot = makeBot(handler);
    const target = (bot as any).resolveStopTarget("C123", undefined);
    expect(target).toBe("C123");
  });

  test("stop at top level returns null when not running", () => {
    const handler = makeHandler([]);
    const bot = makeBot(handler);
    const target = (bot as any).resolveStopTarget("C123", undefined);
    expect(target).toBeNull();
  });

  test("thread session takes priority over channel session when both are running", () => {
    const handler = makeHandler(["C123", "C123:1000.0001"]);
    const bot = makeBot(handler);
    const target = (bot as any).resolveStopTarget("C123", "1000.0001");
    expect(target).toBe("C123:1000.0001");
  });
});
