import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface AgentConfig {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  sessionScope?: "thread" | "channel";
  logFormat?: "console" | "json";
  logLevel?: "trace" | "debug" | "info" | "warn" | "error";
  sentryDsn?: string;
}

const SETTINGS_TEMPLATE: AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  thinkingLevel: "off",
  sessionScope: "thread",
  logFormat: "console",
  logLevel: "info",
};

export function loadAgentConfig(stateDir: string): AgentConfig {
  const settingsPath = join(stateDir, "settings.json");
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as AgentConfig;
    }
  } catch {
    // File missing or malformed
  }
  return {};
}

/**
 * Ensure settings.json exists in stateDir.
 * If missing, writes a default template and returns it.
 * If it already exists, loads and returns the current config.
 */
export function ensureSettingsFile(stateDir: string): { created: boolean; config: AgentConfig } {
  const settingsPath = join(stateDir, "settings.json");
  if (!existsSync(settingsPath)) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(SETTINGS_TEMPLATE, null, 2) + "\n", "utf-8");
    return { created: true, config: SETTINGS_TEMPLATE };
  }
  return { created: false, config: loadAgentConfig(stateDir) };
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

export function resolveSentryDsn(stateDir: string): string | undefined {
  return loadAgentConfig(stateDir).sentryDsn;
}

/**
 * Resolve Sentry DSN from settings.json, checking both the new stateDir location
 * (default: ~/.mama/settings.json) and the legacy workspace location for backwards compatibility.
 * Returns undefined if not found in either location.
 */
export function resolveSentryDsnFromConfig(
  stateDir: string,
  workingDir?: string,
): string | undefined {
  // First check the new stateDir location
  const stateDirDsn = resolveSentryDsn(stateDir);
  if (stateDirDsn) {
    return stateDirDsn;
  }
  // Fall back to legacy workspace location for backwards compatibility
  return workingDir ? resolveSentryDsn(workingDir) : undefined;
}

export function saveAgentConfig(stateDir: string, config: AgentConfig): void {
  const settingsPath = join(stateDir, "settings.json");

  let existing: AgentConfig = {};
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      existing = parsed as AgentConfig;
    }
  } catch {
    // Start fresh if file is missing or malformed
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ ...existing, ...config }, null, 2), "utf-8");
}
