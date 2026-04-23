import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createEventTool } from "../src/tools/event.js";

describe("event tool", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("writes one-shot event with current conversation context", async () => {
    const workspaceDir = join(tmpdir(), `mama-event-tool-${Date.now()}`);
    createdDirs.push(workspaceDir);

    const { tool, setEventContext } = createEventTool(workspaceDir);
    setEventContext({
      platform: "telegram",
      conversationId: "574247312",
      userId: "574247312",
    });

    const result = await tool.execute("tool-call", {
      label: "schedule reminder",
      type: "one-shot",
      text: "該下班了！",
      at: "2026-04-23T20:24:09+08:00",
      filenamePrefix: "clocking-off",
    });

    expect(result.content[0].type).toBe("text");

    const eventsDir = join(workspaceDir, "events");
    const [filename] = await import("node:fs/promises").then(({ readdir }) => readdir(eventsDir));
    const payload = JSON.parse(readFileSync(join(eventsDir, filename), "utf-8"));

    expect(payload).toEqual({
      type: "one-shot",
      platform: "telegram",
      channelId: "574247312",
      userId: "574247312",
      text: "該下班了！",
      at: "2026-04-23T20:24:09+08:00",
    });
  });
});
