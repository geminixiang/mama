import { readFileSync } from "fs";
import { basename } from "path";
import { Bot as GrammyBot, InputFile } from "grammy";
import type { Bot, BotEvent, BotHandler, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import {
  createAttachmentTarget,
  downloadAttachmentToFile,
  type DownloadedAttachment,
} from "../shared/attachments.js";
import { appendChannelLog, createBotLogEntry } from "../shared/channel-log.js";
import { SerialWorkQueue } from "../shared/serial-queue.js";
import { createTelegramAdapters } from "./context.js";

// ============================================================================
// Types
// ============================================================================

export interface TelegramEvent extends BotEvent {
  type: "message" | "command";
  userName?: string;
}

// ============================================================================
// TelegramBot
// ============================================================================

export class TelegramBot implements Bot {
  private client: GrammyBot;
  private handler: BotHandler;
  private botToken: string;
  private workingDir: string;
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private queues = new Map<string, SerialWorkQueue>();
  private startupTime: number = 0;

  constructor(handler: BotHandler, config: { token: string; workingDir: string }) {
    this.handler = handler;
    this.botToken = config.token;
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
    appendChannelLog(this.workingDir, channel, entry);
  }

  logBotResponse(channel: string, text: string, ts: string): void {
    this.logToFile(channel, createBotLogEntry(text, ts));
  }

  /**
   * Process attachments from a Telegram message
   * Downloads files before returning metadata so the agent can read them immediately
   * Returns format compatible with ChatMessage: { name: string, localPath: string }[]
   */
  async processAttachments(chatId: string, message: any): Promise<DownloadedAttachment[]> {
    const downloads: Array<Promise<DownloadedAttachment | null>> = [];

    // Handle photos (take the largest size for best quality)
    if (message.photo && message.photo.length > 0) {
      const photos = message.photo;
      const photo = photos[photos.length - 1]; // Largest photo
      const fileId = photo.file_id;

      downloads.push(this.processTelegramFile(chatId, fileId, `photo_${message.message_id}.jpg`));
    }

    // Handle documents
    if (message.document) {
      const doc = message.document;
      const fileId = doc.file_id;
      const fileName = doc.file_name ?? `document_${message.message_id}`;

      downloads.push(this.processTelegramFile(chatId, fileId, fileName));
    }

    const attachments = await Promise.all(downloads);
    return attachments.filter(
      (attachment): attachment is { name: string; localPath: string } => attachment !== null,
    );
  }

  /**
   * Download a file from Telegram and return attachment metadata
   */
  private async processTelegramFile(
    chatId: string,
    fileId: string,
    originalName: string,
  ): Promise<DownloadedAttachment | null> {
    try {
      // Get file info from Telegram
      const file = await this.client.api.getFile(fileId);
      if (!file.file_path) {
        log.logWarning("Telegram file has no path", fileId);
        return null;
      }

      const target = createAttachmentTarget(this.workingDir, chatId, originalName, Date.now());

      // Construct download URL
      const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

      await downloadAttachmentToFile(target.directory, target.filename, downloadUrl);

      return {
        name: originalName,
        localPath: target.localPath,
      };
    } catch (err) {
      log.logWarning(`Failed to process Telegram file`, `${originalName}: ${err}`);
      return null;
    }
  }

  // ==========================================================================
  // Private - Event Handlers
  // ==========================================================================

  private getQueue(channelId: string): SerialWorkQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new SerialWorkQueue("Telegram queue error");
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
    this.client.on("message", async (ctx) => {
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

      // Process attachments (starts download in background)
      const processedAttachments = await this.processAttachments(chatId, msg);

      const event: TelegramEvent = {
        type: "message",
        channel: chatId,
        ts: msgId,
        thread_ts: threadTs,
        user: userId,
        userName,
        text: cleanedText,
        attachments: processedAttachments,
      };

      // Log the message
      this.logToFile(chatId, {
        date: new Date(msg.date * 1000).toISOString(),
        ts: msgId,
        user: userId,
        userName,
        text: cleanedText,
        attachments: processedAttachments,
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
