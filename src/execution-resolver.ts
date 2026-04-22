import { relative, sep } from "path";
import type { UserBindingStore } from "./bindings.js";
import { DockerContainerManager, type ContainerMount } from "./provisioner.js";
import { createExecutor, type Executor, type SandboxConfig } from "./sandbox.js";
import type { ResolvedVault, VaultManager } from "./vault.js";
import { ensureImageSandboxVault, resolveActorVaultKey } from "./vault-routing.js";

export interface ActorContext {
  platform: string;
  userId?: string;
}

export class ActorExecutionResolver {
  constructor(
    private baseConfig: SandboxConfig,
    private vaultManager: VaultManager,
    private bindingStore?: UserBindingStore,
    private provisioner?: DockerContainerManager,
  ) {}

  refresh(): void {
    this.vaultManager.reload();
    this.bindingStore?.reload();
  }

  async resolve(context: ActorContext): Promise<Executor> {
    if (!context.userId) {
      return this.resolveSystemExecutor();
    }

    const vaultKey = resolveActorVaultKey(
      this.baseConfig,
      this.vaultManager,
      this.bindingStore,
      context.platform,
      context.userId,
    );
    ensureImageSandboxVault(
      this.baseConfig,
      this.vaultManager,
      context.platform,
      context.userId,
      vaultKey,
    );
    const vault = this.vaultManager.resolve(vaultKey);

    if (!vault && this.vaultManager.isStrict()) {
      throw new Error(
        `No vault configured for user "${context.userId}". ` +
          `Ask an admin to add an entry to vaults/vault.json.`,
      );
    }

    const config = this.vaultManager.getSandboxConfig(vaultKey, this.baseConfig);
    const env = vault && Object.keys(vault.env).length > 0 ? vault.env : undefined;
    return createExecutor(config, env, this.getEnsureReady(vaultKey, config, vault));
  }

  private resolveSystemExecutor(): Executor {
    const systemVault = this.vaultManager.resolveSystemActor();
    if (!systemVault) {
      if (this.baseConfig.type === "image") {
        throw new Error(
          "image sandbox requires a configured systemActor vault for event/system-triggered runs.",
        );
      }
      return createExecutor(this.baseConfig);
    }

    const config = this.applySandboxOverride(systemVault, this.baseConfig);
    const env = Object.keys(systemVault.env).length > 0 ? systemVault.env : undefined;
    // For image mode, we need getEnsureReady to auto-provision the container
    // System vault uses userId from the vault config for container naming
    const vaultKey = systemVault.userId;
    const ensureReady = this.getEnsureReady(vaultKey, config, systemVault);
    return createExecutor(config, env, ensureReady);
  }

  private getEnsureReady(
    vaultKey: string,
    config: SandboxConfig,
    vault?: ResolvedVault,
  ): (() => Promise<void>) | undefined {
    if (this.baseConfig.type !== "image" || config.type !== "container") {
      return undefined;
    }

    return async () => {
      const expected = config.container || DockerContainerManager.containerName(vaultKey);
      const actual = await this.provisioner?.provision(vaultKey, {
        containerName: expected,
        mounts: vault ? this.resolveMounts(vault) : [],
      });
      if (actual && actual !== expected) {
        throw new Error(
          `Provisioner returned container "${actual}" for vault "${vaultKey}", expected "${expected}"`,
        );
      }
    };
  }

  private resolveMounts(vault: ResolvedVault): ContainerMount[] {
    return vault.mounts
      .map((source) => {
        const relativePath = relative(vault.dir, source);
        if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith(sep)) {
          return undefined;
        }
        return {
          source,
          target: `/root/${relativePath.split(sep).join("/")}`,
        };
      })
      .filter((mount): mount is ContainerMount => mount !== undefined);
  }

  private applySandboxOverride(vault: ResolvedVault, baseConfig: SandboxConfig): SandboxConfig {
    const override = vault.sandboxOverride;
    if (!override?.type) {
      if (baseConfig.type === "image") {
        return {
          type: "container",
          container: DockerContainerManager.containerName(vault.userId),
        };
      }
      return baseConfig;
    }

    if (override.type === "image") {
      if (baseConfig.type !== "image") {
        throw new Error(
          `systemActor vault uses sandbox.type=image, but base sandbox is "${baseConfig.type}". ` +
            "Use --sandbox=image:<image> to enable per-user managed containers.",
        );
      }
      return {
        type: "container",
        container: override.container || DockerContainerManager.containerName(vault.userId),
      };
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
      throw new Error(
        "systemActor vault uses sandbox.type=host, which is blocked for credential isolation. " +
          "Use sandbox.type=image or sandbox.type=firecracker.",
      );
    }

    if (override.type === "container" || override.type === "docker") {
      throw new Error(
        `systemActor vault uses sandbox.type=${override.type}, which is blocked for credential isolation. ` +
          "Use sandbox.type=image for per-user containers or sandbox.type=firecracker.",
      );
    }

    return baseConfig;
  }
}
