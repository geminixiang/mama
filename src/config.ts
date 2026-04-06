import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

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

function loadRawAgentConfig(workspaceDir: string): Partial<AgentConfig> {
  const settingsPath = join(workspaceDir, "settings.json");

  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Partial<AgentConfig>;
    }
  } catch {
    // Ignore parse errors, fall through to env/defaults
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

    if (arg === "--sandbox" || arg === "--download") {
      i += 1;
      continue;
    }

    if (arg === "--version" || arg === "-v" || arg === "-V") {
      continue;
    }

    if (arg.startsWith("--sandbox=") || arg.startsWith("--download=")) {
      continue;
    }

    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return undefined;
}

export function resolveSentryDsn(workspaceDir?: string): string | undefined {
  if (workspaceDir) {
    const fromFile = loadRawAgentConfig(workspaceDir);
    if (fromFile.sentryDsn) {
      return fromFile.sentryDsn;
    }
  }

  return process.env.SENTRY_DSN;
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
