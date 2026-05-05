import * as log from "../log.js";
import { parseLoginCommand } from "../login/index.js";
import {
  createManagedVaultEntry,
  ensureSandboxVaultEntry,
  resolveActorVaultKey,
} from "../vault-routing.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyWithContext } from "./utils.js";

function ensureLoginVault(context: CommandContext): string {
  const { services, platform, platformUserId } = context;
  const vaultId = resolveActorVaultKey(
    services.sandbox,
    services.vaultManager,
    services.bindingStore,
    platform,
    platformUserId,
  );

  ensureSandboxVaultEntry(
    services.sandbox,
    services.vaultManager,
    platform,
    platformUserId,
    vaultId,
  );
  if (services.sandbox.type !== "container" && services.sandbox.type !== "image") {
    services.vaultManager.addEntry(
      vaultId,
      createManagedVaultEntry(platform, platformUserId, vaultId),
    );
  }

  return vaultId;
}

export class LoginCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseLoginCommand(context.commandText);
    if (!parsed) return false;

    if (!context.privateConversation) {
      await replyWithContext(
        context.responseCtx,
        "為了保護你的憑證，`/login` 只能在與機器人的私訊中使用。請先私訊機器人，再重新執行 `/login`。",
      );
      return true;
    }

    if (!context.services.portalBaseUrl) {
      await replyWithContext(
        context.responseCtx,
        "Login is not configured. Set `MAMA_LINK_URL` or `MAMA_LINK_PORT` on the server.",
      );
      return true;
    }

    let vaultId: string;
    try {
      vaultId = ensureLoginVault(context);
    } catch (error) {
      log.logWarning(
        `[${context.conversationId}] Failed to prepare login vault for ${context.platform}/${context.platformUserId}`,
        error instanceof Error ? error.message : String(error),
      );
      await replyWithContext(
        context.responseCtx,
        "Login setup failed on the server. 請稍後重試，或聯絡管理員檢查 vault 儲存權限。",
      );
      return true;
    }

    const token = context.services.linkTokenStore.create(
      context.platform,
      context.platformUserId,
      context.conversationId,
      vaultId,
      "",
    );
    const vaultLabel =
      context.services.sandbox.type === "container" ? `container vault (${vaultId})` : "your vault";
    await replyWithContext(
      context.responseCtx,
      `Open this link to store credentials in ${vaultLabel} (expires in 15 minutes):\n${context.services.portalBaseUrl}/link?token=${token.token}`,
    );
    return true;
  }
}
