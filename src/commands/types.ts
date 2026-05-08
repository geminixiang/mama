import type { Bot, BotAdapters, PlatformName } from "../adapter.js";
import type { UserBindingStore } from "../bindings.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { SandboxConfig } from "../sandbox.js";
import type { VaultManager } from "../vault.js";
import type { SecretProxyManager } from "../execution-resolver.js";

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
  runtime?: SessionRuntime;
  sandbox: SandboxConfig;
  vaultManager: VaultManager;
  bindingStore?: UserBindingStore;
  provisioner?: DockerContainerManager;
  secretProxyManager?: SecretProxyManager;
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
