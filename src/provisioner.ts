import { execFile } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

// ── DockerProvisioner ──────────────────────────────────────────────────────────

/**
 * Automatically provisions per-user Docker containers.
 * When a user links their account, a dedicated container is created from the
 * configured base image and mounted to the shared workspace.
 */
export class DockerProvisioner {
  /** Tracks vaultIds whose containers were last observed running. */
  private running = new Set<string>();

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
    return `${DockerProvisioner.sanitizeSegment(platform)}-${DockerProvisioner.sanitizeSegment(platformUserId)}`;
  }

  /** Deterministic container name for a vault-backed user sandbox. */
  static containerName(vaultId: string): string {
    return `mama-sandbox-${vaultId}`;
  }

  /**
   * Ensure a container exists and is running for the given vaultId.
   * - If container is running: no-op.
   * - If container exists but stopped: start it.
   * - If container does not exist: create it from the base image.
   *
   * Returns the container name.
   */
  async provision(vaultId: string): Promise<string> {
    const containerName = DockerProvisioner.containerName(vaultId);

    try {
      const { stdout } = await this.execFileImpl("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        containerName,
      ]);
      if (stdout.trim() === "true") {
        log.logInfo(`Provisioner: container ${containerName} already running`);
        this.running.add(vaultId);
        return containerName;
      }
      await this.execFileImpl("docker", ["start", containerName]);
      log.logInfo(`Provisioner: started existing container ${containerName}`);
      this.running.add(vaultId);
      return containerName;
    } catch {
      // Container does not exist — create it
    }

    log.logInfo(`Provisioner: creating container ${containerName} from image ${this.image}`);
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
    log.logInfo(`Provisioner: container ${containerName} created`);
    this.running.add(vaultId);
    return containerName;
  }

  /** Stop and remove a user's container (e.g. on vault revoke). */
  async deprovision(vaultId: string): Promise<void> {
    const containerName = DockerProvisioner.containerName(vaultId);
    this.running.delete(vaultId);
    try {
      await this.execFileImpl("docker", ["rm", "-f", containerName]);
      log.logInfo(`Provisioner: removed container ${containerName}`);
    } catch (err) {
      log.logWarning(
        `Provisioner: failed to remove ${containerName}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
