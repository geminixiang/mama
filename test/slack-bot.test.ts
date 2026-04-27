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

  test("/pi-new in a DM resets the DM session", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    handler.handleNew = vi.fn(async (_sessionKey, conversationId, commandBot) => {
      await commandBot.postMessage(
        conversationId,
        "Conversation reset. Send a new message to start fresh.",
      );
    });

    const postMessage = vi.fn().mockResolvedValue({ ts: "3000.0001" });
    (bot as any).webClient = {
      chat: {
        postMessage,
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    await (bot as any).routeSlashNewCommand({
      command: "/pi-new",
      channel_id: "D123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(handler.handleNew).toHaveBeenCalledWith("D123", "D123", expect.any(Object));
    expect(postMessage).toHaveBeenCalledWith({
      channel: "D123",
      text: "Conversation reset. Send a new message to start fresh.",
    });
  });

  test("/pi-new in a shared channel is rejected with an ephemeral hint", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    (bot as any).webClient = {
      chat: {
        postEphemeral,
        postMessage: vi.fn().mockResolvedValue({ ts: "3000.0002" }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    await (bot as any).routeSlashNewCommand({
      command: "/pi-new",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(handler.handleNew).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "為了避免誤清除共享上下文，/pi-new 目前只能在與 mama 的私訊中使用。",
    });
  });
});

describe("SlackBot queues follow-up messages", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-slack-queue-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("shared channel mentions are queued while the session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation((sessionKey: string) => sessionKey === "C123");

    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let mentionHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            thread_ts?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("2000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "app_mention") mentionHandler = fn as typeof mentionHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("C123");
    queue.processing = true;
    const ack = vi.fn();

    mentionHandler?.({
      event: {
        text: "<@B123> second request",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).postMessage).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C123",
      sessionKey: "C123",
      text: "second request",
    });
  });

  test("DM follow-up messages are queued while the session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation((sessionKey: string) => sessionKey === "D123");

    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("3000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("D123");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "second request",
        channel: "D123",
        user: "U123",
        ts: "2001.0001",
        channel_type: "im",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).postMessage).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "D123",
      sessionKey: "D123",
      text: "second request",
    });
  });
});

describe("SlackBot attachments", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-slack-attachments-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("waits for attachment downloads before invoking the agent", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let mentionHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            files?: Array<{ name: string; url_private: string }>;
          };
          ack: () => void;
        }) => void)
      | undefined;

    let resolveAttachments!: (attachments: Array<{ original: string; localPath: string }>) => void;
    const attachmentsPromise = new Promise<Array<{ original: string; localPath: string }>>(
      (resolve) => {
        resolveAttachments = resolve;
      },
    );

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue(attachmentsPromise);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "app_mention") mentionHandler = fn as typeof mentionHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();
    mentionHandler?.({
      event: {
        text: "<@B123> 看這個檔案",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        files: [{ name: "clip.mov", url_private: "https://example.com/clip.mov" }],
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    await Promise.resolve();
    expect(handler.handleEvent).not.toHaveBeenCalled();

    resolveAttachments([{ original: "clip.mov", localPath: "C123/attachments/1_clip.mov" }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ original: "clip.mov", localPath: "C123/attachments/1_clip.mov" }],
    });
  });
});
