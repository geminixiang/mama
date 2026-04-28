import { SessionManager } from "@mariozechner/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncLogToSessionManager } from "../src/context.js";

const testDir = "/tmp/mama-context-sync-test";

function writeLog(entries: object[]): void {
  for (const entry of entries) {
    appendFileSync(join(testDir, "log.jsonl"), JSON.stringify(entry) + "\n");
  }
}

function getMessageTexts(sessionManager: SessionManager): string[] {
  return sessionManager
    .buildSessionContext()
    .messages.flatMap((message) =>
      message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text),
    );
}

describe("syncLogToSessionManager", () => {
  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("top-level scope syncs all top-level messages for persistent sessions", async () => {
    writeLog([
      {
        date: "2026-04-01T10:00:00.000Z",
        ts: "1000.0010",
        user: "U001",
        userName: "alice",
        text: "first top-level message",
        isBot: false,
      },
      {
        date: "2026-04-01T10:01:00.000Z",
        ts: "1000.0020",
        threadTs: "1000.0010",
        user: "U002",
        userName: "bob",
        text: "reply inside another thread",
        isBot: false,
      },
      {
        date: "2026-04-01T10:02:00.000Z",
        ts: "1000.0030",
        user: "U003",
        userName: "charlie",
        text: "second top-level message",
        isBot: false,
      },
      {
        date: "2026-04-01T10:03:00.000Z",
        ts: "1000.0040",
        user: "bot",
        userName: "mama",
        text: "bot response",
        isBot: true,
      },
    ]);

    const sessionManager = SessionManager.inMemory(testDir);
    const synced = await syncLogToSessionManager(
      sessionManager,
      testDir,
      undefined,
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { scope: "top-level", rootTs: "C001" },
    );

    expect(synced).toBe(2);
    expect(getMessageTexts(sessionManager)).toEqual([
      "[alice]: first top-level message",
      "[charlie]: second top-level message",
    ]);
  });

  test("does not duplicate messages when sync runs again after new activity", async () => {
    writeLog([
      {
        date: "2026-04-01T10:00:00.000Z",
        ts: "1000.0010",
        user: "U001",
        userName: "alice",
        text: "first top-level message",
        isBot: false,
      },
      {
        date: "2026-04-01T10:02:00.000Z",
        ts: "1000.0030",
        user: "U003",
        userName: "charlie",
        text: "second top-level message",
        isBot: false,
      },
    ]);

    const sessionManager = SessionManager.inMemory(testDir);
    const firstSynced = await syncLogToSessionManager(
      sessionManager,
      testDir,
      undefined,
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { scope: "top-level", rootTs: "C001" },
    );

    expect(firstSynced).toBe(2);
    expect(getMessageTexts(sessionManager)).toEqual([
      "[alice]: first top-level message",
      "[charlie]: second top-level message",
    ]);

    writeLog([
      {
        date: "2026-04-01T10:05:00.000Z",
        ts: "1000.0050",
        user: "U004",
        userName: "dora",
        text: "third top-level message",
        isBot: false,
      },
    ]);

    const secondSynced = await syncLogToSessionManager(
      sessionManager,
      testDir,
      undefined,
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { scope: "top-level", rootTs: "C001" },
    );

    expect(secondSynced).toBe(1);
    expect(getMessageTexts(sessionManager)).toEqual([
      "[alice]: first top-level message",
      "[charlie]: second top-level message",
      "[dora]: third top-level message",
    ]);
  });

  test("does not look ahead to newer queued messages", async () => {
    writeLog([
      {
        date: "2026-04-01T10:00:00.000Z",
        ts: "1000.0010",
        user: "U001",
        userName: "alice",
        text: "first",
        isBot: false,
      },
      {
        date: "2026-04-01T10:00:05.000Z",
        ts: "1000.0020",
        user: "U001",
        userName: "alice",
        text: "second",
        isBot: false,
      },
      {
        date: "2026-04-01T10:00:10.000Z",
        ts: "1000.0030",
        user: "U001",
        userName: "alice",
        text: "third",
        isBot: false,
      },
    ]);

    const sessionManager = SessionManager.inMemory(testDir);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[2026-04-01 18:00:00+08:00] [alice]: first" }],
      timestamp: new Date("2026-04-01T10:00:00.500Z").getTime(),
    });

    const synced = await syncLogToSessionManager(
      sessionManager,
      testDir,
      "1000.0020",
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { scope: "top-level", rootTs: "C001" },
    );

    expect(synced).toBe(0);
    expect(getMessageTexts(sessionManager)).toEqual(["[2026-04-01 18:00:00+08:00] [alice]: first"]);
  });

  test("does not re-import a live prompt that was already added to the session", async () => {
    writeLog([
      {
        date: "2026-04-01T10:00:00.000Z",
        ts: "1000.0010",
        user: "U001",
        userName: "alice",
        text: "hello from slack",
        isBot: false,
      },
    ]);

    const sessionManager = SessionManager.inMemory(testDir);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[2026-04-01 18:01:10+08:00] [alice]: hello from slack" }],
      timestamp: new Date("2026-04-01T10:01:10.000Z").getTime(),
    });

    const synced = await syncLogToSessionManager(
      sessionManager,
      testDir,
      undefined,
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { scope: "top-level", rootTs: "C001" },
    );

    expect(synced).toBe(0);
    expect(getMessageTexts(sessionManager)).toEqual([
      "[2026-04-01 18:01:10+08:00] [alice]: hello from slack",
    ]);
  });

  test("does not re-import a live prompt when the session copy includes attachment markup", async () => {
    writeLog([
      {
        date: "2026-04-01T10:00:00.000Z",
        ts: "1000.0010",
        user: "U001",
        userName: "alice",
        text: "hello from slack",
        isBot: false,
      },
    ]);

    const sessionManager = SessionManager.inMemory(testDir);
    sessionManager.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: "[2026-04-01 18:01:10+08:00] [alice]: hello from slack\n\n<slack_attachments>\n/workspace/C001/attachments/report.txt\n</slack_attachments>",
        },
      ],
      timestamp: new Date("2026-04-01T10:01:10.000Z").getTime(),
    });

    const synced = await syncLogToSessionManager(
      sessionManager,
      testDir,
      undefined,
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { scope: "top-level", rootTs: "C001" },
    );

    expect(synced).toBe(0);
    expect(getMessageTexts(sessionManager)).toHaveLength(1);
  });

  test("thread scope only syncs the matching root message and thread replies", async () => {
    writeLog([
      {
        date: "2026-04-01T10:00:00.000Z",
        ts: "1000.0010",
        user: "U001",
        userName: "alice",
        text: "thread root",
        isBot: false,
      },
      {
        date: "2026-04-01T10:01:00.000Z",
        ts: "1000.0020",
        threadTs: "1000.0010",
        user: "U002",
        userName: "bob",
        text: "matching thread reply",
        isBot: false,
      },
      {
        date: "2026-04-01T10:02:00.000Z",
        ts: "1000.0030",
        threadTs: "1000.0099",
        user: "U003",
        userName: "charlie",
        text: "different thread reply",
        isBot: false,
      },
      {
        date: "2026-04-01T10:03:00.000Z",
        ts: "1000.0040",
        user: "U004",
        userName: "dora",
        text: "different top-level message",
        isBot: false,
      },
    ]);

    const sessionManager = SessionManager.inMemory(testDir);
    const synced = await syncLogToSessionManager(
      sessionManager,
      testDir,
      undefined,
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { scope: "thread", rootTs: "1000.0010", threadTs: "1000.0010" },
    );

    expect(synced).toBe(2);
    expect(getMessageTexts(sessionManager)).toEqual([
      "[alice]: thread root",
      "[bob] [in-thread:1000.0010]: matching thread reply",
    ]);
  });
});
