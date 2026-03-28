import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createAttachTool } from "../adapters/slack/tools/attach.js";
import type { Executor } from "../sandbox.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createMamaTools(
  executor: Executor,
  getExecutionEnv?: () => Record<string, string>,
): {
  tools: AgentTool<any>[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  return {
    tools: [
      createReadTool(executor),
      createBashTool(executor, getExecutionEnv),
      createEditTool(executor),
      createWriteTool(executor),
      attachTool,
    ],
    setUploadFunction,
  };
}
