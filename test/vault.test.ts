import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileUserBindingStore } from "../src/bindings.js";
import { ActorExecutionResolver } from "../src/execution-resolver.js";
import { DockerContainerManager } from "../src/provisioner.js";
import { HostExecutor } from "../src/sandbox.js";
import { ensureSandboxVaultEntry, resolveActorVaultKey } from "../src/vault-routing.js";
import { FileVaultManager, parseEnvFile, type VaultConfig } from "../src/vault.js";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("parseEnvFile", () => {
  test("parses key value lines and ignores comments", () => {
    expect(parseEnvFile("# comment\nFOO=bar\nEMPTY=\nURL=https://e.test?a=1&b=2\n")).toEqual({
      EMPTY: "",
      FOO: "bar",
      URL: "https://e.test?a=1&b=2",
    });
  });

  test("strips matching single and double quotes", () => {
    expect(parseEnvFile("A=\"hello world\"\nB='ok'")).toEqual({ A: "hello world", B: "ok" });
  });
});

describe("FileVaultManager", () => {
  let tmpDir: string;
  let vaultsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-vault-test-${Date.now()}-${Math.random()}`);
    vaultsDir = join(tmpDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  function writeVaultJson(config: VaultConfig): void {
    writeFileSync(join(vaultsDir, "vault.json"), JSON.stringify(config));
  }

  function writeVaultEnv(vaultKey: string, content: string): void {
    const dir = join(vaultsDir, vaultKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "env"), content);
  }

  test("is disabled when vault.json is missing or malformed", () => {
    expect(new FileVaultManager(tmpDir).isEnabled()).toBe(false);

    writeFileSync(join(vaultsDir, "vault.json"), "not json");
    expect(new FileVaultManager(tmpDir).isEnabled()).toBe(false);
  });

  test("resolves a direct user vault with mounts and env", () => {
    writeVaultJson({ vaults: { U123: { displayName: "Alice", mounts: [".ssh"] } } });
    writeVaultEnv("U123", "GITHUB_TOKEN=ghp_abc\n");

    const vault = new FileVaultManager(tmpDir).resolve("U123");

    expect(vault).toMatchObject({
      userId: "U123",
      displayName: "Alice",
      env: { GITHUB_TOKEN: "ghp_abc" },
      mounts: [{ source: join(vaultsDir, "U123", ".ssh"), target: "/root/.ssh" }],
    });
  });

  test("returns undefined for users without an entry", () => {
    writeVaultJson({ vaults: { U123: { displayName: "Alice" } } });
    expect(new FileVaultManager(tmpDir).resolve("UNKNOWN")).toBeUndefined();
  });

  test("upsertEnv creates private files and merges values", () => {
    writeVaultJson({ vaults: { U123: { displayName: "Alice" } } });

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
    expect(mode(vaultsDir) & 0o077).toBe(0);
    expect(mode(join(vaultsDir, "U123")) & 0o077).toBe(0);
    expect(mode(join(vaultsDir, "U123", "env")) & 0o077).toBe(0);
  });

  test("upsertEnv tightens permissions on an existing env file", () => {
    writeVaultJson({ vaults: { U123: { displayName: "Alice" } } });
    const userDir = join(vaultsDir, "U123");
    mkdirSync(userDir, { recursive: true });
    const envPath = join(userDir, "env");
    writeFileSync(envPath, "OLD=value\n");
    chmodSync(envPath, 0o644);

    new FileVaultManager(tmpDir).upsertEnv("U123", { OPENAI_API_KEY: "sk-test" });

    expect(mode(envPath) & 0o077).toBe(0);
  });

  test("upsertFile writes private credential files and persists mount metadata", () => {
    writeVaultJson({ vaults: { U123: { displayName: "Alice" } } });

    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile(
      "U123",
      "gws.json",
      '{\n  "type": "authorized_user"\n}\n',
      "/root/.config/gws/credentials.json",
    );

    const credentialPath = join(vaultsDir, "U123", "gws.json");
    expect(readFileSync(credentialPath, "utf-8")).toBe('{\n  "type": "authorized_user"\n}\n');
    expect(mode(credentialPath) & 0o077).toBe(0);
    expect(mgr.resolve("U123")?.mounts).toEqual([
      { source: credentialPath, target: "/root/.config/gws/credentials.json" },
    ]);
  });

  test("applies firecracker sandbox overrides without changing hostPath", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "firecracker", vmId: "vm-user", sshPort: 2222 },
        },
      },
    });

    expect(
      new FileVaultManager(tmpDir).getSandboxConfig("U123", {
        type: "firecracker",
        vmId: "base-vm",
        hostPath: "/host/workspace",
      }),
    ).toEqual({
      type: "firecracker",
      vmId: "vm-user",
      hostPath: "/host/workspace",
      sshUser: undefined,
      sshPort: 2222,
    });
  });

  test("applies image override in image mode", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.getSandboxConfig("U123", { type: "image", image: "ubuntu:24.04" })).toEqual({
      type: "container",
      container: "alice-box",
    });
  });

  test("defaults image container name from userId", () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "image" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.getSandboxConfig("U123", { type: "image", image: "ubuntu:24.04" })).toEqual({
      type: "container",
      container: "mama-sandbox-U123",
    });
  });

  test("blocks image override when base sandbox is not image", () => {
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
});

describe("ActorExecutionResolver image mode", () => {
  let tmpDir: string;
  let vaultsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-image-vault-test-${Date.now()}-${Math.random()}`);
    vaultsDir = join(tmpDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeVaultJson(config: VaultConfig): void {
    writeFileSync(join(vaultsDir, "vault.json"), JSON.stringify(config));
  }

  function writeBindings(bindings: unknown): void {
    writeFileSync(join(vaultsDir, "bindings.json"), JSON.stringify(bindings));
  }

  test("uses platform-namespaced vault ids for new users", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver({ type: "image", image: "ubuntu:24.04" }, mgr);

    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-slack-u123",
    });
    expect(mgr.resolve(DockerContainerManager.vaultId("slack", "U123"))?.displayName).toBe(
      "slack:U123",
    );
  });

  test("respects direct vault keys before creating generated ids", async () => {
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
    expect(mgr.hasEntry(DockerContainerManager.vaultId("slack", "U123"))).toBe(false);
  });

  test("respects explicit bindings before creating generated ids", async () => {
    writeVaultJson({
      vaults: {
        alice: {
          displayName: "Alice",
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });
    writeBindings({
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
    });

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
    expect(mgr.hasEntry(DockerContainerManager.vaultId("slack", "U123"))).toBe(false);
  });

  test("login and execution use the same generated vault key in image mode", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const baseConfig = { type: "image", image: "ubuntu:24.04" } as const;
    const vaultKey = resolveActorVaultKey(baseConfig, mgr, undefined, "slack", "U123");

    ensureSandboxVaultEntry(baseConfig, mgr, "slack", "U123", vaultKey);

    const resolver = new ActorExecutionResolver(baseConfig, mgr);
    const executor = await resolver.resolve({ platform: "slack", userId: "U123" });

    expect(vaultKey).toBe("slack-u123");
    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-slack-u123",
    });
  });

  test("provisions custom containers with vault mounts", async () => {
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

  test("deduplicates mount targets and ignores missing files", async () => {
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
