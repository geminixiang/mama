import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Returns the session directory for a given channel/session key.
 * Private chats (no ":"): {channelDir}/sessions/
 * Group threads ("chatId:threadId"): {channelDir}/sessions/{threadId}/
 */
export function getSessionDir(channelDir: string, sessionKey: string): string {
  if (sessionKey.includes(":")) {
    const threadId = sessionKey.split(":").pop()!;
    return join(channelDir, "sessions", threadId);
  }
  return join(channelDir, "sessions");
}

/**
 * Resolves the current active session file for a session directory.
 * Reads the "current" pointer file; creates a new session if none exists
 * or the pointed-to file is missing.
 */
export function resolveSessionFile(sessionDir: string): string {
  const pointerFile = join(sessionDir, "current");
  if (existsSync(pointerFile)) {
    const filename = readFileSync(pointerFile, "utf-8").trim();
    if (filename) {
      const fullPath = join(sessionDir, filename);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return createNewSessionFile(sessionDir);
}

/**
 * Extracts the short UUID from a session file path.
 * e.g. "2026-04-05T00-00_7b54cf90.jsonl" → "7b54cf90"
 */
export function extractSessionUuid(sessionFile: string): string {
  const base = sessionFile.split("/").pop() ?? sessionFile;
  return base.replace(".jsonl", "").split("_").pop() ?? base;
}

/**
 * Extracts the thread/suffix part of a session key.
 * "channelId:threadId" → "threadId", "channelId" → "channelId"
 */
export function extractSessionSuffix(sessionKey: string): string {
  return sessionKey.includes(":") ? sessionKey.split(":").pop()! : sessionKey;
}

/**
 * Creates a new timestamped session file and updates the "current" pointer.
 * Returns the path to the new session file.
 */
export function createNewSessionFile(sessionDir: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uuid = randomUUID().slice(0, 8);
  const filename = `${timestamp}_${uuid}.jsonl`;
  writeFileSync(join(sessionDir, "current"), filename, "utf-8");
  return join(sessionDir, filename);
}
