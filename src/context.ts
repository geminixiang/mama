/**
 * Context management for mama.
 *
 * Mama uses two data sources per conversation:
 * - sessions/*.jsonl: Structured session history for agent context
 * - log.jsonl: Human-readable conversation history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - createMamaSettingsManager: Creates an in-memory SettingsManager for AgentSession
 */

import type { Message, UserMessage } from "@earendil-works/pi-ai";
import {
  type SessionManager,
  type SessionMessageEntry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { parseNewCommand } from "./commands/new.js";
import * as log from "./log.js";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

/**
 * Time range for filtering log messages
 */
export interface TimeRange {
  start: number; // Unix timestamp in ms
  end: number;
}

/**
 * Default number of days to sync when no time range is specified
 */
const DEFAULT_SYNC_DAYS = 10;

export interface ConversationLogMessage {
  date?: string;
  ts?: string;
  threadTs?: string;
  user?: string;
  userName?: string;
  text?: string;
  isBot?: boolean;
}

interface ExistingSessionMessage {
  timestamp?: number;
  rawText: string;
  normalizedText: string;
}

/**
 * Thread filter for scoping log sync to a specific thread session.
 * When provided, only messages belonging to this thread are synced,
 * preventing cross-thread context contamination.
 */
export interface ThreadFilter {
  /** Filter mode: a specific thread, or top-level messages only for persistent channel/chat sessions */
  scope?: "thread" | "top-level";
  /** The root message timestamp (user's original message ts, derived from sessionKey) */
  rootTs: string;
  /** The thread anchor timestamp (bot's first reply ts, used as thread_ts by Slack replies) */
  threadTs?: string;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mama wasn't running (conversation chatter,
 * backfilled messages, messages while busy) are added to the LLM context.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param conversationDir - Path to the conversation directory containing log.jsonl
 * @param excludeSlackTs - Current platform message ID/timestamp (will be added via prompt(), not sync)
 * @param timeRange - Optional time range to filter log entries (defaults to last 10 days)
 * @param threadFilter - Optional thread filter to scope sync to a specific thread
 * @returns Number of messages synced
 */
export async function syncLogToSessionManager(
  sessionManager: SessionManager,
  conversationDir: string,
  excludeSlackTs?: string,
  timeRange?: TimeRange,
  threadFilter?: ThreadFilter,
): Promise<number> {
  // Calculate default time range (last 10 days) if not provided
  const now = Date.now();
  const defaultStart = now - DEFAULT_SYNC_DAYS * 24 * 60 * 60 * 1000;
  const range = timeRange ?? { start: defaultStart, end: now };
  const logFile = join(conversationDir, "log.jsonl");

  if (!existsSync(logFile)) return 0;

  // Build a list of existing session messages for dedupe.
  // Live user prompts carry a formatted timestamp in the text and use Date.now(),
  // while log.jsonl uses the platform event timestamp. We therefore need a small
  // fuzzy match window in addition to the exact timestamp/content match used for
  // already-synced log entries.
  const existingMessages: ExistingSessionMessage[] = [];
  const existingMessageKeys = new Set<string>();
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const msgEntry = entry as SessionMessageEntry;
    const message = msgEntry.message as Message;
    const contentText = Array.isArray(message.content)
      ? message.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n\n")
      : typeof message.content === "string"
        ? message.content
        : "";
    existingMessages.push({
      timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
      rawText: contentText,
      normalizedText: normalizeComparableUserText(contentText),
    });
    if (typeof message.timestamp === "number") {
      existingMessageKeys.add(`${message.timestamp}:${contentText}`);
    }
  }

  // Read log.jsonl and find user messages not in context
  const logContent = await readFile(logFile, "utf-8");
  const logLines = logContent.trim().split("\n").filter(Boolean);
  const logEntries: ConversationLogMessage[] = [];

  for (let lineIdx = 0; lineIdx < logLines.length; lineIdx++) {
    try {
      logEntries.push(JSON.parse(logLines[lineIdx]) as ConversationLogMessage);
    } catch (err) {
      log.logWarning(
        `Skipping malformed log entry at ${logFile}:${lineIdx + 1}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const resetCutoff = findLatestResetCutoff(logEntries, excludeSlackTs, threadFilter);
  const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

  for (const logMsg of logEntries) {
    const slackTs = logMsg.ts;
    const date = logMsg.date;
    if (!slackTs || !date) continue;

    // Skip the current message being processed (will be added via prompt())
    if (excludeSlackTs && slackTs === excludeSlackTs) continue;

    // While queued messages are being processed, newer messages may already be present
    // in log.jsonl. Do not look ahead into those future messages when building the
    // current turn's context.
    if (!isMessageAtOrBeforeCurrent(slackTs, excludeSlackTs)) continue;

    // Skip bot messages - added through agent flow
    if (logMsg.isBot) continue;

    const msgTime = new Date(date).getTime() || Date.now();
    if (resetCutoff !== null && msgTime <= resetCutoff) continue;

    if (!isLogMessageInThreadScope(logMsg, threadFilter)) continue;

    // Build the message text as it would appear in context
    const threadContext = logMsg.threadTs ? ` [in-thread:${logMsg.threadTs}]` : "";
    const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]${threadContext}: ${logMsg.text || ""}`;

    const messageKey = `${msgTime}:${messageText}`;
    if (existingMessageKeys.has(messageKey)) continue;
    if (hasExistingSessionMessage(existingMessages, msgTime, messageText)) continue;

    // Skip messages outside the time range
    if (msgTime < range.start || msgTime > range.end) continue;

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: messageText }],
      timestamp: msgTime,
    };

    newMessages.push({ timestamp: msgTime, message: userMessage });
    existingMessages.push({
      timestamp: msgTime,
      rawText: messageText,
      normalizedText: normalizeComparableUserText(messageText),
    });
    existingMessageKeys.add(messageKey); // Track to avoid duplicates within this sync
  }

  if (newMessages.length === 0) return 0;

  // Sort by timestamp and add to session
  newMessages.sort((a, b) => a.timestamp - b.timestamp);

  for (const { message } of newMessages) {
    sessionManager.appendMessage(message);
  }

  return newMessages.length;
}

