import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { randomBytes } from "crypto";
import { basename, dirname, isAbsolute, join, normalize, sep } from "path";
import type { SandboxConfig } from "./sandbox.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// ── Types ──────────────────────────────────────────────────────────────────────

/** Shape of workspace/vaults/vault.json */
export interface VaultConfig {
  vaults: Record<string, VaultEntry>;
}

/** Per-user vault mount entry in vault.json */
export interface VaultMountEntry {
  source: string;
  target?: string;
}

/** Per-user vault entry in vault.json */
export interface VaultEntry {
  displayName: string;
  platform?: "slack" | "discord" | "telegram";
  /** Subdirs/files in vault dir to mount into sandbox (e.g. [".gcloud", ".ssh", ".kube"]) */
  mounts?: Array<string | VaultMountEntry>;
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

export interface ResolvedVaultMount {
  source: string;
  target: string;
}

/** Resolved vault ready for use at runtime */
export interface ResolvedVault {
  userId: string;
  displayName: string;
  /** Absolute path to vault directory */
  dir: string;
  /** Absolute mount specs */
  mounts: ResolvedVaultMount[];
  /** Parsed from env file */
  env: Record<string, string>;
  sandboxOverride?: VaultEntry["sandbox"];
}

export interface VaultManager {
  /** Return true when vault.json contains this exact key. */
  hasEntry(key: string): boolean;
  /** Resolve vault for a user; returns undefined when no entry exists. */
  resolve(userId: string): ResolvedVault | undefined;
  /** Get sandbox config with credential injection for a user */
  getSandboxConfig(userId: string, baseConfig: SandboxConfig): SandboxConfig;
  /** List all configured vaults */
  list(): ResolvedVault[];
  /** Re-read vault.json without restart */
  reload(): void;
  /** Check if vault system is enabled (vault.json exists) */
  isEnabled(): boolean;
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
  /** Write a private file into vaults/<key>/ and ensure it is mounted into the sandbox. */
  upsertFile(key: string, relativePath: string, content: string, targetPath?: string): void;
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

  hasEntry(key: string): boolean {
    return !!this.config?.vaults[key];
  }

  resolve(userId: string): ResolvedVault | undefined {
    const entry = this.config?.vaults[userId];
    if (!entry) return undefined;
    return this.buildResolved(userId, entry);
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
      if (baseConfig.type !== "firecracker") {
        throw new Error(
          `vault "${userId}" sets sandbox.type=firecracker, but base sandbox is "${baseConfig.type}". ` +
            "Use --sandbox=firecracker:<vm-id>:<host-path> so /workspace stays mapped to the real workspace.",
        );
      }
      return {
        type: "firecracker",
        vmId: override.vmId,
        hostPath: baseConfig.hostPath,
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
      results.push(this.buildResolved(key, entry));
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
    ensurePrivateDir(this.vaultsDir);
    ensurePrivateDir(dir);
    const existing = existsSync(envPath)
      ? parseEnvFile(readFileSync(envPath, "utf-8"))
      : ({} as Record<string, string>);
    const merged = { ...existing, ...env };
    const content =
      Object.entries(merged)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([envKey, value]) => `${envKey}=${value}`)
        .join("\n") + "\n";
    atomicWritePrivateFile(envPath, content);
  }

  upsertFile(key: string, relativePath: string, content: string, targetPath?: string): void {
    const normalizedPath = normalizeVaultRelativePath(relativePath);
    const normalizedTarget = normalizeVaultTargetPath(targetPath);
    if (!normalizedPath || (targetPath !== undefined && !normalizedTarget)) {
      throw new Error(`vault: invalid relative secret file path for "${key}": ${relativePath}`);
    }

    const dir = join(this.vaultsDir, key);
    const filePath = join(dir, normalizedPath);

    ensurePrivateDir(this.vaultsDir);
    ensurePrivateDir(dir);
    const parentDir = dirname(filePath);
    if (parentDir !== dir) ensurePrivateDir(parentDir);
    atomicWritePrivateFile(filePath, content);
    this.ensureMountEntry(key, normalizedPath, normalizedTarget);
  }

  // ── private ────────────────────────────────────────────────────────────────

