import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { BrowserCommandType, BrowserExtensionManager } from "../browser-extension.js";

const browserSchema = Type.Object({
  label: Type.String({ description: "Brief description of the browser action (shown to user)" }),
  action: Type.Union([
    Type.Literal("list_tabs"),
    Type.Literal("open_tab"),
    Type.Literal("activate_tab"),
    Type.Literal("reload_tab"),
    Type.Literal("get_active_tab"),
    Type.Literal("screenshot"),
  ]),
  url: Type.Optional(Type.String({ description: "URL for open_tab" })),
  tabId: Type.Optional(Type.Number({ description: "Chrome tab id for activate_tab/reload_tab" })),
  windowId: Type.Optional(Type.Number({ description: "Chrome window id for screenshot" })),
});

type BrowserToolParams = {
  label: string;
  action: BrowserCommandType;
  url?: string;
  tabId?: number;
  windowId?: number;
};

interface BrowserToolContext {
  conversationId: string;
  hostOutputDir: string;
  uploadFile?: (filePath: string, title?: string) => Promise<void>;
}

export function createBrowserTool(manager: BrowserExtensionManager): {
  tool: AgentTool<typeof browserSchema>;
  setBrowserContext: (context: BrowserToolContext) => void;
} {
  let context: BrowserToolContext | null = null;

  const tool: AgentTool<typeof browserSchema> = {
    name: "browser",
    label: "browser",
    description:
      "Operate the Chrome browser extension paired with this conversation. Use this when the user asks to inspect, open, refresh, list tabs, or screenshot their browser. Requires the user to have paired via /pi-login browser.",
    parameters: browserSchema,
    execute: async (_toolCallId: string, params: BrowserToolParams, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!context) throw new Error("Browser tool context not configured");

      const payload: Record<string, unknown> = {};
      if (params.url) payload.url = params.url;
      if (params.tabId !== undefined) payload.tabId = params.tabId;
      if (params.windowId !== undefined) payload.windowId = params.windowId;

      const { result } = await manager.enqueueAndWait(
        context.conversationId,
        params.action,
        payload,
      );
      if (!result.ok) throw new Error(result.error ?? "Browser command failed");

      const data = await maybeUploadScreenshot(context, result.data);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        details: data,
      };
    },
  };

  return {
    tool,
    setBrowserContext: (nextContext) => {
      context = nextContext;
    },
  };
}

async function maybeUploadScreenshot(context: BrowserToolContext, data: unknown): Promise<unknown> {
  if (!data || typeof data !== "object") return data;
  const obj = data as { dataUrl?: unknown; title?: unknown; url?: unknown };
  if (typeof obj.dataUrl !== "string") return data;
  const match = obj.dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) return data;

  mkdirSync(context.hostOutputDir, { recursive: true });
  const filePath = join(context.hostOutputDir, `browser-screenshot-${Date.now()}.png`);
  writeFileSync(filePath, Buffer.from(match[1], "base64"), { mode: 0o600 });
  if (context.uploadFile) {
    await context.uploadFile(
      filePath,
      typeof obj.title === "string" ? obj.title : "Browser screenshot",
    );
  }

  return {
    ...obj,
    dataUrl: undefined,
    screenshotPath: filePath,
    screenshotUploaded: !!context.uploadFile,
  };
}
