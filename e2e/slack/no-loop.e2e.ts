import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  assertNoAdditionalBotReply,
  nowSeconds,
  postMessage,
  summarizeMessage,
  waitForBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mamaBotUserId)("Slack no bot-to-bot loop", () => {
  if (!ctx || !ctx.env.mamaBotUserId) return;
  const { client, env } = ctx;
  const primary = ctx.env.mamaBotUserId;
  const botUserIds = [env.questionBotUserId, env.mamaBotUserId].filter((id): id is string =>
    Boolean(id),
  );

  it("S-010 no extra bot reply follows the first reply", async () => {
    const startedAt = nowSeconds();
    const rootTs = await postMessage(
      client,
      env.channel,
      `<@${primary}> no-loop e2e，請只用一句話回覆。`,
    );
    const firstReply = await waitForBotReply({
      client,
      channel: env.channel,
      botUserId: primary,
      rootTs,
      startedAt,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
    });
    expect(firstReply, "no initial reply to observe").not.toBeNull();

    const unexpected = await assertNoAdditionalBotReply({
      client,
      channel: env.channel,
      rootTs,
      botUserIds,
      afterTs: String(firstReply!.ts),
      timeoutMs: Math.min(env.timeoutMs, 10_000),
      pollMs: env.pollMs,
    });
    expect(
      unexpected,
      unexpected
        ? `unexpected additional bot reply from ${unexpected.user ?? unexpected.bot_id}: ${summarizeMessage(unexpected)}`
        : "",
    ).toBeNull();
  });
});
