import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Environment Config
// ============================================================================

export interface EnvConfig {
  // Bot tokens
  slackAppToken?: string;
  slackBotToken?: string;
  telegramBotToken?: string;
  discordBotToken?: string;
  // Google OAuth
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
  googleOAuthRedirectUri?: string;
  googleCloudProject?: string;
  googleOAuthPort?: number;
}

export function loadEnvConfig(): EnvConfig {
  return {
    // Bot tokens
    slackAppToken: process.env.MOM_SLACK_APP_TOKEN,
    slackBotToken: process.env.MOM_SLACK_BOT_TOKEN,
    telegramBotToken: process.env.MOM_TELEGRAM_BOT_TOKEN,
    discordBotToken: process.env.MOM_DISCORD_BOT_TOKEN,
    // Google OAuth
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    googleOAuthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT,
    googleOAuthPort: process.env.GOOGLE_OAUTH_PORT
      ? parseInt(process.env.GOOGLE_OAUTH_PORT, 10)
      : undefined,
  };
}

// ============================================================================
// Agent Config
// ============================================================================

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel?: string;
  sessionScope?: "thread" | "channel";
  logFormat?: "console" | "json";
  logLevel?: "trace" | "debug" | "info" | "warn" | "error";
}

const DEFAULTS: AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  sessionScope: "thread",
  logFormat: "console",
  logLevel: "info",
};

export function loadAgentConfig(workspaceDir: string): AgentConfig {
  const settingsPath = join(workspaceDir, "settings.json");

  let fromFile: Partial<AgentConfig> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        fromFile = parsed as Partial<AgentConfig>;
      }
    } catch {
      // Ignore parse errors, fall through to env/defaults
    }
  }

  const provider = fromFile.provider || process.env.MOM_AI_PROVIDER || DEFAULTS.provider;
  const model = fromFile.model || process.env.MOM_AI_MODEL || DEFAULTS.model;
  const thinkingLevel = fromFile.thinkingLevel ?? DEFAULTS.thinkingLevel;
  const sessionScope = fromFile.sessionScope ?? DEFAULTS.sessionScope;
  const logFormat = fromFile.logFormat ?? DEFAULTS.logFormat;
  const logLevel = fromFile.logLevel ?? DEFAULTS.logLevel;

  return { provider, model, thinkingLevel, sessionScope, logFormat, logLevel };
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
