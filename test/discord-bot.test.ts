import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection } from "discord.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BotHandler } from "../src/adapter.js";
import { DiscordBot } from "../src/adapters/discord/bot.js";

function makeHandler(): BotHandler {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    getRunningSessions: vi.fn().mockReturnValue([]),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNew: vi.fn(),
  };
}

describe("DiscordBot attachments", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-discord-bot-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("processAttachments waits for downloads and filters failures", async () => {
    const bot = new DiscordBot(makeHandler(), { token: "TEST_TOKEN", workingDir });
    const downloadAttachment = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));

    (bot as any).downloadAttachment = downloadAttachment;

    const attachments = new Collection<string, any>([
      ["a", { name: "clip.mov", url: "https://example.com/clip.mov" }],
      ["b", { name: "broken.mov", url: "https://example.com/broken.mov" }],
    ]);

    const result = await bot.processAttachments("C123", attachments as any, "M1");

    expect(downloadAttachment).toHaveBeenNthCalledWith(
      1,
      join(workingDir, "C123", "attachments"),
      expect.stringMatching(/^\d+_clip\.mov$/),
      "https://example.com/clip.mov",
    );
    expect(downloadAttachment).toHaveBeenNthCalledWith(
      2,
      join(workingDir, "C123", "attachments"),
      expect.stringMatching(/^\d+_broken\.mov$/),
      "https://example.com/broken.mov",
    );
    expect(result).toEqual([
      {
        name: "clip.mov",
        localPath: expect.stringMatching(/^C123\/attachments\/\d+_clip\.mov$/),
      },
    ]);
  });
});
