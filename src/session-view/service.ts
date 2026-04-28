import { dirname, join } from "path";
import { existsSync, readdirSync } from "fs";
import {
  SessionManager,
  type BranchSummaryEntry,
  type CompactionEntry,
  type SessionEntry,
  type SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import {
  getThreadSessionFile,
  resolveChannelSessionFile,
  tryResolveThreadSession,
} from "../session-store.js";

export interface SessionViewItem {
  kind: "user" | "assistant" | "tool" | "system";
  title: string;
  body?: string;
  meta?: string;
  tone?: "default" | "ok" | "err" | "muted";
}

export interface SessionViewModel {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
  items: SessionViewItem[];
}

export function resolveExistingSessionFile(
  workingDir: string,
  conversationId: string,
  sessionKey: string,
): string | null {
  const conversationDir = join(workingDir, conversationId);
  if (sessionKey.includes(":")) {
    return tryResolveThreadSession(getThreadSessionFile(conversationDir, sessionKey));
  }
  return resolveChannelSessionFile(conversationDir);
}

export function loadSessionViewModel(sessionFile: string): SessionViewModel {
  const sessionFiles = resolveSessionFiles(sessionFile);
  const allItems: SessionViewItem[] = [];
  let createdAt = "";
  let updatedAt = "";
  let totalEntries = 0;
  let sessionId = "";
  let title = "";

  for (let i = 0; i < sessionFiles.length; i++) {
    const file = sessionFiles[i];
    const sm = SessionManager.open(file);
    const header = sm.getHeader();
    if (!header) continue;

    const entries = sm.getEntries();
    totalEntries += entries.length;

    if (!createdAt || header.timestamp < createdAt) createdAt = header.timestamp;
    const lastTs = entries.at(-1)?.timestamp ?? header.timestamp;
    if (!updatedAt || lastTs > updatedAt) updatedAt = lastTs;

    sessionId = header.id;
    const sessionName = sm.getSessionName() || `Session ${header.id.slice(0, 8)}`;
    title = sessionName;

    if (sessionFiles.length > 1) {
      allItems.push({
        kind: "system",
        title: i === 0 ? `Session started — ${sessionName}` : `New session — ${sessionName}`,
        meta: header.timestamp,
        tone: "muted",
      });
    }

    for (const entry of entries) {
      const item = mapEntryToItem(entry);
      if (item) allItems.push(item);
    }
  }

  if (!createdAt) throw new Error(`No valid sessions found near: ${sessionFile}`);

  return {
    sessionId,
    title,
    createdAt,
    updatedAt,
    entryCount: totalEntries,
    items: allItems,
  };
}

function resolveSessionFiles(sessionFile: string): string[] {
  const dir = dirname(sessionFile);
  if (!existsSync(dir)) return [sessionFile];

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((f) => join(dir, f));

  if (files.length === 0) return [sessionFile];

  // Sort by session header timestamp so channel + thread sessions appear chronologically
  const withTimestamp = files.flatMap((f) => {
    try {
      const sm = SessionManager.open(f);
      const header = sm.getHeader();
      return header ? [{ f, ts: header.timestamp }] : [];
    } catch {
      return [];
    }
  });

  withTimestamp.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return withTimestamp.length > 0 ? withTimestamp.map((x) => x.f) : [sessionFile];
}

function mapEntryToItem(entry: SessionEntry): SessionViewItem | null {
  switch (entry.type) {
    case "message":
      return mapMessageEntry(entry);
    case "model_change":
      return {
        kind: "system",
        title: "Model changed",
        body: `${entry.provider} / ${entry.modelId}`,
        meta: entry.timestamp,
        tone: "muted",
      };
    case "thinking_level_change":
      return {
        kind: "system",
        title: "Thinking level changed",
        body: entry.thinkingLevel,
        meta: entry.timestamp,
        tone: "muted",
      };
    case "compaction":
      return mapCompactionEntry(entry);
    case "branch_summary":
      return mapBranchSummaryEntry(entry);
    case "custom_message":
      return {
        kind: "system",
        title: `Custom message · ${entry.customType}`,
        body: contentToText(entry.content),
        meta: entry.timestamp,
        tone: "muted",
      };
    case "custom":
      return {
        kind: "system",
        title: `Custom data · ${entry.customType}`,
        body: entry.data === undefined ? "(no data)" : JSON.stringify(entry.data, null, 2),
        meta: entry.timestamp,
        tone: "muted",
      };
    case "label":
      return {
        kind: "system",
        title: "Label updated",
        body: entry.label || "(cleared)",
        meta: entry.timestamp,
        tone: "muted",
      };
    case "session_info":
      return entry.name
        ? {
            kind: "system",
            title: "Session renamed",
            body: entry.name,
            meta: entry.timestamp,
            tone: "muted",
          }
        : null;
    default:
      return null;
  }
}

function mapMessageEntry(entry: SessionMessageEntry): SessionViewItem {
  const message = entry.message as unknown as Record<string, unknown> & {
    role?: string;
    content?: unknown;
    provider?: string;
    model?: string;
    toolName?: string;
    isError?: boolean;
    command?: string;
    output?: string;
    stopReason?: string;
    customType?: string;
    summary?: string;
  };

  switch (message.role) {
    case "user":
      return {
        kind: "user",
        title: "User",
        body: contentToText(message.content),
        meta: entry.timestamp,
      };
    case "assistant": {
      const assistantBody = assistantContentToText(message.content);
      const metaParts = [message.provider, message.model, message.stopReason].filter(Boolean);
      return {
        kind: "assistant",
        title: "Assistant",
        body: assistantBody,
        meta:
          metaParts.length > 0 ? `${entry.timestamp} · ${metaParts.join(" · ")}` : entry.timestamp,
      };
    }
    case "toolResult":
      return {
        kind: "tool",
        title: `Tool result · ${String(message.toolName ?? "unknown")}`,
        body: contentToText(message.content),
        meta: entry.timestamp,
        tone: message.isError ? "err" : "ok",
      };
    case "bashExecution": {
      const command = String(message.command ?? "").trim();
      const output = String(message.output ?? "").trim();
      const body = [command ? `$ ${command}` : "", output].filter(Boolean).join("\n\n");
      return {
        kind: "tool",
        title: "Bash execution",
        body: body || "(no output)",
        meta: entry.timestamp,
      };
    }
    case "custom":
      return {
        kind: "system",
        title: `Custom message · ${String(message.customType ?? "custom")}`,
        body: contentToText(message.content),
        meta: entry.timestamp,
        tone: "muted",
      };
    case "branchSummary":
      return {
        kind: "system",
        title: "Branch summary",
        body: String(message.summary ?? ""),
        meta: entry.timestamp,
        tone: "muted",
      };
    case "compactionSummary":
      return {
        kind: "system",
        title: "Compaction summary",
        body: String(message.summary ?? ""),
        meta: entry.timestamp,
        tone: "muted",
      };
    default:
      return {
        kind: "system",
        title: `Message · ${String(message.role ?? "unknown")}`,
        body: contentToText(message.content),
        meta: entry.timestamp,
        tone: "muted",
      };
  }
}

function mapCompactionEntry(entry: CompactionEntry): SessionViewItem {
  return {
    kind: "system",
    title: "Context compacted",
    body: entry.summary,
    meta: `${entry.timestamp} · ${entry.tokensBefore} tokens before compaction`,
    tone: "muted",
  };
}

function mapBranchSummaryEntry(entry: BranchSummaryEntry): SessionViewItem {
  return {
    kind: "system",
    title: "Branch summary",
    body: entry.summary,
    meta: entry.timestamp,
    tone: "muted",
  };
}

function assistantContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const textBlocks: string[] = [];
  const thinkingBlocks: string[] = [];
  const toolCalls: string[] = [];
  const otherBlocks: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      textBlocks.push(value.text);
      continue;
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      thinkingBlocks.push(value.thinking);
      continue;
    }
    if (value.type === "toolCall") {
      const name = typeof value.name === "string" ? value.name : "tool";
      const args = value.arguments === undefined ? "" : JSON.stringify(value.arguments, null, 2);
      toolCalls.push([name, args].filter(Boolean).join("\n"));
      continue;
    }
    if (value.type === "image") {
      otherBlocks.push(`[image ${String(value.mimeType ?? "unknown")}]`);
    }
  }

  const sections = [
    textBlocks.join("\n\n").trim(),
    thinkingBlocks.length > 0
      ? [`[thinking]`, thinkingBlocks.join("\n\n")].filter(Boolean).join("\n")
      : "",
    toolCalls.length > 0 ? [`[tool calls]`, toolCalls.join("\n\n")].filter(Boolean).join("\n") : "",
    otherBlocks.join("\n"),
  ].filter(Boolean);

  return sections.join("\n\n");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      lines.push(value.text);
      continue;
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      lines.push(`[thinking]\n${value.thinking}`);
      continue;
    }
    if (value.type === "toolCall") {
      const name = typeof value.name === "string" ? value.name : "tool";
      const args = value.arguments === undefined ? "" : JSON.stringify(value.arguments, null, 2);
      lines.push([`[toolCall] ${name}`, args].filter(Boolean).join("\n"));
      continue;
    }
    if (value.type === "image") {
      lines.push(`[image ${String(value.mimeType ?? "unknown")}]`);
    }
  }

  return lines.join("\n\n");
}
