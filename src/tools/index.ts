import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createAttachTool } from "../adapters/slack/tools/attach.js";
import { redact } from "../redact.js";
import type { Executor } from "../sandbox.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

/**
 * Wrap a tool so that text content blocks and error messages are redacted
 * before reaching the LLM context window.
 */
function withRedaction<S>(tool: AgentTool<S>): AgentTool<S> {
  const originalExecute = tool.execute;
  return {
    ...tool,
    execute: async (...args: Parameters<typeof originalExecute>) => {
      try {
        const result = await originalExecute(...args);
        return {
          ...result,
          content: result.content.map((block) =>
            block.type === "text" ? { ...block, text: redact(block.text) } : block,
          ),
        };
      } catch (err) {
        if (err instanceof Error) {
          throw new Error(redact(err.message));
        }
        throw err;
      }
    },
  };
}

export function createMamaTools(executor: Executor): {
  tools: AgentTool<any>[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  return {
    tools: [
      withRedaction(createReadTool(executor)),
      withRedaction(createBashTool(executor)),
      withRedaction(createEditTool(executor)),
      withRedaction(createWriteTool(executor)),
      withRedaction(attachTool),
    ],
    setUploadFunction,
  };
}
