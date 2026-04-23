import { describe, expect, test, vi } from "vitest";
import type { SlackBot, SlackEvent } from "../src/adapters/slack/bot.js";
import { createSlackAdapters } from "../src/adapters/slack/context.js";

// ============================================================================
// Minimal SlackBot mock
// ============================================================================

function makeSlackBot(overrides: Partial<SlackBot> = {}): SlackBot {
  return {
    getUser: vi.fn().mockReturnValue(undefined),
    getAllChannels: vi.fn().mockReturnValue([]),
    getAllUsers: vi.fn().mockReturnValue([]),
    postMessage: vi.fn().mockResolvedValue("T001"),
    postInThread: vi.fn().mockResolvedValue("T002"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    logBotResponse: vi.fn(),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    getChannel: vi.fn().mockReturnValue(undefined),
    enqueueEvent: vi.fn().mockReturnValue(true),
    logToFile: vi.fn(),
    ...overrides,
  } as unknown as SlackBot;
}

function makeEvent(overrides: Partial<SlackEvent> = {}): SlackEvent {
  return {
    type: "mention",
    channel: "C001",
    ts: "1000.0001",
    user: "U001",
    text: "hello",
    ...overrides,
  };
}

// ============================================================================
// Session key derivation
// ============================================================================

describe("session key derivation", () => {
  test("top-level mention uses persistent channel session", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: undefined });
    const bot = makeSlackBot();
    const { message } = createSlackAdapters(event, bot);
    expect(message.sessionKey).toBe("C001");
  });

  test("thread reply uses isolated per-thread session", () => {
    const bot = makeSlackBot();
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { message } = createSlackAdapters(event, bot);
    expect(message.sessionKey).toBe("C001:1000.0001");
  });

  test("different threads produce different session keys", () => {
    const event1 = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const event2 = makeEvent({ ts: "1000.0006", thread_ts: "1000.0004" });
    const { message: m1 } = createSlackAdapters(event1, makeSlackBot());
    const { message: m2 } = createSlackAdapters(event2, makeSlackBot());
    expect(m1.sessionKey).toBe("C001:1000.0001");
    expect(m2.sessionKey).toBe("C001:1000.0004");
    expect(m1.sessionKey).not.toBe(m2.sessionKey);
  });

  test("message id is always event.ts (not thread_ts)", () => {
    const event = makeEvent({ ts: "1000.0005", thread_ts: "1000.0001" });
    const { message } = createSlackAdapters(event, makeSlackBot());
    expect(message.id).toBe("1000.0005");
  });
});

// ============================================================================
// respond() routing
// ============================================================================

describe("respond() — non-threaded", () => {
  test("first call posts in-thread under the user's message", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("hello"),
    );
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  test("subsequent calls update the same message", async () => {
    const bot = makeSlackBot({ postInThread: vi.fn().mockResolvedValue("MSG1") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("first");
    await responseCtx.respond("second");
    expect(bot.postInThread).toHaveBeenCalledTimes(1);
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "C001",
      "MSG1",
      expect.stringContaining("second"),
    );
  });
});

describe("respond() — threaded", () => {
  test("first call posts in user's thread (rootTs)", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("hello"),
    );
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  test("subsequent calls update the in-thread message", async () => {
    const bot = makeSlackBot({ postInThread: vi.fn().mockResolvedValue("THREAD_MSG1") });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("first");
    await responseCtx.respond("second");
    expect(bot.postInThread).toHaveBeenCalledTimes(1);
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "C001",
      "THREAD_MSG1",
      expect.stringContaining("second"),
    );
  });
});

// ============================================================================
// respondInThread() — thread anchor
// ============================================================================

