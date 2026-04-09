import { spawn } from "child_process";

export type SandboxConfig =
  | { type: "host" }
  | { type: "docker"; container: string }
  | { type: "docker-auto"; image: string }
  | { type: "firecracker"; vmId: string; hostPath: string; sshUser?: string; sshPort?: number };

export function parseSandboxArg(value: string): SandboxConfig {
  if (value === "host") {
    return { type: "host" };
  }
  if (value.startsWith("docker-auto:")) {
    const image = value.slice("docker-auto:".length);
    if (!image) {
      console.error(
        "Error: docker-auto sandbox requires an image name (e.g., docker-auto:ubuntu:24.04)",
      );
      process.exit(1);
    }
    return { type: "docker-auto", image };
  }
  if (value.startsWith("docker:")) {
    const container = value.slice("docker:".length);
    if (!container) {
      console.error("Error: docker sandbox requires container name (e.g., docker:mama-sandbox)");
      process.exit(1);
    }
    return { type: "docker", container };
  }
  if (value.startsWith("firecracker:")) {
    const arg = value.slice("firecracker:".length);
    // Format: firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
    // Example: firecracker:vm1:/home/user/workspace
    //          firecracker:vm1:/home/user/workspace:root
    //          firecracker:vm1:/home/user/workspace:root:22
    const parts = arg.split(":");
    if (parts.length < 2) {
      console.error(
        "Error: firecracker sandbox requires vm-id and host-path\n" +
          "Usage: firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]\n" +
          "Example: firecracker:vm1:/home/user/workspace",
      );
      process.exit(1);
    }
    const vmId = parts[0];
    const hostPath = parts[1];
    const sshUser = parts[2] || "root";
    const sshPort = parts[3] ? parseInt(parts[3], 10) : 22;

    if (!vmId || !hostPath) {
      console.error("Error: firecracker sandbox requires vm-id and host-path");
      process.exit(1);
    }
    if (isNaN(sshPort) || sshPort <= 0 || sshPort > 65535) {
      console.error("Error: invalid SSH port");
      process.exit(1);
    }
    return { type: "firecracker", vmId, hostPath, sshUser, sshPort };
  }
  console.error(
    `Error: Invalid sandbox type '${value}'. Use 'host', 'docker:<container-name>', 'docker-auto:<image>', or 'firecracker:<vm-id>:<host-path>'`,
  );
  process.exit(1);
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
  if (config.type === "host") {
    return;
  }

  if (config.type === "docker-auto") {
    try {
      await execSimple("docker", ["--version"]);
    } catch {
      console.error("Error: Docker is not installed or not in PATH");
      process.exit(1);
    }
    console.log(`  Docker auto-provisioning enabled. Image: ${config.image}`);
    return;
  }

  if (config.type === "docker") {
    // Check if Docker is available
    try {
      await execSimple("docker", ["--version"]);
    } catch {
      console.error("Error: Docker is not installed or not in PATH");
      process.exit(1);
    }

    // Check if container exists and is running
    try {
      const result = await execSimple("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        config.container,
      ]);
      if (result.trim() !== "true") {
        console.error(`Error: Container '${config.container}' is not running.`);
        console.error(`Start it with: docker start ${config.container}`);
        process.exit(1);
      }
    } catch {
      console.error(`Error: Container '${config.container}' does not exist.`);
      console.error("Create it with: ./docker.sh create <data-dir>");
      process.exit(1);
    }

    console.log(`  Docker container '${config.container}' is running.`);
    return;
  }

  if (config.type === "firecracker") {
    // Check if fc-agent or firecracker CLI is available
    try {
      await execSimple("fc-agent", ["--version"]);
    } catch {
      // Try alternative: firecracker
      try {
        await execSimple("firecracker", ["--version"]);
      } catch {
        console.error("Error: Firecracker tools (fc-agent or firecracker) not found in PATH");
        console.error("Install firecracker: https://github.com/firecracker-microvm/firecracker");
        process.exit(1);
      }
    }

    // Check if VM is running using fc-agent
    try {
      const result = await execSimple("fc-agent", ["status", config.vmId]);
      if (!result.includes("running") && !result.includes("Running")) {
        console.error(`Error: Firecracker VM '${config.vmId}' is not running.`);
        console.error(`Start it with: fc-agent start ${config.vmId}`);
        process.exit(1);
      }
    } catch {
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
      console.error(`Error: Host path '${config.hostPath}' does not exist.`);
      process.exit(1);
    }

    console.log(
      `  Firecracker VM '${config.vmId}' configured with workspace '${config.hostPath}'.`,
    );
    return;
  }
}

function execSimple(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
  });
}

