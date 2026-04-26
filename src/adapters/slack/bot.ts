import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { basename, join } from "path";
import type {
  Bot,
  BotAdapters,
  BotEvent,
  BotHandler,
  ChatMessage,
  ChatResponseContext,
  ConversationKind,
  PlatformInfo,
} from "../../adapter.js";
import type { EventsWatcher } from "../../events.js";
import * as log from "../../log.js";
import type { Attachment, ChannelStore } from "../../store.js";
import { PRODUCT_NAME, formatForceStopped, formatNothingRunning } from "../../ui-copy.js";
import { createSlackAdapters } from "./context.js";

// ============================================================================
// Exponential backoff utility for Slack API calls
// ============================================================================

/**
 * Retry a function with exponential backoff on rate limit errors.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check for rate limit errors
      let isRateLimited = false;

      // Check for rate_limited error code (Slack SDK)
      if ("code" in lastError && lastError.code === "rate_limited") {
        isRateLimited = true;
      }

      // Check for rate_limited in error response
      if ("data" in lastError) {
        const data = (lastError as { data?: { error?: string; response?: { status?: number } } })
          .data;
        if (data?.error === "rate_limited" || data?.response?.status === 429) {
          isRateLimited = true;
        }
      }

      if (isRateLimited) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        log.logWarning(
          `Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Non-retryable error
      throw lastError;
    }
  }
  throw lastError;
}

// ============================================================================
// Types
// ============================================================================

export interface SlackEvent {
  type: "mention" | "dm";
  conversationId: string;
  conversationKind: ConversationKind;
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
  files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
  /** Processed attachments with local paths (populated after logUserMessage) */
  attachments?: Attachment[];
  /** Session key passed through to BotEvent so handleEvent uses the correct persistent session */
  sessionKey?: string;
}

export interface SlackUser {
  id: string;
  userName: string;
  displayName: string;
}

export interface SlackChannel {
  id: string;
  name: string;
}

// Types used by agent.ts
export interface ChannelInfo {
  id: string;
  name: string;
}

export interface UserInfo {
  id: string;
  userName: string;
  displayName: string;
}

export interface SlackContext {
  message: {
    text: string;
    rawText: string;
    user: string;
    userName?: string;
    channel: string;
    ts: string;
    attachments: Array<{ localPath: string }>;
  };
  channelName?: string;
  channels: ChannelInfo[];
  users: UserInfo[];
  respond: (text: string, shouldLog?: boolean) => Promise<void>;
  replaceMessage: (text: string) => Promise<void>;
  respondInThread: (text: string) => Promise<void>;
  setTyping: (isTyping: boolean) => Promise<void>;
  uploadFile: (filePath: string, title?: string) => Promise<void>;
  setWorking: (working: boolean) => Promise<void>;
  deleteMessage: () => Promise<void>;
}