describe("respondInThread()", () => {
  test("non-threaded: anchors to event.ts (rootTs), not bot message ts", async () => {
    const postInThreadMock = vi
      .fn()
      .mockResolvedValueOnce("BOT_MSG")
      .mockResolvedValueOnce("THREAD_MSG");
    const bot = makeSlackBot({ postInThread: postInThreadMock });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondInThread("detail");
    // respondInThread always uses rootTs (event.ts), not the bot reply ts
    expect(postInThreadMock).toHaveBeenNthCalledWith(
      2,
      "C001",
      "1000.0001",
      expect.stringContaining("detail"),
    );
  });

  test("threaded: anchors to rootTs (user's thread root), not bot message ts", async () => {
    const bot = makeSlackBot({ postInThread: vi.fn().mockResolvedValue("BOT_THREAD_MSG") });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("main");
    vi.clearAllMocks();
    await responseCtx.respondInThread("detail");
    // Always anchored to rootTs (1000.0001), not the bot message ts
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("detail"),
    );
  });

  test("non-threaded: anchors to event.ts even without a prior respond()", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    // rootTs is always available (event.ts), so respondInThread posts immediately
    await responseCtx.respondInThread("detail");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("detail"),
    );
  });

  test("event without thread root falls back to bot message thread after initial post", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("BOT_MSG") });
    const event = makeEvent({ ts: "event:reminder.json", thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot, true);
    await responseCtx.respond("main");
    await responseCtx.respondInThread("detail");
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("main"));
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "BOT_MSG",
      expect.stringContaining("detail"),
    );
  });
});

// ============================================================================
// setTyping()
// ============================================================================

