import { resolveActorVaultKey } from "../vault-routing.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyWithContext } from "./utils.js";

export interface ParsedSandboxCommand {
  command: "/pi-sandbox" | "/sandbox";
  action?: "boost";
}

export function parseSandboxCommand(text: string): ParsedSandboxCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const command = tokens[0].replace(/@\w+$/i, "").toLowerCase();
  if (command !== "/pi-sandbox" && command !== "/sandbox") return null;
  if (tokens.length === 1) return { command };
  if (tokens.length === 2 && tokens[1].toLowerCase() === "boost") {
    return { command, action: "boost" };
  }
  return { command };
}

export class SandboxCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseSandboxCommand(context.commandText);
    if (!parsed) return false;

    if (context.services.sandbox.type !== "image" || !context.services.provisioner) {
      await replyWithContext(
        context.responseCtx,
        "`/pi-sandbox` 目前只支援 `image:*` managed sandbox。",
      );
      return true;
    }

    const containerKey = resolveActorVaultKey(
      context.services.sandbox,
      context.platformUserId,
      context.conversationId,
    );

    if (parsed.action === "boost") {
      const boostLimits = context.services.provisioner.getBoostLimits();
      if (!boostLimits?.cpus && !boostLimits?.memory) {
        await replyWithContext(
          context.responseCtx,
          "此 mama instance 尚未設定 sandbox boost 規格，請先在全域 settings.json 設定 `sandbox.boost`。",
        );
        return true;
      }

      const status = await context.services.provisioner.boost(containerKey);
      await replyWithContext(
        context.responseCtx,
        `已暫時提升此 conversation 的 sandbox 規格。\n\n目前：${formatLimits(status.limits)}\n\nboost 會在此 sandbox container 關閉後結束。`,
      );
      return true;
    }

    const status = context.services.provisioner.getLimitStatus(containerKey);
    const defaultLimits = context.services.provisioner.getDefaultLimits();
    const boostLimits = context.services.provisioner.getBoostLimits();
    await replyWithContext(
      context.responseCtx,
      [
        "目前 sandbox 規格：",
        "",
        formatLimits(status.limits),
        `狀態：${status.boosted ? "boosted" : "default"}`,
        "",
        `預設：${formatLimits(defaultLimits)}`,
        boostLimits ? `boost：${formatLimits({ ...defaultLimits, ...boostLimits })}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return true;
  }
}

function formatLimits(limits: { cpus?: string; memory?: string } | undefined): string {
  return `CPU ${limits?.cpus ?? "unlimited"} / Memory ${limits?.memory ?? "unlimited"}`;
}
