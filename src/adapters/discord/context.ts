import type { ChatMessage, ChatResponseContext, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import type { DiscordBot, DiscordEvent } from "./bot.js";

export const DISCORD_FORMATTING_GUIDE = `## Discord Formatting (Markdown)
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`language\ncode\`\`\`
Links: [text](url), Spoiler: ||text||
Keep messages under 2000 characters. Use code blocks for code.`;

export function createDiscordAdapters(
	event: DiscordEvent,
	bot: DiscordBot,
	isEvent?: boolean,
): {
	message: ChatMessage;
	responseCtx: ChatResponseContext;
	platform: PlatformInfo;
} {
	let messageId: string | null = null;
	const threadMessageIds: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;
	const isThreaded = !!event.thread_ts;

	const message: ChatMessage = {
		id: event.ts,
		sessionKey: `${event.channel}:${event.thread_ts ?? event.ts}`,
		userId: event.user,
		userName: event.userName,
		text: event.text,
		attachments: event.attachments,
	};

	const platform: PlatformInfo = {
		name: "discord",
		formattingGuide: DISCORD_FORMATTING_GUIDE,
		channels: bot.getAllChannels(),
		users: bot.getAllUsers(),
	};

	// Discord message limit is 2000 chars; use 1900 for safety
	const MAX_LENGTH = 1900;
	const truncationNote = "\n\n*(message truncated, ask me to elaborate on specific parts)*";

	function truncate(text: string, limit: number, note: string): string {
		if (text.length > limit) {
			return text.substring(0, limit - note.length) + note;
		}
		return text;
	}

	const responseCtx: ChatResponseContext = {
		respond: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
					const displayText = truncate(
						isWorking ? accumulatedText + workingIndicator : accumulatedText,
						MAX_LENGTH,
						truncationNote,
					);

					if (messageId !== null) {
						await bot.updateMessageRaw(event.channel, messageId, displayText);
					} else if (isThreaded && event.thread_ts) {
						messageId = await bot.postInThread(event.channel, event.thread_ts, displayText);
					} else {
						messageId = await bot.postReply(event.channel, event.ts, displayText);
					}

					if (messageId !== null) {
						bot.logBotResponse(event.channel, text, messageId);
					}
				} catch (err) {
					log.logWarning("Discord respond error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		replaceResponse: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					accumulatedText = truncate(text, MAX_LENGTH, truncationNote);
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageId !== null) {
						await bot.updateMessageRaw(event.channel, messageId, displayText);
					} else if (isThreaded && event.thread_ts) {
						messageId = await bot.postInThread(event.channel, event.thread_ts, displayText);
					} else {
						messageId = await bot.postReply(event.channel, event.ts, displayText);
					}
				} catch (err) {
					log.logWarning("Discord replaceResponse error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					const anchor = isThreaded ? event.thread_ts : messageId;
					if (anchor) {
						const threadText = truncate(text, MAX_LENGTH, "\n\n*(truncated)*");
						const id = await bot.postInThread(event.channel, anchor, threadText);
						threadMessageIds.push(id);
					}
				} catch (err) {
					log.logWarning("Discord respondInThread error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && messageId === null) {
				updatePromise = updatePromise.then(async () => {
					try {
						if (messageId === null) {
							await bot.sendTyping(event.channel);
							const initialText = eventFilename ? `Starting event: ${eventFilename}` : "_Thinking..._";
							accumulatedText = initialText;
							const displayText = accumulatedText + workingIndicator;
							if (isThreaded && event.thread_ts) {
								messageId = await bot.postInThread(event.channel, event.thread_ts, displayText);
							} else {
								messageId = await bot.postReply(event.channel, event.ts, displayText);
							}
						}
					} catch (err) {
						log.logWarning("Discord setTyping error", err instanceof Error ? err.message : String(err));
					}
				});
				await updatePromise;
			}
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				try {
					isWorking = working;
					if (messageId !== null) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await bot.updateMessageRaw(event.channel, messageId, displayText);
					}
				} catch (err) {
					log.logWarning("Discord setWorking error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		uploadFile: async (filePath: string, title?: string) => {
			await bot.uploadFile(event.channel, filePath, title);
		},

		deleteResponse: async () => {
			updatePromise = updatePromise.then(async () => {
				for (let i = threadMessageIds.length - 1; i >= 0; i--) {
					try {
						await bot.deleteMessageRaw(event.channel, threadMessageIds[i]);
					} catch {
						// Ignore errors
					}
				}
				threadMessageIds.length = 0;
				if (messageId !== null) {
					try {
						await bot.deleteMessageRaw(event.channel, messageId);
					} catch {
						// Ignore errors
					}
					messageId = null;
				}
			});
			await updatePromise;
		},
	};

	return { message, responseCtx, platform };
}
