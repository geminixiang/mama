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

import type { UserMessage } from "@mariozechner/pi-ai";
import {
  type SessionManager,
  type SessionMessageEntry,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

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

interface LogMessage {
  date?: string;
  ts?: string;
  threadTs?: string;
  user?: string;
  userName?: string;
  text?: string;
  isBot?: boolean;
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
 * @param excludeSlackTs - Slack timestamp of current message (will be added via prompt(), not sync)
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

  // Build set of existing timestamps from session entries
  // We use ts (Slack timestamp) as the unique key instead of message content
  const existingTimestamps = new Set<string>();
  for (const entry of sessionManager.getEntries()) {
    if (entry.type === "message") {
      const msgEntry = entry as SessionMessageEntry;
      // SessionMessageEntry has a timestamp field (number, Unix ms)
      if (msgEntry.timestamp) {
        existingTimestamps.add(msgEntry.timestamp.toString());
      }
    }
  }

  // Read log.jsonl and find user messages not in context
  const logContent = await readFile(logFile, "utf-8");
  const logLines = logContent.trim().split("\n").filter(Boolean);

  const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

  for (const line of logLines) {
    try {
      const logMsg: LogMessage = JSON.parse(line);

      const slackTs = logMsg.ts;
      const date = logMsg.date;
      if (!slackTs || !date) continue;

      // Skip the current message being processed (will be added via prompt())
      if (excludeSlackTs && slackTs === excludeSlackTs) continue;

      // Skip bot messages - added through agent flow
      if (logMsg.isBot) continue;

      // Thread filtering: only sync messages belonging to this session's thread
      if (threadFilter) {
        if (threadFilter.scope === "top-level") {
          // Persistent top-level sessions should only ingest top-level messages.
          // This avoids pulling in unrelated replies from other threads.
          if (logMsg.threadTs) {
            continue;
          }
        } else {
          if (logMsg.threadTs) {
            // Thread reply: only include if threadTs matches our thread anchor or rootTs
            if (
              logMsg.threadTs !== threadFilter.threadTs &&
              logMsg.threadTs !== threadFilter.rootTs
            ) {
              continue;
            }
          } else {
            // Top-level message: only include if it's this session's root message
            if (slackTs !== threadFilter.rootTs) {
              continue;
            }
          }
        }
      }

      // Skip if this Slack timestamp is already in the session (dedupe by ts, not content)
      // Convert Slack ts (e.g., "1234567890.123456") to Unix ms for comparison
      const slackTsMs = Math.floor(parseFloat(slackTs) * 1000).toString();
      if (existingTimestamps.has(slackTsMs)) continue;

      // Build the message text as it would appear in context
      const threadContext = logMsg.threadTs ? ` [in-thread:${logMsg.threadTs}]` : "";
      const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]${threadContext}: ${logMsg.text || ""}`;

      const msgTime = new Date(date).getTime() || Date.now();

      // Skip messages outside the time range
      if (msgTime < range.start || msgTime > range.end) continue;

      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: messageText }],
        timestamp: msgTime,
      };

      newMessages.push({ timestamp: msgTime, message: userMessage });
      existingTimestamps.add(slackTsMs); // Track to avoid duplicates within this sync
    } catch {
      // Skip malformed lines
    }
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
