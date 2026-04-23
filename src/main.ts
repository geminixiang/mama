#!/usr/bin/env node

import "./instrument.js";

import { join, resolve } from "path";
import { homedir } from "os";
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
  getChannelSessionDir,
  getThreadSessionFile,
} from "./session-store.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { FileUserBindingStore } from "./bindings.js";
import { startLinkServer } from "./link-server.js";
import { parseLoginCommand } from "./login.js";
import { InMemoryLinkTokenStore } from "./link-token.js";
import { DockerContainerManager } from "./provisioner.js";
import { SandboxError, parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { formatNothingRunning, formatStopping } from "./ui-copy.js";
import { FileVaultManager } from "./vault.js";
import { ensureSettingsFile } from "./config.js";
import {
  createManagedVaultEntry,
  ensureImageSandboxVault,
  resolveActorVaultKey,
} from "./vault-routing.js";
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
/** Base URL of the web login portal, e.g. https://platform.trygemini.xyz */
const MOM_LINK_URL = process.env.MOM_LINK_URL;
/**
 * Port for the link callback HTTP server.
 * Defaults to 8181 when MOM_LINK_URL is set (behind a reverse proxy).
 * If neither is set, the server is not started.
 */
const MOM_LINK_PORT = process.env.MOM_LINK_PORT
  ? parseInt(process.env.MOM_LINK_PORT, 10)
  : MOM_LINK_URL
    ? 8181
    : undefined;

interface ParsedArgs {
  workingDir?: string;
  stateDir?: string;
  sandbox: SandboxConfig;
  downloadChannel?: string;
  showVersion?: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let sandbox: SandboxConfig = { type: "host" };
  let workingDir: string | undefined;
  let stateDirArg: string | undefined;
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
    } else if (arg.startsWith("--state-dir=")) {
      stateDirArg = arg.slice("--state-dir=".length);
    } else if (arg === "--state-dir") {
      stateDirArg = args[++i];
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
    stateDir: stateDirArg ? resolve(stateDirArg) : undefined,
    sandbox,
    downloadChannel: downloadChannelId,
    showVersion,
  };
}

function handleStartupError(error: unknown): never {
  if (error instanceof SandboxError) {
    for (const line of error.formatForCli()) {
      console.error(line);
    }
    process.exit(1);
  }
  throw error;
}

let parsedArgs: ParsedArgs;
try {
  parsedArgs = parseArgs();
} catch (error) {
  handleStartupError(error);
}

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
    "Usage: mama [--sandbox=host|container:<name>|image:<image>|firecracker:<vm-id>:<host-path>] [--state-dir=<path>] <working-directory>",
  );
  console.error("       mama --download <channel-id>");
  process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };
// stateDir holds operator-managed files (vaults, settings, bindings).
// Defaults to ~/.mama to keep secrets outside the project workspace mounted into sandboxes.
const stateDir = parsedArgs.stateDir ?? join(homedir(), ".mama");
// Share stateDir with instrument.ts (for Sentry config loading)
process.env.MAMA_STATE_DIR = stateDir;

// Ensure settings.json exists; create a template if first run.
const { created: settingsCreated, config: agentSettings } = ensureSettingsFile(stateDir);
if (settingsCreated) {
  console.log(`Created default settings: ${join(stateDir, "settings.json")}`);
  console.log("Review and update provider/model before starting.");
}

if (!agentSettings.provider || !agentSettings.model) {
  console.error(`Error: 'provider' and 'model' must be set in ${join(stateDir, "settings.json")}`);
  process.exit(1);
}

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

try {
  await validateSandbox(sandbox);
} catch (error) {
  handleStartupError(error);
}

const vaultManager = new FileVaultManager(stateDir);
if (vaultManager.isEnabled()) {
  console.log("  Vault system enabled. Per-user credential routing active.");
}

const bindingStore = new FileUserBindingStore(stateDir);
if (bindingStore.isEnabled()) {
  console.log("  Binding store enabled. Platform user → vault routing active.");
}

const provisioner =
  sandbox.type === "image" ? new DockerContainerManager(sandbox.image, workingDir) : undefined;

const linkTokenStore = new InMemoryLinkTokenStore();

// Purge expired link tokens every 5 minutes
setInterval(() => linkTokenStore.purge(), 5 * 60 * 1000).unref();

// ============================================================================
// State (per conversation)
// ============================================================================

interface ConversationState {
  running: boolean;
  runner: AgentRunner;
  stopRequested: boolean;
  stopMessageTs?: string;
  lastAccessedAt: number;
  startedAt?: number;
  lastActivityAt?: number;
}

const conversationStates = new Map<string, ConversationState>();

/** Track in-flight runs for graceful shutdown */
const inFlightRuns = new Set<Promise<void>>();

/** Flag to stop accepting new events during shutdown */
let isShuttingDown = false;

