import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
} from "../src/session-store.js";
import { parseSessionViewCommand } from "../src/session-view/command.js";
import { loadSessionViewModel, resolveExistingSessionFile } from "../src/session-view/service.js";

let workspaceDir: string;
let conversationDir: string;
let nextTimestamp = 1;

beforeEach(() => {
  nextTimestamp = 1;
  workspaceDir = join(
    tmpdir(),
    `session-view-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  conversationDir = join(workspaceDir, "D123");
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: nextTimestamp++,
  };
}

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: nextTimestamp++,
  };
}

describe("parseSessionViewCommand", () => {
  test("recognizes supported commands", () => {
    expect(parseSessionViewCommand("session")).toEqual({ command: "session" });
    expect(parseSessionViewCommand("/session")).toEqual({ command: "/session" });
    expect(parseSessionViewCommand("/pi-session now")).toEqual({ command: "/pi-session" });
  });

  test("ignores unrelated text", () => {
    expect(parseSessionViewCommand("hello there")).toBeNull();
  });
});

describe("resolveExistingSessionFile", () => {
  test("resolves the current channel session", () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);

    expect(resolveExistingSessionFile(workspaceDir, "D123", "D123")).toBe(sessionFile);
  });

  test("resolves a fixed-path thread session when the conversation directory matches", () => {
    const sharedConversationDir = join(workspaceDir, "C123");
    mkdirSync(sharedConversationDir, { recursive: true });
    const sessionFile = getThreadSessionFile(sharedConversationDir, "C123:1000.0001");
    createManagedSessionFileAtPath(sessionFile, sharedConversationDir);

    expect(resolveExistingSessionFile(workspaceDir, "C123", "C123:1000.0001")).toBe(sessionFile);
  });
});

describe("loadSessionViewModel", () => {
  test("maps session entries into a readable timeline", () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);
    const sessionManager = openManagedSession(sessionFile, sessionDir, conversationDir);

    sessionManager.appendMessage(makeUserMessage("請幫我看一下測試結果"));
    sessionManager.appendMessage(makeAssistantMessage("好的，我正在查看。"));
    sessionManager.appendMessage({
      role: "bashExecution",
      command: "npm test",
      output: "1 passed",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: nextTimestamp++,
    } as any);

    const model = loadSessionViewModel(sessionFile);

    expect(model.title).toContain("Session");
    expect(model.items.map((item) => item.title)).toEqual(["User", "Assistant", "Bash execution"]);
    expect(model.items[0].body).toContain("請幫我看一下測試結果");
    expect(model.items[1].body).toContain("好的，我正在查看");
    expect(model.items[2].body).toContain("npm test");
    expect(model.items[2].body).toContain("1 passed");
  });
});
