import { execFile } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

type ContainerStatus = "running" | "stopped" | "missing";

interface ContainerState {
  status: ContainerStatus;
  lastUsed: number;
}

// ── DockerContainerManager ─────────────────────────────────────────────────────

/**
 * Manages the lifecycle of per-user Docker containers.
 *
 * Tracks each container's status in memory (running / stopped / missing).
 * State is always verified against Docker on provision(), so in-memory state
 * stays accurate without polling.
 */
export class DockerContainerManager {
  private state = new Map<string, ContainerState>();

  constructor(
    private readonly image: string,
    private readonly workspaceDir: string,
    private readonly execFileImpl: ExecFileAsync = execFileAsync,
  ) {}

  /** Sanitize an identifier segment for use in vault keys and container names. */
  static sanitizeSegment(value: string): string {
    const sanitized = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return sanitized || "unknown";
  }

  /**
   * Deterministic vault key for a platform user.
   * e.g. ("slack", "U04ABC") → "slack-u04abc"
   */
  static vaultId(platform: string, platformUserId: string): string {
    return `${DockerContainerManager.sanitizeSegment(platform)}-${DockerContainerManager.sanitizeSegment(platformUserId)}`;
  }

  /** Deterministic container name for a vault-backed user sandbox. */
  static containerName(vaultId: string): string {
    return `mama-sandbox-${vaultId}`;
  }

  /**
   * Ensure a container exists and is running for the given vaultId.
   * Always inspects the actual Docker state, then acts accordingly:
   * - running  → no-op
   * - stopped  → docker start
   * - missing  → docker run
   *
   * Returns the container name.
   */
  async provision(vaultId: string): Promise<string> {
    const containerName = DockerContainerManager.containerName(vaultId);
    const status = await this.inspectStatus(containerName);

    if (status === "running") {
      log.logInfo(`Container ${containerName} already running`);
    } else if (status === "stopped") {
      await this.execFileImpl("docker", ["start", containerName]);
      log.logInfo(`Container ${containerName} started`);
    } else {
      log.logInfo(`Creating container ${containerName} from image ${this.image}`);
      await this.execFileImpl("docker", [
        "run",
        "-d",
        "--name",
        containerName,
        "-v",
        `${this.workspaceDir}:/workspace`,
        this.image,
        "sleep",
        "infinity",
      ]);
      log.logInfo(`Container ${containerName} created`);
    }

    this.setState(vaultId, "running");
    return containerName;
  }

  /**
   * Stop a running container (docker stop). Container is preserved and can be
   * restarted via provision(). Intended for idle lifecycle management.
   */
  async stop(vaultId: string): Promise<void> {
    const containerName = DockerContainerManager.containerName(vaultId);
    try {
      await this.execFileImpl("docker", ["stop", containerName]);
      this.setState(vaultId, "stopped");
      log.logInfo(`Container ${containerName} stopped (idle)`);
    } catch (err) {
      log.logWarning(
        `Failed to stop container ${containerName}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Stop and remove a container permanently (e.g. on vault revocation). */
  async remove(vaultId: string): Promise<void> {
    const containerName = DockerContainerManager.containerName(vaultId);
    try {
      await this.execFileImpl("docker", ["rm", "-f", containerName]);
      this.state.delete(vaultId);
      log.logInfo(`Container ${containerName} removed`);
    } catch (err) {
      log.logWarning(
        `Failed to remove container ${containerName}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Stop all containers that have been idle for longer than maxIdleMs.
   * Idle time is measured from the last provision() call.
   */
  async stopIdle(maxIdleMs: number): Promise<void> {
    const now = Date.now();
    const toStop: string[] = [];
    for (const [vaultId, containerState] of this.state) {
      if (containerState.status === "running" && now - containerState.lastUsed > maxIdleMs) {
        toStop.push(vaultId);
      }
    }
    await Promise.all(toStop.map((vaultId) => this.stop(vaultId)));
  }

  private setState(vaultId: string, status: ContainerStatus): void {
    this.state.set(vaultId, { status, lastUsed: Date.now() });
  }

  private async inspectStatus(containerName: string): Promise<ContainerStatus> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        containerName,
      ]);
      return stdout.trim() === "true" ? "running" : "stopped";
    } catch {
      return "missing";
    }
  }
}

/** @deprecated Use DockerContainerManager */
export const DockerProvisioner = DockerContainerManager;