/** Maximum number of cached sessions */
const MAX_SESSIONS = 500;
/** Idle timeout before a non-running session can be evicted (10 minutes) */
const IDLE_TIMEOUT_MS = 600000;

if (provisioner) {
  await provisioner.reconcile();
  await provisioner.stopIdle(IDLE_TIMEOUT_MS);
}

// Stop idle containers every hour (same cadence as session eviction)
if (provisioner) {
  setInterval(() => provisioner.stopIdle(IDLE_TIMEOUT_MS), IDLE_TIMEOUT_MS).unref();
}

function normalizeLoginBaseUrl(): string | undefined {
  if (MOM_LINK_URL) {
    return MOM_LINK_URL.replace(/\/+$/, "");
  }
  if (MOM_LINK_PORT) {
    return `http://localhost:${MOM_LINK_PORT}`;
  }
  return undefined;
}

function ensureLoginVault(platform: string, platformUserId: string): string {
  const vaultId = resolveActorVaultKey(
    sandbox,
    vaultManager,
    bindingStore,
    platform,
    platformUserId,
  );

  if (sandbox.type === "image") {
    ensureImageSandboxVault(sandbox, vaultManager, platform, platformUserId, vaultId);
  } else {
    vaultManager.addEntry(
      vaultId,
      createManagedVaultEntry(platform, platformUserId, vaultId, false),
    );
  }

  return vaultId;
}

async function getState(conversationId: string, sessionKey?: string): Promise<ConversationState> {
  const key = sessionKey ?? conversationId;
  let state = conversationStates.get(key);
  if (!state) {
    const conversationDir = join(workingDir, conversationId);
    state = {
      running: false,
      runner: await createRunner(
        sandbox,
        key,
        conversationId,
        conversationDir,
        workingDir,
        vaultManager,
        bindingStore,
        provisioner,
        stateDir,
      ),
      stopRequested: false,
      lastAccessedAt: Date.now(),
    };
    conversationStates.set(key, state);
  } else {
    state.lastAccessedAt = Date.now();
  }
  return state;
}

/**
 * Evict idle sessions from conversationStates to bound memory usage.
 * Called after each handleEvent completes.
 */
function evictIdleSessions(): void {
  const now = Date.now();

  for (const [key, state] of conversationStates) {
    if (!state.running && now - state.lastAccessedAt > IDLE_TIMEOUT_MS) {
      conversationStates.delete(key);
    }
  }

  if (conversationStates.size > MAX_SESSIONS) {
    const idleSessions: Array<{ key: string; lastAccessedAt: number }> = [];
    for (const [key, state] of conversationStates) {
      if (!state.running) {
        idleSessions.push({ key, lastAccessedAt: state.lastAccessedAt });
      }
    }

    idleSessions.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    const toEvict = conversationStates.size - MAX_SESSIONS;
    for (let i = 0; i < toEvict && i < idleSessions.length; i++) {
      conversationStates.delete(idleSessions[i].key);
    }
  }
}

// ============================================================================
// Handler
// ============================================================================

