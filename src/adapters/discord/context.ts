import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { ChatMessage, ChatResponseContext, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import type { DiscordBot, DiscordEvent } from "./bot.js";

export const DISCORD_FORMATTING_GUIDE = `## Discord Formatting (Markdown)
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`language\ncode\`\`\`
Links: [text](url), Spoiler: ||text||
Keep messages under 2000 characters. Use code blocks for code.
Your reply appears as the main message; a thread is auto-created beneath it for tool logs, thinking, and usage details. Keep your main reply concise — users can expand the thread for details.`;

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
  let accumulatedText = "";
  let isWorking = true;
  const workingIndicator = " ...";
  let updatePromise = Promise.resolve();
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let threadChannelId: string | null = null;
  let pendingThreadMessages: Array<{ text: string; options?: { style?: "muted" } }> = [];

  function stopTyping(): void {
    if (typingInterval !== null) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  }

  const _eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;
  const isThreaded = !!event.thread_ts;

  const message: ChatMessage = {
    id: event.ts,
    sessionKey: `${event.channel}:${event.thread_ts ?? event.ts}`,
    userId: event.user,
    userName: event.userName,
    text: event.text,
    attachments: event.attachments,
    threadTs: event.thread_ts,
  };

  const platform: PlatformInfo = {
    name: "discord",
    formattingGuide: DISCORD_FORMATTING_GUIDE,
    channels: bot.getAllChannels(),
    users: bot.getAllUsers(),
  };

  // Discord message limit is 2000 chars; use 1900 for safety
  const MAX_LENGTH = 1900;
  // Embed description limit
  const EMBED_MAX_LENGTH = 4096;

  const sessionKey = message.sessionKey;

  function buildStopRow(): object {
    return new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`mama_stop:${sessionKey}`)
          .setLabel("Stop")
          .setStyle(ButtonStyle.Danger)
          .setEmoji("🛑"),
      )
      .toJSON();
  }

  /**
   * Split text into chunks of at most maxLen characters.
   * Prefers splitting at \n\n boundaries, then \n, then space.
   * Avoids splitting inside ``` code blocks when possible.
   * Non-final parts get a _(continued N...)_ suffix.
   */
  function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const parts: string[] = [];

    function findSplit(chunk: string, limit: number): number {
      // Check if we'd split inside a code block
      const codeBlockMatches = [...chunk.substring(0, limit).matchAll(/```/g)];
      const insideCodeBlock = codeBlockMatches.length % 2 !== 0;

      // Try to find a split before any open code block if inside one
      if (insideCodeBlock) {
        // Find the last ``` before limit
        const lastOpen = chunk.lastIndexOf("```", limit - 1);
        if (lastOpen > 0) {
          // Split just before the code block opening
          const beforeBlock = chunk.lastIndexOf("\n\n", lastOpen);
          if (beforeBlock > limit / 2) return beforeBlock;
          const beforeBlockNl = chunk.lastIndexOf("\n", lastOpen);
          if (beforeBlockNl > limit / 2) return beforeBlockNl;
        }
      }

      // Try \n\n
      const dblNl = chunk.lastIndexOf("\n\n", limit - 1);
      if (dblNl > limit / 2) return dblNl + 2; // split after the \n\n

      // Try \n
      const nl = chunk.lastIndexOf("\n", limit - 1);
      if (nl > limit / 2) return nl + 1;

      // Try space
      const sp = chunk.lastIndexOf(" ", limit - 1);
      if (sp > limit / 2) return sp + 1;

      // Hard cut
      return limit;
    }

    let remaining = text;
    let partNum = 1;

    while (remaining.length > 0) {
      const isLast = remaining.length <= maxLen;
      if (isLast) {
        parts.push(remaining);
        break;
      }

      const suffix = ` _(continued ${partNum + 1}...)_`;
      const splitAt = findSplit(remaining, maxLen - suffix.length);
      parts.push(remaining.substring(0, splitAt) + suffix);
      remaining = remaining.substring(splitAt);
      partNum++;
    }

    return parts;
  }

  /**
   * Detect content type and build an embed (or return null for plain text).
   */
  function buildEmbed(text: string, options?: { style?: "muted" }): object | null {
    const truncated = text.length > EMBED_MAX_LENGTH ? text.substring(0, EMBED_MAX_LENGTH) : text;

    // Error messages
    if (text.startsWith("_Error:")) {
      return new EmbedBuilder().setDescription(truncated).setColor(0xff4444).toJSON();
    }

    // Usage summary (muted style)
    if (options?.style === "muted") {
      return new EmbedBuilder().setDescription(truncated).setColor(0x808080).toJSON();
    }

    // Tool execution — lines starting with *✓ or *✗
    const toolMatch = text.match(/^\*([✓✗])\s+(.+?)\*(?::(.+))?$/m);
    if (toolMatch) {
      const success = toolMatch[1] === "✓";
      const color = success ? 0x44ff44 : 0xff4444;
      // Convert *bold* to **bold** for Discord embeds
      const converted = truncated.replace(/\*([^*]+)\*/g, "**$1**");
      return new EmbedBuilder().setDescription(converted).setColor(color).toJSON();
    }

    return null;
  }

  /**
   * Post a thread message (embed or plain text) to the thread channel.
   */
  async function postToThread(
    channelId: string,
    text: string,
    options?: { style?: "muted" },
  ): Promise<void> {
    const embed = buildEmbed(text, options);
    if (embed) {
      await bot.postEmbed(channelId, embed);
    } else {
      await bot.postInThread(channelId, channelId, text);
    }
  }

  /**
   * Try to create a thread on the main reply message. Falls back silently on error.
   */
  async function tryCreateThread(msgId: string): Promise<void> {
    try {
      threadChannelId = await bot.createThreadOnMessage(event.channel, msgId, "🤖 Response");
      // Flush pending thread messages
      const pending = pendingThreadMessages;
      pendingThreadMessages = [];
      for (const { text, options } of pending) {
        await postToThread(threadChannelId, text, options);
      }
    } catch (err) {
      log.logWarning(
        "Discord thread creation failed, thread messages will be discarded",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const responseCtx: ChatResponseContext = {
    respond: async (text: string) => {
      updatePromise = updatePromise.then(async () => {
        try {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

          const parts = splitMessage(
            isWorking ? accumulatedText + workingIndicator : accumulatedText,
            MAX_LENGTH,
          );
          const firstPart = parts[0];
          const overflowParts = parts.slice(1);

          if (messageId !== null) {
            if (isWorking) {
              await bot.updateMessageWithComponents(event.channel, messageId, firstPart, [
                buildStopRow(),
              ]);
            } else {
              await bot.updateMessageRaw(event.channel, messageId, firstPart);
            }
          } else {
            stopTyping();
            if (isThreaded && event.thread_ts) {
              messageId = await bot.postInThread(event.channel, event.thread_ts, firstPart);
            } else {
              messageId = await bot.postReply(event.channel, event.ts, firstPart);
            }

            // Attach stop button to the just-posted message
            if (isWorking && messageId !== null) {
              await bot
                .updateMessageWithComponents(event.channel, messageId, firstPart, [buildStopRow()])
                .catch(() => {});
            }

            // Auto-create thread on the main reply
            await tryCreateThread(messageId);
          }

          if (messageId !== null) {
            bot.logBotResponse(event.channel, text, messageId);
          }

          // Post overflow parts in thread
          if (overflowParts.length > 0 && threadChannelId !== null) {
            for (const part of overflowParts) {
              await bot.postInThread(threadChannelId, threadChannelId, part);
            }
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
          const parts = splitMessage(isWorking ? text + workingIndicator : text, MAX_LENGTH);
          const firstPart = parts[0];
          const overflowParts = parts.slice(1);

          accumulatedText = firstPart;

          if (messageId !== null) {
            await bot.updateMessageRaw(event.channel, messageId, firstPart);
          } else {
            stopTyping();
            if (isThreaded && event.thread_ts) {
              messageId = await bot.postInThread(event.channel, event.thread_ts, firstPart);
            } else {
              messageId = await bot.postReply(event.channel, event.ts, firstPart);
            }

            await tryCreateThread(messageId);
          }

          // Post overflow parts in thread
          if (overflowParts.length > 0 && threadChannelId !== null) {
            for (const part of overflowParts) {
              await bot.postInThread(threadChannelId, threadChannelId, part);
            }
          }
        } catch (err) {
          log.logWarning(
            "Discord replaceResponse error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    respondInThread: async (text: string, options?: { style?: "muted" }) => {
      updatePromise = updatePromise.then(async () => {
        try {
          if (threadChannelId !== null) {
            await postToThread(threadChannelId, text, options);
          } else {
            // Buffer until thread is created
            pendingThreadMessages.push({ text, options });
          }
        } catch (err) {
          log.logWarning(
            "Discord respondInThread error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    setTyping: async (isTyping: boolean) => {
      if (isTyping && typingInterval === null) {
        // Send immediately and repeat every 8s (Discord clears indicator after ~10s)
        bot.sendTyping(event.channel).catch(() => {});
        typingInterval = setInterval(() => {
          bot.sendTyping(event.channel).catch(() => {});
        }, 8000);
      } else if (!isTyping) {
        stopTyping();
      }
    },

    setWorking: async (working: boolean) => {
      updatePromise = updatePromise.then(async () => {
        try {
          isWorking = working;
          if (!working) stopTyping();
          if (messageId !== null) {
            const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
            if (isWorking) {
              await bot.updateMessageWithComponents(event.channel, messageId, displayText, [
                buildStopRow(),
              ]);
            } else {
              // Remove buttons when done
              await bot.updateMessageWithComponents(event.channel, messageId, displayText, []);
            }
          }
        } catch (err) {
          log.logWarning(
            "Discord setWorking error",
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
        stopTyping();
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
