import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel?: string;
  sessionScope?: "thread" | "channel";
  logFormat?: "console" | "json";
  logLevel?: "trace" | "debug" | "info" | "warn" | "error";
  sentryDsn?: string;
}

const DEFAULTS: AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  sessionScope: "thread",
  logFormat: "console",
  logLevel: "info",
};

function loadConfigFile(settingsPath: string): Partial<AgentConfig> | undefined {
  if (!existsSync(settingsPath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Partial<AgentConfig>;
    }
  } catch {
    // Ignore parse errors, fall through to next candidate
  }

  return undefined;
}

function getConfiguredStateDir(): string | undefined {
  const raw = process.env.MAMA_STATE_DIR?.trim();
  return raw ? resolve(raw) : undefined;
}

function loadRawAgentConfig(workspaceDir?: string): Partial<AgentConfig> {
  const stateDir = getConfiguredStateDir();
  const candidates = [
    ...(stateDir ? [join(stateDir, "settings.json")] : []),
    ...(workspaceDir ? [join(workspaceDir, "settings.json")] : []),
  ];

  for (const settingsPath of candidates) {
    const config = loadConfigFile(settingsPath);
    if (config) {
      return config;
    }
  }

  return {};
}

export function loadAgentConfig(workspaceDir: string): AgentConfig {
  const fromFile = loadRawAgentConfig(workspaceDir);

  const provider = fromFile.provider || process.env.MOM_AI_PROVIDER || DEFAULTS.provider;
  const model = fromFile.model || process.env.MOM_AI_MODEL || DEFAULTS.model;
  const thinkingLevel = fromFile.thinkingLevel ?? DEFAULTS.thinkingLevel;
  const sessionScope = fromFile.sessionScope ?? DEFAULTS.sessionScope;
  const logFormat = fromFile.logFormat ?? DEFAULTS.logFormat;
  const logLevel = fromFile.logLevel ?? DEFAULTS.logLevel;
  const sentryDsn = fromFile.sentryDsn ?? process.env.SENTRY_DSN;

  return { provider, model, thinkingLevel, sessionScope, logFormat, logLevel, sentryDsn };
}

export function resolveWorkspaceDirFromArgv(args = process.argv.slice(2)): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--sandbox" || arg === "--download" || arg === "--state-dir") {
      i += 1;
      continue;
    }

    if (arg === "--version" || arg === "-v" || arg === "-V") {
      continue;
    }

    if (
      arg.startsWith("--sandbox=") ||
      arg.startsWith("--download=") ||
      arg.startsWith("--state-dir=")
    ) {
      continue;
    }

    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return undefined;
}

export function resolveStateDirFromArgv(args = process.argv.slice(2)): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--state-dir=")) {
      return resolve(arg.slice("--state-dir=".length));
    }
    if (arg === "--state-dir") {
      return resolve(args[++i] || "");
    }
  }

  return join(homedir(), ".mama");
}

export function resolveSentryDsn(workspaceDir?: string): string | undefined {
  const fromFile = loadRawAgentConfig(workspaceDir);
  if (fromFile.sentryDsn) {
    return fromFile.sentryDsn;
  }

  return process.env.SENTRY_DSN;
}

/**
 * Externally-visible base URL of the link/OAuth server, e.g.
 * `https://mama.example.com` (no trailing slash). Read from `MOM_LINK_URL`,
 * the same env var the bot uses to build credential onboarding links.
 */
export function resolveLinkBaseUrl(): string | undefined {
  const raw = process.env.MOM_LINK_URL?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

export function saveAgentConfig(workspaceDir: string, config: Partial<AgentConfig>): void {
  const settingsPath = join(workspaceDir, "settings.json");

  let existing: Partial<AgentConfig> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        existing = parsed as Partial<AgentConfig>;
      }
    } catch {
      // Start fresh if file is malformed
    }
  }

  const merged = { ...existing, ...config };

  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf-8");
}
