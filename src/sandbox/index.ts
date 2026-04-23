import {
  ContainerExecutor,
  containerSandboxAdapter,
  parseContainerSandboxArg,
  validateContainerSandbox,
} from "./container.js";
import {
  FirecrackerExecutor,
  firecrackerSandboxAdapter,
  parseFirecrackerSandboxArg,
  validateFirecrackerSandbox,
} from "./firecracker.js";
import {
  HostExecutor,
  hostSandboxAdapter,
  parseHostSandboxArg,
  validateHostSandbox,
} from "./host.js";
import { imageSandboxAdapter, parseImageSandboxArg, validateImageSandbox } from "./image.js";
import { SandboxError } from "./errors.js";
import type { Executor, SandboxAdapter, SandboxConfig } from "./types.js";

export type {
  ContainerSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  FirecrackerSandboxConfig,
  HostSandboxConfig,
  ImageSandboxConfig,
  SandboxAdapter,
  SandboxConfig,
} from "./types.js";
export { ContainerExecutor, FirecrackerExecutor, HostExecutor };
export { SandboxError } from "./errors.js";
export {
  buildContainerExecCommand,
  containerSandboxAdapter,
  parseContainerSandboxArg,
  validateContainerSandbox,
} from "./container.js";
export {
  firecrackerSandboxAdapter,
  parseFirecrackerSandboxArg,
  validateFirecrackerSandbox,
} from "./firecracker.js";
export { hostSandboxAdapter, parseHostSandboxArg, validateHostSandbox } from "./host.js";
export { imageSandboxAdapter, parseImageSandboxArg, validateImageSandbox } from "./image.js";

const sandboxAdapters = [
  hostSandboxAdapter,
  containerSandboxAdapter,
  imageSandboxAdapter,
  firecrackerSandboxAdapter,
] as const;
const sandboxAdapterByType = new Map(
  sandboxAdapters.map((adapter) => [adapter.type, adapter]),
) as Map<SandboxConfig["type"], SandboxAdapter>;

export function getSandboxAdapters(): readonly [...typeof sandboxAdapters] {
  return sandboxAdapters;
}

export function parseSandboxArg(value: string): SandboxConfig {
  for (const adapter of sandboxAdapters) {
    const config = adapter.parse(value);
    if (config) {
      return config;
    }
  }

  if (value.startsWith("docker:")) {
    throw new SandboxError(
      `Error: '${value}' is not supported. Use 'container:<container-name>' for the shared-container mode or 'image:<image-name>' for mama-managed per-user containers.`,
    );
  }

  throw new SandboxError(
    `Error: Invalid sandbox type '${value}'. Use 'host', 'container:<container-name>', 'image:<image-name>', or 'firecracker:<vm-id>:<host-path>'`,
  );
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
  const adapter = sandboxAdapterByType.get(config.type);
  if (!adapter) {
    throw new SandboxError(`Error: Unsupported sandbox type '${config.type}'`);
  }

  await adapter.validate(config);
}

/**
 * Create an executor that runs commands on host, in a Docker container, or in a Firecracker VM.
 */
export function createExecutor(
  config: SandboxConfig,
  env?: Record<string, string>,
  ensureReady?: () => Promise<void>,
): Executor {
  const adapter = sandboxAdapterByType.get(config.type);
  if (!adapter) {
    throw new SandboxError(`Error: Unsupported sandbox type '${config.type}'`);
  }
  return adapter.createExecutor(config, env, ensureReady);
}
