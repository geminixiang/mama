import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileUserBindingStore } from "../src/bindings.js";

describe("FileUserBindingStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-bindings-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("upsert creates vaults directory and bindings.json when missing", () => {
    const store = new FileUserBindingStore(tmpDir);

    store.upsert({
      platform: "telegram",
      platformUserId: "123456",
      internalUserId: "alice",
      vaultId: "alice",
      status: "active",
      createdAt: "2026-04-09T00:00:00Z",
      updatedAt: "2026-04-09T00:00:00Z",
    });

    const configPath = join(tmpDir, "vaults", "bindings.json");
    expect(existsSync(configPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      bindings: Array<{ platformUserId: string; vaultId: string }>;
    };
    expect(parsed.bindings).toHaveLength(1);
    expect(parsed.bindings[0]).toMatchObject({
      platformUserId: "123456",
      vaultId: "alice",
    });
  });

  test("resolve only returns active bindings", () => {
    const store = new FileUserBindingStore(tmpDir);
    store.upsert({
      platform: "slack",
      platformUserId: "U123",
      internalUserId: "alice",
      vaultId: "alice",
      status: "active",
      createdAt: "2026-04-09T00:00:00Z",
      updatedAt: "2026-04-09T00:00:00Z",
    });

    expect(store.resolve("slack", "U123")?.vaultId).toBe("alice");
    store.revoke("slack", "U123");
    expect(store.resolve("slack", "U123")).toBeUndefined();
  });
});
