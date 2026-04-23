import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { FileVaultManager } from "./vault.js";

describe("FileVaultManager", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createStateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mama-vault-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("reuses the base firecracker workspace hostPath for user overrides", () => {
    const stateDir = createStateDir();
    const vaultsDir = join(stateDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(vaultsDir, "vault.json"),
      JSON.stringify(
        {
          vaults: {
            alice: {
              displayName: "Alice",
              sandbox: { type: "firecracker", vmId: "alice-vm", sshUser: "root", sshPort: 2222 },
            },
          },
        },
        null,
        2,
      ) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );

    const manager = new FileVaultManager(stateDir);
    expect(
      manager.getSandboxConfig("alice", {
        type: "firecracker",
        vmId: "shared-vm",
        hostPath: "/real/workspace",
        sshUser: "root",
        sshPort: 22,
      }),
    ).toEqual({
      type: "firecracker",
      vmId: "alice-vm",
      hostPath: "/real/workspace",
      sshUser: "root",
      sshPort: 2222,
    });
  });

  it("rejects firecracker overrides when the base sandbox is not firecracker", () => {
    const stateDir = createStateDir();
    const vaultsDir = join(stateDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(vaultsDir, "vault.json"),
      JSON.stringify(
        {
          vaults: {
            alice: {
              displayName: "Alice",
              sandbox: { type: "firecracker", vmId: "alice-vm" },
            },
          },
        },
        null,
        2,
      ) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );

    const manager = new FileVaultManager(stateDir);
    expect(() =>
      manager.getSandboxConfig("alice", { type: "image", image: "alpine:3.20" }),
    ).toThrow(/base sandbox is "image"/);
  });

  it("throws on invalid secret file paths instead of silently succeeding", () => {
    const stateDir = createStateDir();
    const manager = new FileVaultManager(stateDir);
    manager.addEntry("alice", { displayName: "Alice" });

    expect(() => manager.upsertFile("alice", "../credentials.txt", "secret")).toThrow(
      /invalid relative secret file path/,
    );
  });
});
