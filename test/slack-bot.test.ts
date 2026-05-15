import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BotHandler } from "../src/adapter.js";
import { SlackBot } from "../src/adapters/slack/bot.js";
import { createManagedSessionFileAtPath, getThreadSessionFile } from "../src/session-store.js";

function makeHandler(): BotHandler {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    getRunningSessions: vi.fn().mockReturnValue([]),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
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
      vaultConversationId: "C123",
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

    handler.handleNewCommand = vi.fn(async (_sessionKey, conversationId, commandBot) => {
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

    expect(handler.handleNewCommand).toHaveBeenCalledWith("D123", "D123", expect.any(Object));
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

    expect(handler.handleNewCommand).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "為了避免誤清除共享上下文，/pi-new 目前只能在與 mama 的私訊中使用。",
    });
  });

  test("/pi-sandbox in a shared channel routes to command handling ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, adapters) => {
      await adapters.responseCtx.respond("sandbox status");
    });

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
        postMessage: vi.fn().mockResolvedValue({ ts: "3000.0003" }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);

    await (bot as any).routeSlashSandboxCommand({
      command: "/pi-sandbox",
      text: "boost",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "dm",
      conversationId: "C123",
      conversationKind: "shared",
      sessionKey: "C123",
      text: "/pi-sandbox boost",
    });
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "sandbox status",
    });
  });

  test("/pi-session in a shared channel returns the link ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, adapters) => {
      await adapters.responseCtx.respond("session link");
    });

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
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);

    await (bot as any).routeSlashSessionCommand({
      command: "/pi-session",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "dm",
      conversationId: "C123",
      conversationKind: "shared",
      sessionKey: "C123",
      text: "/pi-session",
    });
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "session link",
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
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
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

  test("shared channel mentions preserve mentions of other users", async () => {
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
            thread_ts?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "app_mention") mentionHandler = fn as typeof mentionHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();

    mentionHandler?.({
      event: {
        text: "<@B123> ask <@U999> about this",
        channel: "C123",
        user: "U123",
        ts: "1001.00015",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();

    const queue = (bot as any).getQueue("C123");
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      text: "ask <@U999> about this",
    });
  });

  test("first shared-channel thread reply waits behind the channel queue until the thread session exists", async () => {
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
            thread_ts?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
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
        text: "<@B123> thread request",
        channel: "C123",
        user: "U123",
        ts: "1001.0002",
        thread_ts: "1000.0001",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel bare thread replies trigger without a mention after the thread session exists", async () => {
    const handler = makeHandler();

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
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const conversationDir = join(workingDir, "C123");
    createManagedSessionFileAtPath(join(conversationDir, "session.jsonl"), conversationDir);
    createManagedSessionFileAtPath(
      getThreadSessionFile(conversationDir, "C123:1000.0001"),
      conversationDir,
    );

    const queue = (bot as any).getQueue("C123:1000.0001");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "thread follow-up",
        channel: "C123",
        user: "U123",
        ts: "1001.0003",
        thread_ts: "1000.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C123",
      sessionKey: "C123:1000.0001",
      text: "thread follow-up",
      thread_ts: "1000.0001",
    });
  });

  test("external Slack app bot messages are logged but do not trigger mama", async () => {
    const handler = makeHandler();

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
            subtype?: string;
            bot_id?: string;
            app_id?: string;
            username?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "U_MAMA";
    (bot as any).botId = "B_MAMA";
    (bot as any).logExternalBotMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();
    messageHandler?.({
      event: {
        text: "Test Issue\nProject: pi-agent",
        channel: "C123",
        ts: "1001.0003",
        subtype: "bot_message",
        bot_id: "B_SENTRY",
        app_id: "A_SENTRY",
        username: "Sentry",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).logExternalBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bot_id: "B_SENTRY", username: "Sentry" }),
    );
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel replies in synthetic event thread reuse the event session", async () => {
    const handler = makeHandler();

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
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };
    (bot as any).rememberSyntheticThreadSession("C123", "2000.0001", "C123:event-reminder");

    (bot as any).setupEventHandlers();

    const ack = vi.fn();
    messageHandler?.({
      event: {
        text: "收到，我回來了",
        channel: "C123",
        user: "U123",
        ts: "2000.0002",
        thread_ts: "2000.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C123",
      sessionKey: "C123:event-reminder",
      text: "收到，我回來了",
      thread_ts: "2000.0001",
    });
  });

  test("shared-channel bare thread replies do not trigger for unrelated threads", async () => {
    const handler = makeHandler();

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
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "unrelated thread follow-up",
        channel: "C123",
        user: "U123",
        ts: "1001.0003",
        thread_ts: "1000.0009",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).getQueue("C123").size()).toBe(0);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel bare thread replies still trigger while that thread session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (sessionKey: string) => sessionKey === "C123:1000.0001",
    );

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
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("C123");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "thread follow-up",
        channel: "C123",
        user: "U123",
        ts: "1001.0003",
        thread_ts: "1000.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("DM follow-up messages are queued while the top-level DM session is running", async () => {
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

  test("first DM thread reply waits behind the top-level DM queue until the thread session exists", async () => {
    const handler = makeHandler();

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
            thread_ts?: string;
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
        text: "thread request",
        channel: "D123",
        user: "U123",
        ts: "2001.0001",
        thread_ts: "2000.0001",
        channel_type: "im",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("DM thread follow-up messages are queued on the thread session key once the thread session exists", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (sessionKey: string) => sessionKey === "D123:2000.0001",
    );

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
            thread_ts?: string;
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

    createManagedSessionFileAtPath(
      getThreadSessionFile(join(workingDir, "D123"), "D123:2000.0001"),
      join(workingDir, "D123"),
    );

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("D123:2000.0001");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "thread request",
        channel: "D123",
        user: "U123",
        ts: "2001.0001",
        thread_ts: "2000.0001",
        channel_type: "im",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "D123",
      sessionKey: "D123:2000.0001",
      text: "thread request",
      thread_ts: "2000.0001",
    });
  });
});

