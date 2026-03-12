#!/usr/bin/env node

import { join, resolve } from "path";
import type { Bot, BotAdapters, BotEvent, BotHandler } from "./adapter.js";
import { DiscordBot } from "./adapters/discord/index.js";
import { TelegramBot } from "./adapters/telegram/index.js";
import { SlackBot as SlackBotClass } from "./adapters/slack/index.js";
import { type AgentRunner, createRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;
const MOM_TELEGRAM_BOT_TOKEN = process.env.MOM_TELEGRAM_BOT_TOKEN;
const MOM_DISCORD_BOT_TOKEN = process.env.MOM_DISCORD_BOT_TOKEN;

interface ParsedArgs {
  workingDir?: string;
  sandbox: SandboxConfig;
  downloadChannel?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let sandbox: SandboxConfig = { type: "host" };
  let workingDir: string | undefined;
  let downloadChannelId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--sandbox=")) {
      sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
    } else if (arg === "--sandbox") {
      sandbox = parseSandboxArg(args[++i] || "");
    } else if (arg.startsWith("--download=")) {
      downloadChannelId = arg.slice("--download=".length);
    } else if (arg === "--download") {
      downloadChannelId = args[++i];
    } else if (!arg.startsWith("-")) {
      workingDir = arg;
    }
  }

  return {
    workingDir: workingDir ? resolve(workingDir) : undefined,
    sandbox,
    downloadChannel: downloadChannelId,
  };
}

const parsedArgs = parseArgs();

// Handle --download mode (Slack only)
if (parsedArgs.downloadChannel) {
  if (!MOM_SLACK_BOT_TOKEN) {
    console.error("Missing env: MOM_SLACK_BOT_TOKEN");
    process.exit(1);
  }
  await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
  process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
  console.error("Usage: mama [--sandbox=host|docker:<name>] <working-directory>");
  console.error("       mama --download <channel-id>");
  process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };

// Validate platform tokens
const hasSlack = !!(MOM_SLACK_APP_TOKEN && MOM_SLACK_BOT_TOKEN);
const hasTelegram = !!MOM_TELEGRAM_BOT_TOKEN;
const hasDiscord = !!MOM_DISCORD_BOT_TOKEN;

if (!hasSlack && !hasTelegram && !hasDiscord) {
  console.error(
    "No platform tokens found. Set one of:\n" +
      "  Slack:    MOM_SLACK_APP_TOKEN + MOM_SLACK_BOT_TOKEN\n" +
      "  Telegram: MOM_TELEGRAM_BOT_TOKEN\n" +
      "  Discord:  MOM_DISCORD_BOT_TOKEN",
  );
  process.exit(1);
}

await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
  running: boolean;
  runner: AgentRunner;
  stopRequested: boolean;
  stopMessageTs?: string;
  lastAccessedAt: number;
  startedAt?: number;
}

const channelStates = new Map<string, ChannelState>();

/** Track in-flight runs for graceful shutdown */
const inFlightRuns = new Set<Promise<void>>();

/** Flag to stop accepting new events during shutdown */
let isShuttingDown = false;

/** Maximum number of cached sessions */
const MAX_SESSIONS = 500;
/** Idle timeout before a non-running session can be evicted (1 hour) */
const IDLE_TIMEOUT_MS = 3600000;

async function getState(channelId: string, sessionKey?: string): Promise<ChannelState> {
  const key = sessionKey ?? channelId;
  let state = channelStates.get(key);
  if (!state) {
    const channelDir = join(workingDir, channelId);
    state = {
      running: false,
      runner: await createRunner(sandbox, key, channelId, channelDir, workingDir),
      stopRequested: false,
      lastAccessedAt: Date.now(),
    };
    channelStates.set(key, state);
  } else {
    state.lastAccessedAt = Date.now();
  }
  return state;
}

/**
 * Evict idle sessions from channelStates to bound memory usage.
 * Called after each handleEvent completes.
 */
function evictIdleSessions(): void {
  const now = Date.now();

  for (const [key, state] of channelStates) {
    if (!state.running && now - state.lastAccessedAt > IDLE_TIMEOUT_MS) {
      channelStates.delete(key);
    }
  }

  if (channelStates.size > MAX_SESSIONS) {
    const idleSessions: Array<{ key: string; lastAccessedAt: number }> = [];
    for (const [key, state] of channelStates) {
      if (!state.running) {
        idleSessions.push({ key, lastAccessedAt: state.lastAccessedAt });
      }
    }

    idleSessions.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    const toEvict = channelStates.size - MAX_SESSIONS;
    for (let i = 0; i < toEvict && i < idleSessions.length; i++) {
      channelStates.delete(idleSessions[i].key);
    }
  }
}

