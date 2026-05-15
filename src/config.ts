import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "./file-guards.js";
import { atomicWritePrivateFile } from "./fs-atomic.js";

export class MissingGlobalSettingsError extends Error {
  constructor(public readonly settingsPath: string) {
    super(`Missing global settings file at ${settingsPath}`);
    this.name = "MissingGlobalSettingsError";
  }
}

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  logFormat: "console" | "json";
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  sentryDsn?: string;
  sandboxCpus?: string;
  sandboxMemory?: string;
  sandboxBoostCpus?: string;
  sandboxBoostMemory?: string;
  sandboxImageWorkspaceMount?: "private" | "full";
}

export interface AutoReplyConfig {
  enabled: boolean;
  rules: string[];
}

const ONBOARD_SETTINGS: SettingsFileConfig = {
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    thinkingLevel: "off",
  },
  log: {
    format: "console",
    level: "info",
  },
  sandbox: {
    cpus: "0.5",
    memory: "1g",
    boost: {
      cpus: "2",
      memory: "4g",
    },
    image: {
      workspaceMount: "private",
    },
  },
};

interface SettingsFileConfig {
  llm?: Partial<Pick<AgentConfig, "provider" | "model" | "thinkingLevel">>;
  log?: { format?: AgentConfig["logFormat"]; level?: AgentConfig["logLevel"] };
  sentry?: { dsn?: string };
  sandbox?: {
    cpus?: string;
    memory?: string;
    boost?: { cpus?: string; memory?: string };
    image?: { workspaceMount?: AgentConfig["sandboxImageWorkspaceMount"] };
  };
  autoReply?: {
    enabled?: boolean;
    rules?: string[];
  };
}

function loadSettingsFile(settingsPath: string): SettingsFileConfig | undefined {
  return readJsonFileIfExists(
    settingsPath,
    (value): value is SettingsFileConfig => isRecord(value),
    (detail) =>
      detail === "unexpected JSON shape"
        ? `Malformed settings file at ${settingsPath}: expected a JSON object at the top level`
        : `Malformed settings file at ${settingsPath}: ${detail}`,
  );
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
    ...(config.sandbox?.boost?.cpus !== undefined
      ? { sandboxBoostCpus: config.sandbox.boost.cpus }
      : {}),
    ...(config.sandbox?.boost?.memory !== undefined
      ? { sandboxBoostMemory: config.sandbox.boost.memory }
      : {}),
    ...(config.sandbox?.image?.workspaceMount !== undefined
      ? { sandboxImageWorkspaceMount: config.sandbox.image.workspaceMount }
      : {}),
  };
}

function getSettingsPath(): string {
  return join(getStateDir(), "settings.json");
}

function requireGlobalSettings(): SettingsFileConfig {
  const settingsPath = getSettingsPath();
  const config = loadSettingsFile(settingsPath);
  if (!config) {
    throw new MissingGlobalSettingsError(settingsPath);
  }
  return config;
}

function requireString(value: string | undefined, path: string): string {
  if (!value) {
    throw new Error(
      `Missing required global setting: ${path}. Run \`mama --onboard\` to create settings.json.`,
    );
  }
  return value;
}

function requireThinkingLevel(value: ThinkingLevel | undefined): ThinkingLevel {
  return requireString(value, "llm.thinkingLevel") as ThinkingLevel;
}

function requireLogFormat(value: AgentConfig["logFormat"] | undefined): AgentConfig["logFormat"] {
  if (value !== "console" && value !== "json") {
    throw new Error("Missing or invalid required global setting: log.format");
  }
  return value;
}

function requireLogLevel(value: AgentConfig["logLevel"] | undefined): AgentConfig["logLevel"] {
  const allowed = ["trace", "debug", "info", "warn", "error"];
  if (!value || !allowed.includes(value)) {
    throw new Error("Missing or invalid required global setting: log.level");
  }
  return value;
}

function toAgentConfig(fromFile: Partial<AgentConfig>): AgentConfig {
  const provider = requireString(fromFile.provider, "llm.provider");
  const model = requireString(fromFile.model, "llm.model");
  const thinkingLevel = requireThinkingLevel(fromFile.thinkingLevel);
  const logFormat = requireLogFormat(fromFile.logFormat);
  const logLevel = requireLogLevel(fromFile.logLevel);
  const sentryDsn = fromFile.sentryDsn ?? process.env.SENTRY_DSN;
  const sandboxCpus = fromFile.sandboxCpus;
  const sandboxMemory = fromFile.sandboxMemory;
  const sandboxBoostCpus = fromFile.sandboxBoostCpus;
  const sandboxBoostMemory = fromFile.sandboxBoostMemory;
  const sandboxImageWorkspaceMount = fromFile.sandboxImageWorkspaceMount;

  return {
    provider,
    model,
    thinkingLevel,
    logFormat,
    logLevel,
    sentryDsn,
    sandboxCpus,
    sandboxMemory,
    sandboxBoostCpus,
    sandboxBoostMemory,
    sandboxImageWorkspaceMount,
  };
}

