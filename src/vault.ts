import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { SandboxConfig } from "./sandbox.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// ── Types ──────────────────────────────────────────────────────────────────────

/** Shape of workspace/vaults/vault.json */
export interface VaultConfig {
  vaults: Record<string, VaultEntry>;
  /** Vault key for users without a dedicated vault (e.g. "_shared") */
  fallback?: string;
  /** When true, tool execution fails if user has no vault (and no fallback). Default: false */
  strict?: boolean;
  /** Vault key to use for system-triggered runs (events, scheduled tasks) with no userId */
  systemActor?: string;
}

/** Per-user vault entry in vault.json */
export interface VaultEntry {
  displayName: string;
  platform?: "slack" | "discord" | "telegram";
  /** Subdirs/files in vault dir to mount into sandbox (e.g. [".gcloud", ".ssh", ".kube"]) */
  mounts?: string[];
  /** Whether to load env file as environment variables (default: true if env file exists) */
  envFile?: boolean;
  /** Per-user sandbox config override */
  sandbox?: {
    type?: "image" | "firecracker" | "host" | "container" | "docker";
    container?: string;
    image?: string;
    vmId?: string;
    sshUser?: string;
    sshPort?: number;
  };
}

/** Resolved vault ready for use at runtime */
export interface ResolvedVault {
  userId: string;
  displayName: string;
  /** Absolute path to vault directory */
  dir: string;
  /** Absolute paths to mount sources */
  mounts: string[];
  /** Parsed from env file */
  env: Record<string, string>;
  sandboxOverride?: VaultEntry["sandbox"];
}

export interface VaultManager {
  /** Return true when vault.json contains this exact key (does not consider fallback). */
  hasEntry(key: string): boolean;
  /** Resolve vault for a user; returns undefined if no vault and no fallback */
  resolve(userId: string): ResolvedVault | undefined;
  /** Get sandbox config with credential injection for a user */
  getSandboxConfig(userId: string, baseConfig: SandboxConfig): SandboxConfig;
  /** List all configured vaults */
  list(): ResolvedVault[];
  /** Re-read vault.json without restart */
  reload(): void;
  /** Check if vault system is enabled (vault.json exists) */
  isEnabled(): boolean;
  /** Check if strict mode is on (fail-fast when user has no vault) */
  isStrict(): boolean;
  /** Resolve the system actor vault (for events/scheduled tasks with no userId) */
  resolveSystemActor(): ResolvedVault | undefined;
  /**
   * Add a vault entry and persist to disk.
   * No-op if the key already exists (idempotent).
   */
  addEntry(key: string, entry: VaultEntry): void;
  /**
   * Ensure a vault entry has image sandbox metadata.
   * Creates the entry when missing and upgrades existing entries that lack sandbox.type.
   */
  ensureImageSandboxEntry(key: string, entry: VaultEntry): void;
  /** Merge environment variables into vaults/<key>/env and persist them to disk. */
  upsertEnv(key: string, env: Record<string, string>): void;
}

// ── parseEnvFile ───────────────────────────────────────────────────────────────

