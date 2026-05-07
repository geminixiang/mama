import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadAgentConfig,
  loadAgentConfigForConversation,
  resolveSentryDsn,
  resolveStateDirFromArgv,
  resolveWorkspaceDirFromArgv,
  saveAgentConfig,
  saveConversationModelConfig,
} from "../src/config.js";

describe("loadAgentConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mama-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MAMA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    delete process.env.MAMA_AI_PROVIDER;
    delete process.env.MAMA_AI_MODEL;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("returns defaults when no settings.json and no env vars", () => {
    const config = loadAgentConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-5");
    expect(config.thinkingLevel).toBe("off");
    expect(config.sessionScope).toBe("thread");
  });

  test("reads provider and model from settings.json", () => {
    saveAgentConfig({ provider: "openai", model: "gpt-4o" });
    const config = loadAgentConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("reads sessionScope from settings.json", () => {
    saveAgentConfig({ sessionScope: "channel" });
    const config = loadAgentConfig();
    expect(config.sessionScope).toBe("channel");
  });

  test("reads sentryDsn from settings.json", () => {
    saveAgentConfig({ sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0" });
    const config = loadAgentConfig();
    expect(config.sentryDsn).toBe("https://examplePublicKey@o0.ingest.sentry.io/0");
  });

  test("reads sandboxCpus and sandboxMemory from settings.json", () => {
    saveAgentConfig({ sandboxCpus: "0.5", sandboxMemory: "512m" });
    const config = loadAgentConfig();
    expect(config.sandboxCpus).toBe("0.5");
    expect(config.sandboxMemory).toBe("512m");
  });

  test("sandboxCpus and sandboxMemory are undefined when not set", () => {
    const config = loadAgentConfig();
    expect(config.sandboxCpus).toBeUndefined();
    expect(config.sandboxMemory).toBeUndefined();
  });

  test("env vars override defaults but not settings.json", () => {
    process.env.MAMA_AI_PROVIDER = "google";
    process.env.MAMA_AI_MODEL = "gemini-2.0-flash";

    const config = loadAgentConfig();
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-2.0-flash");
  });

  test("settings.json values override env vars", () => {
    saveAgentConfig({ provider: "openai", model: "gpt-4o" });
    process.env.MAMA_AI_PROVIDER = "google";
    process.env.MAMA_AI_MODEL = "gemini-2.0-flash";

    const config = loadAgentConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("ignores settings.json in non-state directories", () => {
    const otherDir = join(tmpdir(), `mama-other-${Date.now()}`);
    mkdirSync(otherDir, { recursive: true });
    try {
      writeFileSync(
        join(otherDir, "settings.json"),
        JSON.stringify({ provider: "openai", model: "gpt-4o" }),
        "utf-8",
      );
      const config = loadAgentConfig();
      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-sonnet-4-5");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("throws on malformed settings.json instead of silently falling back", () => {
    writeFileSync(join(stateDir, "settings.json"), "{ invalid json }", "utf-8");
    expect(() => loadAgentConfig()).toThrow(/Malformed settings file/);
  });

  test("throws on settings.json whose top-level value is not an object", () => {
    writeFileSync(join(stateDir, "settings.json"), "[]", "utf-8");
    expect(() => loadAgentConfig()).toThrow(/expected a JSON object/);
  });

  test("conversation model config overrides global provider and model only", () => {
    saveAgentConfig({ provider: "anthropic", model: "claude-sonnet-4-5", sessionScope: "channel" });
    const conversationDir = join(stateDir, "workspace", "C123");
    saveConversationModelConfig(conversationDir, { provider: "openai", model: "gpt-4o" });

    const config = loadAgentConfigForConversation(conversationDir);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.sessionScope).toBe("channel");
    expect(JSON.parse(readFileSync(join(conversationDir, "settings.json"), "utf-8"))).toEqual({
      llm: { provider: "openai", model: "gpt-4o" },
    });
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
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mama-test-sentry-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MAMA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    delete process.env.SENTRY_DSN;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("prefers settings.json over env", () => {
    saveAgentConfig({ sentryDsn: "https://settings.example/1" });
    process.env.SENTRY_DSN = "https://env.example/1";
    expect(resolveSentryDsn()).toBe("https://settings.example/1");
  });

  test("falls back to env when settings.json has no sentryDsn", () => {
    process.env.SENTRY_DSN = "https://env.example/2";
    expect(resolveSentryDsn()).toBe("https://env.example/2");
  });
});

describe("saveAgentConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mama-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MAMA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("creates settings.json with given config", () => {
    saveAgentConfig({ provider: "google", model: "gemini-2.0-flash" });
    const config = loadAgentConfig();
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-2.0-flash");
  });

  test("merges with existing settings — preserves unrelated fields", () => {
    saveAgentConfig({ provider: "openai", model: "gpt-4o", sessionScope: "channel" });
    saveAgentConfig({ model: "gpt-4o-mini" });
    const config = loadAgentConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.sessionScope).toBe("channel");
  });

  test("creates parent directories if they don't exist", () => {
    const nested = join(stateDir, "a", "b", "c");
    process.env.MAMA_STATE_DIR = nested;
    saveAgentConfig({ provider: "anthropic" });
    expect(existsSync(join(nested, "settings.json"))).toBe(true);
  });
});
