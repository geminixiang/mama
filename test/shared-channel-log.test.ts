import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendChannelLog, createBotLogEntry } from "../src/adapters/shared/channel-log.js";

describe("channel log helpers", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-shared-log-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  test("appendChannelLog creates the channel directory and writes jsonl entries", () => {
    appendChannelLog(workingDir, "C123", { ts: "1", text: "hello" });

    const logPath = join(workingDir, "C123", "log.jsonl");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf-8")).toBe('{"ts":"1","text":"hello"}\n');
  });

  test("appendChannelLog appends multiple entries without overwriting earlier ones", () => {
    appendChannelLog(workingDir, "C123", { ts: "1", text: "hello" });
    appendChannelLog(workingDir, "C123", { ts: "2", text: "world" });

    const logPath = join(workingDir, "C123", "log.jsonl");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { ts: "1", text: "hello" },
      { ts: "2", text: "world" },
    ]);
  });

  test("createBotLogEntry returns a bot log payload with optional thread metadata", () => {
    const entry = createBotLogEntry("Done", "42", "thread-1") as {
      date: string;
      ts: string;
      threadTs?: string;
      user: string;
      text: string;
      attachments: [];
      isBot: boolean;
    };

    expect(entry).toMatchObject({
      ts: "42",
      threadTs: "thread-1",
      user: "bot",
      text: "Done",
      attachments: [],
      isBot: true,
    });
    expect(new Date(entry.date).toISOString()).toBe(entry.date);
  });

  test("createBotLogEntry works when no thread timestamp is provided", () => {
    const entry = createBotLogEntry("Done", "42") as { threadTs?: string };

    expect(entry.threadTs).toBeUndefined();
  });
});
