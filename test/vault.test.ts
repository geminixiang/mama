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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
});
