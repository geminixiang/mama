import {
  createManagedSessionFileAtPath,
  createThreadSessionFileFromRootMessage,
  extractSessionSuffix,
  forkThreadSessionFile,
  forkThreadSessionFileFromRootMessage,
  getChannelSessionDir,
  getThreadSessionFile,
  resolveChannelSessionFile,
  resolveManagedSessionFile,
  ThreadRootNotFoundError,
  tryResolveThreadSession,
  type ThreadRootMessage,
} from "../../session-store.js";
import { findLogMessageById, type ConversationLogMessage } from "../../context.js";

export interface SlackBranchBootstrapWaitOptions {
  parentSessionKey: string;
  sessionKey: string;
  hasThreadSession: () => boolean;
  isParentRunning: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export interface SlackResolvedSessionScope {
  sessionDir: string;
  contextFile: string;
  threadRootMessage: ConversationLogMessage | null;
}

export interface ResolveSlackSessionScopeOptions {
  conversationDir: string;
  sessionKey: string;
  sleep?: (ms: number) => Promise<void>;
  retryCount?: number;
  retryDelayMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildThreadRootSeed(message: ConversationLogMessage): ThreadRootMessage {
  return {
    text: message.text,
    userName: message.userName,
    user: message.user,
    loggedAt: message.date ? new Date(message.date).getTime() : undefined,
  };
}

async function forkThreadSessionFromRootWithRetry(
  sourceSessionFile: string,
  targetSessionFile: string,
  cwd: string,
  rootMessage: ConversationLogMessage,
  sleep: (ms: number) => Promise<void>,
  retryCount: number,
  retryDelayMs: number,
): Promise<string> {
  const seed = buildThreadRootSeed(rootMessage);

  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      return forkThreadSessionFileFromRootMessage(sourceSessionFile, targetSessionFile, cwd, seed);
    } catch (error) {
      if (!(error instanceof ThreadRootNotFoundError)) throw error;
      if (attempt === retryCount - 1) break;
      await sleep(retryDelayMs);
    }
  }

  return createThreadSessionFileFromRootMessage(targetSessionFile, cwd, seed, sourceSessionFile);
}

function createThreadSessionFromRootOrEmpty(
  threadFile: string,
  conversationDir: string,
  threadRootMessage: ConversationLogMessage | null,
  parentSession?: string,
): string {
  if (threadRootMessage) {
    return createThreadSessionFileFromRootMessage(
      threadFile,
      conversationDir,
      buildThreadRootSeed(threadRootMessage),
      parentSession,
    );
  }
  return createManagedSessionFileAtPath(threadFile, conversationDir);
}

export function hasMaterializedSlackBranchSession(
  conversationDir: string,
  sessionKey: string,
): boolean {
  if (!sessionKey.includes(":")) return false;
  return tryResolveThreadSession(getThreadSessionFile(conversationDir, sessionKey)) !== null;
}

export async function waitForSlackBranchBootstrap(
  options: SlackBranchBootstrapWaitOptions,
): Promise<boolean> {
  const {
    parentSessionKey,
    sessionKey,
    hasThreadSession,
    isParentRunning,
    sleep = defaultSleep,
    pollMs = 100,
  } = options;

  if (!sessionKey.includes(":")) return false;
  if (sessionKey === parentSessionKey) return false;
  if (hasThreadSession()) return false;

  let waited = false;
  while (isParentRunning() && !hasThreadSession()) {
    waited = true;
    await sleep(pollMs);
  }

  return waited;
}

export async function resolveSlackSessionScope(
  options: ResolveSlackSessionScopeOptions,
): Promise<SlackResolvedSessionScope> {
  const {
    conversationDir,
    sessionKey,
    sleep = defaultSleep,
    retryCount = 5,
    retryDelayMs = 100,
  } = options;

  const sessionDir = getChannelSessionDir(conversationDir);
  if (!sessionKey.includes(":")) {
    return {
      sessionDir,
      contextFile: resolveManagedSessionFile(sessionDir, conversationDir),
      threadRootMessage: null,
    };
  }

  const rootTs = extractSessionSuffix(sessionKey);
  const threadRootMessage = await findLogMessageById(conversationDir, rootTs);
  const threadFile = getThreadSessionFile(conversationDir, sessionKey);
  const existing = tryResolveThreadSession(threadFile);
  if (existing) {
    return { sessionDir, contextFile: existing, threadRootMessage };
  }

  const conversationSource = resolveChannelSessionFile(conversationDir);
  if (!conversationSource) {
    return {
      sessionDir,
      contextFile: createThreadSessionFromRootOrEmpty(
        threadFile,
        conversationDir,
        threadRootMessage,
      ),
      threadRootMessage,
    };
  }

  try {
    const contextFile = threadRootMessage
      ? await forkThreadSessionFromRootWithRetry(
          conversationSource,
          threadFile,
          conversationDir,
          threadRootMessage,
          sleep,
          retryCount,
          retryDelayMs,
        )
      : forkThreadSessionFile(conversationSource, threadFile, conversationDir);
    return { sessionDir, contextFile, threadRootMessage };
  } catch {
    return {
      sessionDir,
      contextFile: createThreadSessionFromRootOrEmpty(
        threadFile,
        conversationDir,
        threadRootMessage,
        conversationSource,
      ),
      threadRootMessage,
    };
  }
}
