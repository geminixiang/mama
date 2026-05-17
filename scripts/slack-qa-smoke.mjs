#!/usr/bin/env node

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { WebClient } from "@slack/web-api";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;

const env = process.env;

function usage() {
  return `Slack QA smoke runner

Required env:
  SLACK_QA_USER_TOKEN              Slack User OAuth Token used to send QA messages (xoxp- or xoxe-; not xoxb-)
  SLACK_QA_CHANNEL_ID              Test channel ID, for example C0123456789

At least one target bot is required:
  SLACK_QA_QUESTION_BOT_USER_ID    Question bot user ID, for example U0123456789
  SLACK_QA_MAMA_BOT_USER_ID        mama bot user ID, for example U0123456789

Optional env:
  SLACK_QA_QUESTION_TEXT           Question bot prompt. Default: 你是誰？請簡短回答。
  SLACK_QA_MAMA_TEXT               mama prompt. Default: hello，請簡短回答。
  SLACK_QA_TIMEOUT_MS              Per-case timeout. Default: ${DEFAULT_TIMEOUT_MS}
  SLACK_QA_POLL_MS                 Poll interval. Default: ${DEFAULT_POLL_MS}
  SLACK_QA_SKIP_NO_MENTION=1       Skip no-mention false-reply check
  SLACK_QA_SKIP_THREAD=1           Skip mama thread reply check

Example:
  SLACK_QA_USER_TOKEN=xoxp-... \\
  SLACK_QA_CHANNEL_ID=C0123456789 \\
  SLACK_QA_QUESTION_BOT_USER_ID=UQUESTION \\
  SLACK_QA_MAMA_BOT_USER_ID=UMAMA \\
  npm run test:e2e:slack
`;
}

