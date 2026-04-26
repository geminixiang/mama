import type {
  ExecOptions,
  ExecResult,
  Executor,
  FirecrackerSandboxConfig,
  SandboxAdapter,
} from "./types.js";
import { SandboxError } from "./errors.js";
import { execSimple, shellEscape } from "./utils.js";
import { HostExecutor } from "./host.js";

export function parseFirecrackerSandboxArg(value: string): FirecrackerSandboxConfig | undefined {
  if (!value.startsWith("firecracker:")) {
    return undefined;
  }

  const arg = value.slice("firecracker:".length);
  // Format: firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
  // Example: firecracker:vm1:/home/user/workspace
  //          firecracker:vm1:/home/user/workspace:root
  //          firecracker:vm1:/home/user/workspace:root:22
  const parts = arg.split(":");
  if (parts.length < 2) {
    throw new SandboxError(
      "Error: firecracker sandbox requires vm-id and host-path\n" +
        "Usage: firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]\n" +
        "Example: firecracker:vm1:/home/user/workspace",
    );
  }
  const vmId = parts[0];
  const hostPath = parts[1];
  const sshUser = parts[2] || "root";
  const sshPort = parts[3] ? parseInt(parts[3], 10) : 22;

  if (!vmId || !hostPath) {
    throw new SandboxError("Error: firecracker sandbox requires vm-id and host-path");
  }
  if (isNaN(sshPort) || sshPort <= 0 || sshPort > 65535) {
    throw new SandboxError("Error: invalid SSH port");
  }
  return { type: "firecracker", vmId, hostPath, sshUser, sshPort };
}

export async function validateFirecrackerSandbox(config: FirecrackerSandboxConfig): Promise<void> {
  // Check if fc-agent or firecracker CLI is available
  try {
    await execSimple("fc-agent", ["--version"]);
  } catch {
    // Try alternative: firecracker
    try {
      await execSimple("firecracker", ["--version"]);
    } catch {
      throw new SandboxError(
        "Error: Firecracker tools (fc-agent or firecracker) not found in PATH",
        ["Install firecracker: https://github.com/firecracker-microvm/firecracker"],
      );
    }
  }

  // Check if VM is running using fc-agent
  try {
    const result = await execSimple("fc-agent", ["status", config.vmId]);
    if (!result.includes("running") && !result.includes("Running")) {
      throw new SandboxError(`Error: Firecracker VM '${config.vmId}' is not running.`, [
        `Start it with: fc-agent start ${config.vmId}`,
      ]);
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    // Try alternative: firecracker-ctl or direct check
    try {
      await execSimple("firecracker-ctl", ["status", config.vmId]);
    } catch {
      console.error(`Warning: Could not verify if VM '${config.vmId}' is running.`);
      console.error("Make sure the VM is started before running mama.");
    }
  }

  // Verify host path exists
  try {
    await execSimple("ls", ["-d", config.hostPath]);
  } catch {
    throw new SandboxError(`Error: Host path '${config.hostPath}' does not exist.`);
  }

  console.log(`  Firecracker VM '${config.vmId}' configured with workspace '${config.hostPath}'.`);
}

export class FirecrackerExecutor implements Executor {
  constructor(
    private vmId: string,
    private hostPath: string,
    private sshUser: string = "root",
    private sshPort: number = 22,
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    // Use direct SSH to execute command in the Firecracker VM.
    // The workspace inside the VM is expected to be mounted at /workspace.
    const sshCmd =
      this.sshPort === 22
        ? `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${this.sshUser}@${this.vmId} sh -c ${shellEscape(command)}`
        : `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.sshPort} ${this.sshUser}@${this.vmId} sh -c ${shellEscape(command)}`;
    const hostExecutor = new HostExecutor();
    return hostExecutor.exec(sshCmd, options);
  }

  getWorkspacePath(_hostPath: string): string {
    return "/workspace";
  }
}

export const firecrackerSandboxAdapter: SandboxAdapter<FirecrackerSandboxConfig> = {
  type: "firecracker",
  parse: parseFirecrackerSandboxArg,
  validate: validateFirecrackerSandbox,
  createExecutor: (config) =>
    new FirecrackerExecutor(config.vmId, config.hostPath, config.sshUser, config.sshPort),
};
