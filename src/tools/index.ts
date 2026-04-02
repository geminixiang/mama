import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { createAttachTool } from "../adapters/slack/tools/attach.js";
import type { AgentDefinition } from "../agents.js";
import type { Executor } from "../sandbox.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export interface AgentToolContext {
  /** 0 = root agent, 1 = subagent (spawn_agent tool is not added at depth >= 1) */
  agentDepth: number;
  agentDefs: AgentDefinition[];
  spawnSubAgent: (agentName: string, prompt: string, timeoutSecs: number) => Promise<string>;
}

const spawnAgentSchema = Type.Object({
  label: Type.String({ description: "Brief description shown to user (e.g. 'Reviewing auth.ts')" }),
  agent: Type.String({
    description: 'Agent name from AGENT.md, or "default" to use the base agent configuration',
  }),
  prompt: Type.String({ description: "Task prompt sent to the sub-agent" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (default: 300, max: 600)" }),
  ),
});

function createSpawnAgentTool(agentCtx: AgentToolContext): AgentTool<typeof spawnAgentSchema> {
  return {
    name: "spawn_agent",
    label: "spawn_agent",
    description:
      "Spawn a specialized sub-agent to handle a specific subtask. The sub-agent runs with its own system prompt and tool set, then returns its complete response. Sub-agents cannot spawn further agents.",
    parameters: spawnAgentSchema,
    execute: async (
      _toolCallId: string,
      { agent, prompt, timeout }: { label: string; agent: string; prompt: string; timeout?: number },
      _signal?: AbortSignal,
    ) => {
      if (agentCtx.agentDepth >= 1) {
        throw new Error("Subagents cannot spawn further agents (max depth: 1)");
      }
      const timeoutSecs = Math.min(timeout ?? 300, 600);
      return agentCtx.spawnSubAgent(agent, prompt, timeoutSecs);
    },
  };
}

export function createMamaTools(
  executor: Executor,
  agentCtx?: AgentToolContext,
): {
  tools: AgentTool<any>[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  const tools: AgentTool<any>[] = [
    createReadTool(executor),
    createBashTool(executor),
    createEditTool(executor),
    createWriteTool(executor),
    attachTool,
  ];

  if (agentCtx && agentCtx.agentDepth === 0 && agentCtx.agentDefs.length > 0) {
    tools.push(createSpawnAgentTool(agentCtx));
  }

  return { tools, setUploadFunction };
}
