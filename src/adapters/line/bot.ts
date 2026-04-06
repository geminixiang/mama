import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Bot, BotEvent, BotHandler, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import { createLineAdapters } from "./context.js";

// ============================================================================
// Types
// ============================================================================

export interface LineEvent extends BotEvent {
  type: "message" | "command";
  userName?: string;
  replyToken?: string;
}

// Webhook event types (simplified)
interface WebhookMessageEvent {
  type: "message";
  mode: string;
  timestamp: number;
  webhookEventId: string;
  replyToken?: string;
  source: { type: string; userId?: string; groupId?: string; roomId?: string };
  message: {
    id: string;
    type: string;
    text?: string;
    fileName?: string;
    fileSize?: number;
  };
}

interface WebhookPostbackEvent {
  type: "postback";
  mode: string;
  timestamp: number;
  webhookEventId: string;
  replyToken?: string;
  source: { type: string; userId?: string };
  postback: { data: string };
}

type WebhookEvent = WebhookMessageEvent | WebhookPostbackEvent;

interface WebhookRequestBody {
  destination?: string;
  events: WebhookEvent[];
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
      log.logWarning("LINE queue error", err instanceof Error ? err.message : String(err));
    }
    this.processing = false;
    this.processNext();
  }
}

// ============================================================================
// LineBot
// ============================================================================

export class LineBot implements Bot {
  private handler: BotHandler;
  private workingDir: string;
  private channelSecret: string;
  private channelAccessToken: string;
  private botUserId: string | null = null;
  private queues = new Map<string, ChannelQueue>();
  private startupTime: number = 0;

  constructor(
    handler: BotHandler,
    config: { channelSecret: string; channelAccessToken: string; workingDir: string },
  ) {
    this.handler = handler;
    this.workingDir = config.workingDir;
    this.channelSecret = config.channelSecret;
    this.channelAccessToken = config.channelAccessToken;
  }

  // ==========================================================================
  // LINE API Helper
  // ==========================================================================

  private async lineApi<T>(endpoint: string, body?: object): Promise<T> {
    const response = await fetch(`https://api.line.me/v2/bot${endpoint}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`LINE API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  // ==========================================================================
  // Public API (implements Bot)
  // ==========================================================================

  async start(): Promise<void> {
    this.startupTime = Date.now();
    log.logConnected();
    log.logInfo("LINE bot started");
  }

  async postMessage(channel: string, text: string): Promise<string> {
    const result = await this.lineApi<{ sentMessages: { id: string }[] }>("/message/reply", {
      replyToken: channel,
      messages: [{ type: "text", text: text }],
    });
    return result.sentMessages[0]?.id ?? "unknown";
  }

  async updateMessage(channel: string, _ts: string, text: string): Promise<void> {
    // LINE doesn't support message editing
    // We'll just push a new message instead
    await this.lineApi("/message/push", {
      to: channel,
      messages: [{ type: "text", text: text }],
    });
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
      const adapters = createLineAdapters(event as LineEvent, this, true);
      return this.handler.handleEvent(event, this, adapters, true);
    });
    return true;
  }

  getPlatformInfo(): PlatformInfo {
    return {
      name: "line",
      formattingGuide:
        "## LINE Formatting\nText is plain. For bold/italic, use Unicode alternatives or emoji.\nCode blocks are not supported in LINE.",
      channels: [],
      users: [],
    };
  }

  // ==========================================================================
  // Internal helpers (used by context.ts)
  // ==========================================================================

  async replyMessage(replyToken: string, text: string): Promise<void> {
    await this.lineApi("/message/reply", {
      replyToken: replyToken,
      messages: [{ type: "text", text: text }],
    });
  }

  async pushMessage(userId: string, text: string): Promise<void> {
    await this.lineApi("/message/push", {
      to: userId,
      messages: [{ type: "text", text: text }],
    });
  }

  async deleteMessage(_channelId: string, _messageId: string): Promise<void> {
    // LINE doesn't have a delete message API for the bot's own messages
    // This is a no-op
  }

