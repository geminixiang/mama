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
  let fromFile: AgentConfig = {};
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      fromFile = parsed as AgentConfig;
    }
  } catch {
    // File missing or malformed
  }
  return applyEnvOverrides(fromFile);
}

function applyEnvOverrides(config: AgentConfig): AgentConfig {
  return {
    ...config,
    provider: process.env.MOM_AI_PROVIDER ?? config.provider,
    model: process.env.MOM_AI_MODEL ?? config.model,
  };
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
    return { created: true, config: applyEnvOverrides(SETTINGS_TEMPLATE) };
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
 * Externally-visible base URL of the link/OAuth server, e.g.
 * `https://mama.example.com` (no trailing slash). Read from `MOM_LINK_URL`,
 * the same env var the bot uses to build `/link?token=...` invitations.
 *
 * Used by the link server to build OAuth `redirect_uri` values that must
 * match the registered callback URL at the identity provider. When unset,
 * the link server falls back to deriving the base from request headers
 * (Host / X-Forwarded-*), which is insecure in production because those
 * headers are client-controlled.
 */
export function resolveLinkBaseUrl(): string | undefined {
  const raw = process.env.MOM_LINK_URL?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
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
