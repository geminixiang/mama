import { describe, expect, test } from "vitest";
import type { ChatMessage, PlatformInfo } from "../src/adapter.js";
import { buildCurrentRequestContext, buildRunEnvironment } from "../src/agent.js";
import type { SandboxConfig } from "../src/sandbox.js";

function makePlatform(name: PlatformInfo["name"]): PlatformInfo {
  return {
    name,
    formattingGuide: "",
    channels: [],
    users: [],
  };
}

function makeMessage(): ChatMessage {
  return {
    id: "1000.0002",
    sessionKey: "C001:1000.0001",
    userId: "U001",
    userName: "alice",
    text: "list my instances",
    threadTs: "1000.0001",
  };
}

describe("buildRunEnvironment", () => {
  test("builds Slack token env for host sandbox", () => {
    const env = buildRunEnvironment(
      makePlatform("slack"),
      makeMessage(),
      { type: "host" } satisfies SandboxConfig,
      8080,
    );

    expect(env).toMatchObject({
      MAMA_PLATFORM: "slack",
      MAMA_USER_ID: "U001",
      MAMA_CHANNEL_ID: "C001",
      MAMA_THREAD_TS: "1000.0001",
      MAMA_SLACK_USER_ID: "U001",
      MAMA_GOOGLE_TOKEN_BASE_URL: "http://127.0.0.1:8080/api/token",
      MAMA_GOOGLE_ACCESS_TOKEN_URL: "http://127.0.0.1:8080/api/token/U001",
    });
  });

  test("uses host.docker.internal for Docker sandbox token endpoint", () => {
    const env = buildRunEnvironment(
      makePlatform("slack"),
      makeMessage(),
      { type: "docker", container: "mama-sandbox" } satisfies SandboxConfig,
      8080,
    );

    expect(env.MAMA_GOOGLE_TOKEN_BASE_URL).toBe("http://host.docker.internal:8080/api/token");
    expect(env.MAMA_GOOGLE_ACCESS_TOKEN_URL).toBe(
      "http://host.docker.internal:8080/api/token/U001",
    );
  });

  test("does not expose Slack-only token vars on non-Slack platforms", () => {
    const env = buildRunEnvironment(
      makePlatform("telegram"),
      makeMessage(),
      { type: "host" } satisfies SandboxConfig,
      8080,
    );

    expect(env.MAMA_PLATFORM).toBe("telegram");
    expect(env.MAMA_USER_ID).toBe("U001");
    expect(env.MAMA_SLACK_USER_ID).toBeUndefined();
    expect(env.MAMA_GOOGLE_ACCESS_TOKEN_URL).toBeUndefined();
  });
});

describe("buildCurrentRequestContext", () => {
  test("documents Slack auth isolation and execution env", () => {
    const env = buildRunEnvironment(
      makePlatform("slack"),
      makeMessage(),
      { type: "host" } satisfies SandboxConfig,
      8080,
    );

    const context = buildCurrentRequestContext(makePlatform("slack"), makeMessage(), env);

    expect(context).toContain("Use only the requesting Slack user's permissions");
    expect(context).toContain("MAMA_SLACK_USER_ID=U001");
    expect(context).toContain("MAMA_GOOGLE_ACCESS_TOKEN_URL=http://127.0.0.1:8080/api/token/U001");
  });
});
