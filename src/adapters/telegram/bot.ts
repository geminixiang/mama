import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { Bot as GrammyBot, InputFile } from "grammy";
import type { Bot, BotEvent, BotHandler, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import { createTelegramAdapters } from "./context.js";

// ============================================================================
// Types
// ============================================================================

export interface TelegramEvent extends BotEvent {
  type: "message" | "command";
  userName?: string;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
  private queue: QueuedWork[] = [];
  private processing = false;

  enqueue(work: QueuedWork): void {
    this.queue.push(work);
    this.processNext();
  }

  size(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const work = this.queue.shift()!;
    try {
      await work();
    } catch (err) {
      log.logWarning("Telegram queue error", err instanceof Error ? err.message : String(err));
    }
    this.processing = false;
    this.processNext();
  }
}

// ============================================================================
// TelegramBot
// ============================================================================

export class TelegramBot implements Bot {
  private client: GrammyBot;
  private handler: BotHandler;
  private workingDir: string;
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private queues = new Map<string, ChannelQueue>();
  private startupTime: number = 0;

  constructor(handler: BotHandler, config: { token: string; workingDir: string }) {
    this.handler = handler;
    this.workingDir = config.workingDir;
    this.client = new GrammyBot(config.token);
    this.client.catch((err) => {
      log.logWarning("Telegram error", err instanceof Error ? err.message : String(err));
    });
  }

  // ==========================================================================
  // Public API (implements Bot)
  // ==========================================================================

  async start(): Promise<void> {
    const me = await this.client.api.getMe();
    this.botUserId = String(me.id);
    this.botUsername = me.username ?? null;
    this.startupTime = Date.now();

    this.setupEventHandlers();

    // Start polling in background (bot.start() runs indefinitely)
    this.client.start().catch((err) => {
      log.logWarning("Telegram polling error", err instanceof Error ? err.message : String(err));
    });

    log.logConnected();
    log.logInfo(`Telegram bot started as @${this.botUsername ?? this.botUserId}`);
  }

  async postMessage(channel: string, text: string): Promise<string> {
    const result = await this.postMessageRaw(parseInt(channel), text);
    return String(result);
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    try {
      await this.client.api.editMessageText(parseInt(channel), parseInt(ts), text, {
        parse_mode: "HTML",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("message is not modified")) {
        throw err;
      }
    }
  }

  enqueueEvent(event: BotEvent): boolean {
    const queue = this.getQueue(event.channel);
    if (queue.size() >= 5) {
      log.logWarning(
        `Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`,
      );
      return false;
    }
    log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
    queue.enqueue(() => {
      const adapters = createTelegramAdapters(event as TelegramEvent, this, true);
      return this.handler.handleEvent(event, this, adapters, true);
    });
    return true;
  }

  getPlatformInfo(): PlatformInfo {
    return {
      name: "telegram",
      formattingGuide:
        '## Telegram Formatting (HTML mode)\nBold: <b>text</b>, Italic: <i>text</i>, Code: <code>code</code>, Pre: <pre>code</pre>\nLinks: <a href="url">text</a>',
      channels: [],
      users: [],
    };
  }

  // ==========================================================================
  // Internal helpers (used by context.ts)
  // ==========================================================================

  async postMessageRaw(chatId: number, text: string): Promise<number> {
    const result = await this.client.api.sendMessage(chatId, text, { parse_mode: "HTML" });
    return result.message_id;
  }

  async postReply(chatId: number, replyToMessageId: number, text: string): Promise<number> {
    const result = await this.client.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_parameters: { message_id: replyToMessageId },
    });
    return result.message_id;
  }

  async deleteMessageRaw(chatId: number, messageId: number): Promise<void> {
    await this.client.api.deleteMessage(chatId, messageId);
  }

  async sendTyping(chatId: number): Promise<void> {
    await this.client.api.sendChatAction(chatId, "typing");
  }

  async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
    const fileName = title ?? basename(filePath);
    const fileContent = readFileSync(filePath);
    await this.client.api.sendDocument(parseInt(channel), new InputFile(fileContent, fileName));
  }

  logToFile(channel: string, entry: object): void {
    const dir = join(this.workingDir, channel);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  logBotResponse(channel: string, text: string, ts: string): void {
    this.logToFile(channel, {
      date: new Date().toISOString(),
      ts,
      user: "bot",
      text,
      attachments: [],
      isBot: true,
    });
  }

  // ==========================================================================
  // Private - Event Handlers
  // ==========================================================================

  private getQueue(channelId: string): ChannelQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new ChannelQueue();
      this.queues.set(channelId, queue);
    }
    return queue;
  }

  private isAddressedToBot(text: string, chatType: string): boolean {
    if (chatType === "private") return true;
    if (!this.botUsername) return false;
    return text.includes(`@${this.botUsername}`);
  }

  private cleanText(text: string): string {
    if (!this.botUsername) return text.trim();
    return text.replace(new RegExp(`@${this.botUsername}`, "g"), "").trim();
  }

  private setupEventHandlers(): void {
    this.client.on("message", (ctx) => {
      const msg = ctx.message;

      // Skip messages from before startup (Telegram replays recent messages on poll start)
      if (msg.date * 1000 < this.startupTime) return;
      // Skip bot messages
      if (msg.from?.is_bot) return;

      const text = msg.text ?? msg.caption ?? "";
      if (!text && !msg.document && !msg.photo) return;

      const chatId = String(msg.chat.id);
      const chatType = msg.chat.type;
      const userId = String(msg.from?.id ?? "unknown");
      const userName = msg.from?.username ?? msg.from?.first_name ?? userId;
      const msgId = String(msg.message_id);

      // Determine thread: if this is a reply, use parent message_id as thread_ts
      const replyToId = msg.reply_to_message?.message_id;
      const threadTs = replyToId ? String(replyToId) : undefined;

      // Check if addressed to bot
      if (!this.isAddressedToBot(text, chatType)) return;

      const cleanedText = this.cleanText(text);
      const sessionKey = `${chatId}:${threadTs ?? msgId}`;

      const event: TelegramEvent = {
        type: "message",
        channel: chatId,
        ts: msgId,
        thread_ts: threadTs,
        user: userId,
        userName,
        text: cleanedText,
      };

      // Log the message
      this.logToFile(chatId, {
        date: new Date(msg.date * 1000).toISOString(),
        ts: msgId,
        user: userId,
        userName,
        text: cleanedText,
        attachments: [],
        isBot: false,
      });

      // Handle /stop command
      if (cleanedText.toLowerCase() === "/stop" || cleanedText.toLowerCase() === "stop") {
        if (this.handler.isRunning(sessionKey)) {
          this.handler.handleStop(sessionKey, chatId, this);
        } else {
          this.postMessage(chatId, "Nothing running.");
        }
        return;
      }

      if (this.handler.isRunning(sessionKey)) {
        this.postMessage(chatId, "Already working. Say <code>stop</code> to cancel.");
      } else {
        this.getQueue(sessionKey).enqueue(() => {
          const adapters = createTelegramAdapters(event, this, false);
          return this.handler.handleEvent(event, this, adapters, false);
        });
      }
    });
  }
}
