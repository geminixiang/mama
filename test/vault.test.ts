import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ActorExecutionResolver } from "../src/execution-resolver.js";
import { DockerProvisioner } from "../src/provisioner.js";
import { FileVaultManager, parseEnvFile, type VaultConfig } from "../src/vault.js";

// ── parseEnvFile ──────────────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  test("parses basic KEY=VALUE lines", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("skips comments and empty lines", () => {
    const result = parseEnvFile("# comment\nFOO=bar\n\n# another\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("strips double quotes from values", () => {
    const result = parseEnvFile('FOO="hello world"');
    expect(result).toEqual({ FOO: "hello world" });
  });

  test("strips single quotes from values", () => {
    const result = parseEnvFile("FOO='hello world'");
    expect(result).toEqual({ FOO: "hello world" });
  });

  test("handles values with = signs", () => {
    const result = parseEnvFile("URL=https://example.com?a=1&b=2");
    expect(result).toEqual({ URL: "https://example.com?a=1&b=2" });
  });

  test("handles Windows CRLF line endings", () => {
    const result = parseEnvFile("FOO=bar\r\nBAZ=qux\r\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("skips lines without =", () => {
    const result = parseEnvFile("FOO=bar\nINVALID_LINE\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("handles empty value", () => {
    const result = parseEnvFile("FOO=");
    expect(result).toEqual({ FOO: "" });
  });

  test("returns empty object for empty input", () => {
    expect(parseEnvFile("")).toEqual({});
    expect(parseEnvFile("\n\n")).toEqual({});
  });
});

// ── FileVaultManager ──────────────────────────────────────────────────────────