/**
 * Create an executor that runs commands either on host, in Docker container, or in Firecracker VM.
 * Optional `env` injects environment variables into every command executed.
 */
export function createExecutor(
  config: SandboxConfig,
  env?: Record<string, string>,
  ensureReady?: () => Promise<void>,
): Executor {
  if (config.type === "host") {
    return new HostExecutor(env);
  }
  if (config.type === "docker") {
    return new DockerExecutor(config.container, env, ensureReady);
  }
  if (config.type === "docker-auto") {
    throw new Error("docker-auto must be resolved to a concrete executor before execution");
  }
  return new FirecrackerExecutor(config.vmId, config.hostPath, config.sshUser, config.sshPort, env);
}

export interface Executor {
  /**
   * Execute a bash command
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * Get the workspace path prefix for this executor
   * Host: returns the actual path
   * Docker: returns /workspace
   */
  getWorkspacePath(hostPath: string): string;
}

export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function buildDockerExecCommand(
  container: string,
  command: string,
  env?: Record<string, string>,
): string {
  const envFlags = env
    ? Object.entries(env)
        .map(([k, v]) => `-e ${shellEscape(`${k}=${v}`)}`)
        .join(" ")
    : "";
  const envPart = envFlags ? `${envFlags} ` : "";
  return `docker exec ${envPart}-w /workspace ${container} sh -c ${shellEscape(command)}`;
}

class HostExecutor implements Executor {
  constructor(private env?: Record<string, string>) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const shell = process.platform === "win32" ? "cmd" : "sh";
      const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

      const child = spawn(shell, [...shellArgs, command], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(this.env && { env: { ...process.env, ...this.env } }),
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutHandle =
        options?.timeout && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              killProcessTree(child.pid!);
            }, options.timeout * 1000)
          : undefined;

      const onAbort = () => {
        if (child.pid) killProcessTree(child.pid);
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
        if (stdout.length > 10 * 1024 * 1024) {
          stdout = stdout.slice(0, 10 * 1024 * 1024);
        }
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
        if (stderr.length > 10 * 1024 * 1024) {
          stderr = stderr.slice(0, 10 * 1024 * 1024);
        }
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (options?.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }

        if (options?.signal?.aborted) {
          reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
          return;
        }

        if (timedOut) {
          reject(
            new Error(
              `${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim(),
            ),
          );
          return;
        }

        resolve({ stdout, stderr, code: code ?? 0 });
      });
    });
  }

  getWorkspacePath(hostPath: string): string {
    return hostPath;
  }
}

class DockerExecutor implements Executor {
  constructor(
    private container: string,
    private env?: Record<string, string>,
    private ensureReady?: () => Promise<void>,
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (this.ensureReady) {
      await this.ensureReady();
    } else {
      await ensureDockerContainerRunning(this.container);
    }

    const dockerCmd = buildDockerExecCommand(this.container, command, this.env);
    const hostExecutor = new HostExecutor();
    return hostExecutor.exec(dockerCmd, options);
  }

  getWorkspacePath(_hostPath: string): string {
    // Docker container sees /workspace
    return "/workspace";
  }
}

class FirecrackerExecutor implements Executor {
  constructor(
    private vmId: string,
    private hostPath: string,
    private sshUser: string = "root",
    private sshPort: number = 22,
    private env?: Record<string, string>,
  ) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    // Prefix command with env vars for SSH execution
    const envPrefix = this.env
      ? Object.entries(this.env)
          .map(([k, v]) => `${k}=${shellEscape(v)}`)
          .join(" ") + " "
      : "";
    const wrappedCommand = `${envPrefix}${command}`;

    // Use direct SSH to execute command in the Firecracker VM
    // The workspace inside the VM is expected to be mounted at /workspace
    const sshCmd =
      this.sshPort === 22
        ? `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${this.sshUser}@${this.vmId} sh -c ${shellEscape(wrappedCommand)}`
        : `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${this.sshPort} ${this.sshUser}@${this.vmId} sh -c ${shellEscape(wrappedCommand)}`;
    const hostExecutor = new HostExecutor();
    return hostExecutor.exec(sshCmd, options);
  }

  getWorkspacePath(_hostPath: string): string {
    // Firecracker VM sees /workspace (assumes hostPath is mounted there)
    return "/workspace";
  }
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // Ignore errors
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already dead
      }
    }
  }
}

function shellEscape(s: string): string {
  // Escape for passing to sh -c
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function ensureDockerContainerRunning(container: string): Promise<void> {
  try {
    const running = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", container]);
    if (running.trim() === "true") {
      return;
    }
    await execSimple("docker", ["start", container]);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Docker container "${container}" is not available. ` +
        `Expected a pre-existing container or docker-auto provisioning to keep it running.\n${details}`.trim(),
    );
  }
}
