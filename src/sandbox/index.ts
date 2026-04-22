import {
  DockerExecutor,
  dockerSandboxAdapter,
  parseDockerSandboxArg,
  validateDockerSandbox,
} from "./docker.js";
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
import { SandboxError } from "./errors.js";
import type { Executor, SandboxAdapter, SandboxConfig } from "./types.js";

export type {
  DockerSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  FirecrackerSandboxConfig,
  HostSandboxConfig,
  SandboxAdapter,
  SandboxConfig,
} from "./types.js";
export { DockerExecutor, FirecrackerExecutor, HostExecutor };
export { SandboxError } from "./errors.js";
export { dockerSandboxAdapter, parseDockerSandboxArg, validateDockerSandbox } from "./docker.js";
export {
  firecrackerSandboxAdapter,
  parseFirecrackerSandboxArg,
  validateFirecrackerSandbox,
} from "./firecracker.js";
export { hostSandboxAdapter, parseHostSandboxArg, validateHostSandbox } from "./host.js";

const sandboxAdapters = [
  hostSandboxAdapter,
  dockerSandboxAdapter,
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

  throw new SandboxError(
    `Error: Invalid sandbox type '${value}'. Use 'host', 'docker:<container-name>', or 'firecracker:<vm-id>:<host-path>'`,
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
export function createExecutor(config: SandboxConfig): Executor {
  const adapter = sandboxAdapterByType.get(config.type);
  if (!adapter) {
    throw new SandboxError(`Error: Unsupported sandbox type '${config.type}'`);
  }
  return adapter.createExecutor(config);
}
