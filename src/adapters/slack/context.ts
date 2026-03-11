import type { ChatMessage, ChatResponseContext, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import type { SlackBot, SlackEvent } from "./bot.js";

export const SLACK_FORMATTING_GUIDE = `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).`;

export function createSlackAdapters(
	event: SlackEvent,
	slack: SlackBot,
	isEvent?: boolean,
): {
	message: ChatMessage;
	responseCtx: ChatResponseContext;
	platform: PlatformInfo;
} {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	const rootTs = event.thread_ts ?? event.ts;
	const isThreaded = !!event.thread_ts;

	const message: ChatMessage = {
		id: event.ts,
		sessionKey: `${event.channel}:${rootTs}`,
		userId: event.user,
		userName: user?.userName,
		text: event.text,
		attachments: (event.attachments || []).map((a) => ({ name: a.local, localPath: a.local })),
	};

	const platform: PlatformInfo = {
		name: "slack",
		formattingGuide: SLACK_FORMATTING_GUIDE,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),
	};

	const responseCtx = {
		respond: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

					// Truncate accumulated text if too long (Slack limit is 40K, we use 35K for safety)
					const MAX_MAIN_LENGTH = 35000;
					const truncationNote = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
					if (accumulatedText.length > MAX_MAIN_LENGTH) {
						accumulatedText =
							accumulatedText.substring(0, MAX_MAIN_LENGTH - truncationNote.length) + truncationNote;
					}

					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else if (isThreaded) {
						// Reply within the user's thread
						messageTs = await slack.postInThread(event.channel, rootTs, displayText);
					} else {
						messageTs = await slack.postMessage(event.channel, displayText);
					}

					if (messageTs) {
						slack.logBotResponse(event.channel, text, messageTs);
					}
				} catch (err) {
					log.logWarning("Slack respond error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		replaceResponse: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					// Replace the accumulated text entirely, with truncation
					const MAX_MAIN_LENGTH = 35000;
					const truncationNote = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
					if (text.length > MAX_MAIN_LENGTH) {
						accumulatedText = text.substring(0, MAX_MAIN_LENGTH - truncationNote.length) + truncationNote;
					} else {
						accumulatedText = text;
					}

					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else if (isThreaded) {
						messageTs = await slack.postInThread(event.channel, rootTs, displayText);
					} else {
						messageTs = await slack.postMessage(event.channel, displayText);
					}
				} catch (err) {
					log.logWarning("Slack replaceResponse error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					// For threaded sessions, anchor to the user's root thread
					// For channel sessions, anchor to the main bot message
					const threadAnchor = isThreaded ? rootTs : messageTs;
					if (threadAnchor) {
						// Truncate thread messages if too long (20K limit for safety)
						const MAX_THREAD_LENGTH = 20000;
						let threadText = text;
						if (threadText.length > MAX_THREAD_LENGTH) {
							threadText = `${threadText.substring(0, MAX_THREAD_LENGTH - 50)}\n\n_(truncated)_`;
						}

						const ts = await slack.postInThread(event.channel, threadAnchor, threadText);
						threadMessageTs.push(ts);
					}
				} catch (err) {
					log.logWarning("Slack respondInThread error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					try {
						if (!messageTs) {
							accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
							if (isThreaded) {
								messageTs = await slack.postInThread(event.channel, rootTs, accumulatedText + workingIndicator);
							} else {
								messageTs = await slack.postMessage(event.channel, accumulatedText + workingIndicator);
							}
						}
					} catch (err) {
						log.logWarning("Slack setTyping error", err instanceof Error ? err.message : String(err));
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await slack.uploadFile(event.channel, filePath, title);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				try {
					isWorking = working;
					if (messageTs) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await slack.updateMessage(event.channel, messageTs, displayText);
					}
				} catch (err) {
					log.logWarning("Slack setWorking error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		deleteResponse: async () => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread messages first (in reverse order)
				for (let i = threadMessageTs.length - 1; i >= 0; i--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[i]);
					} catch {
						// Ignore errors deleting thread messages
					}
				}
				threadMessageTs.length = 0;
				// Then delete main message
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},
	};

	return { message, responseCtx, platform };
}