describe("SlackBot backfill", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-slack-backfill-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("backfill preserves threadTs for thread replies", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {
        processAttachments: vi.fn().mockResolvedValue([]),
      } as any,
    });

    (bot as any).botUserId = "B123";
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);
    (bot as any).webClient = {
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [
            {
              user: "U123",
              text: "reply in thread",
              ts: "1000.0002",
              thread_ts: "1000.0001",
            },
          ],
          response_metadata: {},
        }),
      },
    };

    const count = await (bot as any).backfillChannel("C123");

    expect(count).toBe(1);
    const logContent = readFileSync(join(workingDir, "C123", "log.jsonl"), "utf-8");
    expect(logContent).toContain('"threadTs":"1000.0001"');
  });

  test("backfill logs external app bot messages", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {
        processAttachments: vi.fn().mockResolvedValue([]),
      } as any,
    });

    (bot as any).botUserId = "U_MAMA";
    (bot as any).botId = "B_MAMA";
    (bot as any).webClient = {
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [
            {
              bot_id: "B_SENTRY",
              app_id: "A_SENTRY",
              username: "Sentry",
              subtype: "bot_message",
              text: "[pi-agent] Test Issue",
              blocks: [
                {
                  type: "section",
                  text: { type: "mrkdwn", text: "*Test Issue*\npoll(.../sentry/scripts/views.js)" },
                },
                {
                  type: "section",
                  fields: [
                    { type: "mrkdwn", text: "*State:* New" },
                    { type: "mrkdwn", text: "*Short ID:* PI-AGENT-A" },
                  ],
                },
              ],
              ts: "1000.0002",
            },
          ],
          response_metadata: {},
        }),
      },
    };

    const count = await (bot as any).backfillChannel("C123");

    expect(count).toBe(1);
    const logContent = readFileSync(join(workingDir, "C123", "log.jsonl"), "utf-8");
    expect(logContent).toContain('"userName":"Sentry"');
    expect(logContent).toContain("[pi-agent] Test Issue");
    expect(logContent).toContain("poll(.../sentry/scripts/views.js)");
    expect(logContent).toContain("PI-AGENT-A");
    expect(logContent).toContain('"botId":"B_SENTRY"');
  });

  test("backfill preserves mentions of other users while stripping mama", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {
        processAttachments: vi.fn().mockResolvedValue([]),
      } as any,
    });

    (bot as any).botUserId = "B123";
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);
    (bot as any).webClient = {
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [
            {
              user: "U123",
              text: "<@B123> ask <@U999> about this",
              ts: "1000.0002",
            },
          ],
          response_metadata: {},
        }),
      },
    };

    const count = await (bot as any).backfillChannel("C123");

    expect(count).toBe(1);
    const logContent = readFileSync(join(workingDir, "C123", "log.jsonl"), "utf-8");
    expect(logContent).toContain('"text":"ask <@U999> about this"');
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