const handler: BotHandler = {
  isRunning(sessionKey: string): boolean {
    const state = conversationStates.get(sessionKey);
    return !!state?.running;
  },

  getRunningSessions() {
    const sessions: import("./adapter.js").RunningSession[] = [];
    for (const [sessionKey, state] of conversationStates) {
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

  async handleStop(sessionKey: string, conversationId: string, bot: Bot): Promise<void> {
    const state = conversationStates.get(sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
      const ts = await bot.postMessage(conversationId, formatStopping(bot));
      state.stopMessageTs = ts;
    } else {
      await bot.postMessage(conversationId, formatNothingRunning(bot));
    }
  },

  forceStop(sessionKey: string): void {
    const state = conversationStates.get(sessionKey);
    if (state?.running) {
      log.logInfo(`[Force Stop] Force stopping session: ${sessionKey}`);
      state.stopRequested = true;
      state.runner.abort();
      state.running = false;
    }
  },

  async handleNew(sessionKey: string, conversationId: string, bot: Bot): Promise<void> {
    const state = conversationStates.get(sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
    }

    // Channel sessions rotate via current pointer. Thread sessions reset in place.
    const conversationDir = join(workingDir, conversationId);
    if (sessionKey.includes(":")) {
      createManagedSessionFileAtPath(
        getThreadSessionFile(conversationDir, sessionKey),
        conversationDir,
      );
    } else {
      createManagedSessionFile(getChannelSessionDir(conversationDir), conversationDir);
    }

    // Remove from in-memory cache
    conversationStates.delete(sessionKey);

    log.logInfo(`[${conversationId}] Session reset: ${sessionKey}`);
    await bot.postMessage(conversationId, "Conversation reset. Send a new message to start fresh.");
  },

  async handleLogin(
    platform: string,
    platformUserId: string,
    conversationId: string,
    bot: Bot,
    commandText: string,
    isPrivateConversation: boolean,
  ): Promise<void> {
    const parsed = parseLoginCommand(commandText);
    if (!parsed) {
      return;
    }

    if (!isPrivateConversation) {
      await bot.postMessage(
        conversationId,
        "为了保护你的凭证，`/login` 只能在与机器人的私聊中使用。请先私信机器人，再重新执行 `/login`。",
      );
      return;
    }

    const baseUrl = normalizeLoginBaseUrl();
    if (!baseUrl) {
      await bot.postMessage(
        conversationId,
        "Login is not configured. Set `MOM_LINK_URL` or `MOM_LINK_PORT` on the server.",
      );
      return;
    }

    let vaultId: string;
    try {
      vaultId = ensureLoginVault(platform, platformUserId);
    } catch (error) {
      log.logWarning(
        `[${conversationId}] Failed to prepare login vault for ${platform}/${platformUserId}`,
        error instanceof Error ? error.message : String(error),
      );
      await bot.postMessage(
        conversationId,
        "Login setup failed on the server. 请稍后重试，或联系管理员检查 vault 存储权限。",
      );
      return;
    }

    const loginLabel = "credential";
    await bot.postMessage(
      conversationId,
      `Open this link to store ${loginLabel} in your personal vault ` +
        `(expires in 15 minutes):\n${baseUrl}/link?token=${
          linkTokenStore.create(
            platform as "slack" | "discord" | "telegram",
            platformUserId,
            conversationId,
            vaultId,
            "",
          ).token
        }`,
    );
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
        `[${event.conversationId}] Rejected event during shutdown: ${event.text.substring(0, 50)}`,
      );
      return;
    }

    const sessionKey = event.sessionKey ?? `${event.conversationId}:${event.thread_ts ?? event.ts}`;
    const state = await getState(event.conversationId, sessionKey);

    // Start run
    state.running = true;
    state.stopRequested = false;
    state.startedAt = Date.now();
    state.lastActivityAt = Date.now();

    log.logInfo(`[${event.conversationId}] Starting run: ${event.text.substring(0, 50)}`);

    // Wrap in-flight run tracking
    Sentry.metrics.count("agent.run.started", 1, {
      attributes: { channel: event.conversationId },
    });
    Sentry.metrics.gauge("agent.sessions.active", inFlightRuns.size + 1);

    const runPromise = Sentry.startSpan(
      {
        name: "agent.run",
        op: "agent",
        attributes: { channelId: event.conversationId, sessionKey },
      },
      async () => {
        return Sentry.withScope(async (scope) => {
          const { message, responseCtx, platform } = adapters;
          applyRunScope(scope, {
            conversationId: event.conversationId,
            sessionKey,
            messageId: message.id,
            platform: platform.name,
            userId: message.userId,
            userName: message.userName,
            threadTs: message.threadTs,
            isEvent: _isEvent,
          });
          addLifecycleBreadcrumb("agent.run.started", {
            channel_id: event.conversationId,
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
                channel: event.conversationId,
                platform: platform.name,
                stop_reason: result.stopReason,
              },
            });
            Sentry.metrics.count("agent.run.completed", 1, {
              attributes: {
                channel: event.conversationId,
                platform: platform.name,
                stop_reason: result.stopReason,
              },
            });
            addLifecycleBreadcrumb("agent.run.completed", {
              channel_id: event.conversationId,
              platform: platform.name,
              stop_reason: result.stopReason,
              duration_ms: durationMs,
            });

            if (result.stopReason === "aborted" && state.stopRequested) {
              if (state.stopMessageTs) {
                await bot.updateMessage(event.conversationId, state.stopMessageTs, "_Stopped_");
                state.stopMessageTs = undefined;
              } else {
                await bot.postMessage(event.conversationId, "_Stopped_");
              }
            }
          } catch (err) {
            scope.setContext("agent_run_error", {
              conversationId: event.conversationId,
              sessionKey,
              platform: adapters.platform.name,
              messageId: adapters.message.id,
              threadTs: adapters.message.threadTs,
            });
            Sentry.captureException(err);
            Sentry.metrics.count("agent.run.errors", 1, {
              attributes: { channel: event.conversationId, platform: adapters.platform.name },
            });
            log.logWarning(
              `[${event.conversationId}] Run error`,
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
    : sandbox.type === "container"
      ? `container:${sandbox.container}`
      : sandbox.type === "image"
        ? `image:${sandbox.image}`
        : `firecracker:${sandbox.vmId}`;
log.logStartup(workingDir, sandboxDesc);

// Start link callback server if port is configured
if (MOM_LINK_PORT) {
  startLinkServer(
    MOM_LINK_PORT,
    linkTokenStore,
    vaultManager,
    async (platform, conversationId, msg) => {
      const bot = botsByPlatform[platform];
      if (bot) await bot.postMessage(conversationId, msg);
    },
  );
}

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
