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
import { ActorExecutionResolver } from "../src/execution-resolver.js";
import { DockerContainerManager } from "../src/provisioner.js";
import { HostExecutor } from "../src/sandbox.js";
import { resolveActorVaultKey } from "../src/vault-routing.js";
import { FileVaultManager, parseEnvFile, sharedVaultKey, type VaultConfig } from "../src/vault.js";

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

  test("is enabled when vaults dir exists even without vault.json", () => {
    expect(new FileVaultManager(tmpDir).isEnabled()).toBe(true);

    writeFileSync(join(vaultsDir, "vault.json"), "not json");
    expect(new FileVaultManager(tmpDir).isEnabled()).toBe(true);
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

  test("resolves a vault from directory contents without vault.json metadata", () => {
    const conversationDir = join(vaultsDir, "d123");
    mkdirSync(join(conversationDir, ".ssh"), { recursive: true });
    writeFileSync(join(conversationDir, "env"), "OPENAI_API_KEY=sk-test\n");

    const vault = new FileVaultManager(tmpDir).resolve("d123");

    expect(vault).toMatchObject({
      userId: "d123",
      displayName: "d123",
      env: { OPENAI_API_KEY: "sk-test" },
      mounts: [{ source: join(conversationDir, ".ssh"), target: "/root/.ssh" }],
    });
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

  test("sharedVaultKey validates shared login profile names", () => {
    expect(sharedVaultKey("gliaclaw")).toBe("shared/gliaclaw");
    expect(sharedVaultKey("team.prod-1")).toBe("shared/team.prod-1");
    expect(sharedVaultKey("../secret")).toBeUndefined();
    expect(sharedVaultKey("bad/name")).toBeUndefined();
  });

  test("copySharedVaultTo merge-copies shared vault into target with shared values winning", () => {
    const sharedDir = join(vaultsDir, "shared", "gliaclaw");
    const targetDir = join(vaultsDir, "c123");
    mkdirSync(join(sharedDir, ".config", "gh"), { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(sharedDir, "env"), "A=profile-a\nB=profile-b\n");
    writeFileSync(join(targetDir, "env"), "A=conversation-a\nD=conversation-d\n");
    writeFileSync(join(sharedDir, ".config", "gh", "hosts.yml"), "github.com:\n  token: shared\n");

    const result = new FileVaultManager(tmpDir).copySharedVaultTo("gliaclaw", "c123");

    expect(result).toEqual({ envKeysCopied: 2, filesCopied: 1 });
    expect(parseEnvFile(readFileSync(join(targetDir, "env"), "utf-8"))).toEqual({
      A: "profile-a",
      B: "profile-b",
      D: "conversation-d",
    });
    expect(readFileSync(join(targetDir, ".config", "gh", "hosts.yml"), "utf-8")).toContain(
      "shared",
    );
  });

  test("lists and deletes shared vaults", () => {
    mkdirSync(join(vaultsDir, "shared", "gliaclaw"), { recursive: true });
    mkdirSync(join(vaultsDir, "shared", "another"), { recursive: true });
    mkdirSync(join(vaultsDir, "shared", ".hidden"), { recursive: true });
    const mgr = new FileVaultManager(tmpDir);

    expect(mgr.listSharedVaults()).toEqual(["another", "gliaclaw"]);
    expect(mgr.deleteSharedVault("gliaclaw")).toBe(true);
    expect(existsSync(join(vaultsDir, "shared", "gliaclaw"))).toBe(false);
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

  test("ignores managed image metadata when switching to cloudflare mode", () => {
    writeVaultJson({
      vaults: {
        d123: {
          displayName: "slack:D123",
          sandbox: { type: "image" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.getSandboxConfig("d123", { type: "cloudflare", sandboxId: "mama-remote" })).toEqual({
      type: "cloudflare",
      sandboxId: "mama-remote-d123",
    });
  });

  test("derives per-vault cloudflare sandbox ids", () => {
    writeVaultJson({
      vaults: {
        alice: {
          displayName: "Alice",
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.getSandboxConfig("alice", { type: "cloudflare", sandboxId: "mama-remote" })).toEqual(
      {
        type: "cloudflare",
        sandboxId: "mama-remote-alice",
      },
    );
  });

  test("applies cloudflare sandbox override in cloudflare mode", () => {
    writeVaultJson({
      vaults: {
        alice: {
          displayName: "Alice",
          sandbox: { type: "cloudflare", sandboxId: "custom-alice" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    expect(mgr.getSandboxConfig("alice", { type: "cloudflare", sandboxId: "mama-remote" })).toEqual(
      {
        type: "cloudflare",
        sandboxId: "custom-alice",
      },
    );
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

  test("uses platform-namespaced vault ids for new users", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      undefined,
      tmpDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "D123",
    });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-d123",
    });
    expect(mgr.resolve(DockerContainerManager.sanitizeSegment("D123"))).toBeUndefined();
  });

  test("uses conversation-scoped vault keys even when user-scoped entries exist", async () => {
    writeVaultJson({
      vaults: {
        U123: {
          displayName: "Alice",
          sandbox: { type: "image" },
        },
      },
    });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      undefined,
      tmpDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "D123",
    });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-d123",
    });
    expect(mgr.hasEntry("U123")).toBe(true);
    expect(mgr.hasEntry(DockerContainerManager.sanitizeSegment("D123"))).toBe(false);
  });

  test("ignores bindings for image-mode vault routing", async () => {
    writeVaultJson({
      vaults: {
        alice: {
          displayName: "Alice",
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });

    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      undefined,
      tmpDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "D123",
    });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-d123",
    });
    expect(mgr.hasEntry("alice")).toBe(true);
    expect(mgr.hasEntry(DockerContainerManager.sanitizeSegment("D123"))).toBe(false);
  });

  test("login and execution use the same generated vault key in image mode", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const baseConfig = { type: "image", image: "ubuntu:24.04" } as const;
    const vaultKey = resolveActorVaultKey(baseConfig, "U123", "D123");

    const resolver = new ActorExecutionResolver(baseConfig, mgr, undefined, tmpDir);
    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "D123",
    });

    expect(vaultKey).toBe("d123");
    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mama-sandbox-d123",
    });
  });

  test("uses platform-namespaced vault ids for new users in cloudflare mode", async () => {
    writeVaultJson({ vaults: {} });
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "cloudflare", sandboxId: "mama-remote" },
      mgr,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "D123",
    });

    expect(executor.getSandboxConfig()).toEqual({
      type: "cloudflare",
      sandboxId: "mama-remote-d123",
    });
    expect(mgr.resolve(DockerContainerManager.sanitizeSegment("D123"))).toBeUndefined();
  });

  test("provisions custom containers with vault mounts", async () => {
    writeVaultJson({
      vaults: {
        d123: {
          displayName: "Alice",
          mounts: [".ssh"],
          sandbox: { type: "image", container: "alice-box" },
        },
      },
    });
    mkdirSync(join(vaultsDir, "d123", ".ssh"), { recursive: true });

    const mgr = new FileVaultManager(tmpDir);
    const provision = vi.fn().mockResolvedValue("alice-box");
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      { provision } as any,
      tmpDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "D123",
    });
    await executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith("d123", {
      containerName: "alice-box",
      conversationId: "D123",
      mounts: [
        { source: join(tmpDir, "MEMORY.md"), target: "/workspace/MEMORY.md" },
        { source: join(tmpDir, "skills"), target: "/workspace/skills" },
        { source: join(tmpDir, "events"), target: "/workspace/events" },
        { source: join(tmpDir, "D123"), target: "/workspace/D123" },
        { source: join(vaultsDir, "d123", ".ssh"), target: "/root/.ssh" },
      ],
    });
    expect(exec).toHaveBeenCalledWith("docker exec -w /workspace alice-box sh -c 'pwd'", undefined);
  });

  test("deduplicates mount targets and ignores missing files", async () => {
    writeVaultJson({
      vaults: {
        d123: {
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
    mkdirSync(join(vaultsDir, "d123"), { recursive: true });
    writeFileSync(join(vaultsDir, "d123", "gws.json"), '{ "type": "authorized_user" }\n');

    const mgr = new FileVaultManager(tmpDir);
    const provision = vi.fn().mockResolvedValue("alice-box");
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      { provision } as any,
      tmpDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "D123",
    });
    await executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith("d123", {
      containerName: "alice-box",
      conversationId: "D123",
      mounts: [
        { source: join(tmpDir, "MEMORY.md"), target: "/workspace/MEMORY.md" },
        { source: join(tmpDir, "skills"), target: "/workspace/skills" },
        { source: join(tmpDir, "events"), target: "/workspace/events" },
        { source: join(tmpDir, "D123"), target: "/workspace/D123" },
        {
          source: join(vaultsDir, "d123", "gws.json"),
          target: "/root/.config/gws/credentials.json",
        },
      ],
    });
    expect(exec).toHaveBeenCalledWith("docker exec -w /workspace alice-box sh -c 'pwd'", undefined);
  });
});