function loadRawAgentConfig(): Partial<AgentConfig> {
  return normalizeSettingsConfig(requireGlobalSettings());
}

export function loadAgentConfig(): AgentConfig {
  return toAgentConfig(loadRawAgentConfig());
}

export function loadAgentConfigForConversation(conversationDir: string): AgentConfig {
  const globalConfig = loadRawAgentConfig();
  const conversationConfig = normalizeSettingsConfig(
    loadSettingsFile(join(conversationDir, "settings.json")) ?? {},
  );
  return toAgentConfig({ ...globalConfig, ...conversationConfig });
}

export function saveConversationModelConfig(
  conversationDir: string,
  config: Pick<AgentConfig, "provider" | "model"> & Partial<Pick<AgentConfig, "thinkingLevel">>,
): void {
  if (!existsSync(conversationDir)) {
    ensureDirExists(conversationDir);
  }
  const settingsPath = join(conversationDir, "settings.json");
  const existing = loadSettingsFile(settingsPath) ?? {};
  const scopedConfig: SettingsFileConfig = {
    ...existing,
    llm: { ...existing.llm, ...config },
  };
  atomicWritePrivateFile(settingsPath, JSON.stringify(scopedConfig, null, 2));
}

export function saveConversationSandboxConfig(
  conversationDir: string,
  config: { imageWorkspaceMount: AgentConfig["sandboxImageWorkspaceMount"] },
): void {
  if (!existsSync(conversationDir)) {
    ensureDirExists(conversationDir);
  }
  const settingsPath = join(conversationDir, "settings.json");
  const existing = loadSettingsFile(settingsPath) ?? {};
  const scopedConfig: SettingsFileConfig = {
    ...existing,
    sandbox: {
      ...existing.sandbox,
      image: {
        ...existing.sandbox?.image,
        workspaceMount: config.imageWorkspaceMount,
      },
    },
  };
  atomicWritePrivateFile(settingsPath, JSON.stringify(scopedConfig, null, 2));
}

export function loadConversationAutoReplyConfig(conversationDir: string): AutoReplyConfig {
  const settings = loadSettingsFile(join(conversationDir, "settings.json")) ?? {};
  const rules = Array.isArray(settings.autoReply?.rules)
    ? settings.autoReply.rules.filter((rule): rule is string => typeof rule === "string")
    : [];
  return {
    enabled: settings.autoReply?.enabled === true,
    rules,
  };
}

export function saveConversationAutoReplyConfig(
  conversationDir: string,
  config: AutoReplyConfig,
): void {
  if (!existsSync(conversationDir)) {
    ensureDirExists(conversationDir);
  }
  const settingsPath = join(conversationDir, "settings.json");
  const existing = loadSettingsFile(settingsPath) ?? {};
  const scopedConfig: SettingsFileConfig = {
    ...existing,
    autoReply: {
      enabled: config.enabled,
      rules: config.rules,
    },
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

    if (arg === "--version" || arg === "-v" || arg === "-V" || arg === "--onboard") {
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
  const fromFile = normalizeSettingsConfig(loadSettingsFile(getSettingsPath()) ?? {});
  if (fromFile.sentryDsn) {
    return fromFile.sentryDsn;
  }

  return process.env.SENTRY_DSN;
}

export function createGlobalSettingsFile(stateDir: string): string {
  const settingsPath = join(stateDir, "settings.json");
  if (existsSync(settingsPath)) {
    throw new Error(`Global settings already exists at ${settingsPath}`);
  }
  if (!existsSync(stateDir)) {
    ensureDirExists(stateDir);
  }
  atomicWritePrivateFile(settingsPath, JSON.stringify(ONBOARD_SETTINGS, null, 2));
  return settingsPath;
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
    ...(hasDefinedValue(config.autoReply) ? { autoReply: config.autoReply } : {}),
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
      ...(config.sandboxBoostCpus !== undefined || config.sandboxBoostMemory !== undefined
        ? {
            boost: {
              ...existing.sandbox?.boost,
              ...(config.sandboxBoostCpus !== undefined ? { cpus: config.sandboxBoostCpus } : {}),
              ...(config.sandboxBoostMemory !== undefined
                ? { memory: config.sandboxBoostMemory }
                : {}),
            },
          }
        : {}),
    },
  };
  return compactSettingsConfig(patched);
}

export function saveAgentConfig(config: Partial<AgentConfig>): void {
  const settingsPath = join(getStateDir(), "settings.json");

  let existing: SettingsFileConfig = ONBOARD_SETTINGS;
  if (existsSync(settingsPath)) {
    try {
      existing = loadSettingsFile(settingsPath) ?? {};
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const message = detail.startsWith("Malformed settings file")
        ? detail.replace("Malformed settings file", "Refusing to overwrite malformed settings file")
        : detail;
      throw new Error(message, { cause: err });
    }
  }

  const merged = patchSettingsConfig(existing, config);

  const dir = dirname(settingsPath);
  ensureDirExists(dir);

  atomicWritePrivateFile(settingsPath, JSON.stringify(merged, null, 2));
}
