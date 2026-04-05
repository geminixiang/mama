import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { SessionManager } from "@mariozechner/pi-coding-agent";

/**
 * Returns the shared session directory for a channel.
 * Channel sessions use a current pointer within this directory.
 * Thread sessions are stored as fixed files within the same directory.
 */
export function getSessionDir(channelDir: string, _sessionKey: string): string {
  return join(channelDir, "sessions");
}

/**
 * Resolves the current active session file for a session directory.
 * Reads the "current" pointer file; creates a new session if none exists
 * or the pointed-to file is missing.
 */
export function resolveSessionFile(sessionDir: string): string {
  const existing = tryResolveCurrentSession(sessionDir);
  if (existing) return existing;
  return createNewSessionFile(sessionDir);
}

/**
 * Resolve the current active session file for a session directory.
 * Creates a fully initialized persistent session with the provided cwd when none exists.
 */
export function resolveManagedSessionFile(sessionDir: string, cwd: string): string {
  const existingPath = getCurrentSessionPath(sessionDir);
  if (existingPath) return existingPath;
  return createManagedSessionFile(sessionDir, cwd);
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
 * Creates an empty timestamped file and updates the "current" pointer.
 * Used only by tests for placeholder-file scenarios.
 */
export function createNewSessionFile(sessionDir: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uuid = randomUUID().slice(0, 8);
  const filename = `${timestamp}_${uuid}.jsonl`;
  const filePath = join(sessionDir, filename);
  writeFileSync(join(sessionDir, "current"), filename, "utf-8");
  writeFileSync(filePath, "", "utf-8");
  return filePath;
}

/**
 * Creates a new persistent session file with a proper SessionManager header and cwd.
 * Also updates the "current" pointer.
 */
export function createManagedSessionFile(sessionDir: string, cwd: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionId = randomUUID();
  const sessionFile = join(sessionDir, `${timestamp}_${sessionId.slice(0, 8)}.jsonl`);
  writeSessionHeader(sessionFile, cwd, sessionId);
  setCurrentPointer(sessionDir, sessionFile);
  return sessionFile;
}

/**
 * Open a session file with an explicit cwd, even if the file does not exist yet.
 * This avoids SessionManager.open() falling back to process.cwd() for fresh sessions.
 */
export function openManagedSession(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
): SessionManager {
  const SessionManagerCtor = SessionManager as unknown as {
    new (cwd: string, sessionDir: string, sessionFile: string, persist: boolean): SessionManager;
  };
  return new SessionManagerCtor(cwd, sessionDir, sessionFile, true);
}

function setCurrentPointer(sessionDir: string, sessionFilePath: string): void {
  const filename = sessionFilePath.split("/").pop()!;
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "current"), filename, "utf-8");
}

/**
 * Creates or overwrites a fixed-path session file with a valid session header.
 */
export function createManagedSessionFileAtPath(sessionFile: string, cwd: string): string {
  writeSessionHeader(sessionFile, cwd);
  return sessionFile;
}

function writeSessionHeader(sessionFile: string, cwd: string, sessionId = randomUUID()): void {
  const sessionDir = getFileDir(sessionFile);
  mkdirSync(sessionDir, { recursive: true });
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
}

/**
 * Returns the channel-level session directory: {channelDir}/sessions/
 */
export function getChannelSessionDir(channelDir: string): string {
  return join(channelDir, "sessions");
}

/**
 * Returns the fixed session file path for a Slack thread.
 */
export function getThreadSessionFile(channelDir: string, sessionKey: string): string {
  return join(getChannelSessionDir(channelDir), `${extractSessionSuffix(sessionKey)}.jsonl`);
}

function hasSessionHeader(sessionFile: string): boolean {
  try {
    const lines = readFileSync(sessionFile, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = JSON.parse(trimmed) as { type?: string };
      return entry.type === "session";
    }
  } catch {
    return false;
  }
  return false;
}

function getFileDir(sessionFile: string): string {
  return sessionFile.substring(0, sessionFile.lastIndexOf("/"));
}

function getCurrentSessionPath(sessionDir: string): string | null {
  const pointerFile = join(sessionDir, "current");
  if (!existsSync(pointerFile)) return null;
  const filename = readFileSync(pointerFile, "utf-8").trim();
  if (!filename) return null;
  return join(sessionDir, filename);
}

/**
 * Try to resolve an existing current session file.
 * Returns null if no current pointer exists or the pointed file has no valid session header.
 */
export function tryResolveCurrentSession(sessionDir: string): string | null {
  const fullPath = getCurrentSessionPath(sessionDir);
  if (fullPath && existsSync(fullPath) && hasSessionHeader(fullPath)) return fullPath;
  return null;
}

/**
 * Try to resolve an existing thread session file.
 * Returns the file path if found, or null if no valid thread session exists yet.
 */
export function tryResolveThreadSession(sessionFile: string): string | null {
  return existsSync(sessionFile) && hasSessionHeader(sessionFile) ? sessionFile : null;
}

/**
 * Resolve the channel's current session file path (for fork source).
 * Returns null if no channel session exists.
 */
export function resolveChannelSessionFile(channelDir: string): string | null {
  const channelSessionDir = getChannelSessionDir(channelDir);
  return tryResolveCurrentSession(channelSessionDir);
}

/**
 * Fork a channel session into a fixed thread-session path.
 * The resulting file keeps forkFrom's distinct session/header metadata.
 */
export function forkThreadSessionFile(
  sourceSessionFile: string,
  targetSessionFile: string,
  cwd: string,
): string {
  const sessionDir = getFileDir(targetSessionFile);
  mkdirSync(sessionDir, { recursive: true });
  const forked = SessionManager.forkFrom(sourceSessionFile, cwd, sessionDir);
  const forkedFile = forked.getSessionFile();
  if (!forkedFile) {
    throw new Error(`Failed to fork session from ${sourceSessionFile}`);
  }
  rmSync(targetSessionFile, { force: true });
  renameSync(forkedFile, targetSessionFile);
  return targetSessionFile;
}
