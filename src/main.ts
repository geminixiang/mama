#!/usr/bin/env node

import "./instrument.js";

import { join, resolve } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join as pathJoin } from "path";
import type { Bot, BotAdapters, BotEvent, BotHandler } from "./adapter.js";
import { DiscordBot } from "./adapters/discord/index.js";
import { TelegramBot } from "./adapters/telegram/index.js";
import { SlackBot as SlackBotClass } from "./adapters/slack/index.js";
import { type AgentRunner, createRunner } from "./agent.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getSessionDir,
  getThreadSessionFile,
} from "./session-store.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { FileVaultManager } from "./vault.js";
import { addLifecycleBreadcrumb, applyRunScope } from "./sentry.js";
import { ChannelStore } from "./store.js";
import * as Sentry from "@sentry/node";

// ============================================================================
// Config
// ============================================================================

// Get version from package.json
function getVersion(): string {
  // Try to find package.json in the dist directory or parent
  const possiblePaths = [
    pathJoin(dirname(fileURLToPath(import.meta.url)), "package.json"),
    pathJoin(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    pathJoin(process.cwd(), "package.json"),
  ];

  for (const pkgPath of possiblePaths) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.version) return pkg.version;
    } catch {
      // Continue to next path
    }
  }
  return "unknown";
}

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;
const MOM_TELEGRAM_BOT_TOKEN = process.env.MOM_TELEGRAM_BOT_TOKEN;
const MOM_DISCORD_BOT_TOKEN = process.env.MOM_DISCORD_BOT_TOKEN;

interface ParsedArgs {
  workingDir?: string;
  sandbox: SandboxConfig;
  downloadChannel?: string;
  showVersion?: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let sandbox: SandboxConfig = { type: "host" };
  let workingDir: string | undefined;
  let downloadChannelId: string | undefined;
  let showVersion = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v" || arg === "-V") {
      showVersion = true;
    } else if (arg.startsWith("--sandbox=")) {
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
    showVersion,
  };
}

const parsedArgs = parseArgs();

// Handle --version
if (parsedArgs.showVersion) {
  console.log(getVersion());
  process.exit(0);
}

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
  console.error(
    "Usage: mama [--sandbox=host|docker:<name>|firecracker:<vm-id>:<host-path>] <working-directory>",
  );
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