/** @deprecated Use BotHandler from adapter.ts instead */
export type MomHandler = BotHandler;

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
      log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
    }
    this.processing = false;
    this.processNext();
  }
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot implements Bot {
  private socketClient: SocketModeClient;
  private webClient: WebClient;
  private handler: BotHandler;
  private workingDir: string;
  private store: ChannelStore;
  private botUserId: string | null = null;
  private startupTs: string | null = null; // Messages older than this are just logged, not processed

  private users = new Map<string, SlackUser>();
  private channels = new Map<string, SlackChannel>();
  private queues = new Map<string, ChannelQueue>();
  private eventsWatcher: EventsWatcher | null = null;

  constructor(
    handler: BotHandler,
    config: { appToken: string; botToken: string; workingDir: string; store: ChannelStore },
  ) {
    this.handler = handler;
    this.workingDir = config.workingDir;
    this.store = config.store;
    this.socketClient = new SocketModeClient({ appToken: config.appToken });
    this.webClient = new WebClient(config.botToken);
  }

  setEventsWatcher(watcher: EventsWatcher): void {
    this.eventsWatcher = watcher;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  async start(): Promise<void> {
    const auth = await this.webClient.auth.test();
    this.botUserId = auth.user_id as string;

    await Promise.all([this.fetchUsers(), this.fetchChannels()]);
    log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

    await this.backfillAllChannels();

    this.setupEventHandlers();
    await this.socketClient.start();

    // Record startup time - messages older than this are just logged, not processed
    this.startupTs = (Date.now() / 1000).toFixed(6);

    log.logConnected();
  }

  getUser(userId: string): SlackUser | undefined {
    return this.users.get(userId);
  }

  getChannel(channelId: string): SlackChannel | undefined {
    return this.channels.get(channelId);
  }

  getAllUsers(): SlackUser[] {
    return Array.from(this.users.values());
  }

  getAllChannels(): SlackChannel[] {
    return Array.from(this.channels.values());
  }

  async postMessage(channel: string, text: string): Promise<string> {
    return withRetry(async () => {
      const result = await this.webClient.chat.postMessage({ channel, text });
      return result.ts as string;
    });
  }

  async postEphemeral(channel: string, user: string, text: string): Promise<void> {
    return withRetry(async () => {
      await this.webClient.chat.postEphemeral({ channel, user, text });
    });
  }

  async openDirectMessage(userId: string): Promise<string> {
    return withRetry(async () => {
      const result = await this.webClient.conversations.open({ users: userId });
      const channelId = result.channel?.id;
      if (!channelId) {
        throw new Error(`Failed to open DM for user ${userId}`);
      }
      return channelId;
    });
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    return withRetry(async () => {
      await this.webClient.chat.update({ channel, ts, text });
    });
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    return withRetry(async () => {
      await this.webClient.chat.delete({ channel, ts });
    });
  }

  // ==========================================================================
  // Slack Assistant API (AI assistant experience)
  // ==========================================================================

  /** Set the status for an assistant thread (shows "thinking" state) */
  async setAssistantStatus(channel: string, threadTs: string, status: string): Promise<void> {
    return withRetry(async () => {
      await this.webClient.assistant.threads.setStatus({
        channel_id: channel,
        thread_ts: threadTs,
        status,
      });
    });
  }

  async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
    return withRetry(async () => {
      // Use Block Kit section for long messages to trigger Slack's "Show more" collapsing (~700 chars)
      const SECTION_TEXT_LIMIT = 3000;
      if (text.length > 500) {
        const blockText =
          text.length > SECTION_TEXT_LIMIT
            ? text.substring(0, SECTION_TEXT_LIMIT - 20) + "\n_(truncated)_"
            : text;
        const result = await this.webClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text, // full text as notification fallback
          blocks: [{ type: "section", text: { type: "mrkdwn", text: blockText } }],
        });
        return result.ts as string;
      }
      const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
      return result.ts as string;
    });
  }

  async postInThreadBlocks(
    channel: string,
    threadTs: string,
    text: string,
    blocks: object[],
  ): Promise<string> {
    return withRetry(async () => {
      const result = await this.webClient.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text, // fallback for notifications
        blocks: blocks as any,
      });
      return result.ts as string;
    });
  }

  async uploadFile(
    channel: string,
    filePath: string,
    title?: string,
    threadTs?: string,
  ): Promise<void> {
    return withRetry(async () => {
      const fileName = title || basename(filePath);
      const fileContent = readFileSync(filePath);
      await this.webClient.files.uploadV2({
        channel_id: channel,
        file: fileContent,
        filename: fileName,
        title: fileName,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      } as Parameters<typeof this.webClient.files.uploadV2>[0]);
    });
  }

  /**
   * Log a message to log.jsonl (SYNC)
   * This is the ONLY place messages are written to log.jsonl
   */
  logToFile(channel: string, entry: object): void {
    const dir = join(this.workingDir, channel);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  /**
   * Log a bot response to log.jsonl
   */
  logBotResponse(channel: string, text: string, ts: string, threadTs?: string): void {
    this.logToFile(channel, {
      date: new Date().toISOString(),
      ts,
      threadTs,
      user: "bot",
      text,
      attachments: [],
      isBot: true,
    });
  }

  getPlatformInfo(): PlatformInfo {
    return {
      name: "slack",
      formattingGuide:
        "## Slack Formatting (mrkdwn, NOT Markdown)\nBold: *text*, Italic: _text_, Code: `code`, Block: ```code```, Links: <url|text>\nDo NOT use **double asterisks** or [markdown](links).",
      channels: this.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
      users: this.getAllUsers().map((u) => ({
        id: u.id,
        userName: u.userName,
        displayName: u.displayName,
      })),
    };
  }

  // ==========================================================================
  // Events Integration
  // ==========================================================================

  /**
   * Enqueue an event for processing. Always queues (no "already working" rejection).
   * Returns true if enqueued, false if queue is full (max 5).
   */
  enqueueEvent(event: BotEvent): boolean {
    const conversationId = event.conversationId;
    const queue = this.getQueue(conversationId);
    if (queue.size() >= 5) {
      log.logWarning(
        `Event queue full for ${conversationId}, discarding: ${event.text.substring(0, 50)}`,
      );
      return false;
    }
    log.logInfo(`Enqueueing event for ${conversationId}: ${event.text.substring(0, 50)}`);
    queue.enqueue(() => {
      const slackEvent: SlackEvent = {
        type: event.type as SlackEvent["type"],
        conversationId,
        conversationKind: event.conversationKind,
        channel: conversationId,
        ts: event.ts,
        thread_ts: event.thread_ts,
        user: event.user,
        text: event.text,
        attachments: event.attachments?.map((attachment) => ({
          original: attachment.name,
          localPath: attachment.localPath,
        })),
        sessionKey: event.sessionKey,
      };
      const adapters = createSlackAdapters(slackEvent, this, true);
      return this.handler.handleEvent(event, this, adapters, true);
    });
    return true;
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildHomeView(): { type: "home"; blocks: any[] } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${PRODUCT_NAME}*\nStart a new task or check on running work.`,
        },
        accessory: {
          type: "image",
          image_url: "https://media1.tenor.com/m/lfDATg4Bhc0AAAAC/happy-cat.gif",
          alt_text: PRODUCT_NAME,
        },
      },
    ];

    // --- Running tasks ---
    const runningSessions = this.handler.getRunningSessions();

    blocks.push(
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Running Tasks (${runningSessions.length})`,
          emoji: true,
        },
      },
    );

    if (runningSessions.length === 0) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: "_No tasks running right now._" }],
      });
    } else {
      // Threshold for "stuck" detection (10 minutes)
      const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

      for (const session of runningSessions) {
        const channelId = session.sessionKey.split(":")[0];
        const channel = this.channels.get(channelId);
        const channelName = channel ? `#${channel.name}` : channelId;
        const elapsed = Math.floor((Date.now() - session.startedAt) / 60000);
        const elapsedStr = elapsed < 1 ? "<1 min" : `${elapsed} min`;

        // Check if task might be stuck
        const lastActivity = session.lastActivityAt ? Date.now() - session.lastActivityAt : 0;
        const isStuck = lastActivity > STUCK_THRESHOLD_MS;
        const statusText = isStuck ? "_stuck_" : "_running_";

        // Build status line: channel · status · time · step
        let statusLine = `${statusText} · ${elapsedStr}`;
        if (session.currentTool) {
          statusLine += ` · ${session.currentTool}`;
        }
        if (isStuck && lastActivity > 0) {
          const inactiveMin = Math.floor(lastActivity / 60000);
          statusLine += ` · idle ${inactiveMin}m`;
        }

        // Use context block for gray small text (like "No scheduled jobs.")
        blocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `*${channelName}* · ${statusLine}`,
            },
          ],
        });

        // Add Force Stop button as separate element if stuck
        if (isStuck) {
          blocks.push({
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: " ",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Force Stop", emoji: true },
                action_id: `force_stop_${session.sessionKey.replace(/:/g, "_")}`,
                style: "danger",
              },
            ],
          });
        }
      }
    }

    // --- Cron jobs ---
    const periodicEvents = this.eventsWatcher?.getPeriodicEvents() ?? [];

    blocks.push(
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Scheduled Jobs (${periodicEvents.length})`,
          emoji: true,
        },
      },
    );

    if (periodicEvents.length === 0) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: "_No scheduled jobs._" }],
      });
    } else {
      for (const ev of periodicEvents) {
        const channelLabel =
          ev.platform === "slack"
            ? (() => {
                const channel = this.channels.get(ev.conversationId);
                const channelName = channel ? `#${channel.name}` : ev.conversationId;
                return `${ev.platform}:${channelName}`;
              })()
            : `${ev.platform}:${ev.conversationId}`;
        const nextStr = ev.nextRun
          ? new Date(ev.nextRun).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—";
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${ev.text}*\n└ \`${ev.schedule}\` · ${channelLabel} · Next: ${nextStr}`,
          },
        });
      }
    }

    // --- Footer ---
    blocks.push(
      { type: "divider" },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "💡 @mention in a channel or send a DM to start a new task" },
        ],
      },
    );

    return { type: "home", blocks };
  }

  /**
   * Resolve which session key to stop.
   * When stop is called from a thread, the thread session (channelId:thread_ts) might
   * not be running — but the channel session (channelId) might be, because the bot's
   * reply to a top-level mention creates a thread. Check both, prefer thread first.
   */
  private resolveStopTarget(channelId: string, threadTs?: string): string | null {
    if (threadTs) {
      const threadKey = `${channelId}:${threadTs}`;
      if (this.handler.isRunning(threadKey)) return threadKey;
      // Fall back to channel session — the thread may have been spawned by a top-level run
      if (this.handler.isRunning(channelId)) return channelId;
      return null;
    }
    return this.handler.isRunning(channelId) ? channelId : null;
  }

  private createDirectCommandAdapters(
    conversationId: string,
    userId: string,
    userName: string | undefined,
    text: string,
    ts: string,
  ): BotAdapters {
    const message: ChatMessage = {
      id: ts,
      sessionKey: conversationId,
      conversationKind: "direct",
      userId,
      userName,
      text,
      attachments: [],
    };

    const responseCtx: ChatResponseContext = {
      respond: async (responseText: string) => {
        const messageTs = await this.postMessage(conversationId, responseText);
        this.logBotResponse(conversationId, responseText, messageTs);
      },
      replaceResponse: async (responseText: string) => {
        const messageTs = await this.postMessage(conversationId, responseText);
        this.logBotResponse(conversationId, responseText, messageTs);
      },
      respondInThread: async (responseText: string) => {
        const messageTs = await this.postMessage(conversationId, responseText);
        this.logBotResponse(conversationId, responseText, messageTs);
      },
      setTyping: async () => {},
      setWorking: async () => {},
      uploadFile: async (filePath: string, title?: string) => {
        await this.uploadFile(conversationId, filePath, title);
      },
      deleteResponse: async () => {},
    };

    return {
      message,
      responseCtx,
      platform: this.getPlatformInfo(),
    };
  }

  private createSlashCommandBot(conversationId: string, threadTs?: string): Bot {
    return {
      start: async () => {},
      postMessage: async (_channel: string, text: string) => {
        if (threadTs) {
          return this.postInThread(conversationId, threadTs, text);
        }
        return this.postMessage(conversationId, text);
      },
      updateMessage: async (channel: string, ts: string, text: string) => {
        await this.updateMessage(channel, ts, text);
      },
      enqueueEvent: (event: BotEvent) => this.enqueueEvent(event),
      getPlatformInfo: () => this.getPlatformInfo(),
    };
  }

  private async routeSlashLoginCommand(payload: {
    command: string;
    text?: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    const commandSuffix = payload.text?.trim();
    const commandText = commandSuffix ? `${payload.command} ${commandSuffix}` : payload.command;
    const createdAt = new Date();
    const eventTs = (createdAt.getTime() / 1000).toFixed(6);
    const sourceChannelId = payload.channel_id;
    const isDirectMessage = sourceChannelId.startsWith("D");
    const targetChannelId = isDirectMessage
      ? sourceChannelId
      : await this.openDirectMessage(payload.user_id);
    const userName = payload.user_name ?? this.getUser(payload.user_id)?.userName;

    this.logToFile(targetChannelId, {
      date: createdAt.toISOString(),
      ts: eventTs,
      user: payload.user_id,
      userName,
      text: commandText,
      attachments: [],
      isBot: false,
    });

    if (!isDirectMessage) {
      await this.postEphemeral(
        sourceChannelId,
        payload.user_id,
        `我已私訊你 ${PRODUCT_NAME} 的登入連結，請到私訊完成設定。`,
      );
    }

    const event: BotEvent = {
      type: "dm",
      conversationId: targetChannelId,
      conversationKind: "direct",
      ts: eventTs,
      user: payload.user_id,
      text: commandText,
      attachments: [],
      sessionKey: targetChannelId,
    };

    const adapters = this.createDirectCommandAdapters(
      targetChannelId,
      payload.user_id,
      userName,
      commandText,
      eventTs,
    );

    await this.handler.handleEvent(event, this, adapters, false);
  }

  private async routeSlashNewCommand(payload: {
    command: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    const conversationId = payload.channel_id;
    if (!conversationId.startsWith("D")) {
      await this.postEphemeral(
        conversationId,
        payload.user_id,
        `為了避免誤清除共享上下文，${payload.command} 目前只能在與 ${PRODUCT_NAME} 的私訊中使用。`,
      );
      return;
    }

    const createdAt = new Date();
    const eventTs = (createdAt.getTime() / 1000).toFixed(6);
    const userName = payload.user_name ?? this.getUser(payload.user_id)?.userName;

    this.logToFile(conversationId, {
      date: createdAt.toISOString(),
      ts: eventTs,
      user: payload.user_id,
      userName,
      text: payload.command,
      attachments: [],
      isBot: false,
    });

    const commandBot = this.createSlashCommandBot(conversationId);
    await this.handler.handleNew(conversationId, conversationId, commandBot);
  }

  private setupEventHandlers(): void {
    // Channel @mentions
    this.socketClient.on("app_mention", ({ event, ack }) => {
      const e = event as {
        text: string;
        channel: string;
        user: string;
        ts: string;
        thread_ts?: string;
        files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
      };

      // Skip DMs (handled by message event)
      if (e.channel.startsWith("D")) {
        ack();
        return;
      }

      // Top-level mentions use a persistent channel session.
      // Thread replies get their own isolated session (channelId:thread_ts).
      const sessionKey = e.thread_ts ? `${e.channel}:${e.thread_ts}` : e.channel;

      const slackEvent: SlackEvent = {
        type: "mention",
        conversationId: e.channel,
        conversationKind: "shared",
        channel: e.channel,
        ts: e.ts,
        thread_ts: e.thread_ts,
        user: e.user,
        text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
        files: e.files,
        sessionKey,
      };

      // SYNC: Log to log.jsonl (ALWAYS, even for old messages)
      // Also downloads attachments in background and stores local paths
      slackEvent.attachments = this.logUserMessage(slackEvent);

      // Only trigger processing for messages AFTER startup (not replayed old messages)
      if (this.startupTs && e.ts < this.startupTs) {
        log.logInfo(
          `[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
        );
        ack();
        return;
      }

      // Check for stop command - execute immediately, don't queue!
      if (slackEvent.text.toLowerCase().trim() === "stop") {
        const stopTarget = this.resolveStopTarget(e.channel, e.thread_ts);
        if (stopTarget) {
          this.handler.handleStop(stopTarget, e.channel, this);
        } else {
          this.postMessage(e.channel, formatNothingRunning("slack"));
        }
        ack();
        return;
      }

      this.getQueue(sessionKey).enqueue(() => {
        const adapters = createSlackAdapters(slackEvent, this, false);
        return this.handler.handleEvent(
          slackEvent as unknown as import("../../adapter.js").BotEvent,
          this,
          adapters,
          false,
        );
      });

      ack();
    });

    // All messages (for logging) + DMs (for triggering)
    this.socketClient.on("message", ({ event, ack }) => {
      const e = event as {
        text?: string;
        channel: string;
        user?: string;
        ts: string;
        thread_ts?: string;
        channel_type?: string;
        subtype?: string;
        bot_id?: string;
        files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
      };

      // Skip bot messages, edits, etc.
      if (e.bot_id || !e.user || e.user === this.botUserId) {
        ack();
        return;
      }
      if (e.subtype !== undefined && e.subtype !== "file_share") {
        ack();
        return;
      }
      if (!e.text && (!e.files || e.files.length === 0)) {
        ack();
        return;
      }

      const isDM = e.channel_type === "im";
      const conversationKind: ConversationKind = isDM ? "direct" : "shared";
      const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

      // Skip channel @mentions - already handled by app_mention event
      if (!isDM && isBotMention) {
        ack();
        return;
      }

      const slackEvent: SlackEvent = {
        type: isDM ? "dm" : "mention",
        conversationId: e.channel,
        conversationKind,
        channel: e.channel,
        ts: e.ts,
        thread_ts: e.thread_ts,
        user: e.user,
        text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
        files: e.files,
        sessionKey: isDM ? e.channel : undefined,
      };

      // SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
      // Also downloads attachments in background and stores local paths
      slackEvent.attachments = this.logUserMessage(slackEvent);

      // Only trigger processing for messages AFTER startup (not replayed old messages)
      if (this.startupTs && e.ts < this.startupTs) {
        log.logInfo(
          `[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`,
        );
        ack();
        return;
      }

      // Check for stop command in channel threads (without @mention)
      // app_mention handles "@mama stop", but bare "stop" in a thread comes here
      if (!isDM && e.thread_ts && slackEvent.text.toLowerCase().trim() === "stop") {
        const stopTarget = this.resolveStopTarget(e.channel, e.thread_ts);
        if (stopTarget) {
          this.handler.handleStop(stopTarget, e.channel, this);
        } else {
          this.postMessage(e.channel, formatNothingRunning("slack"));
        }
        ack();
        return;
      }

      // Only trigger handler for DMs
      if (isDM) {
        const dmSessionKey = slackEvent.sessionKey!;
        // Check for stop command - execute immediately, don't queue!
        if (slackEvent.text.toLowerCase().trim() === "stop") {
          if (this.handler.isRunning(dmSessionKey)) {
            this.handler.handleStop(dmSessionKey, e.channel, this); // Don't await, don't queue
          } else {
            this.postMessage(e.channel, formatNothingRunning("slack"));
          }
          ack();
          return;
        }

        this.getQueue(dmSessionKey).enqueue(() => {
          const adapters = createSlackAdapters(slackEvent, this, false);
          return this.handler.handleEvent(
            slackEvent as unknown as import("../../adapter.js").BotEvent,
            this,
            adapters,
            false,
          );
        });
      }

      ack();
    });

    this.socketClient.on("slash_commands", async ({ body, ack }) => {
      const payload = body as {
        command?: string;
        text?: string;
        channel_id?: string;
        user_id?: string;
        user_name?: string;
      };

      await ack();

      if (!payload.command || !payload.channel_id || !payload.user_id) {
        return;
      }

      const handlerPromise =
        payload.command === "/pi-login"
          ? this.routeSlashLoginCommand({
              command: payload.command,
              text: payload.text,
              channel_id: payload.channel_id,
              user_id: payload.user_id,
              user_name: payload.user_name,
            })
          : payload.command === "/pi-new"
            ? this.routeSlashNewCommand({
                command: payload.command,
                channel_id: payload.channel_id,
                user_id: payload.user_id,
                user_name: payload.user_name,
              })
            : null;

      if (!handlerPromise) {
        return;
      }

      handlerPromise.catch((err) => {
        log.logWarning(
          "Slack slash command error",
          err instanceof Error ? err.message : String(err),
        );
      });
    });

    // App Home tab
    this.socketClient.on("app_home_opened", ({ event, ack }) => {
      const e = event as { user: string; tab: string };
      ack();
      if (e.tab !== "home") return;

      this.webClient.views
        .publish({
          user_id: e.user,
          view: this.buildHomeView(),
        })
        .catch((err) => {
          log.logWarning(`Failed to publish App Home view`, String(err));
        });
    });

    // Handle button clicks (Force Stop)
    this.socketClient.on("block_actions", async ({ body, ack }) => {
      const action = body.actions?.[0];
      if (!action || !action.action_id?.startsWith("force_stop_")) {
        ack();
        return;
      }

      ack();
      const sessionKey = action.action_id.replace("force_stop_", "").replace(/_/g, ":");
      const userId = body.user?.id;
      const channelId = body.container?.channel_id || sessionKey.split(":")[0];

      log.logInfo(`[Force Stop] User ${userId} requested force stop for ${sessionKey}`);

      // Use handler's forceStop method
      this.handler.forceStop(sessionKey);

      // Notify in channel
      await this.postMessage(channelId, formatForceStopped("slack", userId ?? "unknown"));

      // Refresh home tab
      if (userId) {
        this.webClient.views
          .publish({
            user_id: userId,
            view: this.buildHomeView(),
          })
          .catch((err) => {
            log.logWarning(`Failed to refresh App Home view`, String(err));
          });
      }
    });
  }

  /**
   * Log a user message to log.jsonl (SYNC)
   * Downloads attachments in background via store
   */
  private logUserMessage(event: SlackEvent): Attachment[] {
    const user = this.users.get(event.user);
    // Process attachments - queues downloads in background
    const attachments = event.files
      ? this.store.processAttachments(event.channel, event.files, event.ts)
      : [];
    this.logToFile(event.channel, {
      date: new Date(parseFloat(event.ts) * 1000).toISOString(),
      ts: event.ts,
      threadTs: event.thread_ts,
      user: event.user,
      userName: user?.userName,
      displayName: user?.displayName,
      text: event.text,
      attachments,
      isBot: false,
    });
    return attachments;
  }

  // ==========================================================================
  // Private - Backfill
  // ==========================================================================

  private async getExistingTimestamps(channelId: string): Promise<Set<string>> {
    const logPath = join(this.workingDir, channelId, "log.jsonl");
    const timestamps = new Set<string>();
    if (!existsSync(logPath)) return timestamps;

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.ts) timestamps.add(entry.ts);
      } catch {}
    }
    return timestamps;
  }

  private async backfillChannel(channelId: string): Promise<number> {
    const existingTs = await this.getExistingTimestamps(channelId);

    // Find the biggest ts in log.jsonl
    let latestTs: string | undefined;
    for (const ts of existingTs) {
      if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
    }

    type Message = {
      user?: string;
      bot_id?: string;
      text?: string;
      ts?: string;
      subtype?: string;
      files?: Array<{ name: string }>;
    };
    const allMessages: Message[] = [];

    let cursor: string | undefined;
    let pageCount = 0;
    const maxPages = 3;

    do {
      const result = await this.webClient.conversations.history({
        channel: channelId,
        oldest: latestTs, // Only fetch messages newer than what we have
        inclusive: false,
        limit: 1000,
        cursor,
      });
      if (result.messages) {
        allMessages.push(...(result.messages as Message[]));
      }
      cursor = result.response_metadata?.next_cursor;
      pageCount++;
    } while (cursor && pageCount < maxPages);

    // Filter: include mama's messages, exclude other bots, skip already logged
    const relevantMessages = allMessages.filter((msg) => {
      if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
      if (msg.user === this.botUserId) return true;
      if (msg.bot_id) return false;
      if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
      if (!msg.user) return false;
      if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
      return true;
    });

    // Reverse to chronological order
    relevantMessages.reverse();

    // Log each message to log.jsonl
    for (const msg of relevantMessages) {
      const isMamaMessage = msg.user === this.botUserId;
      const user = this.users.get(msg.user!);
      // Strip @mentions from text (same as live messages)
      const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
      // Process attachments - queues downloads in background
      const attachments = msg.files
        ? this.store.processAttachments(channelId, msg.files, msg.ts!)
        : [];

      this.logToFile(channelId, {
        date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
        ts: msg.ts!,
        user: isMamaMessage ? "bot" : msg.user!,
        userName: isMamaMessage ? undefined : user?.userName,
        displayName: isMamaMessage ? undefined : user?.displayName,
        text,
        attachments,
        isBot: isMamaMessage,
      });
    }

    return relevantMessages.length;
  }

  private async backfillAllChannels(): Promise<void> {
    const startTime = Date.now();

    // Only backfill channels that already have a log.jsonl (mama has interacted with them before)
    const channelsToBackfill: Array<[string, SlackChannel]> = [];
    for (const [channelId, channel] of this.channels) {
      const logPath = join(this.workingDir, channelId, "log.jsonl");
      if (existsSync(logPath)) {
        channelsToBackfill.push([channelId, channel]);
      }
    }

    log.logBackfillStart(channelsToBackfill.length);

    let totalMessages = 0;
    for (const [channelId, channel] of channelsToBackfill) {
      try {
        const count = await this.backfillChannel(channelId);
        if (count > 0) log.logBackfillChannel(channel.name, count);
        totalMessages += count;
      } catch (error) {
        log.logWarning(`Failed to backfill #${channel.name}`, String(error));
      }

      // Add delay between channels to avoid hitting Slack rate limits
      if (channelId !== channelsToBackfill[channelsToBackfill.length - 1][0]) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const durationMs = Date.now() - startTime;
    log.logBackfillComplete(totalMessages, durationMs);
  }

  // ==========================================================================
  // Private - Fetch Users/Channels
  // ==========================================================================

  private async fetchUsers(): Promise<void> {
    let cursor: string | undefined;
    do {
      const result = await this.webClient.users.list({ limit: 200, cursor });
      const members = result.members as
        | Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
        | undefined;
      if (members) {
        for (const u of members) {
          if (u.id && u.name && !u.deleted) {
            this.users.set(u.id, {
              id: u.id,
              userName: u.name,
              displayName: u.real_name || u.name,
            });
          }
        }
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  }

  private async fetchChannels(): Promise<void> {
    // Fetch public/private channels
    let cursor: string | undefined;
    do {
      const result = await this.webClient.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      const channels = result.channels as
        | Array<{ id?: string; name?: string; is_member?: boolean }>
        | undefined;
      if (channels) {
        for (const c of channels) {
          if (c.id && c.name && c.is_member) {
            this.channels.set(c.id, { id: c.id, name: c.name });
          }
        }
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    // Also fetch DM channels (IMs)
    cursor = undefined;
    do {
      const result = await this.webClient.conversations.list({
        types: "im",
        limit: 200,
        cursor,
      });
      const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
      if (ims) {
        for (const im of ims) {
          if (im.id) {
            // Use user's name as channel name for DMs
            const user = im.user ? this.users.get(im.user) : undefined;
            const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
            this.channels.set(im.id, { id: im.id, name });
          }
        }
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  }
}
