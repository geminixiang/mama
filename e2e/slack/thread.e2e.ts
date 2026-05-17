import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  postMessage,
  summarizeMessage,
  waitForBotReply,
  waitForThreadBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mamaBotUserId)("Slack thread routing", () => {
  if (!ctx || !ctx.env.mamaBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mamaBotUserId;

  it("S-006 mama reply stays in thread", async () => {
    const rootStartedAt = nowSeconds();
    const rootTs = await postMessage(
      client,
      env.channel,
      `<@${botUserId}> thread routing smoke，請簡短回覆。`,
    );
    const firstReply = await waitForBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs,
      startedAt: rootStartedAt,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
    });
    expect(firstReply, "no initial mama reply").not.toBeNull();

    const threadStartedAt = nowSeconds();
    const userThreadTs = await postMessage(
      client,
      env.channel,
      `<@${botUserId}> 請用一句話回答：這是 thread e2e 測試`,
      rootTs,
    );
    const threadReply = await waitForThreadBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs,
      startedAt: threadStartedAt,
      excludeTs: new Set([String(firstReply!.ts), userThreadTs]),
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
    });
    expect(threadReply, "no mama reply in thread").not.toBeNull();
    expect(String(threadReply!.thread_ts ?? rootTs), "reply not anchored to root thread").toBe(
      rootTs,
    );
    console.log(`thread reply ts=${threadReply!.ts}: ${summarizeMessage(threadReply!)}`);
  });
});
