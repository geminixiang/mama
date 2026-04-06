import type { ChatMessage, ChatResponseContext, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import type { LineBot, LineEvent } from "./bot.js";

export const LINE_FORMATTING_GUIDE = `## LINE Formatting
Text is plain. For bold/italic, use Unicode alternatives or emoji.
Code blocks are not supported in LINE.
Do NOT use Markdown syntax - LINE doesn't support it.`;

async function notifyError(
  bot: LineBot,
  userId: string,
  label: string,
  err: unknown,
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  log.logWarning(`LINE ${label} error`, errMsg);
  try {
    await bot.pushMessage(userId, `⚠️ 發送失敗：${errMsg}`);
  } catch {
    // ignore secondary failure
  }
}

export function createLineAdapters(
  event: LineEvent,
  bot: LineBot,
  _isEvent?: boolean,
): {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
} {
  let messageSent = false;
  let accumulatedText = "";
  let updatePromise = Promise.resolve();

  const userId = event.channel;

  const message: ChatMessage = {
    id: event.ts,
    sessionKey: event.sessionKey ?? event.channel,
    userId: event.user,
    userName: event.userName,
    text: event.text,
    attachments: event.attachments,
    threadTs: event.thread_ts,
  };

  const platform: PlatformInfo = {
    name: "line",
    formattingGuide: LINE_FORMATTING_GUIDE,
    channels: [],
    users: [],
  };

  // LINE message length limit is 5000 chars for push messages
  const MAX_LENGTH = 4800;
  const truncationNote = "\n\n(message truncated, ask me to elaborate on specific parts)";

  function truncate(text: string, limit: number, note: string): string {
    if (text.length > limit) {
      return text.substring(0, limit - note.length) + note;
    }
    return text;
  }

  async function sendResponse(text: string): Promise<void> {
    const displayText = truncate(text, MAX_LENGTH, truncationNote);
    if (event.replyToken && !messageSent) {
      // First message - use reply
      await bot.replyMessage(event.replyToken, displayText);
      messageSent = true;
    } else {
      // Subsequent messages - use push
      await bot.pushMessage(userId, displayText);
    }
  }

  const responseCtx: ChatResponseContext = {
    respond: async (text: string) => {
      updatePromise = updatePromise.then(async () => {
        try {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
          await sendResponse(accumulatedText);
          bot.logBotResponse(event.channel, text, event.ts);
        } catch (err) {
          await notifyError(bot, userId, "respond", err);
        }
      });
      await updatePromise;
    },

    replaceResponse: async (text: string) => {
      updatePromise = updatePromise.then(async () => {
        try {
          accumulatedText = truncate(text, MAX_LENGTH, truncationNote);
          // LINE doesn't support edit, so we just send a new message
          await bot.pushMessage(userId, accumulatedText);
        } catch (err) {
          await notifyError(bot, userId, "replaceResponse", err);
        }
      });
      await updatePromise;
    },

    // LINE has no threads — discard thread-only messages
    respondInThread: async (_text: string) => {},

    setTyping: async (_isTyping: boolean) => {
      // LINE doesn't have a typing indicator API like Telegram
      // Could use LINE's SIMULTANEOUSLY_SEND_MESSAGE hint but it's more complex
    },

    setWorking: async (_working: boolean) => {
      // No special handling needed
    },

    uploadFile: async (filePath: string, title?: string) => {
      // LINE file upload requires using the Upload Rich Menu Image API or similar
      // For now, we'll just send a text message with the file path
      const fileName = title ?? filePath.split("/").pop() ?? "file";
      await bot.pushMessage(userId, `[File ready: ${fileName}]\n${filePath}`);
    },

    deleteResponse: async () => {
      updatePromise = updatePromise.then(async () => {
        if (messageSent) {
          try {
            await bot.deleteMessage(event.channel, event.ts);
          } catch {
            // Ignore errors
          }
          messageSent = false;
        }
      });
      await updatePromise;
    },
  };

  return { message, responseCtx, platform };
}
