import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { atomicWritePrivateFile } from "./fs-atomic.js";

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel?: string;
  logFormat?: "console" | "json";
  logLevel?: "trace" | "debug" | "info" | "warn" | "error";
  sentryDsn?: string;
  sandboxCpus?: string;
  sandboxMemory?: string;
}

const DEFAULTS: AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  logFormat: "console",
  logLevel: "info",
};

interface SettingsFileConfig {
  llm?: Partial<Pick<AgentConfig, "provider" | "model" | "thinkingLevel">>;
  log?: { format?: AgentConfig["logFormat"]; level?: AgentConfig["logLevel"] };
  sentry?: { dsn?: string };
  sandbox?: { cpus?: string; memory?: string };
}

function loadSettingsFile(settingsPath: string): SettingsFileConfig | undefined {
  if (!existsSync(settingsPath)) {
    return undefined;
  }

  const raw = readFileSync(settingsPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed settings file at ${settingsPath}: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Malformed settings file at ${settingsPath}: expected a JSON object at the top level`,
    );
  }
  return parsed as SettingsFileConfig;
}

function getStateDir(): string {
  const raw = process.env.MAMA_STATE_DIR?.trim();
  return raw ? resolve(raw) : join(homedir(), ".mama");
}

function normalizeSettingsConfig(config: SettingsFileConfig): Partial<AgentConfig> {
  return {
    ...(config.llm?.provider !== undefined ? { provider: config.llm.provider } : {}),
    ...(config.llm?.model !== undefined ? { model: config.llm.model } : {}),
    ...(config.llm?.thinkingLevel !== undefined ? { thinkingLevel: config.llm.thinkingLevel } : {}),
    ...(config.log?.format !== undefined ? { logFormat: config.log.format } : {}),
    ...(config.log?.level !== undefined ? { logLevel: config.log.level } : {}),
    ...(config.sentry?.dsn !== undefined ? { sentryDsn: config.sentry.dsn } : {}),
    ...(config.sandbox?.cpus !== undefined ? { sandboxCpus: config.sandbox.cpus } : {}),
    ...(config.sandbox?.memory !== undefined ? { sandboxMemory: config.sandbox.memory } : {}),
  };
}

function loadRawAgentConfig(): Partial<AgentConfig> {
  return normalizeSettingsConfig(loadSettingsFile(join(getStateDir(), "settings.json")) ?? {});
}

function mergeAgentConfig(fromFile: Partial<AgentConfig>): AgentConfig {
  const provider = fromFile.provider || process.env.MAMA_AI_PROVIDER || DEFAULTS.provider;
  const model = fromFile.model || process.env.MAMA_AI_MODEL || DEFAULTS.model;
  const thinkingLevel = fromFile.thinkingLevel ?? DEFAULTS.thinkingLevel;
  const logFormat = fromFile.logFormat ?? DEFAULTS.logFormat;
  const logLevel = fromFile.logLevel ?? DEFAULTS.logLevel;
  const sentryDsn = fromFile.sentryDsn ?? process.env.SENTRY_DSN;
  const sandboxCpus = fromFile.sandboxCpus;
  const sandboxMemory = fromFile.sandboxMemory;

  return {
    provider,
    model,
    thinkingLevel,
    logFormat,
    logLevel,
    sentryDsn,
    sandboxCpus,
    sandboxMemory,
  };
}

export function loadAgentConfig(): AgentConfig {
  return mergeAgentConfig(loadRawAgentConfig());
}

export function loadAgentConfigForConversation(conversationDir: string): AgentConfig {
  const globalConfig = loadRawAgentConfig();
  const conversationConfig = normalizeSettingsConfig(
    loadSettingsFile(join(conversationDir, "settings.json")) ?? {},
  );
  return mergeAgentConfig({ ...globalConfig, ...conversationConfig });
}

export function saveConversationModelConfig(
  conversationDir: string,
  config: Pick<AgentConfig, "provider" | "model">,
): void {
  if (!existsSync(conversationDir)) {
    mkdirSync(conversationDir, { recursive: true });
  }
  const settingsPath = join(conversationDir, "settings.json");
  const existing = loadSettingsFile(settingsPath) ?? {};
  const scopedConfig: SettingsFileConfig = {
    ...existing,
    llm: { ...existing.llm, ...config },
  };
  atomicWritePrivateFile(settingsPath, JSON.stringify(scopedConfig, null, 2));
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

export function resolveSentryDsn(): string | undefined {
  const fromFile = loadRawAgentConfig();
  if (fromFile.sentryDsn) {
    return fromFile.sentryDsn;
  }

  return process.env.SENTRY_DSN;
}

/**
 * Externally-visible base URL of the link/OAuth server, e.g.
 * `https://mama.example.com` (no trailing slash). Read from `MAMA_LINK_URL`,
 * the same env var the bot uses to build credential onboarding links.
 */
export function resolveLinkBaseUrl(): string | undefined {
  const raw = process.env.MAMA_LINK_URL?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

function hasDefinedValue(values: Record<string, unknown> | undefined): boolean {
  return values !== undefined && Object.values(values).some((value) => value !== undefined);
}

function compactSettingsConfig(config: SettingsFileConfig): SettingsFileConfig {
  return {
    ...(hasDefinedValue(config.llm) ? { llm: config.llm } : {}),
    ...(hasDefinedValue(config.log) ? { log: config.log } : {}),
    ...(hasDefinedValue(config.sentry) ? { sentry: config.sentry } : {}),
    ...(hasDefinedValue(config.sandbox) ? { sandbox: config.sandbox } : {}),
  };
}

function patchSettingsConfig(
  existing: SettingsFileConfig,
  config: Partial<AgentConfig>,
): SettingsFileConfig {
  const patched: SettingsFileConfig = {
    ...existing,
    llm: {
      ...existing.llm,
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
    },
    log: {
      ...existing.log,
      ...(config.logFormat !== undefined ? { format: config.logFormat } : {}),
      ...(config.logLevel !== undefined ? { level: config.logLevel } : {}),
    },
    sentry: {
      ...existing.sentry,
      ...(config.sentryDsn !== undefined ? { dsn: config.sentryDsn } : {}),
    },
    sandbox: {
      ...existing.sandbox,
      ...(config.sandboxCpus !== undefined ? { cpus: config.sandboxCpus } : {}),
      ...(config.sandboxMemory !== undefined ? { memory: config.sandboxMemory } : {}),
    },
  };
  return compactSettingsConfig(patched);
}

export function saveAgentConfig(config: Partial<AgentConfig>): void {
  const settingsPath = join(getStateDir(), "settings.json");

  let existing: SettingsFileConfig = {};
  if (existsSync(settingsPath)) {
    try {
      existing = loadSettingsFile(settingsPath) ?? {};
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const message = detail.startsWith("Malformed settings file")
        ? detail.replace("Malformed settings file", "Refusing to overwrite malformed settings file")
        : detail;
      throw new Error(message);
    }
  }

  const merged = patchSettingsConfig(existing, config);

  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  atomicWritePrivateFile(settingsPath, JSON.stringify(merged, null, 2));
}
