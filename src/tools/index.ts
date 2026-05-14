import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAttachTool } from "../adapters/slack/tools/attach.js";
import type { BrowserExtensionManager } from "../browser-extension.js";
import type { Executor } from "../sandbox.js";
import { createBashTool } from "./bash.js";
import { createBrowserTool } from "./browser.js";
import { createEditTool } from "./edit.js";
import { createEventTool } from "./event.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createMamaTools(
  executor: Executor,
  workspaceDir: string,
  browserExtensionManager?: BrowserExtensionManager,
): {
  tools: AgentTool<any>[];
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: "direct" | "shared";
    userId: string;
    sessionKey: string;
    threadTs?: string;
  }) => void;
  setBrowserContext: (context: {
    conversationId: string;
    hostOutputDir: string;
    uploadFile?: (filePath: string, title?: string) => Promise<void>;
  }) => void;
} {
  const { tool: attachTool, setUploadFunction } = createAttachTool();
  const { tool: eventTool, setEventContext } = createEventTool(workspaceDir);
  const browserTool = browserExtensionManager
    ? createBrowserTool(browserExtensionManager)
    : undefined;
  return {
    tools: [
      createReadTool(executor),
      createBashTool(executor),
      createEditTool(executor),
      createWriteTool(executor),
      eventTool,
      attachTool,
      ...(browserTool ? [browserTool.tool] : []),
    ],
    setUploadFunction,
    setEventContext,
    setBrowserContext: (context) => browserTool?.setBrowserContext(context),
  };
}
