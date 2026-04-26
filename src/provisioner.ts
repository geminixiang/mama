import { execFile } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

type ContainerStatus = "running" | "stopped" | "missing";

interface ContainerState {
  status: ContainerStatus;
  lastUsed: number;
  containerName: string;
}

export interface ContainerMount {
  source: string;
  target: string;
}

export interface ProvisionOptions {
  containerName?: string;
  mounts?: ContainerMount[];
}

export class DockerContainerManager {
  private state = new Map<string, ContainerState>();
  private inflight = new Map<string, Promise<string>>();
  private static readonly MANAGED_LABEL = "mama.managed=true";
  private static readonly IMAGE_MODE_LABEL = "mama.sandbox=image";
  private static readonly VAULT_ID_LABEL_KEY = "mama.vault-id";

  constructor(
    private readonly image: string,
    private readonly workspaceDir: string,
    private readonly execFileImpl: ExecFileAsync = execFileAsync,
  ) {}

  static sanitizeSegment(value: string): string {
    const sanitized = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return sanitized || "unknown";
  }

  static vaultId(platform: string, platformUserId: string): string {
    return `${DockerContainerManager.sanitizeSegment(platform)}-${DockerContainerManager.sanitizeSegment(platformUserId)}`;
  }

  static containerName(vaultId: string): string {
    return `mama-sandbox-${vaultId}`;
  }

  async provision(vaultId: string, options: ProvisionOptions = {}): Promise<string> {
    const existing = this.inflight.get(vaultId);
    if (existing) return existing;

    const pending = this.provisionInner(vaultId, options).finally(() => {
      this.inflight.delete(vaultId);
    });
    this.inflight.set(vaultId, pending);
    return pending;
  }

  private async provisionInner(vaultId: string, options: ProvisionOptions): Promise<string> {
    const containerName = options.containerName ?? DockerContainerManager.containerName(vaultId);
    const mounts = options.mounts ?? [];
    const status = await this.inspectStatus(containerName);

    try {
      if (status !== "missing" && (await this.hasBindMountDrift(containerName, mounts))) {
        log.logInfo(`Container ${containerName} mounts changed; recreating container`);
        await this.execFileImpl("docker", ["rm", "-f", containerName]);
        await this.runContainer(vaultId, containerName, mounts);
        log.logInfo(`Container ${containerName} recreated`);
      } else if (status === "running") {
        log.logInfo(`Container ${containerName} already running`);
      } else if (status === "stopped") {
        await this.execFileImpl("docker", ["start", containerName]);
        log.logInfo(`Container ${containerName} started`);
      } else {
        await this.runContainer(vaultId, containerName, mounts);
        log.logInfo(`Container ${containerName} created`);
      }
    } catch (err) {
      this.state.delete(vaultId);
      throw err;
    }

    this.setState(vaultId, "running", containerName);
    return containerName;
  }

