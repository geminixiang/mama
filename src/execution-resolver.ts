import { existsSync } from "fs";
import type { UserBindingStore } from "./bindings.js";
import { DockerContainerManager, type ContainerMount } from "./provisioner.js";
import { createExecutor, type Executor, type SandboxConfig } from "./sandbox.js";
import type { ResolvedVault, VaultManager } from "./vault.js";
import { ensureImageSandboxVault, resolveActorVaultKey } from "./vault-routing.js";

export interface ActorContext {
  platform: string;
  userId: string;
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

    const config = this.vaultManager.getSandboxConfig(vaultKey, this.baseConfig);
    const env = vault && Object.keys(vault.env).length > 0 ? vault.env : undefined;
    return createExecutor(config, env, this.getEnsureReady(vaultKey, config, vault));
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
    // Last-write-wins by target so stale legacy entries don't fail container
    // startup with duplicate bind mounts pointing at the same path.
    const mountsByTarget = new Map<string, ContainerMount>();
    for (const mount of vault.mounts) {
      if (!existsSync(mount.source)) continue;
      mountsByTarget.set(mount.target, { source: mount.source, target: mount.target });
    }
    return [...mountsByTarget.values()];
  }
}
