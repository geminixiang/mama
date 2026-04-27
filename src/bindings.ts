import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface UserBinding {
  platform: "slack" | "discord" | "telegram";
  platformUserId: string;
  /** Internal identity (matches vault key in vault.json, or a backend user ID) */
  internalUserId: string;
  /** Key in vault.json that holds this user's credentials */
  vaultId: string;
  /** Optional future field for explicit execution target override */
  executionTargetId?: string;
  status: "pending" | "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface BindingsConfig {
  bindings: UserBinding[];
}

export interface UserBindingStore {
  /** Resolve active binding for a platform user; returns undefined if not found or revoked */
  resolve(platform: string, platformUserId: string): UserBinding | undefined;
  /** List all bindings */
  list(): UserBinding[];
  /** Upsert a binding (insert or update by platform + platformUserId) */
  upsert(binding: UserBinding): void;
  /** Revoke a binding by setting status to "revoked" */
  revoke(platform: string, platformUserId: string): void;
  /** Re-read bindings.json from disk */
  reload(): void;
  /** Whether bindings.json exists and was loaded successfully */
  isEnabled(): boolean;
}

/** File-backed binding store. Reads and writes `vaults/bindings.json`. */
export class FileUserBindingStore implements UserBindingStore {
  private config: BindingsConfig | null = null;
  private readonly configPath: string;

  constructor(stateDir: string) {
    this.configPath = join(stateDir, "vaults", "bindings.json");
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
      if (!parsed || !Array.isArray(parsed.bindings)) {
        console.error("bindings: malformed bindings.json — expected { bindings: [...] }");
        this.config = null;
        return;
      }
      this.config = parsed as BindingsConfig;
    } catch (err) {
      console.error(`bindings: failed to read ${this.configPath}:`, err);
      this.config = null;
    }
  }

  isEnabled(): boolean {
    return this.config !== null;
  }

  resolve(platform: string, platformUserId: string): UserBinding | undefined {
    if (!this.config) return undefined;
    return this.config.bindings.find(
      (b) =>
        b.platform === platform && b.platformUserId === platformUserId && b.status === "active",
    );
  }

  list(): UserBinding[] {
    return this.config?.bindings ?? [];
  }

  upsert(binding: UserBinding): void {
    if (!this.config) {
      this.config = { bindings: [] };
    }
    const idx = this.config.bindings.findIndex(
      (b) => b.platform === binding.platform && b.platformUserId === binding.platformUserId,
    );
    if (idx >= 0) {
      this.config.bindings[idx] = binding;
    } else {
      this.config.bindings.push(binding);
    }
    this.persist();
  }

  revoke(platform: string, platformUserId: string): void {
    if (!this.config) return;
    const binding = this.config.bindings.find(
      (b) => b.platform === platform && b.platformUserId === platformUserId,
    );
    if (binding) {
      binding.status = "revoked";
      binding.updatedAt = new Date().toISOString();
      this.persist();
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + "\n", "utf-8");
    } catch (err) {
      console.error(`bindings: failed to write ${this.configPath}:`, err);
    }
  }
}
