import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { Bot as GrammyBot, InputFile } from "grammy";
import type { Bot, BotEvent, BotHandler, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import { formatAlreadyWorking, formatNothingRunning } from "../../ui-copy.js";
import { createTelegramAdapters } from "./context.js";

// ============================================================================
// Types
// ============================================================================

export interface TelegramEvent extends BotEvent {
  type: "message" | "command";
  userName?: string;
}

interface MessageContext {
  msg: any;
  text: string;
  chatId: string;
  chatType: string;
  userId: string;
  userName: string;
  msgId: string;
  threadTs: string | undefined;
  sessionKey: string;
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
  private botToken: string;
  private workingDir: string;
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private queues = new Map<string, ChannelQueue>();
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

    await this.client.api.setMyCommands([
      { command: "start", description: "Welcome message" },
      { command: "help", description: "Show available commands" },
      { command: "stop", description: "Stop ongoing conversation" },
      { command: "new", description: "Reset conversation history and start fresh" },
    ]);

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

  async postPlainMessage(chatId: number, text: string): Promise<void> {
    await this.client.api.sendMessage(chatId, text);
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

  /**
   * Process attachments from a Telegram message
   * Downloads files before returning metadata so the agent can read them immediately
   * Returns format compatible with ChatMessage: { name: string, localPath: string }[]
   */
  async processAttachments(
    chatId: string,
    message: any,
  ): Promise<{ name: string; localPath: string }[]> {
    const downloads: Array<Promise<{ name: string; localPath: string } | null>> = [];

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
  ): Promise<{ name: string; localPath: string } | null> {
    try {
      // Get file info from Telegram
      const file = await this.client.api.getFile(fileId);
      if (!file.file_path) {
        log.logWarning("Telegram file has no path", fileId);
        return null;
      }

      // Generate local filename
      const ts = Date.now();
      const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${ts}_${sanitizedName}`;
      const localPath = `${chatId}/attachments/${filename}`;
      const fullDir = join(this.workingDir, chatId, "attachments");

      if (!existsSync(fullDir)) mkdirSync(fullDir, { recursive: true });

      // Construct download URL
      const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

      // Download the file
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      writeFileSync(join(fullDir, filename), Buffer.from(buffer));

      return {
        name: originalName,
        localPath: localPath,
      };
    } catch (err) {
      log.logWarning(`Failed to process Telegram file`, `${originalName}: ${err}`);
      return null;
    }
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

  private extractMessageContext(msg: any): MessageContext | null {
    if (!msg) return null;
    if (msg.date * 1000 < this.startupTime) return null;
    if (msg.from?.is_bot) return null;

    const text = msg.text ?? msg.caption ?? "";
    if (!text && !msg.document && !msg.photo) return null;

    const chatId = String(msg.chat.id);
    const chatType = msg.chat.type;
    const userId = String(msg.from?.id ?? "unknown");
    const userName = msg.from?.username ?? msg.from?.first_name ?? userId;
    const msgId = String(msg.message_id);
    const replyToId = msg.reply_to_message?.message_id;
    const threadTs = replyToId ? String(replyToId) : undefined;

    // Private chats: single session per chat (no per-message splitting)
    // Groups: per-thread sessions (use reply chain or unique message id)
    const sessionKey = chatType === "private" ? chatId : `${chatId}:${threadTs ?? msgId}`;

    return { msg, text, chatId, chatType, userId, userName, msgId, threadTs, sessionKey };
  }

  private isAddressedToBot(text: string, chatType: string): boolean {
    if (chatType === "private") return true;
    if (!this.botUsername) return false;
    return text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`);
  }

  private cleanText(text: string): string {
    if (!this.botUsername) return text.trim();
    return text.replace(new RegExp(`@${this.botUsername}`, "gi"), "").trim();
  }

  private setupEventHandlers(): void {
    // --- Slash commands (registered before catch-all so grammY intercepts them) ---

    this.client.command("start", async (ctx) => {
      const mc = this.extractMessageContext(ctx.message);
      if (!mc) return;
      await this.postMessageRaw(
        parseInt(mc.chatId),
        [
          "<b>Welcome!</b>",
          "",
          "I'm an AI coding agent. Send me a message or use these commands:",
          "",
          "/new — Reset conversation history and start fresh",
          "/stop — Stop the current conversation",
          "/help — Show available commands",
        ].join("\n"),
      );
    });

    this.client.command("help", async (ctx) => {
      const mc = this.extractMessageContext(ctx.message);
      if (!mc) return;
      await this.postMessageRaw(
        parseInt(mc.chatId),
        [
          "<b>Available commands:</b>",
          "",
          "/start — Welcome message",
          "/help — Show this help",
          "/stop — Stop ongoing conversation",
          "/new — Reset conversation history and start fresh",
          "",
          "You can also send a regular message to chat with the agent.",
        ].join("\n"),
      );
    });

    this.client.command("stop", async (ctx) => {
      const mc = this.extractMessageContext(ctx.message);
      if (!mc) return;
      if (this.handler.isRunning(mc.sessionKey)) {
        await this.handler.handleStop(mc.sessionKey, mc.chatId, this);
      } else {
        await this.postMessage(mc.chatId, formatNothingRunning("telegram"));
      }
    });

    this.client.command("new", async (ctx) => {
      const mc = this.extractMessageContext(ctx.message);
      if (!mc) return;
      await this.handler.handleNew(mc.sessionKey, mc.chatId, this);
    });

    // --- Catch-all for regular (non-command) messages ---

    this.client.on("message", async (ctx) => {
      const mc = this.extractMessageContext(ctx.message);
      if (!mc) return;

      // In groups, only respond when addressed to bot
      if (!this.isAddressedToBot(mc.text, mc.chatType)) return;

      const cleanedText = this.cleanText(mc.text);

      // Process attachments
      const processedAttachments = await this.processAttachments(mc.chatId, mc.msg);

      const event: TelegramEvent = {
        type: "message",
        channel: mc.chatId,
        ts: mc.msgId,
        thread_ts: mc.threadTs,
        sessionKey: mc.sessionKey,
        user: mc.userId,
        userName: mc.userName,
        text: cleanedText,
        attachments: processedAttachments,
      };

      // Log the message
      this.logToFile(mc.chatId, {
        date: new Date(mc.msg.date * 1000).toISOString(),
        ts: mc.msgId,
        user: mc.userId,
        userName: mc.userName,
        text: cleanedText,
        attachments: processedAttachments,
        isBot: false,
      });

      // Handle bare "stop" text (backward compat)
      if (cleanedText.toLowerCase() === "stop") {
        if (this.handler.isRunning(mc.sessionKey)) {
          await this.handler.handleStop(mc.sessionKey, mc.chatId, this);
        } else {
          await this.postMessage(mc.chatId, formatNothingRunning("telegram"));
        }
        return;
      }

      if (this.handler.isRunning(mc.sessionKey)) {
        await this.postMessage(mc.chatId, formatAlreadyWorking("telegram", "/stop"));
      } else {
        this.getQueue(mc.sessionKey).enqueue(() => {
          const adapters = createTelegramAdapters(event, this, false);
          return this.handler.handleEvent(event, this, adapters, false);
        });
      }
    });
  }
}
