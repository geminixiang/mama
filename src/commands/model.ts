import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { loadAgentConfigForConversation, saveConversationModelConfig } from "../config.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyWithContext } from "./utils.js";

export interface ParsedModelCommand {
  command: "model" | "/model" | "/pi-model";
  provider?: string;
  model?: string;
}

export function parseModelCommand(text: string): ParsedModelCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const command = tokens[0].toLowerCase();
  if (command !== "model" && command !== "/model" && command !== "/pi-model") {
    return null;
  }

  if (tokens.length === 1) {
    return { command: command as ParsedModelCommand["command"] };
  }

  const spec = tokens[1];
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    return { command: command as ParsedModelCommand["command"] };
  }

  return {
    command: command as ParsedModelCommand["command"],
    provider: spec.slice(0, slash),
    model: spec.slice(slash + 1),
  };
}

export class ModelCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseModelCommand(context.commandText);
    if (!parsed) return false;

    const conversationDir = join(context.services.workingDir, context.conversationId);
    if (!parsed.provider || !parsed.model) {
      const current = loadAgentConfigForConversation(conversationDir);
      await replyWithContext(
        context.responseCtx,
        `目前模型：\`${current.provider}/${current.model}\`\n用法：\`/pi-model provider/model\`，例如 \`/pi-model openai/gpt-4o\`。`,
      );
      return true;
    }

    if (!this.isKnownModel(parsed.provider, parsed.model)) {
      await replyWithContext(
        context.responseCtx,
        `找不到模型 \`${parsed.provider}/${parsed.model}\`。請確認 provider/model 名稱，或先在 pi models.json 註冊自訂模型。`,
      );
      return true;
    }

    if (!context.services.runtime) {
      await replyWithContext(
        context.responseCtx,
        "Model command is not configured correctly on the server. Please try again later.",
      );
      return true;
    }

    const switched = context.services.runtime.switchConversationModel(
      context.conversationId,
      parsed.provider,
      parsed.model,
    );
    if (!switched) {
      await replyWithContext(
        context.responseCtx,
        "目前這個 conversation 有執行中的工作，請等它完成或先 `/stop` 後再切換模型。",
      );
      return true;
    }

    saveConversationModelConfig(conversationDir, {
      provider: parsed.provider,
      model: parsed.model,
    });

    await replyWithContext(
      context.responseCtx,
      `已切換這個 conversation 的模型為 \`${parsed.provider}/${parsed.model}\`。下一則訊息會使用新模型。`,
    );
    return true;
  }

  private isKnownModel(provider: string, model: string): boolean {
    const authStorage = AuthStorage.create(join(homedir(), ".pi", "mama", "auth.json"));
    const registry = ModelRegistry.create(authStorage);
    return registry.find(provider, model) !== undefined;
  }
}