// ============================================================================
// Handler
// ============================================================================

const handler: BotHandler = {
  isRunning(sessionKey: string): boolean {
    const state = channelStates.get(sessionKey);
    return state?.running ?? false;
  },

  getRunningSessions() {
    const sessions: import("./adapter.js").RunningSession[] = [];
    for (const [sessionKey, state] of channelStates) {
      if (state.running && state.startedAt) {
        sessions.push({ sessionKey, startedAt: state.startedAt });
      }
    }
    return sessions;
  },

  async handleStop(sessionKey: string, channelId: string, bot: Bot): Promise<void> {
    const state = channelStates.get(sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
      const ts = await bot.postMessage(channelId, "_Stopping..._");
      state.stopMessageTs = ts;
    } else {
      await bot.postMessage(channelId, "_Nothing running_");
    }
  },

  async handleEvent(
    event: BotEvent,
    bot: Bot,
    adapters: BotAdapters,
    _isEvent?: boolean,
  ): Promise<void> {
    // Don't accept new events during shutdown
    if (isShuttingDown) {
      log.logInfo(
        `[${event.channel}] Rejected event during shutdown: ${event.text.substring(0, 50)}`,
      );
      return;
    }

    const sessionKey = `${event.channel}:${event.thread_ts ?? event.ts}`;
    const state = await getState(event.channel, sessionKey);

    // Start run
    state.running = true;
    state.stopRequested = false;
    state.startedAt = Date.now();

    log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

    // Wrap in-flight run tracking
    const runPromise = (async () => {
      try {
        const { message, responseCtx, platform } = adapters;

        // Run the agent
        await responseCtx.setTyping(true);
        await responseCtx.setWorking(true);
        const result = await state.runner.run(message, responseCtx, platform);
        await responseCtx.setWorking(false);

        if (result.stopReason === "aborted" && state.stopRequested) {
          if (state.stopMessageTs) {
            await bot.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
            state.stopMessageTs = undefined;
          } else {
            await bot.postMessage(event.channel, "_Stopped_");
          }
        }
      } catch (err) {
        log.logWarning(
          `[${event.channel}] Run error`,
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        state.running = false;
        state.lastAccessedAt = Date.now();
        evictIdleSessions();
      }
    })();

    inFlightRuns.add(runPromise);
    try {
      await runPromise;
    } finally {
      inFlightRuns.delete(runPromise);
    }
  },
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Create the appropriate platform bot
let bot: Bot;

if (hasSlack) {
  const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });
  bot = new SlackBotClass(handler, {
    appToken: MOM_SLACK_APP_TOKEN!,
    botToken: MOM_SLACK_BOT_TOKEN!,
    workingDir,
    store: sharedStore,
  });
  log.logInfo("Platform: Slack");
} else if (hasTelegram) {
  bot = new TelegramBot(handler, {
    token: MOM_TELEGRAM_BOT_TOKEN!,
    workingDir,
  });
  log.logInfo("Platform: Telegram");
} else {
  bot = new DiscordBot(handler, {
    token: MOM_DISCORD_BOT_TOKEN!,
    workingDir,
  });
  log.logInfo("Platform: Discord");
}

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot);
if (hasSlack) {
  (bot as SlackBotClass).setEventsWatcher(eventsWatcher);
}
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.logInfo("Shutting down gracefully...");

  const timeout = Date.now() + 30000;
  while (inFlightRuns.size > 0 && Date.now() < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (inFlightRuns.size > 0) {
    log.logWarning(`Forcing exit with ${inFlightRuns.size} runs still in progress`);
  }

  eventsWatcher.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.logInfo("Shutting down gracefully...");

  const timeout = Date.now() + 30000;
  while (inFlightRuns.size > 0 && Date.now() < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (inFlightRuns.size > 0) {
    log.logWarning(`Forcing exit with ${inFlightRuns.size} runs still in progress`);
  }

  eventsWatcher.stop();
  process.exit(0);
});

bot.start().catch((err) => {
  log.logWarning("Failed to start bot", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
