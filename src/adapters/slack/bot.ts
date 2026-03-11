import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { basename, join } from "path";
import type { Bot, BotEvent, BotHandler, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import type { Attachment, ChannelStore } from "../../store.js";
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
				const data = (lastError as { data?: { error?: string; response?: { status?: number } } }).data;
				if (data?.error === "rate_limited" || data?.response?.status === 429) {
					isRateLimited = true;
				}
			}

			if (isRateLimited) {
				const delay = baseDelayMs * Math.pow(2, attempt);
				log.logWarning(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
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
	channel: string;
	ts: string;
	thread_ts?: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
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
		attachments: Array<{ local: string }>;
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

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		return withRetry(async () => {
			const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
			return result.ts as string;
		});
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		return withRetry(async () => {
			const fileName = title || basename(filePath);
			const fileContent = readFileSync(filePath);
			await this.webClient.files.uploadV2({
				channel_id: channel,
				file: fileContent,
				filename: fileName,
				title: fileName,
			});
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

	getPlatformInfo(): PlatformInfo {
		return {
			name: "slack",
			formattingGuide:
				"## Slack Formatting (mrkdwn, NOT Markdown)\nBold: *text*, Italic: _text_, Code: `code`, Block: ```code```, Links: <url|text>\nDo NOT use **double asterisks** or [markdown](links).",
			channels: this.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
			users: this.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),
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
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => {
			const adapters = createSlackAdapters(event as unknown as SlackEvent, this, true);
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

			// Derive session key from thread context
			const rootTs = e.thread_ts ?? e.ts;
			const sessionKey = `${e.channel}:${rootTs}`;

			const slackEvent: SlackEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				thread_ts: e.thread_ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
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
				if (this.handler.isRunning(sessionKey)) {
					this.handler.handleStop(sessionKey, e.channel, this); // Don't await, don't queue
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				ack();
				return;
			}

			// SYNC: Check if busy (per-thread)
			if (this.handler.isRunning(sessionKey)) {
				this.postMessage(e.channel, "_Already working in this thread. Say `@mama stop` to cancel._");
			} else {
				this.getQueue(sessionKey).enqueue(() => {
					const adapters = createSlackAdapters(slackEvent, this, false);
					return this.handler.handleEvent(slackEvent as unknown as import("../../adapter.js").BotEvent, this, adapters, false);
				});
			}

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
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// Skip channel @mentions - already handled by app_mention event
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				thread_ts: e.thread_ts,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			// Only trigger handler for DMs
			if (isDM) {
				const dmRootTs = e.thread_ts ?? e.ts;
				const dmSessionKey = `${e.channel}:${dmRootTs}`;

				// Check for stop command - execute immediately, don't queue!
				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(dmSessionKey)) {
						this.handler.handleStop(dmSessionKey, e.channel, this); // Don't await, don't queue
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					ack();
					return;
				}

				if (this.handler.isRunning(dmSessionKey)) {
					this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
				} else {
					this.getQueue(dmSessionKey).enqueue(() => {
						const adapters = createSlackAdapters(slackEvent, this, false);
						return this.handler.handleEvent(slackEvent as unknown as import("../../adapter.js").BotEvent, this, adapters, false);
					});
				}
			}

			ack();
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
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
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

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
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
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
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
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
