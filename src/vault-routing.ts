import type { UserBindingStore } from "./bindings.js";
import { DockerContainerManager } from "./provisioner.js";
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

  return baseConfig.type === "image" ? DockerContainerManager.vaultId(platform, userId) : userId;
}

export function createManagedVaultEntry(
  platform: string,
  userId: string,
  vaultKey: string,
  withImageSandbox = false,
): VaultEntry {
  return {
    displayName: `${platform}:${userId}`,
    platform: asVaultPlatform(platform),
    ...(withImageSandbox
      ? {
          sandbox: {
            type: "image" as const,
            container: DockerContainerManager.containerName(vaultKey),
          },
        }
      : {}),
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
  vaultManager: Pick<VaultManager, "addEntry" | "ensureImageSandboxEntry">,
  platform: string,
  userId: string,
  vaultKey: string,
): void {
  if (baseConfig.type === "image") {
    vaultManager.ensureImageSandboxEntry(
      vaultKey,
      createManagedVaultEntry(platform, userId, vaultKey, true),
    );
    return;
  }

  if (baseConfig.type === "container") {
    vaultManager.addEntry(vaultKey, createSharedContainerVaultEntry(baseConfig.container));
  }
}

function asVaultPlatform(platform: string): VaultEntry["platform"] | undefined {
  if (platform === "slack" || platform === "discord" || platform === "telegram") {
    return platform;
  }
  return undefined;
}