describe("FileVaultManager", () => {
  let tmpDir: string;
  let vaultsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-vault-test-${Date.now()}`);
    vaultsDir = join(tmpDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  function writeVaultJson(config: VaultConfig) {
    writeFileSync(join(vaultsDir, "vault.json"), JSON.stringify(config));
  }

  function writeVaultEnv(vaultKey: string, content: string) {
    const dir = join(vaultsDir, vaultKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "env"), content);
  }

  // ── isEnabled ─────────────────────────────────────────────────────────────

  test("isEnabled returns false when vault.json does not exist", () => {
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.isEnabled()).toBe(false);
  });

  test("isEnabled returns true when vault.json exists", () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.isEnabled()).toBe(true);
  });

  test("isEnabled returns false for malformed vault.json", () => {
    writeFileSync(join(vaultsDir, "vault.json"), "not json");
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.isEnabled()).toBe(false);
  });

  // ── resolve ───────────────────────────────────────────────────────────────

  test("resolve returns undefined when disabled", () => {
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.resolve("U123")).toBeUndefined();
  });

  test("resolve finds user by direct match", () => {
    writeVaultJson({
      vaults: { U123: { displayName: "Alice", mounts: [".ssh"] } },
    });
    writeVaultEnv("U123", "GITHUB_TOKEN=ghp_abc");

    const mgr = new FileVaultManager(tmpDir);
    const vault = mgr.resolve("U123");

    expect(vault).toBeDefined();
    expect(vault!.userId).toBe("U123");
    expect(vault!.displayName).toBe("Alice");
    expect(vault!.mounts).toEqual([join(vaultsDir, "U123", ".ssh")]);
    expect(vault!.env).toEqual({ GITHUB_TOKEN: "ghp_abc" });
  });

  test("resolve falls back to fallback vault", () => {
    writeVaultJson({
      vaults: { _shared: { displayName: "Shared" } },
      fallback: "_shared",
    });

    const mgr = new FileVaultManager(tmpDir);
    const vault = mgr.resolve("UNKNOWN_USER");

    expect(vault).toBeDefined();
    expect(vault!.userId).toBe("UNKNOWN_USER");
    expect(vault!.displayName).toBe("Shared");
  });

  test("resolve returns undefined when no match and no fallback", () => {
    writeVaultJson({
      vaults: { U123: { displayName: "Alice" } },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.resolve("UNKNOWN")).toBeUndefined();
  });

  test("resolve skips env parsing when envFile is false", () => {
    writeVaultJson({
      vaults: { U123: { displayName: "Alice", envFile: false } },
    });
    writeVaultEnv("U123", "SECRET=should_not_load");

    const mgr = new FileVaultManager(tmpDir);
    const vault = mgr.resolve("U123");
    expect(vault!.env).toEqual({});
  });

  // ── getSandboxConfig ──────────────────────────────────────────────────────

  test("getSandboxConfig returns base config when user has no vault", () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const base = { type: "host" as const };
    expect(mgr.getSandboxConfig("UNKNOWN", base)).toEqual(base);
  });

  test("getSandboxConfig applies docker override", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "docker", container: "alice-box" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    const result = mgr.getSandboxConfig("U123", { type: "host" });
    expect(result).toEqual({ type: "docker", container: "alice-box" });
  });

  test("getSandboxConfig defaults docker container name from userId", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "docker" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    const result = mgr.getSandboxConfig("U123", { type: "host" });
    expect(result).toEqual({ type: "docker", container: "mama-sandbox-U123" });
  });

  // ── isStrict ──────────────────────────────────────────────────────────────

  test("isStrict returns false by default", () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.isStrict()).toBe(false);
  });

  test("isStrict returns true when configured", () => {
    writeVaultJson({ vaults: {}, strict: true });
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.isStrict()).toBe(true);
  });

  // ── resolveSystemActor ────────────────────────────────────────────────────

  test("resolveSystemActor returns undefined when not configured", () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.resolveSystemActor()).toBeUndefined();
  });

  test("resolveSystemActor resolves configured system vault", () => {
    writeVaultJson({
      vaults: { _system: { displayName: "System" } },
      systemActor: "_system",
    });

    const mgr = new FileVaultManager(tmpDir);
    const vault = mgr.resolveSystemActor();
    expect(vault).toBeDefined();
    expect(vault!.displayName).toBe("System");
    expect(vault!.userId).toBe("__system__");
  });

  test("resolveSystemActor with custom key does not interfere with resolve()", () => {
    // Bug regression: getSandboxConfig("__system__") would re-resolve and miss the actual key
    writeVaultJson({
      vaults: {
        _ops: { displayName: "Ops", sandbox: { type: "docker", container: "ops-box" } },
      },
      systemActor: "_ops",
    });

    const mgr = new FileVaultManager(tmpDir);
    const vault = mgr.resolveSystemActor();
    expect(vault).toBeDefined();
    expect(vault!.sandboxOverride).toEqual({ type: "docker", container: "ops-box" });

    // resolve("__system__") should NOT find _ops (it's only reachable via resolveSystemActor)
    expect(mgr.resolve("__system__")).toBeUndefined();
  });

  test("resolveSystemActor returns undefined when key references missing vault", () => {
    writeVaultJson({
      vaults: {},
      systemActor: "_nonexistent",
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.resolveSystemActor()).toBeUndefined();
  });

  // ── list ──────────────────────────────────────────────────────────────────

  test("list returns all vaults", () => {
    writeVaultJson({
      vaults: {
        U1: { displayName: "Alice" },
        U2: { displayName: "Bob" },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    const vaults = mgr.list();
    expect(vaults).toHaveLength(2);
    expect(vaults.map((v) => v.displayName).sort()).toEqual(["Alice", "Bob"]);
  });

  test("list returns empty array when disabled", () => {
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.list()).toEqual([]);
  });

  // ── reload ────────────────────────────────────────────────────────────────

  test("reload picks up changes to vault.json", () => {
    writeVaultJson({ vaults: { U1: { displayName: "Alice" } } });
    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.resolve("U1")!.displayName).toBe("Alice");

    writeVaultJson({ vaults: { U1: { displayName: "Alice Updated" } } });
    mgr.reload();
    expect(mgr.resolve("U1")!.displayName).toBe("Alice Updated");
  });
});

// ── ActorExecutionResolver ────────────────────────────────────────────────────

describe("ActorExecutionResolver", () => {
  let tmpDir: string;
  let vaultsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-executor-test-${Date.now()}`);
    vaultsDir = join(tmpDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  function writeVaultJson(config: VaultConfig) {
    writeFileSync(join(vaultsDir, "vault.json"), JSON.stringify(config));
  }

  test("strict mode throws when user has no vault", async () => {
    writeVaultJson({ vaults: {}, strict: true });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "host" }, mgr);

    await expect(resolver.resolve({ platform: "slack", userId: "UNKNOWN_USER" })).rejects.toThrow(
      /No vault configured/,
    );
  });

  test("non-strict mode falls back to base config for unknown user", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "host" }, mgr);

    const executor = await resolver.resolve({ platform: "slack", userId: "UNKNOWN_USER" });
    expect(executor.getWorkspacePath("/workspace")).toBe("/workspace");
  });

  test("system actor uses fallback executor", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "host" }, mgr);

    const executor = await resolver.resolve({ platform: "slack", userId: undefined });
    expect(executor.getWorkspacePath("/workspace")).toBe("/workspace");
  });

  test("refresh picks up vault changes for later resolves", async () => {
    writeVaultJson({ vaults: { U1: { displayName: "Alice" } } });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "host" }, mgr);
    let executor = await resolver.resolve({ platform: "slack", userId: "U1" });
    expect(executor.getWorkspacePath("/workspace")).toBe("/workspace");

    writeVaultJson({
      vaults: {
        U1: {
          displayName: "Alice",
          sandbox: { type: "docker", container: "alice-box" },
        },
      },
    });
    resolver.refresh();
    executor = await resolver.resolve({ platform: "slack", userId: "U1" });
    expect(executor.getWorkspacePath("/any/path")).toBe("/workspace");
  });

  test("system actor refresh picks up new system sandbox", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "host" }, mgr);

    writeVaultJson({
      vaults: {
        _sys: {
          displayName: "System",
          sandbox: { type: "docker", container: "sys-box" },
        },
      },
      systemActor: "_sys",
    });
    resolver.refresh();
    const executor = await resolver.resolve({ platform: "slack", userId: undefined });
    expect(executor.getWorkspacePath("/any/path")).toBe("/workspace");
  });

  test("docker-auto mode never falls back to host for unlinked users", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "docker-auto", image: "ubuntu:24.04" },
      mgr,
    );
    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(executor.getWorkspacePath("/any/path")).toBe("/workspace");
    expect(mgr.resolve(DockerProvisioner.vaultId("slack", "U123"))).toBeDefined();
  });

  test("docker-auto mode uses platform-namespaced vault ids", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "docker-auto", image: "ubuntu:24.04" },
      mgr,
    );

    await resolver.resolve({ platform: "slack", userId: "U123" });
    await resolver.resolve({ platform: "discord", userId: "U123" });

    expect(mgr.resolve(DockerProvisioner.vaultId("slack", "U123"))?.displayName).toBe("slack:U123");
    expect(mgr.resolve(DockerProvisioner.vaultId("discord", "U123"))?.displayName).toBe(
      "discord:U123",
    );
  });
});
