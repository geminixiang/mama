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
    registerThreadAlias: vi.fn(),
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
  test("non-threaded event: sessionKey = channelId:ts", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: undefined });
    const { message } = createSlackAdapters(event, makeSlackBot());
    expect(message.sessionKey).toBe("C001:1000.0001");
  });

  test("threaded event: sessionKey = channelId:thread_ts", () => {
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { message } = createSlackAdapters(event, makeSlackBot());
    expect(message.sessionKey).toBe("C001:1000.0001");
  });

  test("different threads in same channel produce different session keys", () => {
    const event1 = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const event2 = makeEvent({ ts: "1000.0006", thread_ts: "1000.0004" });
    const { message: m1 } = createSlackAdapters(event1, makeSlackBot());
    const { message: m2 } = createSlackAdapters(event2, makeSlackBot());
    expect(m1.sessionKey).not.toBe(m2.sessionKey);
    expect(m1.sessionKey).toBe("C001:1000.0001");
    expect(m2.sessionKey).toBe("C001:1000.0004");
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
  test("first call posts to channel (not in thread)", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("hello"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("subsequent calls update the same message", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("MSG1") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("first");
    await responseCtx.respond("second");
    expect(bot.postMessage).toHaveBeenCalledTimes(1);
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
  test("non-threaded: anchors to bot's main message ts", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("BOT_MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    // Must call respond() first to create the main message
    await responseCtx.respond("main");
    await responseCtx.respondInThread("detail");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "BOT_MSG",
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

  test("non-threaded: does nothing if no main message posted yet", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respondInThread("detail");
    expect(bot.postInThread).not.toHaveBeenCalled();
  });
});

// ============================================================================
// setTyping()
// ============================================================================

describe("setTyping()", () => {
  test("non-threaded: posts to channel", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("_Thinking_"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("threaded: posts in user's thread", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("_Thinking_"),
    );
    expect(bot.postMessage).not.toHaveBeenCalled();
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
});

// ============================================================================
// Text accumulation and truncation
// ============================================================================

describe("text accumulation", () => {
  test("multiple respond() calls accumulate text with newlines", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
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
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("original text");
    await responseCtx.replaceResponse("replacement");
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).not.toContain("original text");
    expect(updateCall[2]).toContain("replacement");
  });

  test("text is truncated at 35K chars with truncation note", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    const longText = "x".repeat(36000);
    await responseCtx.respond(longText);
    const postedText = vi.mocked(bot.postMessage).mock.calls[0][1] as string;
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
      postMessage: vi.fn().mockResolvedValue("MAIN"),
      postInThread: vi.fn().mockResolvedValue("THREAD1"),
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

describe("cross-thread isolation", () => {
  test("different thread_ts in same channel should have different sessionKey", () => {
    const event1 = makeEvent({ ts: "1000.0001", thread_ts: "1000.0001" });
    const event2 = makeEvent({ ts: "1000.0002", thread_ts: "1000.0002" });
    const bot = makeSlackBot();
    const { message: msg1 } = createSlackAdapters(event1, bot);
    const { message: msg2 } = createSlackAdapters(event2, bot);
    expect(msg1.sessionKey).not.toBe(msg2.sessionKey);
    expect(msg1.sessionKey).toContain("1000.0001");
    expect(msg2.sessionKey).toContain("1000.0002");
  });

  test("messages in same thread should share same sessionKey", () => {
    const event1 = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const event2 = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const bot = makeSlackBot();
    const { message: msg1 } = createSlackAdapters(event1, bot);
    const { message: msg2 } = createSlackAdapters(event2, bot);
    expect(msg1.sessionKey).toBe(msg2.sessionKey);
  });
});

// ============================================================================
// registerThreadAlias on first respond() (Phase 1: 高優先級)
// ============================================================================

describe("registerThreadAlias on first respond()", () => {
  test("should call registerThreadAlias on first respond() in non-threaded message", async () => {
    const registerThreadAlias = vi.fn();
    const bot = makeSlackBot({
      postMessage: vi.fn().mockResolvedValue("T001"),
      registerThreadAlias,
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(registerThreadAlias).toHaveBeenCalledWith("C001:T001", "C001:1000.0001");
  });

  test("should NOT call registerThreadAlias when responding in existing thread", async () => {
    const registerThreadAlias = vi.fn();
    const bot = makeSlackBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
      registerThreadAlias,
    });
    const event = makeEvent({ thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respondInThread("reply in thread");
    expect(registerThreadAlias).not.toHaveBeenCalled();
  });

  test("should NOT register alias for threaded events (alias only for new threads)", async () => {
    // For threaded events, the session is identified by thread_ts, so no alias needed
    const registerThreadAlias = vi.fn();
    const bot = makeSlackBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
      registerThreadAlias,
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    // respond() uses postInThread for threaded events - no alias needed
    await responseCtx.respond("reply in thread");
    expect(registerThreadAlias).not.toHaveBeenCalled();
  });

  test("should NOT register duplicate alias if messageTs already exists", async () => {
    const registerThreadAlias = vi.fn();
    const bot = makeSlackBot({
      postMessage: vi.fn().mockResolvedValue("T001"),
      postInThread: vi.fn().mockResolvedValue("T002"),
      registerThreadAlias,
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("first");
    await responseCtx.respondInThread("second");
    // Only called once on first respond()
    expect(registerThreadAlias).toHaveBeenCalledTimes(1);
  });

  test("stop command can find session via registerThreadAlias mapping", async () => {
    // This test verifies the alias mechanism works for stop command routing
    const threadAliasMap = new Map<string, string>();
    const bot = makeSlackBot({
      postMessage: vi.fn().mockResolvedValue("T001"),
      registerThreadAlias: vi.fn().mockImplementation((key, alias) => {
        threadAliasMap.set(key, alias);
      }),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("hello");
    // Simulate stop command looking up via alias
    const aliasKey = "C001:T001";
    expect(threadAliasMap.get(aliasKey)).toBe("C001:1000.0001");
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
  test("event without thread_ts should use event.ts as rootTs", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: undefined });
    const { message } = createSlackAdapters(event, makeSlackBot());
    expect(message.sessionKey).toBe("C001:1000.0001");
  });

  test("event with thread_ts should use thread_ts as rootTs", () => {
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { message } = createSlackAdapters(event, makeSlackBot());
    expect(message.sessionKey).toBe("C001:1000.0001");
  });

  test("event with empty string thread_ts is treated as-is (known edge case)", () => {
    // Note: JavaScript ?? operator treats empty string as truthy, so rootTs becomes ""
    // This is a known edge case - empty string !== undefined
    const event = makeEvent({ ts: "1000.0001", thread_ts: "" });
    const { message } = createSlackAdapters(event, makeSlackBot());
    // Current behavior: empty string is used as rootTs (not ideal but expected with ?? operator)
    expect(message.sessionKey).toBe("C001:");
  });

  test("DM channel (no thread_ts) should have unique session per message", () => {
    const event1 = makeEvent({ channel: "D001", ts: "1000.0001", thread_ts: undefined });
    const event2 = makeEvent({ channel: "D001", ts: "1000.0002", thread_ts: undefined });
    const bot = makeSlackBot();
    const { message: msg1 } = createSlackAdapters(event1, bot);
    const { message: msg2 } = createSlackAdapters(event2, bot);
    expect(msg1.sessionKey).not.toBe(msg2.sessionKey);
  });

  test("setTyping in thread should post to correct thread", async () => {
    const bot = makeSlackBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.postInThread).toHaveBeenCalledWith("C001", "1000.0001", expect.any(String));
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
