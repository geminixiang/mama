import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import type { Bot, BotEvent } from "../src/adapter.js";
import { EventsWatcher } from "../src/events.js";

function makeBot(platform: string) {
  const enqueueEvent = vi.fn<(event: BotEvent) => boolean>().mockReturnValue(true);

  const bot: Bot = {
    start: async () => {},
    postMessage: async () => "1",
    updateMessage: async () => {},
    enqueueEvent,
    getPlatformInfo: () => ({
      name: platform,
      formattingGuide: "",
      channels: [],
      users: [],
    }),
  };

  return { bot, enqueueEvent };
}

describe("EventsWatcher platform routing", () => {
  let tmpDir: string;
  let eventsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-events-test-${Date.now()}`);
    eventsDir = join(tmpDir, "events");
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("defaults platform when exactly one bot is configured", () => {
    const { bot } = makeBot("telegram");
    const watcher = new EventsWatcher(eventsDir, { telegram: bot }) as any;

    const parsed = watcher.parseEvent(
      JSON.stringify({
        type: "immediate",
        channelId: "123",
        text: "Check inbox",
      }),
      "single-platform.json",
    );

    expect(parsed).toEqual({
      type: "immediate",
      platform: "telegram",
      channelId: "123",
      userId: undefined,
      text: "Check inbox",
    });
  });

  test("rejects ambiguous events when multiple platforms are configured", () => {
    const { bot: slackBot } = makeBot("slack");
    const { bot: telegramBot } = makeBot("telegram");
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackBot,
      telegram: telegramBot,
    }) as any;

    expect(() =>
      watcher.parseEvent(
        JSON.stringify({
          type: "immediate",
          channelId: "123",
          text: "Check inbox",
        }),
        "ambiguous.json",
      ),
    ).toThrow(/Missing required field 'platform'/);
  });

  test("routes synthetic events to the explicitly requested platform", () => {
    const { bot: slackBot, enqueueEvent: enqueueSlack } = makeBot("slack");
    const { bot: discordBot, enqueueEvent: enqueueDiscord } = makeBot("discord");
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackBot,
      discord: discordBot,
    }) as any;

    watcher.execute("deploy-reminder.json", {
      type: "immediate",
      platform: "discord",
      channelId: "CH-42",
      text: "Deploy in 10 minutes",
      userId: "U123",
    });

    expect(enqueueSlack).not.toHaveBeenCalled();
    expect(enqueueDiscord).toHaveBeenCalledTimes(1);
    expect(enqueueDiscord).toHaveBeenCalledWith({
      type: "mention",
      conversationId: "CH-42",
      user: "U123",
      text: "[EVENT:deploy-reminder.json:immediate:immediate] Deploy in 10 minutes",
      ts: "event:deploy-reminder.json",
      sessionKey: "CH-42",
    });
  });
});
