import { describe, expect, test, vi } from "vitest";
import type { DiscordBot, DiscordEvent } from "../src/adapters/discord/bot.js";
import { createDiscordAdapters } from "../src/adapters/discord/context.js";

// ============================================================================
// Minimal DiscordBot mock
// ============================================================================

function makeDiscordBot(overrides: Partial<DiscordBot> = {}): DiscordBot {
  return {
    postReply: vi.fn().mockResolvedValue("MSG002"),
    postInThread: vi.fn().mockResolvedValue("MSG003"),
    updateMessageRaw: vi.fn().mockResolvedValue(undefined),
    deleteMessageRaw: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    logBotResponse: vi.fn(),
    getAllChannels: vi.fn().mockReturnValue([]),
    getAllUsers: vi.fn().mockReturnValue([]),
    createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH001"),
    postEmbed: vi.fn().mockResolvedValue("EMBED_MSG001"),
    updateMessageWithComponents: vi.fn().mockResolvedValue(undefined),
    // Bot interface stubs
    start: vi.fn(),
    postMessage: vi.fn().mockResolvedValue("MSG001"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    enqueueEvent: vi.fn().mockReturnValue(true),
    getPlatformInfo: vi
      .fn()
      .mockReturnValue({ name: "discord", formattingGuide: "", channels: [], users: [] }),
    ...overrides,
  } as unknown as DiscordBot;
}

function makeEvent(overrides: Partial<DiscordEvent> = {}): DiscordEvent {
  return {
    type: "mention",
    channel: "CH001",
    ts: "MSG001",
    user: "U001",
    text: "hello",
    ...overrides,
  };
}

// ============================================================================
// Session key derivation
// ============================================================================

describe("session key derivation", () => {
  test("non-threaded: sessionKey = channel:ts", () => {
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { message } = createDiscordAdapters(event, makeDiscordBot());
    expect(message.sessionKey).toBe("CH001:MSG001");
  });

  test("threaded: sessionKey = channel:thread_ts", () => {
    const event = makeEvent({ ts: "MSG003", thread_ts: "MSG001" });
    const { message } = createDiscordAdapters(event, makeDiscordBot());
    expect(message.sessionKey).toBe("CH001:MSG001");
  });

  test("message id is always event.ts", () => {
    const event = makeEvent({ ts: "MSG005", thread_ts: "MSG001" });
    const { message } = createDiscordAdapters(event, makeDiscordBot());
    expect(message.id).toBe("MSG005");
  });

  test("different threads in same channel produce different session keys", () => {
    const event1 = makeEvent({ ts: "MSG003", thread_ts: "MSG001" });
    const event2 = makeEvent({ ts: "MSG006", thread_ts: "MSG004" });
    const { message: m1 } = createDiscordAdapters(event1, makeDiscordBot());
    const { message: m2 } = createDiscordAdapters(event2, makeDiscordBot());
    expect(m1.sessionKey).toBe("CH001:MSG001");
    expect(m2.sessionKey).toBe("CH001:MSG004");
    expect(m1.sessionKey).not.toBe(m2.sessionKey);
  });
});

// ============================================================================
// respond() routing
// ============================================================================

describe("respond() — non-threaded (replies to trigger message)", () => {
  test("first call posts as reply to the trigger message", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(bot.postReply).toHaveBeenCalledWith("CH001", "MSG001", expect.stringContaining("hello"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("first call auto-creates thread on reply message", async () => {
    const bot = makeDiscordBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(bot.createThreadOnMessage).toHaveBeenCalledWith(
      "CH001",
      "REPLY001",
      "🤖 unknown · hello",
    );
  });

  test("subsequent calls update the same message", async () => {
    const bot = makeDiscordBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("first");
    await responseCtx.respond("second");
    expect(bot.postReply).toHaveBeenCalledTimes(1);
    // While working, updates go through updateMessageWithComponents (with stop button)
    expect(bot.updateMessageWithComponents).toHaveBeenCalledWith(
      "CH001",
      "REPLY001",
      expect.stringContaining("second"),
      expect.any(Array),
    );
  });

  test("update call accumulates text with newline", async () => {
    const bot = makeDiscordBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("line1");
    await responseCtx.respond("line2");
    // Second respond triggers an update (first may be the button attachment after initial post)
    const calls = vi.mocked(bot.updateMessageWithComponents).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toContain("line1");
    expect(lastCall[2]).toContain("line2");
  });
});

describe("respond() — threaded", () => {
  test("first call posts in thread", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ ts: "MSG003", thread_ts: "THREAD001" });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "CH001",
      "THREAD001",
      expect.stringContaining("hello"),
    );
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("subsequent calls update the thread message", async () => {
    const bot = makeDiscordBot({ postInThread: vi.fn().mockResolvedValue("THREAD_MSG001") });
    const event = makeEvent({ ts: "MSG003", thread_ts: "THREAD001" });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("first");
    await responseCtx.respond("second");
    // While working, updates go through updateMessageWithComponents (with stop button)
    expect(bot.updateMessageWithComponents).toHaveBeenCalledWith(
      "CH001",
      "THREAD_MSG001",
      expect.stringContaining("second"),
      expect.any(Array),
    );
  });
});

// ============================================================================
// respondInThread()
// ============================================================================

describe("respondInThread()", () => {
  test("posts embed in thread after main message is created", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("BOT_MSG"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondInThread("detail");
    // Should have posted in thread (embed or plain)
    const threadCalls = vi
      .mocked(bot.postInThread)
      .mock.calls.concat(vi.mocked(bot.postEmbed).mock.calls as any[]);
    expect(threadCalls.length).toBeGreaterThan(0);
  });

  test("buffers thread messages posted before main message", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("BOT_MSG"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    // respondInThread before respond — should be buffered
    const threadPromise = responseCtx.respondInThread("buffered detail");
    const respondPromise = responseCtx.respond("main");
    await Promise.all([threadPromise, respondPromise]);
    // After main message + thread creation, buffered message should have been flushed
    const embedCalls = vi.mocked(bot.postEmbed).mock.calls;
    const inThreadCalls = vi.mocked(bot.postInThread).mock.calls;
    const totalThreadPosts =
      embedCalls.length + inThreadCalls.filter((c) => c[0] === "THREAD_CH").length;
    expect(totalThreadPosts).toBeGreaterThan(0);
  });

  test("error messages get red embed", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("BOT_MSG"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondInThread("_Error: something went wrong_");
    expect(bot.postEmbed).toHaveBeenCalledWith(
      "THREAD_CH",
      expect.objectContaining({ color: 0xff4444 }),
    );
  });

  test("muted style gets gray embed", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("BOT_MSG"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondInThread("Usage: 100 tokens", { style: "muted" });
    expect(bot.postEmbed).toHaveBeenCalledWith(
      "THREAD_CH",
      expect.objectContaining({ color: 0x808080 }),
    );
  });

  test("tool success gets green embed", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("BOT_MSG"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondInThread("*✓ readFile*: reading file (200ms)");
    expect(bot.postEmbed).toHaveBeenCalledWith(
      "THREAD_CH",
      expect.objectContaining({ color: 0x44ff44 }),
    );
  });

  test("tool failure gets red embed", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("BOT_MSG"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondInThread("*✗ readFile*: failed (50ms)");
    expect(bot.postEmbed).toHaveBeenCalledWith(
      "THREAD_CH",
      expect.objectContaining({ color: 0xff4444 }),
    );
  });

  test("no main message: buffers (postInThread not called)", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respondInThread("detail");
    expect(bot.postInThread).not.toHaveBeenCalled();
    expect(bot.postEmbed).not.toHaveBeenCalled();
  });

  test("thread creation failure is handled gracefully", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("BOT_MSG"),
      createThreadOnMessage: vi.fn().mockRejectedValue(new Error("no permission")),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    // Should not throw
    await expect(responseCtx.respond("main")).resolves.toBeUndefined();
    // Thread messages should be silently dropped
    await expect(responseCtx.respondInThread("detail")).resolves.toBeUndefined();
    expect(bot.postEmbed).not.toHaveBeenCalled();
  });
});

