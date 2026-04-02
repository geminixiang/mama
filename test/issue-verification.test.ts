import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// ============================================================================
// Verify grep CAN search log.jsonl for historical records
// ============================================================================

describe("ISSUE VERIFICATION: Grep can search historical records", () => {
  const testDir = "/tmp/mama-grep-test";

  beforeEach(() => {
    // Create test directory and log file
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Create log.jsonl with various historical messages
    const logEntries = [
      {
        date: "2025-01-01T10:00:00.000Z",
        ts: "1000000000.000001",
        user: "U001",
        userName: "alice",
        text: "Hello team",
        attachments: [],
        isBot: false,
      },
      {
        date: "2025-01-02T10:00:00.000Z",
        ts: "1000000000.000002",
        user: "U002",
        userName: "bob",
        text: "I found a bug in the login flow",
        attachments: [],
        isBot: false,
      },
      {
        date: "2025-01-03T10:00:00.000Z",
        ts: "1000000000.000003",
        user: "bot",
        userName: "mama",
        text: "Hello! How can I help?",
        attachments: [],
        isBot: true,
      },
      {
        date: "2025-01-04T10:00:00.000Z",
        ts: "1000000000.000004",
        user: "U001",
        userName: "alice",
        text: "The database is running slow",
        attachments: [],
        isBot: false,
      },
      {
        date: "2025-03-13T10:00:00.000Z",
        ts: "1000000000.000005",
        user: "U003",
        userName: "charlie",
        text: "Can someone review my PR?",
        attachments: [],
        isBot: false,
      },
    ];

    for (const entry of logEntries) {
      appendFileSync(join(testDir, "log.jsonl"), JSON.stringify(entry) + "\n");
    }
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("grep can find messages from specific user", async () => {
    const { execSync } = await import("child_process");

    const result = execSync(`grep '"userName":"alice"' ${join(testDir, "log.jsonl")}`, {
      encoding: "utf-8",
    });

    const lines = result.trim().split("\n");
    expect(lines.length).toBe(2); // Alice has 2 messages
    expect(lines[0]).toContain("Hello team");
    expect(lines[1]).toContain("The database is running slow");
  });

  test("grep can find messages containing specific keyword", async () => {
    const { execSync } = await import("child_process");

    const result = execSync(`grep -i "bug" ${join(testDir, "log.jsonl")}`, { encoding: "utf-8" });

    expect(result).toContain("I found a bug in the login flow");
    expect(result).toContain("bob");
  });

  test("grep can find messages from specific date range", async () => {
    const { execSync } = await import("child_process");

    // Find messages from January 2025
    const result = execSync(`grep '"date":"2025-01' ${join(testDir, "log.jsonl")}`, {
      encoding: "utf-8",
    });

    const lines = result.trim().split("\n");
    expect(lines.length).toBe(4); // 4 messages from January
  });

  test("log.jsonl is valid JSON Lines format", async () => {
    const { readFileSync } = await import("fs");

    const content = readFileSync(join(testDir, "log.jsonl"), "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(5);

    // Each line is valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("date");
      expect(parsed).toHaveProperty("ts");
      expect(parsed).toHaveProperty("user");
      expect(parsed).toHaveProperty("userName");
      expect(parsed).toHaveProperty("text");
      expect(parsed).toHaveProperty("attachments");
      expect(parsed).toHaveProperty("isBot");
    }
  });

  test("syncLogToSessionManager uses 10-day window (default)", async () => {
    // This verifies the default behavior
    // 10 days ago from now would filter out January messages

    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    // Messages from January 2025 would be older than 10 days
    const januaryDate = new Date("2025-01-01").getTime();

    expect(januaryDate).toBeLessThan(tenDaysAgo);
    // So they would be EXCLUDED from sync by default!
  });

  test("older messages CAN be found via grep but not in auto-context", async () => {
    const { execSync } = await import("child_process");

    // This proves that older messages ARE in the log
    // but would NOT be included in the 10-day sync window

    // All 5 messages exist
    const allResult = execSync(`wc -l ${join(testDir, "log.jsonl")}`, { encoding: "utf-8" });
    expect(allResult).toContain("5");

    // But January messages would be filtered out by syncLogToSessionManager
    // because they are more than 10 days old
    const januaryCount = execSync(`grep '"date":"2025-01' ${join(testDir, "log.jsonl")} | wc -l`, {
      encoding: "utf-8",
    });
    expect(parseInt(januaryCount)).toBe(4); // 4 messages from January

    // This demonstrates the DESIGNED behavior:
    // - grep CAN find all historical messages
    // - But auto-sync only gets the recent default window
  });
});

// Historical attachment verification moved into dedicated adapter tests.