const vaultManager = new FileVaultManager(workingDir);
if (vaultManager.isEnabled()) {
  console.log("  Vault system enabled. Per-user credential routing active.");
}

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
  lastActivityAt?: number;
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
      runner: await createRunner(sandbox, key, channelId, channelDir, workingDir, vaultManager),
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
    return !!state?.running;
  },

  getRunningSessions() {
    const sessions: import("./adapter.js").RunningSession[] = [];
    for (const [sessionKey, state] of channelStates) {
      if (state.running && state.startedAt) {
        // Get current step from runner
        const currentStep = state.runner.getCurrentStep();
        sessions.push({
          sessionKey,
          startedAt: state.startedAt,
          lastActivityAt: state.lastActivityAt,
          currentTool: currentStep?.label || currentStep?.toolName,
        });
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

  forceStop(sessionKey: string): void {
    const state = channelStates.get(sessionKey);
    if (state?.running) {
      log.logInfo(`[Force Stop] Force stopping session: ${sessionKey}`);
      state.stopRequested = true;
      state.runner.abort();
      state.running = false;
    }
  },

  async handleNew(sessionKey: string, channelId: string, bot: Bot): Promise<void> {
    const state = channelStates.get(sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
    }

    // Channel sessions rotate via current pointer. Thread sessions reset in place.
    const channelDir = join(workingDir, channelId);
    if (sessionKey.includes(":")) {
      createManagedSessionFileAtPath(getThreadSessionFile(channelDir, sessionKey), channelDir);
    } else {
      createManagedSessionFile(getSessionDir(channelDir, sessionKey), channelDir);
    }

    // Remove from in-memory cache
    channelStates.delete(sessionKey);

    log.logInfo(`[${channelId}] Session reset: ${sessionKey}`);
    await bot.postMessage(channelId, "Conversation reset. Send a new message to start fresh.");
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

    const sessionKey = event.sessionKey ?? `${event.channel}:${event.thread_ts ?? event.ts}`;
    const state = await getState(event.channel, sessionKey);

    // Start run
    state.running = true;
    state.stopRequested = false;
    state.startedAt = Date.now();
    state.lastActivityAt = Date.now();

    log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

    // Wrap in-flight run tracking
    Sentry.metrics.count("agent.run.started", 1, {
      attributes: { channel: event.channel },
    });
    Sentry.metrics.gauge("agent.sessions.active", inFlightRuns.size + 1);

    const runPromise = Sentry.startSpan(
      { name: "agent.run", op: "agent", attributes: { channelId: event.channel, sessionKey } },
      async () => {
        return Sentry.withScope(async (scope) => {
          const { message, responseCtx, platform } = adapters;
          applyRunScope(scope, {
            channelId: event.channel,
            sessionKey,
            messageId: message.id,
            platform: platform.name,
            userId: message.userId,
            userName: message.userName,
            threadTs: message.threadTs,
            isEvent: _isEvent,
          });
          addLifecycleBreadcrumb("agent.run.started", {
            channel_id: event.channel,
            platform: platform.name,
            has_attachments: (message.attachments?.length ?? 0) > 0,
          });

          try {
            await responseCtx.setTyping(true);
            await responseCtx.setWorking(true);
            const result = await state.runner.run(message, responseCtx, platform);
            await responseCtx.setWorking(false);

            const durationMs = Date.now() - state.startedAt!;
            Sentry.metrics.distribution("agent.run.duration", durationMs, {
              unit: "millisecond",
              attributes: {
                channel: event.channel,
                platform: platform.name,
                stop_reason: result.stopReason,
              },
            });
            Sentry.metrics.count("agent.run.completed", 1, {
              attributes: {
                channel: event.channel,
                platform: platform.name,
                stop_reason: result.stopReason,
              },
            });
            addLifecycleBreadcrumb("agent.run.completed", {
              channel_id: event.channel,
              platform: platform.name,
              stop_reason: result.stopReason,
              duration_ms: durationMs,
            });

            if (result.stopReason === "aborted" && state.stopRequested) {
              if (state.stopMessageTs) {
                await bot.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
                state.stopMessageTs = undefined;
              } else {
                await bot.postMessage(event.channel, "_Stopped_");
              }
            }
          } catch (err) {
            scope.setContext("agent_run_error", {
              channelId: event.channel,
              sessionKey,
              platform: adapters.platform.name,
              messageId: adapters.message.id,
              threadTs: adapters.message.threadTs,
            });
            Sentry.captureException(err);
            Sentry.metrics.count("agent.run.errors", 1, {
              attributes: { channel: event.channel, platform: adapters.platform.name },
            });
            log.logWarning(
              `[${event.channel}] Run error`,
              err instanceof Error ? err.message : String(err),
            );
          } finally {
            state.running = false;
            state.lastAccessedAt = Date.now();
            Sentry.metrics.gauge("agent.sessions.active", inFlightRuns.size - 1);
            evictIdleSessions();
          }
        });
      },
    );

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

const sandboxDesc =
  sandbox.type === "host"
    ? "host"
    : sandbox.type === "docker"
      ? `docker:${sandbox.container}`
      : `firecracker:${sandbox.vmId}`;
log.logStartup(workingDir, sandboxDesc);

// Create platform bots
const bots: Bot[] = [];
const botsByPlatform: Record<string, Bot> = {};

if (hasSlack) {
  const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });
  const slackBot = new SlackBotClass(handler, {
    appToken: MOM_SLACK_APP_TOKEN!,
    botToken: MOM_SLACK_BOT_TOKEN!,
    workingDir,
    store: sharedStore,
  });
  bots.push(slackBot);
  botsByPlatform.slack = slackBot;
  log.logInfo("Platform: Slack");
}
if (hasTelegram) {
  const telegramBot = new TelegramBot(handler, {
    token: MOM_TELEGRAM_BOT_TOKEN!,
    workingDir,
  });
  bots.push(telegramBot);
  botsByPlatform.telegram = telegramBot;
  log.logInfo("Platform: Telegram");
}
if (hasDiscord) {
  const discordBot = new DiscordBot(handler, {
    token: MOM_DISCORD_BOT_TOKEN!,
    workingDir,
  });
  bots.push(discordBot);
  botsByPlatform.discord = discordBot;
  log.logInfo("Platform: Discord");
}

// Start events watcher with explicit platform routing
const eventsWatcher = createEventsWatcher(workingDir, botsByPlatform);
const slackBot = botsByPlatform.slack as SlackBotClass | undefined;
if (slackBot) {
  slackBot.setEventsWatcher(eventsWatcher);
}
eventsWatcher.start();

// Handle shutdown
async function shutdown(): Promise<void> {
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
  await Sentry.close(5000);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start all bots
await Promise.all(
  bots.map((bot) =>
    bot.start().catch((err) => {
      log.logWarning("Failed to start bot", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }),
  ),
);
