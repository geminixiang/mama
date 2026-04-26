import type { UserBindingStore } from "./bindings.js";
import { createExecutor, type Executor, type SandboxConfig } from "./sandbox.js";
import type { VaultManager } from "./vault.js";
import { ensureSandboxVaultEntry, resolveActorVaultKey } from "./vault-routing.js";

export interface ActorContext {
  platform: string;
  userId: string;
}

export class ActorExecutionResolver {
  constructor(
    private baseConfig: SandboxConfig,
    private vaultManager: VaultManager,
    private bindingStore?: UserBindingStore,
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
    ensureSandboxVaultEntry(
      this.baseConfig,
      this.vaultManager,
      context.platform,
      context.userId,
      vaultKey,
    );

    const vault = this.vaultManager.resolve(vaultKey);
    const config = this.vaultManager.getSandboxConfig(vaultKey, this.baseConfig);
    const env = vault && Object.keys(vault.env).length > 0 ? vault.env : undefined;
    return createExecutor(config, env);
  }
}
