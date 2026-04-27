import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadAgentConfig,
  resolveSentryDsn,
  resolveStateDirFromArgv,
  resolveWorkspaceDirFromArgv,
  saveAgentConfig,
} from "../src/config.js";

describe("loadAgentConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    delete process.env.MOM_AI_PROVIDER;
    delete process.env.MOM_AI_MODEL;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("returns defaults when no settings.json and no env vars", () => {
    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-5");
    expect(config.thinkingLevel).toBe("off");
    expect(config.sessionScope).toBe("thread");
  });

  test("reads provider and model from settings.json", () => {
    saveAgentConfig(tmpDir, { provider: "openai", model: "gpt-4o" });
    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("reads sessionScope from settings.json", () => {
    saveAgentConfig(tmpDir, { sessionScope: "channel" });
    const config = loadAgentConfig(tmpDir);
    expect(config.sessionScope).toBe("channel");
  });

  test("reads sentryDsn from settings.json", () => {
    saveAgentConfig(tmpDir, { sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0" });
    const config = loadAgentConfig(tmpDir);
    expect(config.sentryDsn).toBe("https://examplePublicKey@o0.ingest.sentry.io/0");
  });

  test("reads sandboxCpus and sandboxMemory from settings.json", () => {
    saveAgentConfig(tmpDir, { sandboxCpus: "0.5", sandboxMemory: "512m" });
    const config = loadAgentConfig(tmpDir);
    expect(config.sandboxCpus).toBe("0.5");
    expect(config.sandboxMemory).toBe("512m");
  });

  test("sandboxCpus and sandboxMemory are undefined when not set", () => {
    const config = loadAgentConfig(tmpDir);
    expect(config.sandboxCpus).toBeUndefined();
    expect(config.sandboxMemory).toBeUndefined();
  });

  test("env vars override defaults but not settings.json", () => {
    process.env.MOM_AI_PROVIDER = "google";
    process.env.MOM_AI_MODEL = "gemini-2.0-flash";

    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-2.0-flash");
  });

  test("settings.json values override env vars", () => {
    saveAgentConfig(tmpDir, { provider: "openai", model: "gpt-4o" });
    process.env.MOM_AI_PROVIDER = "google";
    process.env.MOM_AI_MODEL = "gemini-2.0-flash";

    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("prefers state-dir settings.json over workspace settings.json", () => {
    const stateDir = join(tmpdir(), `mama-state-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    saveAgentConfig(tmpDir, { provider: "openai", model: "gpt-4o" });
    saveAgentConfig(stateDir, { provider: "google", model: "gemini-2.0-flash" });
    process.env.MAMA_STATE_DIR = stateDir;

    try {
      const config = loadAgentConfig(tmpDir);
      expect(config.provider).toBe("google");
      expect(config.model).toBe("gemini-2.0-flash");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("silently ignores malformed settings.json and falls back to defaults", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tmpDir, "settings.json"), "{ invalid json }", "utf-8");
    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-5");
  });
});

describe("argv config resolution", () => {
  test("returns the positional workspace dir", () => {
    expect(resolveWorkspaceDirFromArgv(["--sandbox=host", "/tmp/mama"])).toBe("/tmp/mama");
  });

  test("skips flag values before resolving workspace dir", () => {
    expect(resolveWorkspaceDirFromArgv(["--sandbox", "host", "/tmp/mama"])).toBe("/tmp/mama");
  });

  test("ignores download mode channel ids", () => {
    expect(resolveWorkspaceDirFromArgv(["--download", "C123"])).toBeUndefined();
  });

  test("resolves explicit state-dir from argv", () => {
    expect(resolveStateDirFromArgv(["--state-dir", "/tmp/state", "/tmp/mama"])).toBe("/tmp/state");
    expect(resolveStateDirFromArgv(["--state-dir=/tmp/state", "/tmp/mama"])).toBe("/tmp/state");
  });
});

describe("resolveSentryDsn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-test-sentry-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    delete process.env.SENTRY_DSN;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("prefers settings.json over env", () => {
    saveAgentConfig(tmpDir, { sentryDsn: "https://settings.example/1" });
    process.env.SENTRY_DSN = "https://env.example/1";
    expect(resolveSentryDsn(tmpDir)).toBe("https://settings.example/1");
  });

  test("falls back to env when settings.json has no sentryDsn", () => {
    process.env.SENTRY_DSN = "https://env.example/2";
    expect(resolveSentryDsn(tmpDir)).toBe("https://env.example/2");
  });

  test("prefers state-dir sentryDsn over workspace settings", () => {
    const stateDir = join(tmpdir(), `mama-state-sentry-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    saveAgentConfig(tmpDir, { sentryDsn: "https://workspace.example/1" });
    saveAgentConfig(stateDir, { sentryDsn: "https://state.example/1" });
    process.env.MAMA_STATE_DIR = stateDir;

    try {
      expect(resolveSentryDsn(tmpDir)).toBe("https://state.example/1");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("saveAgentConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("creates settings.json with given config", () => {
    saveAgentConfig(tmpDir, { provider: "google", model: "gemini-2.0-flash" });
    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-2.0-flash");
  });

  test("merges with existing settings — preserves unrelated fields", () => {
    saveAgentConfig(tmpDir, { provider: "openai", model: "gpt-4o", sessionScope: "channel" });
    saveAgentConfig(tmpDir, { model: "gpt-4o-mini" });
    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.sessionScope).toBe("channel");
  });

  test("creates parent directories if they don't exist", () => {
    const nested = join(tmpDir, "a", "b", "c");
    saveAgentConfig(nested, { provider: "anthropic" });
    expect(existsSync(join(nested, "settings.json"))).toBe(true);
  });
});
