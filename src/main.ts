#!/usr/bin/env node

import "./instrument.js";

import { join, resolve } from "path";
import { mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname, join as pathJoin } from "path";
import type { Bot } from "./adapter.js";
import { DiscordBot } from "./adapters/discord/index.js";
import { TelegramBot } from "./adapters/telegram/index.js";
import { SlackBot as SlackBotClass } from "./adapters/slack/index.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { FileUserBindingStore } from "./bindings.js";
import { startLinkServer } from "./login/portal.js";
import { InMemoryLinkTokenStore } from "./login/session.js";
import { InMemorySessionViewTokenStore } from "./session-view/store.js";
import { DockerContainerManager } from "./provisioner.js";
import { loadAgentConfig } from "./config.js";
import { SandboxError, parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { FileVaultManager } from "./vault.js";
import { createSessionRuntime } from "./runtime/index.js";
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

const MAMA_SLACK_APP_TOKEN = process.env.MAMA_SLACK_APP_TOKEN;
const MAMA_SLACK_BOT_TOKEN = process.env.MAMA_SLACK_BOT_TOKEN;
const MAMA_TELEGRAM_BOT_TOKEN = process.env.MAMA_TELEGRAM_BOT_TOKEN;
const MAMA_DISCORD_BOT_TOKEN = process.env.MAMA_DISCORD_BOT_TOKEN;
const MAMA_LINK_URL = process.env.MAMA_LINK_URL;
const MAMA_LINK_PORT = process.env.MAMA_LINK_PORT
  ? parseInt(process.env.MAMA_LINK_PORT, 10)
  : MAMA_LINK_URL
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

const WORLD_WRITABLE_MODE = 0o002;

function ensureSecureStateDir(path: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return;
    }
    console.error(`Error: cannot access --state-dir ${path}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!stat.isDirectory()) {
    console.error(`Error: --state-dir ${path} exists but is not a directory`);
    process.exit(1);
  }

  if (stat.mode & WORLD_WRITABLE_MODE) {
    console.error(
      `Error: --state-dir ${path} is world-writable (mode ${(stat.mode & 0o777).toString(8)}). ` +
        `Credentials stored there would be exposed to other local users. ` +
        `Fix with: chmod 0700 ${path}`,
    );
    process.exit(1);
  }

  const euid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (euid !== undefined && stat.uid !== euid) {
    console.error(
      `Error: --state-dir ${path} is owned by uid ${stat.uid} but mama is running as uid ${euid}. ` +
        `Run mama as the directory owner or point --state-dir at a directory you own.`,
    );
    process.exit(1);
  }
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
  if (!MAMA_SLACK_BOT_TOKEN) {
    console.error("Missing env: MAMA_SLACK_BOT_TOKEN");
    process.exit(1);
  }
  await downloadChannel(parsedArgs.downloadChannel, MAMA_SLACK_BOT_TOKEN);
  process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
  console.error(
    "Usage: mama [--state-dir=<dir>] [--sandbox=host|container:<name>|image:<image>|firecracker:<vm-id>:<host-path>|cloudflare:<sandbox-id>] <working-directory>",
  );
  console.error("       mama --download <channel-id>");
  process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };
const stateDir = parsedArgs.stateDir ?? join(homedir(), ".mama");
process.env.MAMA_STATE_DIR = stateDir;
ensureSecureStateDir(stateDir);

// Validate platform tokens
const hasSlack = !!(MAMA_SLACK_APP_TOKEN && MAMA_SLACK_BOT_TOKEN);
const hasTelegram = !!MAMA_TELEGRAM_BOT_TOKEN;
const hasDiscord = !!MAMA_DISCORD_BOT_TOKEN;

if (!hasSlack && !hasTelegram && !hasDiscord) {
  console.error(
    "No platform tokens found. Set one of:\n" +
      "  Slack:    MAMA_SLACK_APP_TOKEN + MAMA_SLACK_BOT_TOKEN\n" +
      "  Telegram: MAMA_TELEGRAM_BOT_TOKEN\n" +
      "  Discord:  MAMA_DISCORD_BOT_TOKEN",
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
  console.log(
    sandbox.type === "container"
      ? "  Vault system enabled. Container vault active."
      : sandbox.type === "image" || sandbox.type === "firecracker" || sandbox.type === "cloudflare"
        ? "  Vault system enabled. Per-user credential routing active."
        : "  Vault system enabled. Host mode will not inject vault env.",
  );
}

const bindingStore = new FileUserBindingStore(stateDir);
if (bindingStore.isEnabled()) {
  console.log(
    sandbox.type === "container"
      ? "  Binding store enabled. Container mode uses the container vault."
      : sandbox.type === "image" || sandbox.type === "firecracker" || sandbox.type === "cloudflare"
        ? "  Binding store enabled. Platform user → vault routing active."
        : "  Binding store enabled. Host mode will not inject vault env.",
  );
}

const startupConfig = loadAgentConfig(workingDir);
const sandboxLimits =
  startupConfig.sandboxCpus || startupConfig.sandboxMemory
    ? { cpus: startupConfig.sandboxCpus, memory: startupConfig.sandboxMemory }
    : undefined;

const provisioner =
  sandbox.type === "image"
    ? new DockerContainerManager(sandbox.image, workingDir, { limits: sandboxLimits })
    : undefined;

const linkTokenStore = new InMemoryLinkTokenStore();
const sessionViewTokenStore = new InMemorySessionViewTokenStore();
setInterval(() => linkTokenStore.purge(), 5 * 60 * 1000).unref();
setInterval(() => sessionViewTokenStore.purge(), 5 * 60 * 1000).unref();

function portalBaseUrl(): string | undefined {
  if (MAMA_LINK_URL) return MAMA_LINK_URL.replace(/\/+$/, "");
  if (MAMA_LINK_PORT) return `http://localhost:${MAMA_LINK_PORT}`;
  return undefined;
}
/** Idle timeout for managed image containers (10 minutes) */
const IMAGE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

if (provisioner) {
  await provisioner.reconcile();
  await provisioner.stopIdle(IMAGE_IDLE_TIMEOUT_MS);
  setInterval(() => provisioner.stopIdle(IMAGE_IDLE_TIMEOUT_MS), IMAGE_IDLE_TIMEOUT_MS).unref();
}
const handler = createSessionRuntime({
  workingDir,
  sandbox,
  vaultManager,
  bindingStore,
  provisioner,
  linkTokenStore,
  sessionViewTokenStore,
  portalBaseUrl: portalBaseUrl(),
});

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
        : sandbox.type === "firecracker"
          ? `firecracker:${sandbox.vmId}`
          : `cloudflare:${sandbox.sandboxId}`;
log.logStartup(workingDir, sandboxDesc);

// Create platform bots
const bots: Bot[] = [];
const botsByPlatform: Record<string, Bot> = {};

if (hasSlack) {
  const sharedStore = new ChannelStore({ workingDir, botToken: MAMA_SLACK_BOT_TOKEN! });
  const slackBot = new SlackBotClass(handler, {
    appToken: MAMA_SLACK_APP_TOKEN!,
    botToken: MAMA_SLACK_BOT_TOKEN!,
    workingDir,
    store: sharedStore,
  });
  bots.push(slackBot);
  botsByPlatform.slack = slackBot;
  log.logInfo("Platform: Slack");
}
if (hasTelegram) {
  const telegramBot = new TelegramBot(handler, {
    token: MAMA_TELEGRAM_BOT_TOKEN!,
    workingDir,
  });
  bots.push(telegramBot);
  botsByPlatform.telegram = telegramBot;
  log.logInfo("Platform: Telegram");
}
if (hasDiscord) {
  const discordBot = new DiscordBot(handler, {
    token: MAMA_DISCORD_BOT_TOKEN!,
    workingDir,
  });
  bots.push(discordBot);
  botsByPlatform.discord = discordBot;
  log.logInfo("Platform: Discord");
}

if (MAMA_LINK_PORT) {
  startLinkServer(
    MAMA_LINK_PORT,
    linkTokenStore,
    vaultManager,
    async (platform, conversationId, message) => {
      const bot = botsByPlatform[platform];
      if (bot) await bot.postMessage(conversationId, message);
    },
    sessionViewTokenStore,
  );
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
  await handler.shutdown();
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
