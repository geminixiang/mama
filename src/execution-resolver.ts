import type { UserBindingStore } from "./bindings.js";
import { DockerProvisioner } from "./provisioner.js";
import { createExecutor, type Executor, type SandboxConfig } from "./sandbox.js";
import type { ResolvedVault, VaultEntry, VaultManager } from "./vault.js";

export interface ActorContext {
  platform: string;
  userId?: string;
}

export class ActorExecutionResolver {
  constructor(
    private baseConfig: SandboxConfig,
    private vaultManager: VaultManager,
    private bindingStore?: UserBindingStore,
    private provisioner?: DockerProvisioner,
  ) {}

  refresh(): void {
    this.vaultManager.reload();
    this.bindingStore?.reload();
  }

  async resolve(context: ActorContext): Promise<Executor> {
    if (!context.userId) {
      return this.resolveSystemExecutor();
    }

    const vaultKey = this.resolveVaultKey(context.platform, context.userId);
    this.ensureAutoManagedVault(context.platform, context.userId, vaultKey);
    const vault = this.vaultManager.resolve(vaultKey);

    if (!vault && this.vaultManager.isStrict()) {
      throw new Error(
        `No vault configured for user "${context.userId}". ` +
          `Ask an admin to add an entry to vaults/vault.json.`,
      );
    }

    const config = this.vaultManager.getSandboxConfig(vaultKey, this.baseConfig);
    const env = vault && Object.keys(vault.env).length > 0 ? vault.env : undefined;
    return createExecutor(config, env, this.getEnsureReady(vaultKey, config));
  }

  private resolveVaultKey(platform: string, userId: string): string {
    if (this.baseConfig.type === "docker-auto") {
      return DockerProvisioner.vaultId(platform, userId);
    }

    if (!this.bindingStore) {
      return userId;
    }
    const binding = this.bindingStore.resolve(platform, userId);
    return binding?.vaultId ?? userId;
  }

  private ensureAutoManagedVault(platform: string, userId: string, vaultKey: string): void {
    if (this.baseConfig.type !== "docker-auto") {
      return;
    }

    const entry: VaultEntry = {
      displayName: `${platform}:${userId}`,
      platform: this.asVaultPlatform(platform),
      sandbox: { type: "docker", container: DockerProvisioner.containerName(vaultKey) },
    };
    this.vaultManager.addEntry(vaultKey, entry);
  }

  private asVaultPlatform(platform: string): VaultEntry["platform"] | undefined {
    if (platform === "slack" || platform === "discord" || platform === "telegram") {
      return platform;
    }
    return undefined;
  }

  private resolveSystemExecutor(): Executor {
    const systemVault = this.vaultManager.resolveSystemActor();
    if (!systemVault) {
      if (this.baseConfig.type === "docker-auto") {
        throw new Error(
          "docker-auto requires a configured systemActor vault for event/system-triggered runs.",
        );
      }
      return createExecutor(this.baseConfig);
    }

    const config = this.applySandboxOverride(systemVault, this.baseConfig);
    const env = Object.keys(systemVault.env).length > 0 ? systemVault.env : undefined;
    return createExecutor(config, env);
  }

  private getEnsureReady(
    vaultKey: string,
    config: SandboxConfig,
  ): (() => Promise<void>) | undefined {
    if (this.baseConfig.type !== "docker-auto" || config.type !== "docker") {
      return undefined;
    }

    return async () => {
      const expected = config.container || DockerProvisioner.containerName(vaultKey);
      const actual = await this.provisioner?.provision(vaultKey);
      if (actual && actual !== expected) {
        throw new Error(
          `Provisioner returned container "${actual}" for vault "${vaultKey}", expected "${expected}"`,
        );
      }
    };
  }

  private applySandboxOverride(vault: ResolvedVault, baseConfig: SandboxConfig): SandboxConfig {
    const override = vault.sandboxOverride;
    if (!override?.type) {
      return baseConfig;
    }

    if (override.type === "docker") {
      return { type: "docker", container: override.container || "mama-sandbox-system" };
    }

    if (override.type === "firecracker" && override.vmId) {
      const hostPath = baseConfig.type === "firecracker" ? baseConfig.hostPath : vault.dir;
      return {
        type: "firecracker",
        vmId: override.vmId,
        hostPath,
        sshUser: override.sshUser,
        sshPort: override.sshPort,
      };
    }

    if (override.type === "host") {
      return { type: "host" };
    }

    return baseConfig;
  }
}