  logToFile(channelId: string, entry: object): void {
    const dir = join(this.workingDir, channelId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  logBotResponse(channelId: string, text: string, ts: string): void {
    this.logToFile(channelId, {
      date: new Date().toISOString(),
      ts,
      user: "bot",
      text,
      attachments: [],
      isBot: true,
    });
  }

  /**
   * Process attachments from a LINE message
   * Downloads files and returns metadata
   */
  async processAttachments(
    userId: string,
    events: WebhookEvent[],
  ): Promise<{ name: string; localPath: string }[]> {
    const downloads: Array<Promise<{ name: string; localPath: string } | null>> = [];

    for (const event of events) {
      if (event.type !== "message" || !event.message) continue;

      const msg = event.message;

      // Handle images, videos, audio, files
      if (["image", "video", "audio", "file"].includes(msg.type)) {
        downloads.push(this.processLineFile(userId, msg.id, msg));
      }
    }

    const attachments = await Promise.all(downloads);
    return attachments.filter(
      (attachment): attachment is { name: string; localPath: string } => attachment !== null,
    );
  }

  /**
   * Download a file from LINE and return attachment metadata
   */
  private async processLineFile(
    userId: string,
    messageId: string,
    msg: { type: string; fileName?: string },
  ): Promise<{ name: string; localPath: string } | null> {
    const typeExt: Record<string, string> = {
      image: "jpg",
      video: "mp4",
      audio: "m4a",
      file: "bin",
    };
    const ext = typeExt[msg.type] || "bin";
    const originalName = msg.fileName ?? `message_${messageId}.${ext}`;

    try {
      // Get binary content from LINE
      const response = await fetch(`https://api.line.me/v2/bot/message/${messageId}/content`, {
        headers: { Authorization: `Bearer ${this.channelAccessToken}` },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Generate local filename
      const ts = Date.now();
      const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${ts}_${sanitizedName}`;
      const localPath = `${userId}/attachments/${filename}`;
      const fullDir = join(this.workingDir, userId, "attachments");

      if (!existsSync(fullDir)) mkdirSync(fullDir, { recursive: true });

      writeFileSync(join(fullDir, filename), buffer);

      return {
        name: originalName,
        localPath: localPath,
      };
    } catch (err) {
      log.logWarning(`Failed to process LINE file`, `${originalName}: ${err}`);
      return null;
    }
  }

  /**
   * Handle incoming webhook events from LINE
   */
  handleWebhook(body: WebhookRequestBody): void {
    const events = body.events;
    if (!events || events.length === 0) return;

    for (const event of events) {
      this.processEvent(event);
    }
  }

  private processEvent(event: WebhookEvent): void {
    // Skip events from before startup
    if (event.timestamp && event.timestamp < this.startupTime) return;

    // Only handle message events and postback events
    if (event.type !== "message" && event.type !== "postback") return;

    // Type guard for message events
    if (event.type === "message") {
      this.processMessageEvent(event);
    } else if (event.type === "postback") {
      this.processPostbackEvent(event);
    }
  }

  private processMessageEvent(event: WebhookMessageEvent): void {
    // Get user and channel info
    const userId = event.source?.userId ?? "unknown";
    const channelId = userId;
    const messageId = event.message?.id ?? event.timestamp?.toString() ?? Date.now().toString();

    // Skip messages from bots
    if (event.source?.type === "bot") return;

    let text = "";

    const msg = event.message;
    if (msg.type === "text") {
      text = msg.text ?? "";
    } else if (["image", "video", "audio", "file"].includes(msg.type)) {
      text = `[${msg.type} message]`;
    }

    // Clean text
    text = text.trim();
    if (!text) return;

    const sessionKey = userId;
    const replyToken = event.replyToken;

    const lineEvent: LineEvent = {
      type: "message",
      channel: channelId,
      ts: messageId,
      thread_ts: undefined,
      sessionKey: sessionKey,
      user: userId,
      userName: userId,
      text: text,
      attachments: [],
      replyToken: replyToken,
    };

    this.logToFile(channelId, {
      date: new Date().toISOString(),
      ts: messageId,
      user: userId,
      userName: userId,
      text: text,
      attachments: [],
      isBot: false,
    });

    this.handleCommandOrEnqueue(lineEvent, userId, channelId, async () => {
      const processedAttachments = await this.processAttachments(userId, [event]);
      lineEvent.attachments = processedAttachments;
      const adapters = createLineAdapters(lineEvent, this, false);
      await this.handler.handleEvent(lineEvent, this, adapters, false);
    });
  }

  private processPostbackEvent(event: WebhookPostbackEvent): void {
    const userId = event.source?.userId ?? "unknown";
    const channelId = userId;
    const messageId = event.timestamp?.toString() ?? Date.now().toString();

    const text = event.postback?.data ?? "";

    const lineEvent: LineEvent = {
      type: "message",
      channel: channelId,
      ts: messageId,
      thread_ts: undefined,
      sessionKey: userId,
      user: userId,
      userName: userId,
      text: text,
      attachments: [],
      replyToken: event.replyToken,
    };

    this.logToFile(channelId, {
      date: new Date().toISOString(),
      ts: messageId,
      user: userId,
      userName: userId,
      text: text,
      attachments: [],
      isBot: false,
    });

    this.handleCommandOrEnqueue(lineEvent, userId, channelId, async () => {
      const adapters = createLineAdapters(lineEvent, this, false);
      await this.handler.handleEvent(lineEvent, this, adapters, false);
    });
  }

  private handleCommandOrEnqueue(
    lineEvent: LineEvent,
    sessionKey: string,
    channelId: string,
    onEnqueue: () => Promise<void>,
  ): void {
    const text = lineEvent.text;

    if (text === "/stop" || text.toLowerCase() === "stop") {
      if (this.handler.isRunning(sessionKey)) {
        this.handler.handleStop(sessionKey, channelId, this);
      } else {
        this.postMessage(channelId, "_Nothing running_");
      }
      return;
    }

    if (text === "/new" || text.toLowerCase() === "new") {
      this.handler.handleNew(sessionKey, channelId, this);
      return;
    }

    if (text === "/help" || text === "/start") {
      this.postMessage(
        channelId,
        [
          "Welcome!",
          "",
          "I'm an AI coding agent. Send me a message or use these commands:",
          "",
          "/new — Reset conversation history and start fresh",
          "/stop — Stop the current conversation",
          "/help — Show available commands",
        ].join("\n"),
      );
      return;
    }

    if (this.handler.isRunning(sessionKey)) {
      this.postMessage(channelId, "_Already working. Say /stop to cancel._");
    } else {
      this.getQueue(sessionKey).enqueue(onEnqueue);
    }
  }

  // ==========================================================================
  // Private - Queue Management
  // ==========================================================================

  private getQueue(channelId: string): ChannelQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new ChannelQueue();
      this.queues.set(channelId, queue);
    }
    return queue;
  }
}
