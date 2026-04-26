export interface ChatMessage {
  id: string;
  sessionKey: string;
  userId: string;
  userName?: string;
  text: string;
  attachments?: { name: string; localPath: string }[];
  threadTs?: string;
}

export interface ChatResponseContext {
  respond(text: string): Promise<void>;
  replaceResponse(text: string): Promise<void>;
  respondInThread(text: string, options?: { style?: "muted" }): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  setWorking(working: boolean): Promise<void>;
  uploadFile(filePath: string, title?: string): Promise<void>;
  deleteResponse(): Promise<void>;
}

export interface PlatformInfo {
  name: string;
  formattingGuide: string;
  channels: { id: string; name: string }[];
  users: { id: string; userName: string; displayName: string }[];
}

export interface ChatAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPlatformInfo(): PlatformInfo;
}

// ============================================================================
// Generic cross-platform event and bot interfaces
// ============================================================================

/**
 * A platform-agnostic event (message/mention) that triggers the agent.
 */
export interface BotEvent {
  type: string;
  /** Platform-specific conversation/channel/chat identifier */
  conversationId: string;
  /** Message timestamp or ID as string */
  ts: string;
  /** Parent message ID for threaded replies (optional) */
  thread_ts?: string;
  /** User ID */
  user: string;
  /** Message text (already stripped of bot mentions) */
  text: string;
  /** Downloaded attachments */
  attachments?: { name: string; localPath: string }[];
  /** Platform-computed session key; overrides default conversationId:thread_ts computation */
  sessionKey?: string;
}

/**
 * Minimum interface that every platform bot must implement,
 * used by the central handler in main.ts and by EventsWatcher.
 */
export interface Bot {
  start(): Promise<void>;
  postMessage(channel: string, text: string): Promise<string>;
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  enqueueEvent(event: BotEvent): boolean;
  getPlatformInfo(): PlatformInfo;
}

/** Pre-created platform adapters passed to the handler */
export interface BotAdapters {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
}

/**
 * Handler callbacks invoked by each platform bot.
 * Each bot creates platform-specific adapters before calling handleEvent.
 */
export interface RunningSession {
  sessionKey: string;
  startedAt: number; // Date.now() when run started
  /** Last activity timestamp (for detecting hung tasks) */
  lastActivityAt?: number;
  /** Current tool/step being executed (if any) */
  currentTool?: string;
}

export interface BotHandler {
  isRunning(sessionKey: string): boolean;
  getRunningSessions(): RunningSession[];
  handleEvent(event: BotEvent, bot: Bot, adapters: BotAdapters, isEvent?: boolean): Promise<void>;
  handleStop(sessionKey: string, conversationId: string, bot: Bot): Promise<void>;
  /** Force stop a running session (bypass normal stop mechanism) */
  forceStop(sessionKey: string): void;
  /** Reset a session: abort if running, delete history, remove from cache */
  handleNew(sessionKey: string, conversationId: string, bot: Bot): Promise<void>;
}

/** @deprecated Use BotHandler */
export type MomHandler = BotHandler;
