import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  baseDir: string;
}

function parseAgentMd(content: string, baseDir: string): AgentDefinition | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const [, frontmatter, body] = match;

  const meta: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }

  if (!meta.name || !meta.description) return null;

  return {
    name: meta.name,
    description: meta.description,
    model: meta.model,
    tools: meta.tools ? meta.tools.split(",").map((t) => t.trim()) : undefined,
    systemPrompt: body.trim(),
    baseDir,
  };
}

export function loadAgentDefsFromDir(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return [];

  const defs: AgentDefinition[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(dir, entry.name);
      const agentMdPath = join(agentDir, "AGENT.md");
      if (!existsSync(agentMdPath)) continue;

      try {
        const content = readFileSync(agentMdPath, "utf-8");
        const def = parseAgentMd(content, agentDir);
        if (def) defs.push(def);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Skip unreadable directories
  }

  return defs;
}

export function loadMamaAgentDefs(channelDir: string, workspaceDir: string): AgentDefinition[] {
  const defMap = new Map<string, AgentDefinition>();

  // Workspace-level agents (global)
  const workspaceAgentsDir = join(workspaceDir, "agents");
  for (const def of loadAgentDefsFromDir(workspaceAgentsDir)) {
    defMap.set(def.name, def);
  }

  // Channel-specific agents override workspace agents on name collision
  const channelAgentsDir = join(channelDir, "agents");
  for (const def of loadAgentDefsFromDir(channelAgentsDir)) {
    defMap.set(def.name, def);
  }

  return Array.from(defMap.values());
}

export function formatAgentDefsForPrompt(defs: AgentDefinition[]): string {
  if (defs.length === 0) return "(no agents defined)";

  return defs
    .map((d) => `- **${d.name}**: ${d.description}\n  → agent: "${d.name}"`)
    .join("\n");
}
