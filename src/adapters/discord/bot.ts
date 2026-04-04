import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Collection,
  type Message,
  type Attachment,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
  type ThreadChannel,
} from "discord.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";

import type { Bot, BotEvent, BotHandler, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import { createDiscordAdapters } from "./context.js";

// ============================================================================
// Types
// ============================================================================

export interface DiscordEvent extends BotEvent {
  type: "mention" | "dm";
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
      log.logWarning("Discord queue error", err instanceof Error ? err.message : String(err));
    }
    this.processing = false;
    this.processNext();
  }
}

// ============================================================================
// DiscordBot
// ============================================================================

export class DiscordBot implements Bot {
  private client: Client;
  private handler: BotHandler;
  private workingDir: string;
  private botUserId: string | null = null;
  private queues = new Map<string, ChannelQueue>();
  private startupTime: number = 0;
  private channels = new Map<string, { id: string; name: string }>();
  private users = new Map<string, { id: string; userName: string; displayName: string }>();
  /** Thread IDs created by this bot — replies in these threads skip the @mention check */
  private ownThreads = new Set<string>();

  constructor(handler: BotHandler, config: { token: string; workingDir: string }) {
    this.handler = handler;
    this.workingDir = config.workingDir;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  // ==========================================================================
  // Public API (implements Bot)
  // ==========================================================================

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (readyClient) => {
        this.botUserId = readyClient.user.id;
        this.startupTime = Date.now();
        log.logConnected();
        log.logInfo(`Discord bot started as ${readyClient.user.tag}`);
        this.loadCachedGuildData();
        this.setupEventHandlers();
        resolve();
      });
      this.client.once(Events.Error, reject);
      this.client.login(process.env.MOM_DISCORD_BOT_TOKEN!).catch(reject);
    });
  }

  async postMessage(channel: string, text: string): Promise<string> {
    const ch = await this.fetchTextChannel(channel);
    const msg = await ch.send(text);
    return msg.id;
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await this.updateMessageRaw(channel, ts, text);
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
      const adapters = createDiscordAdapters(event as DiscordEvent, this, true);
      return this.handler.handleEvent(event, this, adapters, true);
    });
    return true;
  }

  getPlatformInfo(): PlatformInfo {
    return {
      name: "discord",
      formattingGuide:
        "## Discord Formatting (Markdown)\nBold: **text**, Italic: *text*, Code: `code`, Block: ```language\ncode```\nLinks: [text](url)",
      channels: this.getAllChannels(),
      users: this.getAllUsers(),
    };
  }

  // ==========================================================================
  // Internal helpers (used by context.ts)
  // ==========================================================================

  async updateMessageRaw(channelId: string, messageId: string, text: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit(text);
  }

  async postReply(channelId: string, replyToId: string, text: string): Promise<string> {
    const ch = await this.fetchTextChannel(channelId);
    const replyTarget = await ch.messages.fetch(replyToId);
    const sent = await replyTarget.reply(text);
    return sent.id;
  }

  async createThreadOnMessage(channelId: string, messageId: string, name: string): Promise<string> {
    const ch = await this.fetchTextChannel(channelId);
    const msg = await ch.messages.fetch(messageId);
    const thread = await msg.startThread({
      name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    });
    this.ownThreads.add(thread.id);
    return thread.id;
  }

  registerThreadAlias(aliasKey: string, sessionKey: string): void {
    this.handler.registerThreadAlias(aliasKey, sessionKey);
  }

  async postEmbed(channelId: string, embed: object): Promise<string> {
    const ch = await this.fetchTextChannel(channelId);
    const msg = await ch.send({ embeds: [embed] });
    return msg.id;
  }

  async updateMessageWithComponents(
    channelId: string,
    messageId: string,
    text: string,
    components: object[],
  ): Promise<void> {
    const ch = await this.fetchTextChannel(channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({ content: text, components: components as any[] });
  }

  async postInThread(channelId: string, threadOrMessageId: string, text: string): Promise<string> {
    // Try as a thread channel first, then fall back to posting in the channel
    try {
      const thread = await this.client.channels.fetch(threadOrMessageId);
      if (thread && (thread.isThread() || thread.isTextBased())) {
        const msg = await (thread as ThreadChannel).send(text);
        return msg.id;
      }
    } catch {
      // Not a thread channel, treat as message ID for reply
    }
    return this.postReply(channelId, threadOrMessageId, text);
  }

  async deleteMessageRaw(channelId: string, messageId: string): Promise<void> {
    try {
      const ch = await this.fetchTextChannel(channelId);
      const msg = await ch.messages.fetch(messageId);
      await msg.delete();
    } catch {
      // Ignore if already deleted
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      const ch = await this.fetchTextChannel(channelId);
      await ch.sendTyping();
    } catch {
      // Non-fatal
    }
  }

  async uploadFile(channelId: string, filePath: string, title?: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId);
    const fileName = title ?? basename(filePath);
    const fileContent = readFileSync(filePath);
    await ch.send({ files: [{ attachment: fileContent, name: fileName }] });
  }

  getAllChannels(): { id: string; name: string }[] {
    return Array.from(this.channels.values());
  }

  getAllUsers(): { id: string; userName: string; displayName: string }[] {
    return Array.from(this.users.values());
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
   * Process attachments from a Discord message
   * Downloads files in background and returns metadata
   * Returns format compatible with ChatMessage: { name: string, localPath: string }[]
   */
  processAttachments(
    channelId: string,
    attachments: Collection<string, Attachment>,
    _messageId: string,
  ): { name: string; localPath: string }[] {
    const result: { name: string; localPath: string }[] = [];

    // Discord attachments Collection - iterate over values
    for (const attachment of attachments.values()) {
      if (!attachment.name) {
        log.logWarning("Discord attachment missing name, skipping", attachment.url);
        continue;
      }

      // Generate local filename
      const ts = Date.now();
      const sanitizedName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${ts}_${sanitizedName}`;
      const localPath = `${channelId}/attachments/${filename}`;
      const fullDir = join(this.workingDir, channelId, "attachments");

      result.push({
        name: attachment.name,
        localPath: localPath,
      });

      // Download in background (fire and forget)
      this.downloadAttachment(fullDir, filename, attachment.url).catch((err) => {
        log.logWarning(`Failed to download Discord attachment`, `${filename}: ${err}`);
      });
    }

    return result;
  }

  /**
   * Download an attachment from URL to local file
   */
  private async downloadAttachment(dir: string, filename: string, url: string): Promise<void> {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      writeFileSync(join(dir, filename), Buffer.from(buffer));
    } catch (err) {
      throw new Error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
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

  private loadCachedGuildData(): void {
    for (const guild of this.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (channel.isTextBased() && "name" in channel) {
          this.channels.set(channel.id, { id: channel.id, name: channel.name ?? channel.id });
        }
      }
      for (const member of guild.members.cache.values()) {
        this.users.set(member.id, {
          id: member.id,
          userName: member.user.username,
          displayName: member.displayName,
        });
      }
    }
  }

  private stripBotMention(text: string): string {
    if (!this.botUserId) return text;
    return text.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
  }

  private setupEventHandlers(): void {
    this.client.on(Events.MessageCreate, async (msg: Message) => {
      // Skip messages from before startup
      if (msg.createdTimestamp < this.startupTime) return;
      // Skip bot messages
      if (msg.author.bot) return;
      // Skip if bot isn't mentioned and it's not a DM
      const isDM = msg.channel.type === 1; // ChannelType.DM = 1
      const isMentioned = msg.mentions.users.has(this.botUserId ?? "");
      const isInOwnThread = msg.channel.isThread() && this.ownThreads.has(msg.channelId);
      if (!isDM && !isMentioned && !isInOwnThread) return;

      const channelId = msg.channelId;
      const userId = msg.author.id;
      const userName = msg.author.username;
      const msgId = msg.id;

      // Track user
      this.users.set(userId, {
        id: userId,
        userName,
        displayName: msg.member?.displayName ?? userName,
      });

      // Track channel
      if (!this.channels.has(channelId) && "name" in msg.channel) {
        const ch = msg.channel as TextChannel | NewsChannel;
        this.channels.set(channelId, { id: channelId, name: ch.name });
      }

      // Thread: if this message is in a thread (has parentId) or is a reply
      const isInThread = msg.channel.isThread();
      const referencedMsgId = msg.reference?.messageId;
      const threadTs = isInThread ? msg.channelId : referencedMsgId;
      const rawSessionKey = `${channelId}:${threadTs ?? msgId}`;
      const sessionKey = this.handler.resolveSessionKey(rawSessionKey);

      const cleanedText = this.stripBotMention(msg.content);

      // Process attachments (download in background)
      const processedAttachments = this.processAttachments(channelId, msg.attachments, msgId);

      const event: DiscordEvent = {
        type: isDM ? "dm" : "mention",
        channel: channelId,
        ts: msgId,
        thread_ts: threadTs,
        user: userId,
        userName,
        text: cleanedText,
        attachments: processedAttachments,
      };

      // Log message
      this.logToFile(channelId, {
        date: msg.createdAt.toISOString(),
        ts: msgId,
        user: userId,
        userName,
        text: cleanedText,
        attachments: processedAttachments,
        isBot: false,
      });

      // Handle stop command
      if (cleanedText.toLowerCase() === "stop" || cleanedText.toLowerCase() === "/stop") {
        if (this.handler.isRunning(sessionKey)) {
          this.handler.handleStop(sessionKey, channelId, this);
        } else {
          await this.postMessage(channelId, "_Nothing running_");
        }
        return;
      }

      if (this.handler.isRunning(sessionKey)) {
        await this.postMessage(channelId, "_Already working. Say `stop` to cancel._");
      } else {
        this.getQueue(sessionKey).enqueue(() => {
          const adapters = createDiscordAdapters(event, this, false);
          return this.handler.handleEvent(event, this, adapters, false);
        });
      }
    });

    // Handle button interactions (e.g. Stop button)
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;

      const customId = interaction.customId;

      if (customId.startsWith("mama_stop:")) {
        const sessionKey = customId.slice("mama_stop:".length);
        const channelId = interaction.channelId;

        if (this.handler.isRunning(sessionKey)) {
          this.handler.handleStop(sessionKey, channelId, this);
          await interaction.reply({ content: "_Stopping..._", ephemeral: true });
        } else {
          await interaction.reply({ content: "_Nothing running_", ephemeral: true });
        }
      }
    });
  }

  private async fetchTextChannel(
    channelId: string,
  ): Promise<TextChannel | DMChannel | NewsChannel | ThreadChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    return ch as TextChannel | DMChannel | NewsChannel | ThreadChannel;
  }
}
