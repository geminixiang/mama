import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BotHandler } from "../src/adapter.js";
import { SlackBot } from "../src/adapters/slack/bot.js";

function makeHandler(): BotHandler {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    getRunningSessions: vi.fn().mockReturnValue([]),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNew: vi.fn(),
  };
}

describe("SlackBot slash commands", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-slack-bot-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("/pi-login in a shared channel opens a DM and routes login there", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const open = vi.fn().mockResolvedValue({ channel: { id: "D123" } });
    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn().mockResolvedValue({ ts: "2000.0001" });

    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);
    (bot as any).webClient = {
      conversations: { open },
      chat: {
        postEphemeral,
        postMessage,
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    await (bot as any).routeSlashLoginCommand({
      command: "/pi-login",
      text: "github",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(open).toHaveBeenCalledWith({ users: "U123" });
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "我已私訊你 mama 的登入連結，請到私訊完成設定。",
    });

    const [event, calledBot, adapters] = vi.mocked(handler.handleEvent).mock.calls[0];
    expect(event).toMatchObject({
      type: "dm",
      conversationId: "D123",
      conversationKind: "direct",
      user: "U123",
      text: "/pi-login github",
      sessionKey: "D123",
    });
    expect(calledBot).toBe(bot);

    await adapters.responseCtx.respond("login link");
    expect(postMessage).toHaveBeenLastCalledWith({ channel: "D123", text: "login link" });
  });
});
