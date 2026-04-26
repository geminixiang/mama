import type {
  ContainerSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  SandboxAdapter,
} from "./types.js";
import { SandboxError } from "./errors.js";
import { execSimple, shellEscape } from "./utils.js";
import { HostExecutor } from "./host.js";

export function parseContainerSandboxArg(value: string): ContainerSandboxConfig | undefined {
  if (!value.startsWith("container:")) {
    return undefined;
  }

  const container = value.slice("container:".length);
  if (!container) {
    throw new SandboxError(
      "Error: container sandbox requires container name (e.g., container:mama-sandbox)",
    );
  }
  return { type: "container", container };
}

export async function validateContainerSandbox(config: ContainerSandboxConfig): Promise<void> {
  try {
    await execSimple("docker", ["--version"]);
  } catch {
    throw new SandboxError("Error: Docker is not installed or not in PATH");
  }

  try {
    const result = await execSimple("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      config.container,
    ]);
    if (result.trim() !== "true") {
      throw new SandboxError(`Error: Container '${config.container}' is not running.`, [
        `Start it with: docker start ${config.container}`,
      ]);
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    throw new SandboxError(`Error: Container '${config.container}' does not exist.`, [
      `Create it with: docker run -d --name ${config.container} -v <workspace>:/workspace alpine:latest sleep infinity`,
    ]);
  }

  console.log(`  Container '${config.container}' is running.`);
}

export class ContainerExecutor implements Executor {
  constructor(private container: string) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const dockerCmd = `docker exec ${this.container} sh -c ${shellEscape(command)}`;
    const hostExecutor = new HostExecutor();
    return hostExecutor.exec(dockerCmd, options);
  }

  getWorkspacePath(_hostPath: string): string {
    return "/workspace";
  }
}

export const containerSandboxAdapter: SandboxAdapter<ContainerSandboxConfig> = {
  type: "container",
  parse: parseContainerSandboxArg,
  validate: validateContainerSandbox,
  createExecutor: (config) => new ContainerExecutor(config.container),
};