  private persistConfig(): void {
    ensurePrivateDir(this.vaultsDir);

    // Preserve concurrent external edits: pull in any entries that appear on
    // disk but not in our in-memory view, so a background edit (e.g. another
    // admin adding a user) is not silently dropped by the next upsert here.
    // Individual field edits still follow last-writer-wins per key.
    const onDisk = this.readConfigFromDisk();
    if (onDisk && this.config) {
      for (const [key, entry] of Object.entries(onDisk.vaults)) {
        if (!(key in this.config.vaults)) {
          this.config.vaults[key] = entry;
        }
      }
    }

    atomicWritePrivateFile(this.configPath, JSON.stringify(this.config, null, 2) + "\n");
  }

  private readConfigFromDisk(): VaultConfig | null {
    if (!existsSync(this.configPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf-8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !parsed.vaults ||
        typeof parsed.vaults !== "object"
      ) {
        return null;
      }
      return parsed as VaultConfig;
    } catch {
      return null;
    }
  }

  private ensureMountEntry(key: string, relativePath: string, targetPath?: string): void {
    if (!this.config?.vaults[key]) {
      throw new Error(`vault: cannot add mount "${relativePath}" for missing entry "${key}"`);
    }

    const existing = this.config.vaults[key];
    const mounts = existing.mounts ?? [];
    if (
      mounts.some((mount) =>
        typeof mount === "string"
          ? mount === relativePath && !targetPath
          : mount.source === relativePath && mount.target === targetPath,
      )
    ) {
      return;
    }

    this.config.vaults[key] = {
      ...existing,
      mounts: [...mounts, targetPath ? { source: relativePath, target: targetPath } : relativePath],
    };
    this.persistConfig();
  }

  private buildResolved(key: string, entry: VaultEntry): ResolvedVault {
    const dir = join(this.vaultsDir, key);

    const mounts = (entry.mounts ?? [])
      .map((mount) => this.resolveMountEntry(dir, mount))
      .filter((mount): mount is ResolvedVaultMount => mount !== undefined);

    let env: Record<string, string> = {};
    const envPath = join(dir, "env");
    if (entry.envFile !== false && existsSync(envPath)) {
      try {
        env = parseEnvFile(readFileSync(envPath, "utf-8"));
      } catch (err) {
        console.error(`vault: failed to parse env file for "${key}":`, err);
      }
    }

    return {
      userId: key,
      displayName: entry.displayName,
      dir,
      mounts,
      env,
      sandboxOverride: entry.sandbox,
    };
  }

  private resolveMountEntry(
    dir: string,
    mount: string | VaultMountEntry,
  ): ResolvedVaultMount | undefined {
    if (typeof mount === "string") {
      const normalizedSource = normalizeVaultRelativePath(mount);
      if (!normalizedSource) return undefined;
      return {
        source: join(dir, normalizedSource),
        target: defaultVaultTargetPath(normalizedSource),
      };
    }

    if (!mount || typeof mount !== "object") return undefined;
    const normalizedSource = normalizeVaultRelativePath(mount.source);
    if (!normalizedSource) return undefined;
    const normalizedTarget = normalizeVaultTargetPath(mount.target);
    return {
      source: join(dir, normalizedSource),
      target: normalizedTarget ?? defaultVaultTargetPath(normalizedSource),
    };
  }
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(path, PRIVATE_DIR_MODE);
}

/**
 * Write `content` to `targetPath` with mode 0600, even when `targetPath`
 * already exists. Uses O_CREAT|O_EXCL on a temp sibling (so the kernel
 * guarantees permissions at creation, not after a racy chmod) and then
 * rename(2) into place for atomicity. Readers never see a torn write.
 */
function atomicWritePrivateFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  const tmpPath = join(
    dir,
    `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = openSync(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  try {
    writeSync(fd, content);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — original error is more informative
    }
    throw err;
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function normalizeVaultRelativePath(relativePath: string): string | undefined {
  const trimmed = relativePath.trim();
  if (!trimmed || isAbsolute(trimmed)) return undefined;

  const normalized = normalize(trimmed).split(sep).join("/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function normalizeVaultTargetPath(targetPath?: string): string | undefined {
  if (targetPath === undefined) {
    return undefined;
  }

  const trimmed = targetPath.trim();
  if (!trimmed || !trimmed.startsWith("/")) {
    return undefined;
  }

  const normalized = normalize(trimmed).split(sep).join("/");
  return normalized.startsWith("/") ? normalized : undefined;
}

export function defaultVaultTargetPath(relativePath: string): string {
  const normalized = normalizeVaultRelativePath(relativePath) ?? relativePath.replace(/^\/+/, "");
  return `/root/${normalized}`;
}
