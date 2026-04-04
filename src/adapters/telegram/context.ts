import type { ChatMessage, ChatResponseContext, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import type { TelegramBot, TelegramEvent } from "./bot.js";

export const TELEGRAM_FORMATTING_GUIDE = `## Telegram Formatting (HTML mode)
Bold: <b>text</b>, Italic: <i>text</i>, Code: <code>code</code>, Pre: <pre>code</pre>
Links: <a href="url">text</a>
Do NOT use Markdown asterisks or backtick syntax.
Do NOT use <table> tags — they are unsupported. Use <pre> with ASCII art for tables instead.`;

function htmlTableToText(tableHtml: string): string {
  const rows: string[][] = [];
  for (const rowMatch of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return "";

  const numCols = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = Array(numCols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i], (row[i] ?? "").length);
    }
  }

  const sep = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const lines: string[] = [sep];
  for (let i = 0; i < rows.length; i++) {
    const cells = colWidths.map((w, j) => ` ${(rows[i][j] ?? "").padEnd(w)} `);
    lines.push("|" + cells.join("|") + "|");
    if (i === 0) lines.push(sep);
  }
  lines.push(sep);
  return lines.join("\n");
}

function sanitizeTelegramHtml(text: string): string {
  if (!text.includes("<table")) return text;
  return text.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const ascii = htmlTableToText(tableHtml);
    return ascii ? `<pre>${ascii}</pre>` : "";
  });
}

async function notifyError(
  bot: TelegramBot,
  chatId: number,
  label: string,
  err: unknown,
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  log.logWarning(`Telegram ${label} error`, errMsg);
  try {
    await bot.postPlainMessage(chatId, `⚠️ 發送失敗：${errMsg}`);
  } catch {
    // ignore secondary failure
  }
}

export function createTelegramAdapters(
  event: TelegramEvent,
  bot: TelegramBot,
  _isEvent?: boolean,
): {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
} {
  let messageId: number | null = null;
  let accumulatedText = "";
  let updatePromise = Promise.resolve();
  let typingInterval: ReturnType<typeof setInterval> | null = null;

  function stopTyping() {
    if (typingInterval !== null) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  }

  const chatId = parseInt(event.channel);
  const replyToId = event.thread_ts ? parseInt(event.thread_ts) : null;

  const message: ChatMessage = {
    id: event.ts,
    sessionKey: event.sessionKey ?? `${event.channel}:${event.thread_ts ?? event.ts}`,
    userId: event.user,
    userName: event.userName,
    text: event.text,
    attachments: event.attachments,
    threadTs: event.thread_ts,
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

  async function sendOrUpdate(displayText: string): Promise<void> {
    if (messageId !== null) {
      await bot.updateMessage(event.channel, String(messageId), displayText);
    } else if (replyToId !== null) {
      messageId = await bot.postReply(chatId, replyToId, displayText);
    } else {
      messageId = await bot.postMessageRaw(chatId, displayText);
    }
  }

  const responseCtx: ChatResponseContext = {
    respond: async (text: string) => {
      updatePromise = updatePromise.then(async () => {
        try {
          const sanitized = sanitizeTelegramHtml(text);
          accumulatedText = accumulatedText ? `${accumulatedText}\n${sanitized}` : sanitized;
          const displayText = truncate(accumulatedText, MAX_LENGTH, truncationNote);
          await sendOrUpdate(displayText);
          if (messageId !== null) {
            bot.logBotResponse(event.channel, text, String(messageId));
          }
        } catch (err) {
          await notifyError(bot, chatId, "respond", err);
        }
      });
      await updatePromise;
    },

    replaceResponse: async (text: string) => {
      updatePromise = updatePromise.then(async () => {
        try {
          accumulatedText = truncate(sanitizeTelegramHtml(text), MAX_LENGTH, truncationNote);
          await sendOrUpdate(accumulatedText);
        } catch (err) {
          await notifyError(bot, chatId, "replaceResponse", err);
        }
      });
      await updatePromise;
    },

    // Telegram has no threads — discard thread-only messages (e.g. usage summary)
    respondInThread: async (_text: string) => {},

    setTyping: async (isTyping: boolean) => {
      if (isTyping && typingInterval === null) {
        // Send immediately and repeat every 4s (Telegram clears indicator after ~5s)
        bot.sendTyping(chatId).catch(() => {});
        typingInterval = setInterval(() => {
          bot.sendTyping(chatId).catch(() => {});
        }, 4000);
      } else if (!isTyping) {
        stopTyping();
      }
    },

    setWorking: async (working: boolean) => {
      if (!working) stopTyping();
    },

    uploadFile: async (filePath: string, title?: string) => {
      await bot.uploadFile(event.channel, filePath, title);
    },

    deleteResponse: async () => {
      updatePromise = updatePromise.then(async () => {
        if (messageId !== null) {
          try {
            await bot.deleteMessageRaw(chatId, messageId);
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