  async stop(vaultId: string): Promise<void> {
    const containerName = this.getContainerName(vaultId);
    try {
      await this.execFileImpl("docker", ["stop", containerName]);
      this.setState(vaultId, "stopped", containerName);
      log.logInfo(`Container ${containerName} stopped (idle)`);
    } catch (err) {
      log.logWarning(
        `Failed to stop container ${containerName}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async remove(vaultId: string): Promise<void> {
    const containerName = this.getContainerName(vaultId);
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

  async reconcile(): Promise<void> {
    const discovered = new Set<string>();
    const labeledNames = await this.listContainerNamesByLabel();
    for (const name of labeledNames) discovered.add(name);
    const legacyNames = await this.listContainerNamesByPrefix();
    for (const name of legacyNames) discovered.add(name);

    this.state.clear();

    for (const containerName of discovered) {
      const details = await this.inspectContainerDetails(containerName);
      if (!details) continue;

      const vaultId = details.vaultId || this.vaultIdFromContainerName(containerName);
      if (!vaultId) {
        log.logWarning(`Skipping unmanaged-style container without vault id`, containerName);
        continue;
      }

      const status: ContainerStatus = details.running ? "running" : "stopped";
      const lastUsed = details.startedAtMs ?? Date.now();
      this.state.set(vaultId, { status, lastUsed, containerName });
    }

    const running = Array.from(this.state.values()).filter((s) => s.status === "running").length;
    const stopped = this.state.size - running;
    log.logInfo(
      `Reconciled ${this.state.size} managed containers (running=${running}, stopped=${stopped})`,
    );
  }

  private setState(vaultId: string, status: ContainerStatus, containerName: string): void {
    this.state.set(vaultId, { status, lastUsed: Date.now(), containerName });
  }

  private getContainerName(vaultId: string): string {
    return this.state.get(vaultId)?.containerName ?? DockerContainerManager.containerName(vaultId);
  }

  private mountArgs(mounts: ContainerMount[]): string[] {
    return mounts.flatMap((mount) => ["-v", this.toBindSpec(mount)]);
  }

  private toBindSpec(mount: ContainerMount): string {
    return `${mount.source}:${mount.target}`;
  }

  private async runContainer(
    vaultId: string,
    containerName: string,
    mounts: ContainerMount[],
  ): Promise<void> {
    log.logInfo(`Creating container ${containerName} from image ${this.image}`);
    await this.execFileImpl("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "--label",
      DockerContainerManager.MANAGED_LABEL,
      "--label",
      DockerContainerManager.IMAGE_MODE_LABEL,
      "--label",
      `${DockerContainerManager.VAULT_ID_LABEL_KEY}=${vaultId}`,
      "-v",
      `${this.workspaceDir}:/workspace`,
      ...this.mountArgs(mounts),
      this.image,
      "sleep",
      "infinity",
    ]);
  }

  private async hasBindMountDrift(
    containerName: string,
    mounts: ContainerMount[],
  ): Promise<boolean> {
    const expected = this.expectedBinds(mounts);
    const actual = await this.inspectBindMounts(containerName);
    return !this.sameBinds(expected, actual);
  }

  private expectedBinds(mounts: ContainerMount[]): string[] {
    return [`${this.workspaceDir}:/workspace`, ...mounts.map((mount) => this.toBindSpec(mount))]
      .slice()
      .sort();
  }

  private sameBinds(expected: string[], actual: string[]): boolean {
    if (expected.length !== actual.length) {
      return false;
    }

    return expected.every((bind, index) => bind === actual[index]);
  }

  private async inspectBindMounts(containerName: string): Promise<string[]> {
    const { stdout } = await this.execFileImpl("docker", [
      "inspect",
      "-f",
      "{{json .HostConfig.Binds}}",
      containerName,
    ]);
    const payload = stdout.trim();
    const parsed = JSON.parse(payload.length > 0 ? payload : "null") as unknown;

    if (parsed === null) {
      return [];
    }

    if (!Array.isArray(parsed) || parsed.some((bind) => typeof bind !== "string")) {
      throw new Error(`Unexpected docker bind mount payload for container "${containerName}"`);
    }

    return [...parsed].sort();
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

  private async listContainerNamesByLabel(): Promise<string[]> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "ps",
        "-a",
        "--filter",
        `label=${DockerContainerManager.MANAGED_LABEL}`,
        "--filter",
        `label=${DockerContainerManager.IMAGE_MODE_LABEL}`,
        "--format",
        "{{.Names}}",
      ]);
      return this.parseNameLines(stdout);
    } catch (err) {
      log.logWarning(
        "Failed to list labeled managed containers",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  private async listContainerNamesByPrefix(): Promise<string[]> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "ps",
        "-a",
        "--filter",
        `name=${DockerContainerManager.containerName("")}`,
        "--format",
        "{{.Names}}",
      ]);
      return this.parseNameLines(stdout);
    } catch (err) {
      log.logWarning(
        "Failed to list legacy managed containers",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  private parseNameLines(stdout: string): string[] {
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async inspectContainerDetails(
    containerName: string,
  ): Promise<{ running: boolean; startedAtMs?: number; vaultId?: string } | undefined> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "inspect",
        "-f",
        `{{.State.Running}}\t{{.State.StartedAt}}\t{{index .Config.Labels "${DockerContainerManager.VAULT_ID_LABEL_KEY}"}}`,
        containerName,
      ]);
      const [runningRaw, startedAtRaw, vaultIdRaw] = stdout.trim().split("\t");
      const running = runningRaw === "true";
      const startedAtMs = this.parseDockerTimestamp(startedAtRaw);
      const vaultId = this.normalizeDockerValue(vaultIdRaw);
      return { running, startedAtMs, vaultId };
    } catch (err) {
      log.logWarning(
        `Failed to inspect container ${containerName} during reconcile`,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  private normalizeDockerValue(value?: string): string | undefined {
    if (!value || value === "<no value>") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private parseDockerTimestamp(value?: string): number | undefined {
    const normalized = this.normalizeDockerValue(value);
    if (!normalized || normalized.startsWith("0001-")) return undefined;
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private vaultIdFromContainerName(containerName: string): string | undefined {
    const prefix = DockerContainerManager.containerName("");
    if (!containerName.startsWith(prefix)) return undefined;
    const vaultId = containerName.slice(prefix.length);
    return vaultId.length > 0 ? vaultId : undefined;
  }
}

/** @deprecated Use DockerContainerManager */
export const DockerProvisioner = DockerContainerManager;