describe("setTyping()", () => {
  test("non-threaded: sets assistant status only", async () => {
    const bot = makeSlackBot({ setAssistantStatus: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("threaded: sets assistant status only", async () => {
    const bot = makeSlackBot({ setAssistantStatus: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("setTyping(false) does nothing", async () => {
    const bot = makeSlackBot();
    const event = makeEvent();
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(false);
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("setTyping(true) after message exists does nothing", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true); // creates message
    vi.clearAllMocks();
    await responseCtx.setTyping(true); // should be no-op
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  test("event without thread root skips assistant status and posts top-level message", async () => {
    const bot = makeSlackBot({
      postMessage: vi.fn().mockResolvedValue("BOT_MSG"),
      setAssistantStatus: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ ts: "event:reminder.json", thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot, true);
    await responseCtx.setTyping(true);
    expect(bot.setAssistantStatus).not.toHaveBeenCalled();
    await responseCtx.respond("hello");
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("hello"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Text accumulation and truncation
// ============================================================================

describe("text accumulation", () => {
  test("multiple respond() calls accumulate text with newlines", async () => {
    const bot = makeSlackBot({ postInThread: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("line1");
    await responseCtx.respond("line2");
    // Second call should update with accumulated text
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).toContain("line1");
    expect(updateCall[2]).toContain("line2");
  });

  test("replaceResponse() replaces accumulated text entirely", async () => {
    const bot = makeSlackBot({ postInThread: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("original text");
    await responseCtx.replaceResponse("replacement");
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).not.toContain("original text");
    expect(updateCall[2]).toContain("replacement");
  });

  test("text is truncated at 35K chars with truncation note", async () => {
    const bot = makeSlackBot({ postInThread: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    const longText = "x".repeat(36000);
    await responseCtx.respond(longText);
    const postedText = vi.mocked(bot.postInThread).mock.calls[0][2] as string;
    expect(postedText.length).toBeLessThan(36000);
    expect(postedText).toContain("message truncated");
  });
});

// ============================================================================
// deleteResponse()
// ============================================================================

describe("deleteResponse()", () => {
  test("deletes main message and all thread messages", async () => {
    const bot = makeSlackBot({
      postInThread: vi
        .fn()
        .mockResolvedValueOnce("MAIN") // from respond()
        .mockResolvedValueOnce("THREAD1"), // from respondInThread()
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondInThread("detail");
    await responseCtx.deleteResponse();
    expect(bot.deleteMessage).toHaveBeenCalledWith("C001", "THREAD1");
    expect(bot.deleteMessage).toHaveBeenCalledWith("C001", "MAIN");
  });

  test("does nothing if no message was created", async () => {
    const bot = makeSlackBot();
    const event = makeEvent();
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.deleteResponse();
    expect(bot.deleteMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// PlatformInfo
// ============================================================================

describe("platform info", () => {
  test("name is 'slack'", () => {
    const { platform } = createSlackAdapters(makeEvent(), makeSlackBot());
    expect(platform.name).toBe("slack");
  });

  test("channels and users come from SlackBot", () => {
    const bot = makeSlackBot({
      getAllChannels: vi.fn().mockReturnValue([{ id: "C001", name: "general" }]),
      getAllUsers: vi
        .fn()
        .mockReturnValue([{ id: "U001", userName: "alice", displayName: "Alice" }]),
    });
    const { platform } = createSlackAdapters(makeEvent(), bot);
    expect(platform.channels).toEqual([{ id: "C001", name: "general" }]);
    expect(platform.users).toEqual([{ id: "U001", userName: "alice", displayName: "Alice" }]);
  });
});

// ============================================================================
// Cross-thread isolation (Phase 1: 高優先級)
// ============================================================================

describe("cross-channel isolation", () => {
  test("top-level mentions in same channel share channel session, thread replies are isolated", () => {
    const topLevel = makeEvent({ ts: "1000.0001", thread_ts: undefined });
    const threadReply = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const bot = makeSlackBot();
    expect(createSlackAdapters(topLevel, bot).message.sessionKey).toBe("C001");
    expect(createSlackAdapters(threadReply, bot).message.sessionKey).toBe("C001:1000.0001");
  });
});

// ============================================================================
// Same-thread multi-round follow-up (Phase 1: 高優先級)
// ============================================================================

describe("same-thread multi-round follow-up", () => {
  test("subsequent message in same thread should preserve rootTs", () => {
    const event1 = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001", text: "first" });
    const event2 = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001", text: "second" });
    const bot = makeSlackBot();
    const { message: msg1 } = createSlackAdapters(event1, bot);
    const { message: msg2 } = createSlackAdapters(event2, bot);
    expect(msg1.sessionKey).toBe(msg2.sessionKey);
  });

  test("respondInThread uses correct rootTs for same-thread follow-up", async () => {
    const bot = makeSlackBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respondInThread("reply");
    expect(bot.postInThread).toHaveBeenCalledWith("C001", "1000.0001", expect.any(String));
  });

  test("multiple respondInThread calls should all go to same thread", async () => {
    const bot = makeSlackBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respondInThread("reply 1");
    await responseCtx.respondInThread("reply 2");
    await responseCtx.respondInThread("reply 3");
    expect(bot.postInThread).toHaveBeenCalledTimes(3);
    // All calls should use same rootTs
    expect(bot.postInThread).toHaveBeenCalledWith("C001", "1000.0001", expect.any(String));
  });
});

// ============================================================================
// thread_ts boundary values (Phase 1: 高優先級)
// ============================================================================

describe("thread_ts boundary values", () => {
  test("no thread_ts → bare channelId session", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: undefined });
    expect(createSlackAdapters(event, makeSlackBot()).message.sessionKey).toBe("C001");
  });

  test("with thread_ts → channelId:thread_ts session", () => {
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    expect(createSlackAdapters(event, makeSlackBot()).message.sessionKey).toBe("C001:1000.0001");
  });

  test("empty string thread_ts is treated as no thread (falsy)", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: "" });
    expect(createSlackAdapters(event, makeSlackBot()).message.sessionKey).toBe("C001");
  });

  test("DM channel should share a single persistent session across messages", () => {
    const event1 = makeEvent({ channel: "D001", ts: "1000.0001", thread_ts: undefined });
    const event2 = makeEvent({ channel: "D001", ts: "1000.0002", thread_ts: undefined });
    const bot = makeSlackBot();
    const { message: msg1 } = createSlackAdapters(event1, bot);
    const { message: msg2 } = createSlackAdapters(event2, bot);
    expect(msg1.sessionKey).toBe("D001");
    expect(msg2.sessionKey).toBe("D001");
  });

  test("setTyping in thread should set assistant status with correct rootTs", async () => {
    const bot = makeSlackBot({
      setAssistantStatus: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
  });

  test("uploadFile in thread should use correct rootTs", async () => {
    const bot = makeSlackBot({
      uploadFile: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.uploadFile("/path/to/file.txt", "test");
    expect(bot.uploadFile).toHaveBeenCalledWith("C001", "/path/to/file.txt", "test", "1000.0001");
  });
});
