import { resolveExistingSessionFile } from "../session-view/service.js";
import { parseSessionViewCommand } from "../session-view/command.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyWithContext } from "./utils.js";

export class SessionViewCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!parseSessionViewCommand(context.commandText)) return false;

    const sendSessionViewReply = async (text: string): Promise<void> => {
      if (context.privateConversation) {
        await replyWithContext(context.responseCtx, text);
        return;
      }

      if (context.bot.postPrivate) {
        await context.bot.postPrivate(context.conversationId, context.platformUserId, text);
        return;
      }

      await replyWithContext(context.responseCtx, text);
    };

    if (!context.privateConversation && !context.bot.postPrivate) {
      await sendSessionViewReply(
        "為了保護對話內容，`/session` 目前只能在與機器人的私訊 / DM 中使用。",
      );
      return true;
    }

    if (!context.services.portalBaseUrl) {
      await sendSessionViewReply(
        "Session viewer is not configured. Set `MAMA_LINK_URL` or `MAMA_LINK_PORT` on the server.",
      );
      return true;
    }

    const sessionFile = resolveExistingSessionFile(
      context.services.workingDir,
      context.conversationId,
      context.sessionKey,
    );
    if (!sessionFile) {
      await sendSessionViewReply(
        "目前還沒有可查看的 session。先和機器人對話一次，建立 session 後再試。",
      );
      return true;
    }

    const token = context.services.sessionViewTokenStore.create(
      context.platform,
      context.platformUserId,
      context.conversationId,
      context.sessionKey,
      sessionFile,
    );

    const linkText = `Open this read-only session link (expires in 24 hours):\n${context.services.portalBaseUrl}/session?token=${token.token}`;
    await sendSessionViewReply(linkText);
    return true;
  }
}
