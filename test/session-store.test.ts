import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  createNewSessionFile,
  forkThreadSessionFile,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
  resolveChannelSessionFile,
  resolveManagedSessionFile,
  resolveSessionFile,
  tryResolveCurrentSession,
  tryResolveThreadSession,
} from "../src/session-store.js";

let channelDir: string;
let nextTimestamp = 1;

beforeEach(() => {
  nextTimestamp = 1;
  channelDir = join(
    tmpdir(),
    `session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(channelDir, { recursive: true });
});

afterEach(() => {
  rmSync(channelDir, { recursive: true, force: true });
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

function countSessionHeaders(sessionFile: string): number {
  return readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string })
    .filter((entry) => entry.type === "session").length;
}

function seedManagedSession(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
  text: string,
): string {
  createManagedSessionFileAtPath(sessionFile, cwd);
  const sessionManager = openManagedSession(sessionFile, sessionDir, cwd);
  sessionManager.appendMessage(makeUserMessage(text));
  sessionManager.appendMessage(makeAssistantMessage(`${text} reply`));
  return sessionFile;
}

describe("getChannelSessionDir", () => {
  test("channel session key uses shared sessions directory", () => {
    expect(getChannelSessionDir(channelDir)).toBe(join(channelDir, "sessions"));
  });

  test("thread session key also uses shared sessions directory", () => {
    expect(getChannelSessionDir(channelDir)).toBe(join(channelDir, "sessions"));
  });
});

describe("getThreadSessionFile", () => {
  test("maps thread session key to a fixed jsonl file", () => {
    expect(getThreadSessionFile(channelDir, "C123:1000.0001")).toBe(
      join(channelDir, "sessions", "1000.0001.jsonl"),
    );
  });
});

describe("resolveSessionFile", () => {
  test("creates new placeholder session file when none exists", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const file = resolveSessionFile(sessionDir);
    expect(existsSync(file)).toBe(true);
    expect(file).toContain(join(channelDir, "sessions"));
  });

  test("returns existing current session file on second call", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const file1 = resolveSessionFile(sessionDir);
    writeFileSync(file1, '{"type":"session","id":"test"}\n');
    const file2 = resolveSessionFile(sessionDir);
    expect(file2).toBe(file1);
  });
});

describe("tryResolveThreadSession", () => {
  test("returns null when no thread session file exists", () => {
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("ignores empty placeholder files without a valid header", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(threadFile, "", "utf-8");
    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("returns fixed thread file path when a valid session exists", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    const created = seedManagedSession(threadFile, sessionDir, channelDir, "thread msg");
    expect(tryResolveThreadSession(threadFile)).toBe(created);
    expect(readFileSync(created, "utf-8")).toContain("thread msg");
  });
});

describe("resolveChannelSessionFile", () => {
  test("returns null when no channel session exists", () => {
    expect(resolveChannelSessionFile(channelDir)).toBeNull();
  });

  test("returns current channel session file when it exists", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const created = createManagedSessionFile(sessionDir, channelDir);
    expect(resolveChannelSessionFile(channelDir)).toBe(created);
  });
});

describe("managed session initialization", () => {
  test("channel session filename uses a short UUID suffix", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const sessionFile = createManagedSessionFile(sessionDir, channelDir);
    const filename = sessionFile.split("/").pop()!;
    const suffix = filename.replace(".jsonl", "").split("_").pop()!;

    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  test("creates a channel session with the provided cwd", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const sessionFile = resolveManagedSessionFile(sessionDir, channelDir);
    const sessionManager = openManagedSession(sessionFile, sessionDir, channelDir);

    sessionManager.appendMessage(makeUserMessage("hello"));
    sessionManager.appendMessage(makeAssistantMessage("hi"));

    const entries = readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; cwd?: string });
    const header = entries.find((entry) => entry.type === "session");

    expect(header?.cwd).toBe(channelDir);
    expect(countSessionHeaders(sessionFile)).toBeGreaterThan(0);
  });

  test("creates a fixed-path thread session with the provided cwd", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const sessionManager = openManagedSession(threadFile, sessionDir, channelDir);

    sessionManager.appendMessage(makeUserMessage("hello thread"));

    const entries = readFileSync(threadFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; cwd?: string });
    const header = entries.find((entry) => entry.type === "session");

    expect(header?.cwd).toBe(channelDir);
    expect(countSessionHeaders(threadFile)).toBe(1);
  });
});

describe("thread fork", () => {
  test("forked thread session has a different session ID than channel session", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = resolveManagedSessionFile(sessionDir, channelDir);
    const channelSM = openManagedSession(channelFile, sessionDir, channelDir);
    channelSM.appendMessage(makeUserMessage("hello channel"));
    channelSM.appendMessage(makeAssistantMessage("hi there"));
    const channelSessionId = channelSM.getSessionId();

    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    const forkedThreadFile = forkThreadSessionFile(channelFile, threadFile, channelDir);
    const threadSM = openManagedSession(forkedThreadFile, sessionDir, channelDir);

    expect(threadSM.getSessionId()).not.toBe(channelSessionId);
    expect(forkedThreadFile).toBe(threadFile);
    expect(readFileSync(forkedThreadFile, "utf-8")).toContain("hello channel");
  });

  test("second thread access reuses the same fixed thread file", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = resolveManagedSessionFile(sessionDir, channelDir);
    const channelSM = openManagedSession(channelFile, sessionDir, channelDir);
    channelSM.appendMessage(makeUserMessage("channel msg"));
    channelSM.appendMessage(makeAssistantMessage("reply"));

    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    const forkedThreadFile = forkThreadSessionFile(channelFile, threadFile, channelDir);
    const threadSM = openManagedSession(forkedThreadFile, sessionDir, channelDir);
    const threadSessionId = threadSM.getSessionId();

    threadSM.appendMessage(makeUserMessage("thread msg"));

    const existing = tryResolveThreadSession(threadFile);
    expect(existing).toBe(threadFile);

    const reopened = openManagedSession(existing!, sessionDir, channelDir);
    expect(reopened.getSessionId()).toBe(threadSessionId);
    expect(readFileSync(existing!, "utf-8")).toContain("thread msg");
  });

  test("different threads get independent session IDs", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = resolveManagedSessionFile(sessionDir, channelDir);
    const channelSM = openManagedSession(channelFile, sessionDir, channelDir);
    channelSM.appendMessage(makeUserMessage("shared"));
    channelSM.appendMessage(makeAssistantMessage("reply"));

    const thread1File = getThreadSessionFile(channelDir, "C123:1000.0001");
    const thread2File = getThreadSessionFile(channelDir, "C123:1000.0002");

    const thread1SM = openManagedSession(
      forkThreadSessionFile(channelFile, thread1File, channelDir),
      sessionDir,
      channelDir,
    );
    const thread2SM = openManagedSession(
      forkThreadSessionFile(channelFile, thread2File, channelDir),
      sessionDir,
      channelDir,
    );

    const ids = new Set([
      channelSM.getSessionId(),
      thread1SM.getSessionId(),
      thread2SM.getSessionId(),
    ]);
    expect(ids.size).toBe(3);
  });

  test("fresh thread file can be created without a channel source", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const threadSM = openManagedSession(threadFile, sessionDir, channelDir);
    const entries = threadSM.getEntries().filter((e: { type: string }) => e.type === "message");
    expect(entries.length).toBe(0);
  });
});

describe("session-scoped /new reset", () => {
  test("channel /new rotates channel current pointer and keeps thread session intact", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = createManagedSessionFile(sessionDir, channelDir);
    const originalChannel = openManagedSession(channelFile, sessionDir, channelDir);
    originalChannel.appendMessage(makeUserMessage("channel"));
    originalChannel.appendMessage(makeAssistantMessage("channel reply"));

    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    seedManagedSession(threadFile, sessionDir, channelDir, "thread");

    const newChannelFile = createManagedSessionFile(sessionDir, channelDir);

    expect(newChannelFile).not.toBe(channelFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(newChannelFile);
    expect(tryResolveThreadSession(threadFile)).toBe(threadFile);
    expect(readFileSync(threadFile, "utf-8")).toContain("thread");
  });

  test("thread /new resets the same fixed file and keeps channel plus sibling thread intact", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = createManagedSessionFile(sessionDir, channelDir);
    const channelSM = openManagedSession(channelFile, sessionDir, channelDir);
    channelSM.appendMessage(makeUserMessage("channel"));
    channelSM.appendMessage(makeAssistantMessage("channel reply"));

    const thread1File = getThreadSessionFile(channelDir, "C123:1000.0001");
    const thread2File = getThreadSessionFile(channelDir, "C123:1000.0002");
    seedManagedSession(thread1File, sessionDir, channelDir, "thread1");
    seedManagedSession(thread2File, sessionDir, channelDir, "thread2");

    createManagedSessionFileAtPath(thread1File, channelDir);

    expect(tryResolveThreadSession(thread1File)).toBe(thread1File);
    expect(readFileSync(thread1File, "utf-8")).not.toContain("thread1");
    expect(readFileSync(thread2File, "utf-8")).toContain("thread2");
    expect(readFileSync(resolveManagedSessionFile(sessionDir, channelDir), "utf-8")).toContain(
      "channel",
    );
    expect(countSessionHeaders(thread1File)).toBe(1);
  });
});

describe("persistence across restart", () => {
  test("thread session survives simulated restart via fixed file path", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    seedManagedSession(threadFile, sessionDir, channelDir, "thread specific");

    expect(tryResolveThreadSession(threadFile)).toBe(threadFile);
    expect(readFileSync(threadFile, "utf-8")).toContain("thread specific");
  });
});

describe("placeholder sessions", () => {
  test("createNewSessionFile still updates current pointer for channel placeholder files", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const placeholder = createNewSessionFile(sessionDir);
    expect(tryResolveCurrentSession(sessionDir)).toBeNull();
    expect(existsSync(placeholder)).toBe(true);
  });
});
