import type {
  ChatMessage,
  ChatResponseContext,
  ChatToolResult,
  PlatformInfo,
} from "../../adapter.js";
import * as log from "../../log.js";
import { formatToolArgs, splitText } from "../shared.js";
import type { SlackBot, SlackEvent } from "./bot.js";
import { resolveSlackRootTs, resolveSlackSessionKey } from "./session.js";

export const SLACK_FORMATTING_GUIDE = `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).`;

const MAX_MAIN_LENGTH = 35000; // Slack hard limit is 40k
const MAX_THREAD_LENGTH = 20000;
const TRUNCATION_NOTE_INCREMENTAL =
  "\n\n_(message truncated, ask me to elaborate on specific parts)_";
const TRUNCATION_NOTE_FINAL = "\n\n_(see thread for full response)_";

const formatSlackContinuation = (partNum: number): string => `_(continued ${partNum})_`;

function isSlackMessageTs(ts: string | undefined): ts is string {
  return typeof ts === "string" && /^\d+\.\d+$/.test(ts);
}

function formatSlackToolResult(result: ChatToolResult): string {
  const argsFormatted = formatToolArgs(result.args);
  const duration = (result.durationMs / 1000).toFixed(1);
  let text = `*${result.isError ? "✗" : "✓"} ${result.toolName}*`;
  if (result.label) text += `: ${result.label}`;
  text += ` (${duration}s)\n`;
  if (argsFormatted) text += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
  text += `*Result:*\n\`\`\`\n${result.result}\n\`\`\``;
  return text;
}

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

  const channelId = event.channel;
  const conversationId = event.conversationId;
  const user = slack.getUser(event.user);

  // Extract event filename for status message
  const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

  const rootTs =
    event.thread_ts ?? (isSlackMessageTs(event.ts) ? resolveSlackRootTs(event.ts) : undefined);
  const isThreaded = !!event.thread_ts;

  /**
   * Post the first visible reply.
   * Normal Slack messages reply in-thread under the triggering user message.
   * Synthetic event messages have no real Slack root ts, so they must post top-level.
   */
  const postFirstMessage = async (text: string): Promise<string> => {
    if (isEvent) {
      if (event.thread_ts) {
        return slack.postInThread(channelId, event.thread_ts, text);
      }
      return slack.postMessage(channelId, text);
    }
    return isSlackMessageTs(event.ts)
      ? slack.postInThread(channelId, event.ts, text)
      : slack.postMessage(channelId, text);
  };

  const postDiagnosticDirect = async (
    text: string,
    options?: { style?: "muted" | "error" },
  ): Promise<void> => {
    const threadAnchor = rootTs ?? messageTs;
    if (!threadAnchor) return;

    for (const part of splitText(text, MAX_THREAD_LENGTH, formatSlackContinuation)) {
      if (options?.style === "muted") {
        const CONTEXT_TEXT_LIMIT = 3000;
        const blockText =
          part.length > CONTEXT_TEXT_LIMIT
            ? part.substring(0, CONTEXT_TEXT_LIMIT - 20) + "\n_(truncated)_"
            : part;
        const ts = await slack.postInThreadBlocks(channelId, threadAnchor, part, [
          { type: "context", elements: [{ type: "mrkdwn", text: blockText }] },
        ]);
        threadMessageTs.push(ts);
      } else {
        const diagnosticText = options?.style === "error" ? `_${part}_` : part;
        const ts = await slack.postInThread(channelId, threadAnchor, diagnosticText);
        threadMessageTs.push(ts);
      }
    }
  };

  const message: ChatMessage = {
    id: event.ts,
    sessionKey: event.sessionKey ?? resolveSlackSessionKey(conversationId, event.thread_ts),
    conversationKind: event.conversationKind,
    userId: event.user,
    userName: user?.userName,
    text: event.text,
    attachments: (event.attachments || []).map((a) => ({
      name: a.original,
      localPath: a.localPath,
    })),
    threadTs: event.thread_ts,
  };

  const platform: PlatformInfo = {
    name: "slack",
    formattingGuide: SLACK_FORMATTING_GUIDE,
    channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
    users: slack
      .getAllUsers()
      .map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),
  };

  const responseCtx = {
    respond: async (text: string) => {
      updatePromise = updatePromise.then(async () => {
        try {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

          if (accumulatedText.length > MAX_MAIN_LENGTH) {
            accumulatedText =
              accumulatedText.substring(0, MAX_MAIN_LENGTH - TRUNCATION_NOTE_INCREMENTAL.length) +
              TRUNCATION_NOTE_INCREMENTAL;
          }

          const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

          if (messageTs) {
            await slack.updateMessage(channelId, messageTs, displayText);
          } else if (isThreaded && rootTs) {
            // Reply within the user's thread
            messageTs = await slack.postInThread(channelId, rootTs, displayText);
          } else {
            messageTs = await postFirstMessage(displayText);
          }

          if (messageTs) {
            slack.logBotResponse(channelId, text, messageTs, isThreaded ? rootTs : undefined);
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
          const overflowed = text.length > MAX_MAIN_LENGTH;
          accumulatedText = overflowed
            ? text.substring(0, MAX_MAIN_LENGTH - TRUNCATION_NOTE_FINAL.length) +
              TRUNCATION_NOTE_FINAL
            : text;

          const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

          if (messageTs) {
            await slack.updateMessage(channelId, messageTs, displayText);
          } else if (isThreaded && rootTs) {
            messageTs = await slack.postInThread(channelId, rootTs, displayText);
          } else {
            messageTs = await postFirstMessage(displayText);
          }

          if (overflowed) {
            await postDiagnosticDirect(text);
          }
        } catch (err) {
          log.logWarning(
            "Slack replaceResponse error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    respondDiagnostic: async (text: string, options?: { style?: "muted" | "error" }) => {
      updatePromise = updatePromise.then(async () => {
        try {
          await postDiagnosticDirect(text, options);
        } catch (err) {
          log.logWarning(
            "Slack respondDiagnostic error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    respondToolResult: async (result: ChatToolResult) => {
      await responseCtx.respondDiagnostic(formatSlackToolResult(result));
    },

    setTyping: async (isTyping: boolean) => {
      if (isTyping && !messageTs && rootTs) {
        try {
          const statusText = eventFilename ? `Starting event: ${eventFilename}` : "Thinking";
          await slack.setAssistantStatus(channelId, rootTs, statusText);
        } catch {
          // Assistant API not available — first respond() call will create the message
        }
      }
    },

    uploadFile: async (filePath: string, title?: string) => {
      await slack.uploadFile(channelId, filePath, title, rootTs);
    },

    setWorking: async (working: boolean) => {
      updatePromise = updatePromise.then(async () => {
        try {
          isWorking = working;
          if (messageTs) {
            const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
            const updates: Promise<void>[] = [
              slack.updateMessage(channelId, messageTs, displayText),
            ];
            if (!working) {
              if (rootTs) {
                updates.push(slack.setAssistantStatus(channelId, rootTs, "").catch(() => {}));
              }
            }
            await Promise.all(updates);
          }
        } catch (err) {
          log.logWarning(
            "Slack setWorking error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    deleteResponse: async () => {
      updatePromise = updatePromise.then(async () => {
        // Clear assistant status first
        if (rootTs) {
          try {
            await slack.setAssistantStatus(channelId, rootTs, "");
          } catch {
            // Ignore errors clearing status
          }
        }

        // Delete thread messages first (in reverse order)
        for (let i = threadMessageTs.length - 1; i >= 0; i--) {
          try {
            await slack.deleteMessage(channelId, threadMessageTs[i]);
          } catch {
            // Ignore errors deleting thread messages
          }
        }
        threadMessageTs.length = 0;
        // Then delete main message
        if (messageTs) {
          await slack.deleteMessage(channelId, messageTs);
          messageTs = null;
        }
      });
      await updatePromise;
    },
  };

  return { message, responseCtx, platform };
}
