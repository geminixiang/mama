import type { ChatMessage, ChatResponseContext, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import type { TelegramBot, TelegramEvent } from "./bot.js";

export const TELEGRAM_FORMATTING_GUIDE = `## Telegram Formatting (HTML mode)
Bold: <b>text</b>, Italic: <i>text</i>, Code: <code>code</code>, Pre: <pre>code</pre>
Links: <a href="url">text</a>
Do NOT use Markdown asterisks or backtick syntax.`;

export function createTelegramAdapters(
  event: TelegramEvent,
  bot: TelegramBot,
  isEvent?: boolean,
): {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
} {
  let messageId: number | null = null;
  let accumulatedText = "";
  let isWorking = true;
  const workingIndicator = " ...";
  let updatePromise = Promise.resolve();

  const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;
  const replyToId = event.thread_ts ? parseInt(event.thread_ts) : null;

  const message: ChatMessage = {
    id: event.ts,
    sessionKey: `${event.channel}:${event.thread_ts ?? event.ts}`,
    userId: event.user,
    userName: event.userName,
    text: event.text,
    attachments: event.attachments,
  };

  const platform: PlatformInfo = {
    name: "telegram",
    formattingGuide: TELEGRAM_FORMATTING_GUIDE,
    channels: [],
    users: [],
  };

  // Telegram message length limit is 4096 chars; use 3800 for safety
  const MAX_LENGTH = 3800;
  const truncationNote = "\n\n<i>(message truncated, ask me to elaborate on specific parts)</i>";

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
            await bot.updateMessage(event.channel, String(messageId), displayText);
          } else if (replyToId !== null) {
            messageId = await bot.postReply(parseInt(event.channel), replyToId, displayText);
          } else {
            messageId = await bot.postMessageRaw(parseInt(event.channel), displayText);
          }

          if (messageId !== null) {
            bot.logBotResponse(event.channel, text, String(messageId));
          }
        } catch (err) {
          log.logWarning(
            "Telegram respond error",
            err instanceof Error ? err.message : String(err),
          );
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
            await bot.updateMessage(event.channel, String(messageId), displayText);
          } else if (replyToId !== null) {
            messageId = await bot.postReply(parseInt(event.channel), replyToId, displayText);
          } else {
            messageId = await bot.postMessageRaw(parseInt(event.channel), displayText);
          }
        } catch (err) {
          log.logWarning(
            "Telegram replaceResponse error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    // Telegram has no threads — discard thread-only messages (e.g. usage summary)
    respondInThread: async (_text: string) => {},

    setTyping: async (isTyping: boolean) => {
      if (isTyping && messageId === null) {
        updatePromise = updatePromise.then(async () => {
          try {
            if (messageId === null) {
              await bot.sendTyping(parseInt(event.channel));
              const initialText = eventFilename ? `Starting event: ${eventFilename}` : "Thinking";
              accumulatedText = initialText;
              const displayText = accumulatedText + workingIndicator;
              if (replyToId !== null) {
                messageId = await bot.postReply(parseInt(event.channel), replyToId, displayText);
              } else {
                messageId = await bot.postMessageRaw(parseInt(event.channel), displayText);
              }
            }
          } catch (err) {
            log.logWarning(
              "Telegram setTyping error",
              err instanceof Error ? err.message : String(err),
            );
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
            await bot.updateMessage(event.channel, String(messageId), displayText);
          }
        } catch (err) {
          log.logWarning(
            "Telegram setWorking error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    uploadFile: async (filePath: string, title?: string) => {
      await bot.uploadFile(event.channel, filePath, title);
    },

    deleteResponse: async () => {
      updatePromise = updatePromise.then(async () => {
        if (messageId !== null) {
          try {
            await bot.deleteMessageRaw(parseInt(event.channel), messageId);
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
