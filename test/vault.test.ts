import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileUserBindingStore } from "../src/bindings.js";
import { ActorExecutionResolver } from "../src/execution-resolver.js";
import { DockerProvisioner } from "../src/provisioner.js";
import { HostExecutor } from "../src/sandbox.js";
import {
  containerSharedVaultId,
  ensureImageSandboxVault,
  ensureSandboxVaultEntry,
  resolveActorVaultKey,
} from "../src/vault-routing.js";
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
    vi.restoreAllMocks();
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
    expect(vault!.mounts).toEqual([
      { source: join(vaultsDir, "U123", ".ssh"), target: "/root/.ssh" },
    ]);
    expect(vault!.env).toEqual({ GITHUB_TOKEN: "ghp_abc" });
  });

  test("resolve returns undefined when user has no vault entry", () => {
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

  test("upsertEnv creates and merges vault env entries", () => {
    writeVaultJson({
      vaults: { U123: { displayName: "Alice" } },
    });

    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertEnv("U123", { OPENAI_API_KEY: "sk-old" });
    mgr.upsertEnv("U123", { GITHUB_TOKEN: "ghp_123", OPENAI_API_KEY: "sk-new" });

    expect(mgr.resolve("U123")?.env).toEqual({
      GITHUB_TOKEN: "ghp_123",
      OPENAI_API_KEY: "sk-new",
    });
    expect(readFileSync(join(vaultsDir, "U123", "env"), "utf-8")).toBe(
      "GITHUB_TOKEN=ghp_123\nOPENAI_API_KEY=sk-new\n",
    );
  });

  test("upsertEnv writes private directory and env file permissions", () => {
    writeVaultJson({
      vaults: { U123: { displayName: "Alice" } },
    });

    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertEnv("U123", { OPENAI_API_KEY: "sk-test" });

    const vaultRootMode = statSync(vaultsDir).mode & 0o777;
    const userVaultDirMode = statSync(join(vaultsDir, "U123")).mode & 0o777;
    const envMode = statSync(join(vaultsDir, "U123", "env")).mode & 0o777;

    // On POSIX, ensure no group/other permissions are granted.
    expect(vaultRootMode & 0o077).toBe(0);
    expect(userVaultDirMode & 0o077).toBe(0);
    expect(envMode & 0o077).toBe(0);
  });

  test("upsertFile writes private credential files and adds mounts", () => {
    writeVaultJson({
      vaults: { U123: { displayName: "Alice" } },
    });

    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile(
      "U123",
      "gws.json",
      '{\n  "type": "authorized_user"\n}\n',
      "/root/.config/gws/credentials.json",
    );

    const credentialPath = join(vaultsDir, "U123", "gws.json");
    const credentialMode = statSync(credentialPath).mode & 0o777;

    expect(readFileSync(credentialPath, "utf-8")).toBe('{\n  "type": "authorized_user"\n}\n');
    expect(credentialMode & 0o077).toBe(0);
    expect(mgr.resolve("U123")?.mounts).toEqual([
      { source: credentialPath, target: "/root/.config/gws/credentials.json" },
    ]);
    expect(JSON.parse(readFileSync(join(vaultsDir, "vault.json"), "utf-8"))).toEqual({
      vaults: {
        U123: {
          displayName: "Alice",
          mounts: [
            {
              source: "gws.json",
              target: "/root/.config/gws/credentials.json",
            },
          ],
        },
      },
    });
  });

  test("upsertFile preserves env values written separately for file-based credentials", () => {
    writeVaultJson({
      vaults: { U123: { displayName: "Alice" } },
    });

    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile(
      "U123",
      ".vault-secrets/gws/credentials.json",
      "{}\n",
      "/root/.config/gws/credentials.json",
    );
    mgr.upsertEnv("U123", {
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "/root/.config/gws/credentials.json",
    });

    expect(mgr.resolve("U123")?.env).toEqual({
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "/root/.config/gws/credentials.json",
    });
    expect(mgr.resolve("U123")?.mounts).toEqual([
      {
        source: join(vaultsDir, "U123", ".vault-secrets", "gws", "credentials.json"),
        target: "/root/.config/gws/credentials.json",
      },
    ]);
  });

  test("addEntry writes vault.json with private permissions", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.addEntry("U123", { displayName: "Alice" });

    const vaultRootMode = statSync(vaultsDir).mode & 0o777;
    const configMode = statSync(join(vaultsDir, "vault.json")).mode & 0o777;

    expect(vaultRootMode & 0o077).toBe(0);
    expect(configMode & 0o077).toBe(0);
  });

  // ── getSandboxConfig ──────────────────────────────────────────────────────

  test("getSandboxConfig returns base config when user has no vault", () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const base = { type: "host" as const };
    expect(mgr.getSandboxConfig("UNKNOWN", base)).toEqual(base);
  });

  test("getSandboxConfig applies image override in image mode", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    const result = mgr.getSandboxConfig("U123", { type: "image", image: "ubuntu:24.04" });
    expect(result).toEqual({ type: "container", container: "alice-box" });
  });

  test("getSandboxConfig defaults image container name from userId", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "image" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    const result = mgr.getSandboxConfig("U123", { type: "image", image: "ubuntu:24.04" });
    expect(result).toEqual({ type: "container", container: "mama-sandbox-U123" });
  });

  test("getSandboxConfig blocks host override for vault isolation", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "host" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(() => mgr.getSandboxConfig("U123", { type: "image", image: "ubuntu:24.04" })).toThrow(
      /blocked for credential isolation/,
    );
  });

  test("getSandboxConfig blocks container override for vault isolation", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "container", container: "shared-box" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(() => mgr.getSandboxConfig("U123", { type: "image", image: "ubuntu:24.04" })).toThrow(
      /blocked for credential isolation/,
    );
  });

  test("getSandboxConfig blocks image override when base sandbox is not image", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(() => mgr.getSandboxConfig("U123", { type: "host" })).toThrow(/base sandbox is "host"/);
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

  test("unknown user on host sandbox runs base config (no vault required)", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "host" }, mgr);

    const executor = await resolver.resolve({ platform: "slack", userId: "UNKNOWN_USER" });
    expect(executor.getWorkspacePath("/workspace")).toBe("/workspace");
  });

  test("container mode routes all users to one shared vault", async () => {
    writeVaultJson({
      vaults: {
        U123: { displayName: "Alice" },
        alice: { displayName: "Bound Alice" },
      },
    });
    writeFileSync(
      join(vaultsDir, "bindings.json"),
      JSON.stringify({
        bindings: [
          {
            platform: "slack",
            platformUserId: "U123",
            internalUserId: "alice",
            vaultId: "alice",
            status: "active",
            createdAt: "2026-04-22T00:00:00.000Z",
            updatedAt: "2026-04-22T00:00:00.000Z",
          },
        ],
      }),
    );

    const mgr = new FileVaultManager(tmpDir);
    const bindings = new FileUserBindingStore(tmpDir);
    const baseConfig = { type: "container", container: "shared-box" } as const;
    const vaultKey = resolveActorVaultKey(baseConfig, mgr, bindings, "slack", "U123");

    expect(vaultKey).toBe(containerSharedVaultId("shared-box"));

    ensureSandboxVaultEntry(baseConfig, mgr, "slack", "U123", vaultKey);
    expect(mgr.resolve(vaultKey)?.displayName).toBe("container:shared-box");

    const resolver = new ActorExecutionResolver(baseConfig, mgr, bindings);
    const executor = await resolver.resolve({ platform: "discord", userId: "DIFFERENT_USER" });

    expect(executor.getSandboxConfig()).toEqual({ type: "container", container: "shared-box" });
    expect(mgr.hasEntry(vaultKey)).toBe(true);
    expect(mgr.hasEntry("alice")).toBe(true);
    expect(mgr.hasEntry("U123")).toBe(true);
  });

  test("refresh picks up vault changes for later resolves", async () => {
    writeVaultJson({ vaults: { U1: { displayName: "Alice" } } });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "firecracker", vmId: "vm-base", hostPath: "/host/workspace" },
      mgr,
    );
    let executor = await resolver.resolve({ platform: "slack", userId: "U1" });
    expect(executor.getWorkspacePath("/workspace")).toBe("/workspace");

    writeVaultJson({
      vaults: {
        U1: {
          displayName: "Alice",
          sandbox: { type: "firecracker", vmId: "vm-alice" },
        },
      },
    });
    resolver.refresh();
    executor = await resolver.resolve({ platform: "slack", userId: "U1" });
    expect(executor.getWorkspacePath("/any/path")).toBe("/workspace");
  });

  test("image mode never falls back to host for unlinked users", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "image", image: "ubuntu:24.04" }, mgr);
    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(executor.getWorkspacePath("/any/path")).toBe("/workspace");
    expect(mgr.resolve(DockerProvisioner.vaultId("slack", "U123"))).toBeDefined();
  });

  test("image mode uses platform-namespaced vault ids", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "image", image: "ubuntu:24.04" }, mgr);

    await resolver.resolve({ platform: "slack", userId: "U123" });
    await resolver.resolve({ platform: "discord", userId: "U123" });

    expect(mgr.resolve(DockerProvisioner.vaultId("slack", "U123"))?.displayName).toBe("slack:U123");
    expect(mgr.resolve(DockerProvisioner.vaultId("discord", "U123"))?.displayName).toBe(
      "discord:U123",
    );
  });

  test("image mode respects direct vault keys before creating generated ids", async () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "image" },
        },
      },
    });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "image", image: "ubuntu:24.04" }, mgr);

    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-U123",
    });
    expect(mgr.hasEntry("U123")).toBe(true);
    expect(mgr.hasEntry(DockerProvisioner.vaultId("slack", "U123"))).toBe(false);
  });

  test("image mode upgrades existing direct vault entries without sandbox metadata", async () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          mounts: [".ssh"],
        },
      },
    });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "image", image: "ubuntu:24.04" }, mgr);

    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-U123",
    });
    expect(mgr.resolve("U123")?.sandboxOverride).toEqual({
      type: "image",
      container: "mama-sandbox-U123",
    });
  });

  test("login and execution use the same direct vault key in image mode", async () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
        },
      },
    });
    const mgr = new FileVaultManager(tmpDir);
    const baseConfig = { type: "image", image: "ubuntu:24.04" } as const;
    const loginVaultId = resolveActorVaultKey(baseConfig, mgr, undefined, "slack", "U123");
    ensureImageSandboxVault(baseConfig, mgr, "slack", "U123", loginVaultId);

    const resolver = new ActorExecutionResolver(baseConfig, mgr);
    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(loginVaultId).toBe("U123");
    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-U123",
    });
  });

  test("image mode respects explicit bindings before creating generated ids", async () => {
    writeVaultJson({
      vaults: {
        alice: {
          displayName: "Alice",
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });
    writeFileSync(
      join(vaultsDir, "bindings.json"),
      JSON.stringify({
        bindings: [
          {
            platform: "slack",
            platformUserId: "U123",
            internalUserId: "alice",
            vaultId: "alice",
            status: "active",
            createdAt: "2026-04-22T00:00:00.000Z",
            updatedAt: "2026-04-22T00:00:00.000Z",
          },
        ],
      }),
    );
    const mgr = new FileVaultManager(tmpDir);
    const bindings = new FileUserBindingStore(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      bindings,
    );

    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(executor.getSandboxConfig()).toEqual({ type: "container", container: "alice-box" });
    expect(mgr.hasEntry("alice")).toBe(true);
    expect(mgr.hasEntry(DockerProvisioner.vaultId("slack", "U123"))).toBe(false);
  });

  test("image mode upgrades bound vault entries without sandbox metadata", async () => {
    writeVaultJson({
      vaults: {
        alice: {
          displayName: "Alice",
          mounts: [".ssh"],
        },
      },
    });
    writeFileSync(
      join(vaultsDir, "bindings.json"),
      JSON.stringify({
        bindings: [
          {
            platform: "slack",
            platformUserId: "U123",
            internalUserId: "alice",
            vaultId: "alice",
            status: "active",
            createdAt: "2026-04-22T00:00:00.000Z",
            updatedAt: "2026-04-22T00:00:00.000Z",
          },
        ],
      }),
    );
    const mgr = new FileVaultManager(tmpDir);
    const bindings = new FileUserBindingStore(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      bindings,
    );

    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-alice",
    });
    expect(mgr.resolve("alice")?.sandboxOverride).toEqual({
      type: "image",
      container: "mama-sandbox-alice",
    });
  });

  test("login and execution use the same bound vault key in image mode", async () => {
    writeVaultJson({
      vaults: {
        alice: {
          displayName: "Alice",
        },
      },
    });
    writeFileSync(
      join(vaultsDir, "bindings.json"),
      JSON.stringify({
        bindings: [
          {
            platform: "slack",
            platformUserId: "U123",
            internalUserId: "alice",
            vaultId: "alice",
            status: "active",
            createdAt: "2026-04-22T00:00:00.000Z",
            updatedAt: "2026-04-22T00:00:00.000Z",
          },
        ],
      }),
    );
    const mgr = new FileVaultManager(tmpDir);
    const bindings = new FileUserBindingStore(tmpDir);
    const baseConfig = { type: "image", image: "ubuntu:24.04" } as const;
    const loginVaultId = resolveActorVaultKey(baseConfig, mgr, bindings, "slack", "U123");
    ensureImageSandboxVault(baseConfig, mgr, "slack", "U123", loginVaultId);

    const resolver = new ActorExecutionResolver(baseConfig, mgr, bindings);
    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(loginVaultId).toBe("alice");
    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-alice",
    });
  });

  test("image mode provisions custom containers with vault mounts", async () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          mounts: [".ssh"],
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });
    mkdirSync(join(vaultsDir, "U123", ".ssh"), { recursive: true });
    const mgr = new FileVaultManager(tmpDir);
    const provision = vi.fn().mockResolvedValue("alice-box");
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      undefined,
      { provision } as any,
    );

    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });
    await executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith("U123", {
      containerName: "alice-box",
      mounts: [{ source: join(vaultsDir, "U123", ".ssh"), target: "/root/.ssh" }],
    });
    expect(exec).toHaveBeenCalledWith("docker exec -w /workspace alice-box sh -c 'pwd'", undefined);
  });

  test("image mode mounts vault files to their matching root paths", async () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          mounts: [
            {
              source: ".vault-secrets/gws/credentials.json",
              target: "/root/.config/gws/credentials.json",
            },
          ],
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });
    mkdirSync(join(vaultsDir, "U123", ".vault-secrets", "gws"), { recursive: true });
    writeFileSync(
      join(vaultsDir, "U123", ".vault-secrets", "gws", "credentials.json"),
      '{ "type": "authorized_user" }\n',
    );

    const mgr = new FileVaultManager(tmpDir);
    const provision = vi.fn().mockResolvedValue("alice-box");
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      undefined,
      { provision } as any,
    );

    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });
    await executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith("U123", {
      containerName: "alice-box",
      mounts: [
        {
          source: join(vaultsDir, "U123", ".vault-secrets", "gws", "credentials.json"),
          target: "/root/.config/gws/credentials.json",
        },
      ],
    });
    expect(exec).toHaveBeenCalledWith("docker exec -w /workspace alice-box sh -c 'pwd'", undefined);
  });

  test("image mode deduplicates mount targets and ignores missing legacy files", async () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          mounts: [
            ".config/gws/credentials.json",
            {
              source: ".vault-secrets/gws/credentials.json",
              target: "/root/.config/gws/credentials.json",
            },
            {
              source: "gws.json",
              target: "/root/.config/gws/credentials.json",
            },
          ],
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });
    mkdirSync(join(vaultsDir, "U123"), { recursive: true });
    writeFileSync(join(vaultsDir, "U123", "gws.json"), '{ "type": "authorized_user" }\n');

    const mgr = new FileVaultManager(tmpDir);
    const provision = vi.fn().mockResolvedValue("alice-box");
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      undefined,
      { provision } as any,
    );

    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });
    await executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith("U123", {
      containerName: "alice-box",
      mounts: [
        {
          source: join(vaultsDir, "U123", "gws.json"),
          target: "/root/.config/gws/credentials.json",
        },
      ],
    });
    expect(exec).toHaveBeenCalledWith("docker exec -w /workspace alice-box sh -c 'pwd'", undefined);
  });
});
