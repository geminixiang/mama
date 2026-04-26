export type SandboxConfig = HostSandboxConfig | ContainerSandboxConfig | FirecrackerSandboxConfig;

export interface HostSandboxConfig {
  type: "host";
}

export interface ContainerSandboxConfig {
  type: "container";
  container: string;
}

export interface FirecrackerSandboxConfig {
  type: "firecracker";
  vmId: string;
  hostPath: string;
  sshUser?: string;
  sshPort?: number;
}

export interface Executor {
  /**
   * Execute a bash command.
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * Get the workspace path prefix for this executor.
   * Host: returns the actual path.
   * Container/Firecracker: returns /workspace.
   */
  getWorkspacePath(hostPath: string): string;

  /**
   * Get the current sandbox config used by this executor.
   */
  getSandboxConfig(): SandboxConfig;
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

export interface SandboxAdapter<TConfig extends SandboxConfig = SandboxConfig> {
  type: TConfig["type"];
  parse(value: string): TConfig | undefined;
  validate(config: TConfig): Promise<void>;
  createExecutor(
    config: TConfig,
    env?: Record<string, string>,
    ensureReady?: () => Promise<void>,
  ): Executor;
}