// ============================================================================
// setTyping()
// ============================================================================

describe("setTyping()", () => {
  // Discord uses persistent typing indicator interval, no initial message
  test("sends typing indicator (persistent)", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
    // Does NOT post initial message - that's done on first respond()
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("setTyping(false) stops typing and allows restart", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    // Start typing
    await responseCtx.setTyping(true);
    // Stop typing (should clear interval internally)
    await responseCtx.setTyping(false);
    vi.clearAllMocks();
    // Start typing again - should call sendTyping (interval was cleared)
    await responseCtx.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
  });

  test("threaded: sends typing indicator", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ ts: "MSG003", thread_ts: "THREAD001" });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("setTyping(false) does nothing", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent();
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setTyping(false);
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
    expect(bot.sendTyping).not.toHaveBeenCalled();
  });

  test("setTyping(true) after message exists does nothing", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setTyping(true); // creates message
    vi.clearAllMocks();
    await responseCtx.setTyping(true); // should be no-op
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.sendTyping).not.toHaveBeenCalled();
  });

  test("event: sends typing indicator", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ text: "[EVENT:deploy.json:immediate:immediate] run deploy" });
    const { responseCtx } = createDiscordAdapters(event, bot, /* isEvent= */ true);
    await responseCtx.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
    // Does NOT post initial message
    expect(bot.postReply).not.toHaveBeenCalled();
  });
});

// ============================================================================
// setWorking()
// ============================================================================

describe("setWorking()", () => {
  test("respond() while working appends indicator", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    // Default isWorking=true
    await responseCtx.respond("content");
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted).toContain(" ...");
  });

  test("setWorking(false) removes indicator and buttons on update", async () => {
    const bot = makeDiscordBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("content");
    await responseCtx.setWorking(false);
    // setWorking(false) uses updateMessageWithComponents with empty components array
    const calls = vi.mocked(bot.updateMessageWithComponents).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).not.toContain(" ...");
    expect(lastCall[2]).toContain("content");
    // Components should be empty (buttons removed)
    expect(lastCall[3]).toEqual([]);
  });
});

