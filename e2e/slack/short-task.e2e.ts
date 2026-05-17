import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { nowSeconds, postMessage, waitForBotReply } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mamaBotUserId)("Slack short task", () => {
  if (!ctx || !ctx.env.mamaBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mamaBotUserId;

  it("S-007 mama completes a short task and echoes the token", async () => {
    const token = `QA_TASK_${Date.now()}`;
    const startedAt = nowSeconds();
    const rootTs = await postMessage(
      client,
      env.channel,
      `<@${botUserId}> 短任務 e2e：請直接回覆這個 token：${token}`,
    );
    const reply = await waitForBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: token,
    });
    expect(reply, `no mama task reply containing ${token}`).not.toBeNull();
  });
});
