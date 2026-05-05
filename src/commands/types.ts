import type { Bot, BotAdapters, PlatformName } from "../adapter.js";
import type { UserBindingStore } from "../bindings.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { SandboxConfig } from "../sandbox.js";
import type { VaultManager } from "../vault.js";

export interface LinkTokenStoreLike {
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
    vaultId: string,
    providerId: string,
  ): { token: string };
}

export interface SessionViewTokenStoreLike {
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
    sessionKey: string,
    sessionFile: string,
  ): { token: string };
}

export interface CommandServices {
  workingDir: string;
  sandbox: SandboxConfig;
  vaultManager: VaultManager;
  bindingStore?: UserBindingStore;
  provisioner?: DockerContainerManager;
  linkTokenStore: LinkTokenStoreLike;
  sessionViewTokenStore: SessionViewTokenStoreLike;
  portalBaseUrl?: string;
}

export interface CommandContext {
  bot: Bot;
  responseCtx: BotAdapters["responseCtx"];
  platform: PlatformName;
  platformUserId: string;
  conversationId: string;
  vaultConversationId?: string;
  sessionKey: string;
  commandText: string;
  privateConversation: boolean;
  services: CommandServices;
}

export interface CommandHandler {
  tryHandle(context: CommandContext): Promise<boolean>;
}
