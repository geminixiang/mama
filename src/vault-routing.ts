import type { UserBindingStore } from "./bindings.js";
import type { SandboxConfig } from "./sandbox.js";
import type { VaultEntry, VaultManager } from "./vault.js";

export function resolveActorVaultKey(
  baseConfig: SandboxConfig,
  vaultManager: Pick<VaultManager, "hasEntry">,
  bindingStore: Pick<UserBindingStore, "resolve"> | undefined,
  platform: string,
  userId: string,
): string {
  if (baseConfig.type === "container") {
    return containerSharedVaultId(baseConfig.container);
  }

  const binding = bindingStore?.resolve(platform, userId);
  if (binding) {
    return binding.vaultId;
  }

  if (vaultManager.hasEntry(userId)) {
    return userId;
  }

  return userId;
}

export function createManagedVaultEntry(
  platform: string,
  userId: string,
  _vaultKey: string,
): VaultEntry {
  return {
    displayName: `${platform}:${userId}`,
    platform: asVaultPlatform(platform),
  };
}

export function containerSharedVaultId(containerName: string): string {
  return `container-${containerName}`;
}

export function createSharedContainerVaultEntry(containerName: string): VaultEntry {
  return {
    displayName: `container:${containerName}`,
  };
}

export function ensureSandboxVaultEntry(
  baseConfig: SandboxConfig,
  vaultManager: Pick<VaultManager, "addEntry">,
  _platform: string,
  _userId: string,
  vaultKey: string,
): void {
  if (baseConfig.type === "container") {
    vaultManager.addEntry(vaultKey, createSharedContainerVaultEntry(baseConfig.container));
    return;
  }

  // Host and firecracker modes should not create credential entries merely
  // because a user sent a message. `/login` owns first-time vault creation.
}

function asVaultPlatform(platform: string): VaultEntry["platform"] | undefined {
  if (platform === "slack" || platform === "discord" || platform === "telegram") {
    return platform;
  }
  return undefined;
}
