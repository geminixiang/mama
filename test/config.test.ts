import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ensureSettingsFile,
  loadAgentConfig,
  resolveSentryDsn,
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
    delete process.env.MOM_AI_PROVIDER;
    delete process.env.MOM_AI_MODEL;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("returns empty config when no settings.json exists", () => {
    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.thinkingLevel).toBeUndefined();
    expect(config.sessionScope).toBeUndefined();
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

  test("silently ignores malformed settings.json and returns empty config", () => {
    writeFileSync(join(tmpDir, "settings.json"), "{ invalid json }", "utf-8");
    const config = loadAgentConfig(tmpDir);
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  test("lets provider and model environment variables override settings.json", () => {
    saveAgentConfig(tmpDir, { provider: "anthropic", model: "claude-sonnet-4-6" });
    process.env.MOM_AI_PROVIDER = "openai";
    process.env.MOM_AI_MODEL = "gpt-5.4";

    const config = loadAgentConfig(tmpDir);

    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5.4");
  });

  test("applies provider and model environment variables to first-run template config", () => {
    process.env.MOM_AI_PROVIDER = "openai";
    process.env.MOM_AI_MODEL = "gpt-5.4";

    const result = ensureSettingsFile(tmpDir);

    expect(result.created).toBe(true);
    expect(result.config.provider).toBe("openai");
    expect(result.config.model).toBe("gpt-5.4");
  });
});

describe("resolveWorkspaceDirFromArgv", () => {
  test("returns the positional workspace dir", () => {
    expect(resolveWorkspaceDirFromArgv(["--sandbox=host", "/tmp/mama"])).toBe("/tmp/mama");
  });

  test("skips flag values before resolving workspace dir", () => {
    expect(resolveWorkspaceDirFromArgv(["--sandbox", "host", "/tmp/mama"])).toBe("/tmp/mama");
  });

  test("ignores download mode channel ids", () => {
    expect(resolveWorkspaceDirFromArgv(["--download", "C123"])).toBeUndefined();
  });
});

describe("resolveSentryDsn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-test-sentry-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("reads sentryDsn from settings.json", () => {
    saveAgentConfig(tmpDir, { sentryDsn: "https://settings.example/1" });
    expect(resolveSentryDsn(tmpDir)).toBe("https://settings.example/1");
  });

  test("returns undefined when settings.json has no sentryDsn", () => {
    expect(resolveSentryDsn(tmpDir)).toBeUndefined();
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
    expect(config.provider).toBe("openai"); // preserved
    expect(config.model).toBe("gpt-4o-mini"); // updated
    expect(config.sessionScope).toBe("channel"); // preserved
  });

  test("creates parent directories if they don't exist", () => {
    const nested = join(tmpDir, "a", "b", "c");
    saveAgentConfig(nested, { provider: "anthropic" });
    expect(existsSync(join(nested, "settings.json"))).toBe(true);
  });
});