// ============================================================================
// replaceResponse()
// ============================================================================

describe("replaceResponse()", () => {
  test("replaces accumulated text entirely", async () => {
    const bot = makeDiscordBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("original text");
    await responseCtx.replaceResponse("replacement");
    const updateCall = vi.mocked(bot.updateMessageRaw).mock.calls[0];
    expect(updateCall[2]).not.toContain("original text");
    expect(updateCall[2]).toContain("replacement");
  });
});

// ============================================================================
// Message splitting (replaces truncation)
// ============================================================================

describe("message splitting", () => {
  test("short text is posted as-is", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setWorking(false);
    await responseCtx.respond("short text");
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted).toBe("short text");
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("long text: first part goes to main message (≤1900 chars)", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("REPLY001"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setWorking(false);
    await responseCtx.respond("x".repeat(2100));
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted.length).toBeLessThanOrEqual(1900);
    // No truncation note
    expect(posted).not.toContain("truncated");
    // Has continued marker
    expect(posted).toContain("continued");
  });

  test("long text: overflow goes to thread", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("REPLY001"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setWorking(false);
    await responseCtx.respond("x".repeat(2100));
    // The overflow part should be posted in thread
    expect(bot.postInThread).toHaveBeenCalledWith("THREAD_CH", "THREAD_CH", expect.any(String));
  });

  test("text exactly at 1900 chars is not split when not working", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setWorking(false);
    await responseCtx.respond("x".repeat(1900));
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted.length).toBe(1900);
    expect(posted).not.toContain("continued");
  });

  test("text at 1901 chars is split", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("REPLY001"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.setWorking(false);
    await responseCtx.respond("x".repeat(1901));
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted.length).toBeLessThanOrEqual(1900);
    expect(posted).toContain("continued");
  });
});

// ============================================================================
// deleteResponse()
// ============================================================================

describe("deleteResponse()", () => {
  test("deletes main message", async () => {
    const bot = makeDiscordBot({
      postReply: vi.fn().mockResolvedValue("MAIN_MSG"),
      createThreadOnMessage: vi.fn().mockResolvedValue("THREAD_CH"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.deleteResponse();
    expect(bot.deleteMessageRaw).toHaveBeenCalledWith("CH001", "MAIN_MSG");
    expect(bot.deleteMessageRaw).toHaveBeenCalledTimes(1);
  });

  test("does nothing if no message was created", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent();
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.deleteResponse();
    expect(bot.deleteMessageRaw).not.toHaveBeenCalled();
  });
});

// ============================================================================
// PlatformInfo
// ============================================================================

describe("platform info", () => {
  test("name is 'discord'", () => {
    const { platform } = createDiscordAdapters(makeEvent(), makeDiscordBot());
    expect(platform.name).toBe("discord");
  });

  test("formattingGuide mentions markdown syntax", () => {
    const { platform } = createDiscordAdapters(makeEvent(), makeDiscordBot());
    expect(platform.formattingGuide).toContain("**");
  });

  test("channels and users come from DiscordBot", () => {
    const bot = makeDiscordBot({
      getAllChannels: vi.fn().mockReturnValue([{ id: "CH001", name: "general" }]),
      getAllUsers: vi
        .fn()
        .mockReturnValue([{ id: "U001", userName: "alice", displayName: "Alice" }]),
    });
    const { platform } = createDiscordAdapters(makeEvent(), bot);
    expect(platform.channels).toEqual([{ id: "CH001", name: "general" }]);
    expect(platform.users).toEqual([{ id: "U001", userName: "alice", displayName: "Alice" }]);
  });
});

// ============================================================================
// uploadFile()
// ============================================================================

describe("uploadFile()", () => {
  test("calls bot.uploadFile with channel, path, and title", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.uploadFile("/path/to/file.txt", "My File");
    expect(bot.uploadFile).toHaveBeenCalledWith("CH001", "/path/to/file.txt", "My File");
  });

  test("calls bot.uploadFile without title", async () => {
    const bot = makeDiscordBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createDiscordAdapters(event, bot);
    await responseCtx.uploadFile("/path/to/image.png");
    expect(bot.uploadFile).toHaveBeenCalledWith("CH001", "/path/to/image.png", undefined);
  });
});

// ============================================================================
// ChatMessage fields
// ============================================================================

describe("message fields", () => {
  test("userId and userName are populated from event", () => {
    const event = makeEvent({ user: "U999", userName: "bob" });
    const { message } = createDiscordAdapters(event, makeDiscordBot());
    expect(message.userId).toBe("U999");
    expect(message.userName).toBe("bob");
  });

  test("text matches event.text", () => {
    const event = makeEvent({ text: "what is 2+2?" });
    const { message } = createDiscordAdapters(event, makeDiscordBot());
    expect(message.text).toBe("what is 2+2?");
  });

  test("attachments are populated from event", () => {
    const attachments = [{ name: "file.txt", localPath: "/tmp/file.txt" }];
    const event = makeEvent({ attachments });
    const { message } = createDiscordAdapters(event, makeDiscordBot());
    expect(message.attachments).toEqual(attachments);
  });
});
