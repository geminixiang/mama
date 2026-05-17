import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { nowSeconds, postMessage, summarizeMessage, waitForBotReply } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx)("Slack mention", () => {
  if (!ctx) return;
  const { client, env } = ctx;

  it.skipIf(!env.questionBotUserId)("S-003 question bot replies to mention", async () => {
    const botUserId = env.questionBotUserId;
    if (!botUserId) return;
    const startedAt = nowSeconds();
    const rootTs = await postMessage(client, env.channel, `<@${botUserId}> ${env.questionText}`);
    const reply = await waitForBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs,
      startedAt,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
    });
    expect(reply, "no reply from question bot").not.toBeNull();
    console.log(`question bot reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  });

  it.skipIf(!env.mamaBotUserId)("S-004 mama replies to mention", async () => {
    const botUserId = env.mamaBotUserId;
    if (!botUserId) return;
    const startedAt = nowSeconds();
    const rootTs = await postMessage(client, env.channel, `<@${botUserId}> ${env.mamaText}`);
    const reply = await waitForBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs,
      startedAt,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
    });
    expect(reply, "no reply from mama").not.toBeNull();
    console.log(`mama reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  });
});
