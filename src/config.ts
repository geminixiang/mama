import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel?: string;
  sessionScope?: "thread" | "channel";
  maxUsersInPrompt?: number;
}

const DEFAULTS: AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  sessionScope: "thread",
  maxUsersInPrompt: 50,
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
  const maxUsersInPrompt = fromFile.maxUsersInPrompt ?? DEFAULTS.maxUsersInPrompt;

  return { provider, model, thinkingLevel, sessionScope, maxUsersInPrompt };
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
