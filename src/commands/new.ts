import type { CommandContext, CommandHandler } from "./types.js";
import { replyWithContext } from "./utils.js";

export interface ParsedNewCommand {
  command: "new" | "/new" | "/pi-new";
}

export function parseNewCommand(text: string): ParsedNewCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const command = tokens[0].toLowerCase();
  if (command !== "new" && command !== "/new" && command !== "/pi-new") {
    return null;
  }

  return { command: command as ParsedNewCommand["command"] };
}

export class NewCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!parseNewCommand(context.commandText)) return false;

    if (!context.privateConversation) {
      await replyWithContext(
        context.responseCtx,
        "為了避免誤清除共享上下文，`/new` 目前只能在與機器人的私訊 / DM 中使用。",
      );
      return true;
    }

    if (!context.services.runtime) {
      await replyWithContext(
        context.responseCtx,
        "New command is not configured correctly on the server. Please try again later.",
      );
      return true;
    }

    await context.services.runtime.handleNew(
      context.sessionKey,
      context.conversationId,
      context.bot,
    );
    return true;
  }
}
