import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BotHandler } from "../src/adapter.js";
import { TelegramBot } from "../src/adapters/telegram/bot.js";

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

// Helper: build a fake Telegram message object
function makeMessage(overrides: Record<string, any> = {}) {
  return {
    message_id: 100,
    date: Math.floor(Date.now() / 1000) + 10,
    chat: { id: 123, type: "private" },
    from: { id: 42, is_bot: false, username: "alice", first_name: "Alice" },
    text: "hello",
    ...overrides,
  };
}

describe("TelegramBot extractMessageContext", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-telegram-ctx-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("returns null for null/undefined message", () => {
    const bot = new TelegramBot(makeHandler(), { token: "T", workingDir });
    const extract = (bot as any).extractMessageContext.bind(bot);
    expect(extract(null)).toBeNull();
    expect(extract(undefined)).toBeNull();
  });

  test("returns null for messages before startup time", () => {
    const bot = new TelegramBot(makeHandler(), { token: "T", workingDir });
    (bot as any).startupTime = Date.now() + 60_000;
    const extract = (bot as any).extractMessageContext.bind(bot);
    const msg = makeMessage({ date: Math.floor(Date.now() / 1000) });
    expect(extract(msg)).toBeNull();
  });

  test("returns null for bot messages", () => {
    const bot = new TelegramBot(makeHandler(), { token: "T", workingDir });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);
    const msg = makeMessage({ from: { id: 1, is_bot: true, username: "bot" } });
    expect(extract(msg)).toBeNull();
  });

  test("private chat: sessionKey is just chatId (single session)", () => {
    const bot = new TelegramBot(makeHandler(), { token: "T", workingDir });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);

    const msg1 = makeMessage({ message_id: 100 });
    const msg2 = makeMessage({ message_id: 200 });
    expect(extract(msg1).sessionKey).toBe("123");
    expect(extract(msg2).sessionKey).toBe("123");
    // Both produce the same sessionKey — same session!
    expect(extract(msg1).sessionKey).toBe(extract(msg2).sessionKey);
  });

  test("group chat: sessionKey includes msgId (per-message session)", () => {
    const bot = new TelegramBot(makeHandler(), { token: "T", workingDir });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);

    const msg = makeMessage({ chat: { id: 999, type: "group" }, message_id: 50 });
    expect(extract(msg).sessionKey).toBe("999:50");
  });

  test("group chat: reply uses threadTs in sessionKey", () => {
    const bot = new TelegramBot(makeHandler(), { token: "T", workingDir });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);

    const msg = makeMessage({
      chat: { id: 999, type: "group" },
      message_id: 60,
      reply_to_message: { message_id: 50 },
    });
    expect(extract(msg).sessionKey).toBe("999:50");
  });

  test("private chat reply still uses chatId as sessionKey", () => {
    const bot = new TelegramBot(makeHandler(), { token: "T", workingDir });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);

    const msg = makeMessage({ reply_to_message: { message_id: 50 } });
    expect(extract(msg).sessionKey).toBe("123");
    // threadTs is still set for reply targeting
    expect(extract(msg).threadTs).toBe("50");
  });
});

describe("TelegramBot attachments", () => {
  let workingDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-telegram-bot-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("processAttachments waits for downloads and returns completed metadata", async () => {
    const bot = new TelegramBot(makeHandler(), { token: "TEST_TOKEN", workingDir });
    const processTelegramFile = vi
      .fn()
      .mockResolvedValueOnce({ name: "photo_42.jpg", localPath: "123/attachments/1_photo.jpg" })
      .mockResolvedValueOnce({ name: "report.pdf", localPath: "123/attachments/2_report.pdf" });

    (bot as any).processTelegramFile = processTelegramFile;

    const attachments = await bot.processAttachments("123", {
      message_id: 42,
      photo: [{ file_id: "small-photo" }, { file_id: "large-photo" }],
      document: { file_id: "doc-1", file_name: "report.pdf" },
    });

    expect(processTelegramFile).toHaveBeenNthCalledWith(1, "123", "large-photo", "photo_42.jpg");
    expect(processTelegramFile).toHaveBeenNthCalledWith(2, "123", "doc-1", "report.pdf");
    expect(attachments).toEqual([
      { name: "photo_42.jpg", localPath: "123/attachments/1_photo.jpg" },
      { name: "report.pdf", localPath: "123/attachments/2_report.pdf" },
    ]);
  });

  test("processTelegramFile downloads via bot token and writes the attachment", async () => {
    const bot = new TelegramBot(makeHandler(), { token: "TEST_TOKEN", workingDir });
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/file_123.jpg" });
    (bot as any).client = { api: { getFile } };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const attachment = await (bot as any).processTelegramFile("456", "file-id", "photo.jpg");

    expect(getFile).toHaveBeenCalledWith("file-id");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botTEST_TOKEN/photos/file_123.jpg",
      undefined,
    );
    expect(attachment).toMatchObject({
      name: "photo.jpg",
      localPath: expect.stringMatching(/^456\/attachments\/\d+_photo\.jpg$/),
    });

    const savedFile = join(workingDir, attachment.localPath);
    expect(existsSync(savedFile)).toBe(true);
    expect(readFileSync(savedFile)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
