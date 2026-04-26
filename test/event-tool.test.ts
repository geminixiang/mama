import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEventTool } from "../src/tools/event.js";

describe("createEventTool", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makeWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "mama-event-tool-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("writes immediate event payload with current context and sanitized filename", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createEventTool(workspaceDir);
    setEventContext({ platform: "slack", channelId: "C123", userId: "U123" });

    const result = await tool.execute("call-1", {
      label: "deploy",
      type: "immediate",
      text: "Check deployment status",
      filenamePrefix: " Deploy / Prod ",
    });

    const eventsDir = join(workspaceDir, "events");
    const files = readdirSync(eventsDir);
    expect(files).toEqual(["deploy-prod-1700000000000.json"]);
    expect(JSON.parse(readFileSync(join(eventsDir, files[0]), "utf-8"))).toEqual({
      type: "immediate",
      platform: "slack",
      channelId: "C123",
      userId: "U123",
      text: "Check deployment status",
    });
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain(
      "Queued immediate event deploy-prod-1700000000000.json",
    );
  });

  test("requires event context before execution", async () => {
    const workspaceDir = makeWorkspace();
    const { tool } = createEventTool(workspaceDir);

    await expect(
      tool.execute("call-1", {
        label: "deploy",
        type: "immediate",
        text: "Check deployment status",
      }),
    ).rejects.toThrow("Event context not configured");
  });

  test("one-shot events require at", async () => {
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createEventTool(workspaceDir);
    setEventContext({ platform: "slack", channelId: "C123", userId: "U123" });

    await expect(
      tool.execute("call-1", {
        label: "dentist",
        type: "one-shot",
        text: "Reminder",
      }),
    ).rejects.toThrow("`at` is required for one-shot events");
  });

  test("periodic events require schedule and timezone", async () => {
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createEventTool(workspaceDir);
    setEventContext({ platform: "discord", channelId: "D123", userId: "U456" });

    await expect(
      tool.execute("call-1", {
        label: "inbox",
        type: "periodic",
        text: "Check inbox",
        timezone: "Asia/Taipei",
      }),
    ).rejects.toThrow("`schedule` is required for periodic events");

    await expect(
      tool.execute("call-2", {
        label: "inbox",
        type: "periodic",
        text: "Check inbox",
        schedule: "0 9 * * 1-5",
      }),
    ).rejects.toThrow("`timezone` is required for periodic events");
  });

  test("writes periodic event payload with context", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000100);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createEventTool(workspaceDir);
    setEventContext({ platform: "telegram", channelId: "999", userId: "U789" });

    const result = await tool.execute("call-1", {
      label: "inbox",
      type: "periodic",
      text: "Check inbox",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });

    const eventsDir = join(workspaceDir, "events");
    const files = readdirSync(eventsDir);
    expect(files).toEqual(["periodic-1700000000100.json"]);
    expect(JSON.parse(readFileSync(join(eventsDir, files[0]), "utf-8"))).toEqual({
      type: "periodic",
      platform: "telegram",
      channelId: "999",
      userId: "U789",
      text: "Check inbox",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });
    expect(result.content[0]?.text).toContain(
      "Scheduled periodic event periodic-1700000000100.json",
    );
  });
});
