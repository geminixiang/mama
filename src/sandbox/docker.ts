import type {
  DockerSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  SandboxAdapter,
} from "./types.js";
import { SandboxError } from "./errors.js";
import { execSimple, shellEscape } from "./utils.js";
import { HostExecutor } from "./host.js";

export function parseDockerSandboxArg(value: string): DockerSandboxConfig | undefined {
  if (!value.startsWith("docker:")) {
    return undefined;
  }

  const container = value.slice("docker:".length);
  if (!container) {
    throw new SandboxError(
      "Error: docker sandbox requires container name (e.g., docker:mama-sandbox)",
    );
  }
  return { type: "docker", container };
}

export async function validateDockerSandbox(config: DockerSandboxConfig): Promise<void> {
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
      "Create it with: ./docker.sh create <data-dir>",
    ]);
  }

  console.log(`  Docker container '${config.container}' is running.`);
}

export class DockerExecutor implements Executor {
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

export const dockerSandboxAdapter: SandboxAdapter<DockerSandboxConfig> = {
  type: "docker",
  parse: parseDockerSandboxArg,
  validate: validateDockerSandbox,
  createExecutor: (config) => new DockerExecutor(config.container),
};
