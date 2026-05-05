import { DockerContainerManager } from "./provisioner.js";
import type { SandboxConfig } from "./sandbox.js";
import type { VaultEntry } from "./vault.js";

export function resolveActorVaultKey(
  baseConfig: SandboxConfig,
  userId: string,
  conversationId: string,
): string {
  if (baseConfig.type === "container") {
    return containerSharedVaultId(baseConfig.container);
  }

  if (
    baseConfig.type === "image" ||
    baseConfig.type === "cloudflare" ||
    baseConfig.type === "firecracker"
  ) {
    return DockerContainerManager.sanitizeSegment(conversationId);
  }

  return userId;
}

export function createManagedVaultEntry(
  platform: string,
  conversationId: string,
  withImageSandbox = false,
): VaultEntry {
  return {
    displayName: `${platform}:${conversationId}`,
    platform: asVaultPlatform(platform),
    ...(withImageSandbox
      ? {
          sandbox: {
            type: "image" as const,
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

function asVaultPlatform(platform: string): VaultEntry["platform"] | undefined {
  if (platform === "slack" || platform === "discord" || platform === "telegram") {
    return platform;
  }
  return undefined;
}
