import { join } from "path";
import {
  type AutoReplyConfig,
  loadConversationAutoReplyConfig,
  saveConversationAutoReplyConfig,
} from "../config.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyDiagnosticWithContext } from "./utils.js";

type AutoReplyAction =
  | { type: "status" }
  | { type: "on" }
  | { type: "off" }
  | { type: "clear" }
  | { type: "rule"; rule: string };

export function parseAutoReplyCommand(text: string): AutoReplyAction | null {
  const trimmed = text.trim().replace(/@\w+$/i, "");
  const match = /^(?:(?:\/)?auto-?reply|\/pi-auto-?reply)(?:\s+(.*))?$/i.exec(trimmed);
  if (!match) return null;

  const rest = match[1]?.trim();
  if (!rest) return { type: "status" };

  const lower = rest.toLowerCase();
  if (lower === "status") return { type: "status" };
  if (lower === "on" || lower === "enable" || lower === "enabled") return { type: "on" };
  if (lower === "off" || lower === "disable" || lower === "disabled") return { type: "off" };
  if (lower === "clear") return { type: "clear" };

  const ruleMatch = /^rule\s+(.+)$/i.exec(rest);
  if (ruleMatch?.[1]?.trim()) return { type: "rule", rule: ruleMatch[1].trim() };

  return null;
}

function formatAutoReplyStatus(config: AutoReplyConfig): string {
  return [
    "_Auto Reply_",
    `Status: \`${config.enabled ? "on" : "off"}\``,
    `Rules: ${config.rules.length === 0 ? "`any message`" : config.rules.map((rule) => `\`${rule}\``).join(", ")}`,
    "",
    "Usage: `/pi-auto-reply on`, `/pi-auto-reply off`, `/pi-auto-reply rule <natural language rule>`, `/pi-auto-reply clear`",
  ].join("\n");
}

function applyAction(current: AutoReplyConfig, action: AutoReplyAction): AutoReplyConfig {
  switch (action.type) {
    case "status":
      return current;
    case "on":
      return { ...current, enabled: true };
    case "off":
      return { ...current, enabled: false };
    case "clear":
      return { ...current, rules: [] };
    case "rule":
      return current.rules.includes(action.rule)
        ? current
        : { ...current, rules: [...current.rules, action.rule] };
  }
}

export class AutoReplyCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const action = parseAutoReplyCommand(context.commandText);
    if (!action) return false;

    if (context.privateConversation) {
      await replyDiagnosticWithContext(
        context.responseCtx,
        "_Auto Reply_\n只能在 group/channel 裡設定。",
        { style: "muted" },
      );
      return true;
    }

    const conversationDir = join(context.services.workingDir, context.conversationId);
    const current = loadConversationAutoReplyConfig(conversationDir);
    const next = applyAction(current, action);
    if (next !== current) saveConversationAutoReplyConfig(conversationDir, next);

    await replyDiagnosticWithContext(context.responseCtx, formatAutoReplyStatus(next), {
      style: "muted",
    });
    return true;
  }
}
