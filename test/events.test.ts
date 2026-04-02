import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import type { Bot, BotEvent } from "../src/adapter.js";
import { EventsWatcher } from "../src/events.js";

function makeBot(platform: string, channelIds: string[] = []) {
  const enqueueEvent = vi.fn<(event: BotEvent) => boolean>().mockReturnValue(true);

  const bot: Bot = {
    start: async () => {},
    postMessage: async () => "1",
    updateMessage: async () => {},
    enqueueEvent,
    getPlatformInfo: () => ({
      name: platform,
      formattingGuide: "",
      channels: channelIds.map((id) => ({ id, name: id })),
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
    });

    expect(enqueueSlack).not.toHaveBeenCalled();
    expect(enqueueDiscord).toHaveBeenCalledTimes(1);
    expect(enqueueDiscord).toHaveBeenCalledWith({
      type: "mention",
      channel: "CH-42",
      user: "EVENT",
      text: "[EVENT:deploy-reminder.json:immediate:immediate] Deploy in 10 minutes",
      ts: "CH-42",
    });
  });
});

describe("EventsWatcher broadcast", () => {
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

  // ── parseEvent ──────────────────────────────────────────────────────────────

  test('parseEvent: channelId "*" triggers broadcast (single platform)', () => {
    const { bot } = makeBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    const parsed = watcher.parseEvent(
      JSON.stringify({ type: "immediate", channelId: "*", text: "hi" }),
      "bcast.json",
    );

    expect(parsed).toEqual({ type: "immediate", platform: "slack", channelId: "*", text: "hi" });
  });

  test("parseEvent: broadcast:true triggers broadcast (channelId omitted)", () => {
    const { bot } = makeBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    const parsed = watcher.parseEvent(
      JSON.stringify({ type: "immediate", broadcast: true, text: "hi" }),
      "bcast.json",
    );

    expect(parsed).toEqual({ type: "immediate", platform: "slack", channelId: "*", text: "hi" });
  });

  test("parseEvent: broadcast across all platforms when platform omitted (multi-bot)", () => {
    const { bot: slackBot } = makeBot("slack");
    const { bot: discordBot } = makeBot("discord");
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackBot,
      discord: discordBot,
    }) as any;

    const parsed = watcher.parseEvent(
      JSON.stringify({ type: "immediate", channelId: "*", text: "hi" }),
      "bcast.json",
    );

    expect(parsed.platform).toBe("*");
    expect(parsed.channelId).toBe("*");
  });

  test("parseEvent: broadcast with explicit platform only targets that platform", () => {
    const { bot: slackBot } = makeBot("slack");
    const { bot: discordBot } = makeBot("discord");
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackBot,
      discord: discordBot,
    }) as any;

    const parsed = watcher.parseEvent(
      JSON.stringify({ type: "immediate", channelId: "*", platform: "slack", text: "hi" }),
      "bcast.json",
    );

    expect(parsed.platform).toBe("slack");
    expect(parsed.channelId).toBe("*");
  });

  test("parseEvent: missing channelId without broadcast flag throws", () => {
    const { bot: slackBot } = makeBot("slack");
    const { bot: discordBot } = makeBot("discord");
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackBot,
      discord: discordBot,
    }) as any;

    expect(() =>
      watcher.parseEvent(
        JSON.stringify({ type: "immediate", platform: "slack", text: "hi" }),
        "bad.json",
      ),
    ).toThrow(/channelId/);
  });

  // ── execute ──────────────────────────────────────────────────────────────────

  test("execute: broadcasts to all channels on the specified platform", () => {
    const { bot: slackBot, enqueueEvent: enqueueSlack } = makeBot("slack", ["C1", "C2", "C3"]);
    const { bot: discordBot, enqueueEvent: enqueueDiscord } = makeBot("discord", ["D1"]);
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackBot,
      discord: discordBot,
    }) as any;

    watcher.execute("announce.json", {
      type: "immediate",
      platform: "slack",
      channelId: "*",
      text: "Hello all",
    });

    expect(enqueueSlack).toHaveBeenCalledTimes(3);
    expect(enqueueDiscord).not.toHaveBeenCalled();

    const channels = enqueueSlack.mock.calls.map((c: [BotEvent]) => c[0].channel);
    expect(channels).toEqual(["C1", "C2", "C3"]);
  });

  test("execute: platform '*' broadcasts to every platform's channels", () => {
    const { bot: slackBot, enqueueEvent: enqueueSlack } = makeBot("slack", ["S1", "S2"]);
    const { bot: discordBot, enqueueEvent: enqueueDiscord } = makeBot("discord", ["D1"]);
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackBot,
      discord: discordBot,
    }) as any;

    watcher.execute("global.json", {
      type: "immediate",
      platform: "*",
      channelId: "*",
      text: "System notice",
    });

    expect(enqueueSlack).toHaveBeenCalledTimes(2);
    expect(enqueueDiscord).toHaveBeenCalledTimes(1);
  });

  test("execute: broadcast message format is correct", () => {
    const { bot, enqueueEvent } = makeBot("slack", ["CH1"]);
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    watcher.execute("news.json", {
      type: "immediate",
      platform: "slack",
      channelId: "*",
      text: "Breaking news",
    });

    expect(enqueueEvent).toHaveBeenCalledWith({
      type: "mention",
      channel: "CH1",
      user: "EVENT",
      text: "[EVENT:news.json:immediate:immediate] Breaking news",
      ts: "CH1",
    });
  });

  test("execute: broadcast with no channels logs warning but does not throw", () => {
    const { bot } = makeBot("slack", []); // no channels
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    expect(() =>
      watcher.execute("empty.json", {
        type: "immediate",
        platform: "slack",
        channelId: "*",
        text: "Anyone?",
      }),
    ).not.toThrow();
  });

  test("execute: periodic broadcast does not delete the file", () => {
    const { bot, enqueueEvent } = makeBot("slack", ["C1"]);
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;
    const deleteFile = vi.spyOn(watcher, "deleteFile");

    watcher.execute(
      "daily.json",
      {
        type: "periodic",
        platform: "slack",
        channelId: "*",
        text: "Daily",
        schedule: "0 9 * * *",
        timezone: "UTC",
      },
      false, // deleteAfter = false
    );

    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
