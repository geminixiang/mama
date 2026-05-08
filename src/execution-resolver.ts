import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { DockerContainerManager, type ContainerMount } from "./provisioner.js";
import { createExecutor, type Executor, type SandboxConfig } from "./sandbox.js";
import { SecretProxyManager } from "./sandbox/secret-proxy.js";
import type { ResolvedVault, VaultManager } from "./vault.js";
import { resolveActorVaultKey } from "./vault-routing.js";

export { SecretProxyManager };

export interface ActorContext {
  platform: string;
  userId: string;
  conversationId: string;
}

export class ActorExecutionResolver {
  private readonly ensuredConversationDirs = new Set<string>();

  constructor(
    private baseConfig: SandboxConfig,
    private vaultManager: VaultManager,
    private provisioner?: DockerContainerManager,
    private workspaceDir?: string,
    private proxyManager?: SecretProxyManager,
  ) {}

  refresh(): void {
    this.vaultManager.reload();
  }

  async resolve(context: ActorContext): Promise<Executor> {
    const vaultKey = resolveActorVaultKey(this.baseConfig, context.userId, context.conversationId);

    const vault = this.vaultManager.resolve(vaultKey);
    const config = this.resolveSandboxConfig(vaultKey);

    const env = this.resolveEnv(config, vaultKey, vault);
    return createExecutor(
      config,
      env,
      this.getEnsureReady(vaultKey, context.conversationId, config, vault),
    );
  }

  private resolveEnv(
    config: SandboxConfig,
    vaultKey: string,
    vault?: ResolvedVault,
  ): Record<string, string> | undefined {
    if (config.type === "host" || !vault || Object.keys(vault.env).length === 0) {
      return undefined;
    }

    // For image:* sandboxes with a proxy manager, replace known API keys with
    // proxy URLs so the sandbox container never receives the real credentials.
    if (this.baseConfig.type === "image" && this.proxyManager?.hasProxiableSecrets(vault.env)) {
      const proxyHostname = this.proxyManager.proxyHostname(vaultKey);
      return this.proxyManager.buildSandboxEnv(vault.env, proxyHostname);
    }

    return vault.env;
  }

  private resolveSandboxConfig(vaultKey: string): SandboxConfig {
    const config = this.vaultManager.getSandboxConfig(vaultKey, this.baseConfig);
    if (this.baseConfig.type !== "image") {
      return config;
    }

    if (config.type === "container") {
      return config;
    }

    return {
      type: "container",
      container: DockerContainerManager.containerName(vaultKey),
    };
  }

  private getEnsureReady(
    vaultKey: string,
    conversationId: string,
    config: SandboxConfig,
    vault?: ResolvedVault,
  ): (() => Promise<void>) | undefined {
    if (this.baseConfig.type !== "image" || config.type !== "container") {
      return undefined;
    }

    return async () => {
      const networkName = DockerContainerManager.networkName(vaultKey);
      const expected = config.container || DockerContainerManager.containerName(vaultKey);

      // Provision the sandbox container first so the network exists
      const actual = await this.provisioner?.provision(vaultKey, {
        containerName: expected,
        mounts: this.resolveMounts(conversationId, vault),
        conversationId,
      });
      if (actual && actual !== expected) {
        throw new Error(
          `Provisioner returned container "${actual}" for container key "${vaultKey}", expected "${expected}"`,
        );
      }

      // Provision proxy container on the same network (no-op if no proxiable secrets)
      if (this.proxyManager && vault && Object.keys(vault.env).length > 0) {
        await this.proxyManager.provision(vaultKey, vault.env, networkName);
      }
    };
  }

  private resolveMounts(conversationId: string, vault?: ResolvedVault): ContainerMount[] {
    const mountsByTarget = new Map<string, ContainerMount>();
    for (const mount of this.buildImageSandboxMounts(conversationId)) {
      mountsByTarget.set(mount.target, mount);
    }
    for (const mount of vault?.mounts ?? []) {
      if (!existsSync(mount.source)) continue;
      mountsByTarget.set(mount.target, { source: mount.source, target: mount.target });
    }
    return [...mountsByTarget.values()];
  }

  private buildImageSandboxMounts(conversationId: string): ContainerMount[] {
    if (!this.workspaceDir) {
      return [];
    }

    const conversationDir = join(this.workspaceDir, conversationId);
    if (!this.ensuredConversationDirs.has(conversationId)) {
      mkdirSync(conversationDir, { recursive: true });
      this.ensuredConversationDirs.add(conversationId);
    }

    return [
      { source: join(this.workspaceDir, "MEMORY.md"), target: "/workspace/MEMORY.md" },
      { source: join(this.workspaceDir, "skills"), target: "/workspace/skills" },
      { source: join(this.workspaceDir, "events"), target: "/workspace/events" },
      { source: conversationDir, target: `/workspace/${conversationId}` },
    ];
  }
}
