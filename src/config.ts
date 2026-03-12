import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel?: string;
  sessionScope?: "thread" | "channel";
  maxUsersInPrompt?: number;
  /**
   * Maximum number of LLM API calls that may be in-flight simultaneously
   * across all channels and users.  Excess requests queue and wait for a slot.
   * Lower values protect against provider rate-limit errors; higher values
   * increase throughput when the provider tier allows it.
   * Default: 20  (suitable for ~200 active users with typical conversation pace)
   */
  maxConcurrentRuns?: number;
  /**
   * How long (ms) cached memory-file and skills data remains valid before
   * being re-read from disk.  Longer values reduce I/O under load; shorter
   * values make manual edits to MEMORY.md / skills visible sooner.
   * Default: 30000 (30 seconds)
   */
  resourceCacheTtlMs?: number;
}

const DEFAULTS: AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  sessionScope: "thread",
  maxUsersInPrompt: 50,
  maxConcurrentRuns: 20,
  resourceCacheTtlMs: 30_000,
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
  const maxConcurrentRuns = fromFile.maxConcurrentRuns ?? DEFAULTS.maxConcurrentRuns;
  const resourceCacheTtlMs = fromFile.resourceCacheTtlMs ?? DEFAULTS.resourceCacheTtlMs;

  return { provider, model, thinkingLevel, sessionScope, maxUsersInPrompt, maxConcurrentRuns, resourceCacheTtlMs };
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