function requireEnv(name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function nowSeconds() {
  return Date.now() / 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(message) {
  return typeof message.text === "string" ? message.text : "";
}

function isTargetBotMessage(message, botUserId) {
  return message.user === botUserId || message.bot_id === botUserId;
}

function summarizeMessage(message) {
  const text = messageText(message).replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

async function postMessage(client, channel, text, threadTs) {
  const res = await client.chat.postMessage({ channel, text, thread_ts: threadTs });
  if (!res.ok || !res.ts) throw new Error(`chat.postMessage failed: ${res.error ?? "missing ts"}`);
  return String(res.ts);
}

async function fetchThreadMessages(client, channel, threadTs) {
  const res = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
  if (!res.ok) throw new Error(`conversations.replies failed: ${res.error ?? "unknown"}`);
  return res.messages ?? [];
}

async function fetchRecentMessages(client, channel, oldest) {
  const res = await client.conversations.history({
    channel,
    oldest: String(oldest),
    inclusive: false,
    limit: 50,
  });
  if (!res.ok) throw new Error(`conversations.history failed: ${res.error ?? "unknown"}`);
  return res.messages ?? [];
}

async function waitForBotReply({
  client,
  channel,
  botUserId,
  rootTs,
  startedAt,
  timeoutMs,
  pollMs,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [threadMessages, recentMessages] = await Promise.all([
      fetchThreadMessages(client, channel, rootTs).catch(() => []),
      fetchRecentMessages(client, channel, startedAt).catch(() => []),
    ]);

    const candidates = [...threadMessages, ...recentMessages]
      .filter((message) => String(message.ts) !== rootTs)
      .filter((message) => isTargetBotMessage(message, botUserId));

    if (candidates.length > 0) return candidates[0];
    await sleep(pollMs);
  }
  return null;
}

async function waitForThreadBotReply({
  client,
  channel,
  botUserId,
  rootTs,
  startedAt,
  excludeTs,
  timeoutMs,
  pollMs,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const threadMessages = await fetchThreadMessages(client, channel, rootTs).catch(() => []);
    const reply = threadMessages
      .filter((message) => String(message.ts) !== rootTs)
      .filter((message) => !excludeTs.has(String(message.ts)))
      .filter((message) => Number(message.ts) >= startedAt)
      .find((message) => isTargetBotMessage(message, botUserId));

    if (reply) return reply;
    await sleep(pollMs);
  }
  return null;
}

async function waitForRecentBotReply({
  client,
  channel,
  botUserId,
  startedAt,
  timeoutMs,
  pollMs,
  textIncludes,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recentMessages = await fetchRecentMessages(client, channel, startedAt).catch(() => []);
    const reply = recentMessages
      .filter((message) => isTargetBotMessage(message, botUserId))
      .find((message) => !textIncludes || messageText(message).includes(textIncludes));

    if (reply) return reply;
    await sleep(pollMs);
  }
  return null;
}

async function assertNoBotReply({ client, channel, botUserIds, startedAt, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recentMessages = await fetchRecentMessages(client, channel, startedAt).catch(() => []);
    const unexpected = recentMessages.find((message) =>
      botUserIds.some((botUserId) => isTargetBotMessage(message, botUserId)),
    );
    if (unexpected) return unexpected;
    await sleep(pollMs);
  }
  return null;
}

async function runMentionCase({ client, channel, name, botUserId, prompt, timeoutMs, pollMs }) {
  const startedAt = nowSeconds();
  const text = `<@${botUserId}> ${prompt}`;
  const rootTs = await postMessage(client, channel, text);
  const reply = await waitForBotReply({
    client,
    channel,
    botUserId,
    rootTs,
    startedAt,
    timeoutMs,
    pollMs,
  });

  if (!reply) {
    return { id: name, ok: false, detail: `No reply from ${botUserId} within ${timeoutMs}ms` };
  }

  return {
    id: name,
    ok: true,
    detail: `Reply ts=${reply.ts}: ${summarizeMessage(reply)}`,
  };
}

async function runOneShotEventCase({ client, channel, botUserId, timeoutMs, pollMs, eventsDir }) {
  const token = `QA_EVENT_${Date.now()}`;
  const filename = `slack-e2e-one-shot-${token}.json`;
  const at = new Date(Date.now() + 5_000).toISOString();
  const startedAt = nowSeconds();

  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    join(eventsDir, filename),
    JSON.stringify(
      {
        type: "one-shot",
        platform: "slack",
        conversationId: channel,
        conversationKind: "shared",
        text: `One-shot E2E reminder. 請在回覆中原樣包含 ${token}`,
        at,
      },
      null,
      2,
    ),
  );

  const reply = await waitForRecentBotReply({
    client,
    channel,
    botUserId,
    startedAt,
    timeoutMs: Math.max(timeoutMs, 45_000),
    pollMs,
    textIncludes: token,
  });

  if (!reply) {
    return {
      id: "S-011 one-shot event",
      ok: false,
      detail: `No one-shot reminder reply containing ${token}`,
    };
  }

  return {
    id: "S-011 one-shot event",
    ok: true,
    detail: `One-shot reply ts=${reply.ts}: ${summarizeMessage(reply)}`,
  };
}

async function runThreadCase({ client, channel, botUserId, timeoutMs, pollMs }) {
  const rootStartedAt = nowSeconds();
  const rootTs = await postMessage(
    client,
    channel,
    `<@${botUserId}> thread routing smoke，請簡短回覆。`,
  );
  const firstReply = await waitForBotReply({
    client,
    channel,
    botUserId,
    rootTs,
    startedAt: rootStartedAt,
    timeoutMs,
    pollMs,
  });

  if (!firstReply) {
    return { id: "S-006 thread reply", ok: false, detail: "No initial mama reply" };
  }

  const threadStartedAt = nowSeconds();
  const userThreadTs = await postMessage(
    client,
    channel,
    `<@${botUserId}> 請用一句話回答：這是 thread e2e 測試`,
    rootTs,
  );
  const threadReply = await waitForThreadBotReply({
    client,
    channel,
    botUserId,
    rootTs,
    startedAt: threadStartedAt,
    excludeTs: new Set([String(firstReply.ts), userThreadTs]),
    timeoutMs,
    pollMs,
  });

  if (!threadReply) {
    return { id: "S-006 thread reply", ok: false, detail: "No mama reply in thread" };
  }

  if (String(threadReply.thread_ts ?? rootTs) !== rootTs) {
    return {
      id: "S-006 thread reply",
      ok: false,
      detail: `Reply was not anchored to root thread ${rootTs}: ts=${threadReply.ts}`,
    };
  }

  return {
    id: "S-006 thread reply",
    ok: true,
    detail: `Thread reply ts=${threadReply.ts}: ${summarizeMessage(threadReply)}`,
  };
}

async function main() {
  if (env.SLACK_QA_HELP === "1" || process.argv.includes("--help")) {
    console.log(usage());
    return;
  }

  const token = requireEnv("SLACK_QA_USER_TOKEN");
  if (!token.startsWith("xoxp-") && !token.startsWith("xoxe-")) {
    throw new Error(
      "SLACK_QA_USER_TOKEN must be a Slack User OAuth Token starting with xoxp- or xoxe-. Do not use xapp- or xoxb- tokens.",
    );
  }
  const channel = requireEnv("SLACK_QA_CHANNEL_ID");
  const timeoutMs = Number(env.SLACK_QA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const pollMs = Number(env.SLACK_QA_POLL_MS ?? DEFAULT_POLL_MS);
  const questionBotUserId = env.SLACK_QA_QUESTION_BOT_USER_ID;
  const mamaBotUserId = env.SLACK_QA_MAMA_BOT_USER_ID;
  const eventsDir = env.SLACK_QA_EVENTS_DIR ?? join(process.cwd(), "events");

  if (!questionBotUserId && !mamaBotUserId) {
    throw new Error("Set SLACK_QA_QUESTION_BOT_USER_ID and/or SLACK_QA_MAMA_BOT_USER_ID");
  }

  const client = new WebClient(token);
  const results = [];

  if (questionBotUserId) {
    results.push(
      await runMentionCase({
        client,
        channel,
        name: "S-003 question bot mention",
        botUserId: questionBotUserId,
        prompt: env.SLACK_QA_QUESTION_TEXT ?? "你是誰？請簡短回答。",
        timeoutMs,
        pollMs,
      }),
    );
  }

  if (mamaBotUserId) {
    results.push(
      await runMentionCase({
        client,
        channel,
        name: "S-004 mama mention",
        botUserId: mamaBotUserId,
        prompt: env.SLACK_QA_MAMA_TEXT ?? "hello，請簡短回答。",
        timeoutMs,
        pollMs,
      }),
    );

    if (env.SLACK_QA_SKIP_THREAD !== "1") {
      results.push(
        await runThreadCase({
          client,
          channel,
          botUserId: mamaBotUserId,
          timeoutMs,
          pollMs,
        }),
      );
    }

    results.push(
      await runOneShotEventCase({
        client,
        channel,
        botUserId: mamaBotUserId,
        timeoutMs,
        pollMs,
        eventsDir,
      }),
    );
  }

  if (env.SLACK_QA_SKIP_NO_MENTION !== "1") {
    const botUserIds = [questionBotUserId, mamaBotUserId].filter(Boolean);
    const startedAt = nowSeconds();
    await postMessage(client, channel, `QA no-mention smoke ${new Date().toISOString()}`);
    const unexpected = await assertNoBotReply({
      client,
      channel,
      botUserIds,
      startedAt,
      timeoutMs: Math.min(timeoutMs, 10_000),
      pollMs,
    });
    results.push(
      unexpected
        ? {
            id: "S-005 no mention",
            ok: false,
            detail: `Unexpected bot reply from ${unexpected.user ?? unexpected.bot_id}: ${summarizeMessage(unexpected)}`,
          }
        : { id: "S-005 no mention", ok: true, detail: "No bot replied" },
    );
  }

  let failed = 0;
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    if (!result.ok) failed += 1;
    console.log(`${status} ${result.id} - ${result.detail}`);
  }

  if (failed > 0) {
    console.error(`Slack QA smoke failed: ${failed}/${results.length} failed`);
    process.exit(1);
  }
  console.log(`Slack QA smoke passed: ${results.length}/${results.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(1);
});