// ============================================================================
// Settings manager for mama
// ============================================================================

// Mama manages model/provider config through its own config.ts / settings.json.
// We use an in-memory SettingsManager so AgentSession has valid defaults
// without interfering with coding-agent's global settings files.
export function createMamaSettingsManager(_workspaceDir: string): SettingsManager {
  return SettingsManager.inMemory();
}

export async function findLogMessageById(
  conversationDir: string,
  messageId: string,
): Promise<ConversationLogMessage | null> {
  const logFile = join(conversationDir, "log.jsonl");
  if (!existsSync(logFile)) return null;

  const logContent = await readFile(logFile, "utf-8");
  const logLines = logContent.trim().split("\n").filter(Boolean);

  for (let i = logLines.length - 1; i >= 0; i--) {
    let entry: ConversationLogMessage;
    try {
      entry = JSON.parse(logLines[i]) as ConversationLogMessage;
    } catch (err) {
      log.logWarning(
        `Skipping malformed log entry at ${logFile}:${i + 1}`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (entry.ts === messageId) {
      return entry;
    }
  }

  return null;
}

function findLatestResetCutoff(
  entries: ConversationLogMessage[],
  currentMessageId?: string,
  threadFilter?: ThreadFilter,
): number | null {
  let cutoff: number | null = null;

  for (const entry of entries) {
    if (!entry.ts || !entry.date) continue;
    if (!isMessageAtOrBeforeCurrent(entry.ts, currentMessageId)) continue;
    if (!isResetCommandLogMessage(entry)) continue;
    if (!isLogMessageInThreadScope(entry, threadFilter)) continue;

    const timestamp = new Date(entry.date).getTime();
    if (!Number.isFinite(timestamp)) continue;
    cutoff = cutoff === null ? timestamp : Math.max(cutoff, timestamp);
  }

  return cutoff;
}

function isResetCommandLogMessage(entry: ConversationLogMessage): boolean {
  if (entry.isBot) return false;
  return parseNewCommand(entry.text ?? "") !== null;
}

function isLogMessageInThreadScope(
  entry: ConversationLogMessage,
  threadFilter?: ThreadFilter,
): boolean {
  if (!threadFilter) return true;
  if (threadFilter.scope === "top-level") return !entry.threadTs;
  if (entry.threadTs) {
    return entry.threadTs === threadFilter.threadTs || entry.threadTs === threadFilter.rootTs;
  }
  return entry.ts === threadFilter.rootTs;
}

function stripSlackAttachmentBlock(text: string): string {
  return text.replace(/\n*<slack_attachments>\n[\s\S]*?\n<\/slack_attachments>\s*$/g, "");
}

function normalizeComparableUserText(text: string): string {
  const withoutTimestamp = text.replace(
    /^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}\]\s+(?=\[[^\]]+\](?:\s+\[in-thread:[^\]]+\])?:\s)/,
    "",
  );
  return stripSlackAttachmentBlock(withoutTimestamp).trim();
}

function hasExistingSessionMessage(
  existingMessages: ExistingSessionMessage[],
  timestamp: number,
  text: string,
): boolean {
  const normalizedText = normalizeComparableUserText(text);
  return existingMessages.some((existing) => {
    if (existing.timestamp === timestamp && existing.rawText === text) {
      return true;
    }
    if (existing.normalizedText !== normalizedText || existing.timestamp === undefined) {
      return false;
    }
    return existing.timestamp >= timestamp;
  });
}

function isMessageAtOrBeforeCurrent(messageId: string, currentMessageId?: string): boolean {
  if (!currentMessageId) return true;
  const comparison = compareMessageIds(messageId, currentMessageId);
  return comparison === null || comparison <= 0;
}

function compareMessageIds(a: string, b: string): number | null {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  const left = Number(a);
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right)) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  return null;
}
