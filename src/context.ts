import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

/**
 * Human-readable log.jsonl entry used for grep/debugging and a few metadata lookups.
 *
 * Runtime conversation context comes from sessions/*.jsonl, not from this file.
 */
export interface ConversationLogMessage {
  date?: string;
  ts?: string;
  threadTs?: string;
  user?: string;
  userName?: string;
  text?: string;
  isBot?: boolean;
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