/**
 * Parse a KEY=VALUE env file. Supports:
 * - Lines starting with # are comments
 * - Empty lines are skipped
 * - Values can be quoted with single or double quotes (quotes are stripped)
 * - No variable expansion
 * - The value is everything after the first `=` to end of line (no inline comments)
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = trimmed.slice(eqIndex + 1);

    // Strip matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

// ── FileVaultManager ───────────────────────────────────────────────────────────

export class FileVaultManager implements VaultManager {
  private config: VaultConfig | null = null;
  private readonly vaultsDir: string;
  private readonly configPath: string;

  constructor(stateDir: string) {
    this.vaultsDir = join(stateDir, "vaults");
    this.configPath = join(this.vaultsDir, "vault.json");
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.configPath)) {
      this.config = null;
      return;
    }

    try {
      const raw = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);

      if (
        !parsed ||
        typeof parsed !== "object" ||
        !parsed.vaults ||
        typeof parsed.vaults !== "object"
      ) {
        console.error(`vault: malformed vault.json — expected { vaults: { ... } }`);
        this.config = null;
        return;
      }

      this.config = parsed as VaultConfig;
      this.warnUnsupportedSandboxTypes();
    } catch (err) {
      console.error(`vault: failed to read ${this.configPath}:`, err);
      this.config = null;
    }
  }

  /** Warn for legacy or insecure vault sandbox overrides that are no longer allowed. */
  private warnUnsupportedSandboxTypes(): void {
    if (!this.config) return;
    for (const [key, entry] of Object.entries(this.config.vaults)) {
      if (entry.sandbox?.type === "host") {
        console.error(
          `vault: "${key}" uses sandbox.type=host, which is blocked for credential isolation. ` +
            "Use sandbox.type=image or sandbox.type=firecracker.",
        );
      }
      if (entry.sandbox?.type === "container" || entry.sandbox?.type === "docker") {
        console.error(
          `vault: "${key}" uses sandbox.type=${entry.sandbox.type}, which is blocked for credential isolation. ` +
            "Use sandbox.type=image for per-user containers or sandbox.type=firecracker.",
        );
      }
    }
  }

  isEnabled(): boolean {
    return this.config !== null;
  }

  isStrict(): boolean {
    return this.config?.strict === true;
  }

  hasEntry(key: string): boolean {
    return !!this.config?.vaults[key];
  }

  resolveSystemActor(): ResolvedVault | undefined {
    if (!this.config?.systemActor) return undefined;
    const key = this.config.systemActor;
    const entry = this.config.vaults[key];
    if (!entry) return undefined;
    return this.buildResolved("__system__", key, entry);
  }

  resolve(userId: string): ResolvedVault | undefined {
    if (!this.config) return undefined;

    let vaultKey = userId;
    let entry = this.config.vaults[vaultKey];

    // Fall back to the configured fallback key
    if (!entry && this.config.fallback) {
      vaultKey = this.config.fallback;
      entry = this.config.vaults[vaultKey];
    }

    if (!entry) return undefined;

    return this.buildResolved(userId, vaultKey, entry);
  }

  getSandboxConfig(userId: string, baseConfig: SandboxConfig): SandboxConfig {
    const vault = this.resolve(userId);
    if (!vault?.sandboxOverride) return baseConfig;

    const override = vault.sandboxOverride;

    if (override.type === "image") {
      if (baseConfig.type !== "image") {
        throw new Error(
          `vault "${userId}" sets sandbox.type=image, but base sandbox is "${baseConfig.type}". ` +
            "Use --sandbox=image:<image> to enable per-user managed containers.",
        );
      }
      const container = override.container || `mama-sandbox-${userId}`;
      return { type: "container", container };
    }

    if (override.type === "firecracker") {
      if (!override.vmId) return baseConfig;
      // Firecracker requires a hostPath — inherit from base if it's also firecracker,
      // otherwise fall back to the vault directory itself
      const hostPath = baseConfig.type === "firecracker" ? baseConfig.hostPath : vault.dir;
      return {
        type: "firecracker",
        vmId: override.vmId,
        hostPath,
        sshUser: override.sshUser,
        sshPort: override.sshPort,
      };
    }

    if (override.type === "host") {
      throw new Error(
        `vault "${userId}" uses sandbox.type=host, which is blocked for credential isolation. ` +
          "Use sandbox.type=image or sandbox.type=firecracker.",
      );
    }

    if (override.type === "container" || override.type === "docker") {
      throw new Error(
        `vault "${userId}" uses sandbox.type=${override.type}, which is blocked for credential isolation. ` +
          "Use sandbox.type=image for per-user containers or sandbox.type=firecracker.",
      );
    }

    // No type override — return base config unchanged
    return baseConfig;
  }

  list(): ResolvedVault[] {
    if (!this.config) return [];

    const results: ResolvedVault[] = [];
    for (const [key, entry] of Object.entries(this.config.vaults)) {
      results.push(this.buildResolved(key, key, entry));
    }
    return results;
  }

  addEntry(key: string, entry: VaultEntry): void {
    if (!this.config) {
      this.config = { vaults: {} };
    }
    // Idempotent: skip if already exists
    if (this.config.vaults[key]) return;
    this.config.vaults[key] = entry;
    this.persistConfig();
  }

  ensureImageSandboxEntry(key: string, entry: VaultEntry): void {
    if (entry.sandbox?.type !== "image") {
      throw new Error(`vault: ensureImageSandboxEntry requires sandbox.type=image for "${key}"`);
    }

    if (!this.config) {
      this.config = { vaults: {} };
    }

    const existing = this.config.vaults[key];
    if (!existing) {
      this.config.vaults[key] = entry;
      this.persistConfig();
      return;
    }

    let nextEntry = existing;
    let changed = false;

    if (!existing.platform && entry.platform) {
      nextEntry = { ...nextEntry, platform: entry.platform };
      changed = true;
    }

    const existingSandbox = existing.sandbox;
    if (!existingSandbox?.type) {
      nextEntry = { ...nextEntry, sandbox: entry.sandbox };
      changed = true;
    } else if (
      existingSandbox.type === "image" &&
      !existingSandbox.container &&
      entry.sandbox.container
    ) {
      nextEntry = {
        ...nextEntry,
        sandbox: { ...existingSandbox, container: entry.sandbox.container },
      };
      changed = true;
    }

    if (!changed) {
      return;
    }

    this.config.vaults[key] = nextEntry;
    this.persistConfig();
  }

  upsertEnv(key: string, env: Record<string, string>): void {
    const dir = join(this.vaultsDir, key);
    const envPath = join(dir, "env");
    try {
      mkdirSync(this.vaultsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
      chmodSync(this.vaultsDir, PRIVATE_DIR_MODE);
      mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
      chmodSync(dir, PRIVATE_DIR_MODE);
      const existing = existsSync(envPath)
        ? parseEnvFile(readFileSync(envPath, "utf-8"))
        : ({} as Record<string, string>);
      const merged = { ...existing, ...env };
      const content =
        Object.entries(merged)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([envKey, value]) => `${envKey}=${value}`)
          .join("\n") + "\n";
      writeFileSync(envPath, content, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
      chmodSync(envPath, PRIVATE_FILE_MODE);
    } catch (err) {
      console.error(`vault: failed to write env file for "${key}":`, err);
    }
  }

  // ── private ────────────────────────────────────────────────────────────────

  private persistConfig(): void {
    mkdirSync(this.vaultsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    chmodSync(this.vaultsDir, PRIVATE_DIR_MODE);
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + "\n", {
      encoding: "utf-8",
      mode: PRIVATE_FILE_MODE,
    });
    chmodSync(this.configPath, PRIVATE_FILE_MODE);
  }

  private buildResolved(userId: string, vaultKey: string, entry: VaultEntry): ResolvedVault {
    const dir = join(this.vaultsDir, vaultKey);

    const mounts = (entry.mounts ?? []).map((m) => join(dir, m));

    let env: Record<string, string> = {};
    const envPath = join(dir, "env");
    if (entry.envFile !== false && existsSync(envPath)) {
      try {
        env = parseEnvFile(readFileSync(envPath, "utf-8"));
      } catch (err) {
        console.error(`vault: failed to parse env file for "${vaultKey}":`, err);
      }
    }

    return {
      userId,
      displayName: entry.displayName,
      dir,
      mounts,
      env,
      sandboxOverride: entry.sandbox,
    };
  }
}
