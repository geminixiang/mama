import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
  AgentSession,
  AuthStorage,
  convertToLlm,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  getAgentDir,
  loadSkillsFromDir,
  ModelRegistry,
  SessionManager,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { ChatMessage, ChatResponseContext, PlatformInfo } from "./adapter.js";
import { loadAgentConfig } from "./config.js";
import { createMamaSettingsManager, syncLogToSessionManager } from "./context.js";
import { ActorExecutionResolver } from "./execution-resolver.js";
import * as log from "./log.js";
import type { UserBindingStore } from "./bindings.js";
import type { DockerContainerManager } from "./provisioner.js";
import { createExecutor, type Executor, type SandboxConfig } from "./sandbox.js";
import type { VaultManager } from "./vault.js";
import { addLifecycleBreadcrumb, metricAttributes } from "./sentry.js";
import {
  createManagedSessionFileAtPath,
  extractSessionSuffix,
  extractSessionUuid,
  forkThreadSessionFile,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
  resolveChannelSessionFile,
  resolveManagedSessionFile,
  tryResolveThreadSession,
} from "./session-store.js";
import { createMamaTools } from "./tools/index.js";
import * as Sentry from "@sentry/node";

export interface PendingMessage {
  userName: string;
  text: string;
  attachments: { localPath: string }[];
  timestamp: number;
}

export interface AgentRunner {
  run(
    message: ChatMessage,
    responseCtx: ChatResponseContext,
    platform: PlatformInfo,
  ): Promise<{ stopReason: string; errorMessage?: string }>;
  abort(): void;
  /** Get current step info (tool name, label) for debugging */
  getCurrentStep(): { toolName?: string; label?: string } | undefined;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
  return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

async function getMemory(conversationDir: string): Promise<string> {
  const parts: string[] = [];

  // Read workspace-level memory (shared across all conversations)
  const workspaceMemoryPath = join(conversationDir, "..", "MEMORY.md");
  if (existsSync(workspaceMemoryPath)) {
    try {
      const content = (await readFile(workspaceMemoryPath, "utf-8")).trim();
      if (content) {
        parts.push(`### Global Workspace Memory\n${content}`);
      }
    } catch (error) {
      log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
    }
  }

  // Read conversation-specific memory
  const conversationMemoryPath = join(conversationDir, "MEMORY.md");
  if (existsSync(conversationMemoryPath)) {
    try {
      const content = (await readFile(conversationMemoryPath, "utf-8")).trim();
      if (content) {
        parts.push(`### Conversation-Specific Memory\n${content}`);
      }
    } catch (error) {
      log.logWarning("Failed to read conversation memory", `${conversationMemoryPath}: ${error}`);
    }
  }

  if (parts.length === 0) {
    return "(no working memory yet)";
  }

  return parts.join("\n\n");
}

function loadMamaSkills(conversationDir: string, workspacePath: string): Skill[] {
  const skillMap = new Map<string, Skill>();

  // conversationDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
  // hostWorkspacePath is the parent directory on host
  // workspacePath is the container path (e.g., /workspace)
  const hostWorkspacePath = join(conversationDir, "..");

  // Helper to translate host paths to container paths
  const translatePath = (hostPath: string): string => {
    if (hostPath.startsWith(hostWorkspacePath)) {
      return workspacePath + hostPath.slice(hostWorkspacePath.length);
    }
    return hostPath;
  };

  // Load workspace-level skills (global)
  const workspaceSkillsDir = join(hostWorkspacePath, "skills");
  for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
    // Translate paths to container paths for system prompt
    skill.filePath = translatePath(skill.filePath);
    skill.baseDir = translatePath(skill.baseDir);
    skillMap.set(skill.name, skill);
  }

  // Load conversation-specific skills (override workspace skills on collision)
  const conversationSkillsDir = join(conversationDir, "skills");
  for (const skill of loadSkillsFromDir({ dir: conversationSkillsDir, source: "channel" }).skills) {
    skill.filePath = translatePath(skill.filePath);
    skill.baseDir = translatePath(skill.baseDir);
    skillMap.set(skill.name, skill);
  }

  return Array.from(skillMap.values());
}

function buildSystemPrompt(
  workspacePath: string,
  conversationId: string,
  currentUserId: string | undefined,
  memory: string,
  sandboxConfig: SandboxConfig,
  platform: PlatformInfo,
  skills: Skill[],
): string {
  const conversationPath = `${workspacePath}/${conversationId}`;
  const isContainer = sandboxConfig.type === "container" || sandboxConfig.type === "image";
  const isFirecracker = sandboxConfig.type === "firecracker";

  // Format platform conversation mappings
  const channelMappings =
    platform.channels.length > 0
      ? platform.channels.map((c) => `${c.id}\t#${c.name}`).join("\n")
      : "(no channels loaded)";

  // Format user mappings
  const userMappings =
    platform.users.length > 0
      ? platform.users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n")
      : "(no users loaded)";

  const envDescription = isContainer
    ? `You are running inside a container (Docker runtime, Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
    : isFirecracker
      ? `You are running inside a Firecracker microVM.
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apt-get install <package> (Debian-based)
- Your changes persist across sessions`
      : `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

  return `You are mama, a ${platform.name} bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).
- User messages include a \`[in-thread:TS]\` marker when sent from within a Slack thread (TS is the root message timestamp). Without this marker, the message is a top-level channel message.

${platform.formattingGuide}

## Platform IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── skills/                      # Global CLI tools you create
└── ${conversationId}/           # This conversation
    ├── MEMORY.md                # Conversation-specific memory
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Conversation-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${conversationPath}/skills/<name>/\` (conversation-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "platform": "${platform.name}", "channelId": "${conversationId}", "userId": "<requester userId>", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "platform": "${platform.name}", "channelId": "${conversationId}", "userId": "<requester userId>", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "platform": "${platform.name}", "channelId": "${conversationId}", "userId": "<requester userId>", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

Set \`userId\` to the platform userId of whoever asked for the event (look it up in the user mappings above). When the event fires, tool execution will route to that user's vault so their credentials are available.

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Platform Routing
Set \`platform\` to the target bot platform (\`${platform.name}\` for this conversation). When only one platform is running, omitting \`platform\` is allowed for backward compatibility, but include it by default to avoid ambiguity.

### Creating Events
Prefer the \`event\` tool. It automatically writes to the correct events directory and fills the current \`platform\`, \`channelId\`, and requester \`userId\`.
Do not use \`bash\` or \`write\` to hand-create JSON files in \`/events\` unless the user explicitly asks for manual file editing.

Current conversation defaults:
- \`platform\`: \`${platform.name}\`
- \`channelId\`: \`${conversationId}\`
- \`userId\`: \`${currentUserId ?? "unknown"}\`

Manual file creation is fallback only:
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "platform": "${platform.name}", "channelId": "${conversationId}", "userId": "<requester userId>", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to the platform. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Conversation (${conversationPath}/MEMORY.md): conversation-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isContainer ? "Install jq: apk add jq" : ""}
${isFirecracker ? "Install jq: apt-get install jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to the platform

Each tool requires a "label" parameter (shown to user).
`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    const textParts: string[] = [];
    for (const part of content) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return JSON.stringify(result);
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (key === "label") continue;

    if (key === "path" && typeof value === "string") {
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      if (offset !== undefined && limit !== undefined) {
        lines.push(`${value}:${offset}-${offset + limit}`);
      } else {
        lines.push(value);
      }
      continue;
    }

    if (key === "offset" || key === "limit") continue;

    if (typeof value === "string") {
      lines.push(value);
    } else {
      lines.push(JSON.stringify(value));
    }
  }

  return lines.join("\n");
}

// ============================================================================
// Agent runner
// ============================================================================

/**
 * Create a new AgentRunner for a conversation.
 * Sets up the session and subscribes to events once.
 *
 * Runner caching is handled by the caller (conversationStates in main.ts).
 * This is a stateless factory function.
 */
export async function createRunner(
  sandboxConfig: SandboxConfig,
  sessionKey: string,
  conversationId: string,
  conversationDir: string,
  workspaceDir: string,
  vaultManager?: VaultManager,
  bindingStore?: UserBindingStore,
  provisioner?: DockerContainerManager,
  stateDir?: string,
): Promise<AgentRunner> {
  const agentConfig = loadAgentConfig(stateDir ?? workspaceDir);

  // Initialize logger with settings from config
  log.initLogger({
    logFormat: agentConfig.logFormat,
    logLevel: agentConfig.logLevel,
  });

  const executionResolver =
    vaultManager && (vaultManager.isEnabled() || !!bindingStore || sandboxConfig.type === "image")
      ? new ActorExecutionResolver(sandboxConfig, vaultManager, bindingStore, provisioner)
      : undefined;
  let activeExecutor: Executor =
    executionResolver !== undefined
      ? createExecutor({ type: "host" })
      : createExecutor(sandboxConfig);
  const executor: Executor = {
    exec(command, options) {
      return activeExecutor.exec(command, options);
    },
    getWorkspacePath(hostPath) {
      return activeExecutor.getWorkspacePath(hostPath);
    },
    getSandboxConfig() {
      return activeExecutor.getSandboxConfig();
    },
  };
  const workspaceBase = conversationDir.replace(`/${conversationId}`, "");
  // Compute workspace path from the current executor. This may change per run.
  const getWorkspacePath = () => executor.getWorkspacePath(workspaceBase);
  let workspacePath = getWorkspacePath();

  // Create tools (per-runner, with per-runner upload function setter)
  const { tools, setUploadFunction, setEventContext } = createMamaTools(executor, workspaceDir);

  // Resolve model from config
  // Use 'as any' cast because agentConfig.provider/model are plain strings,
  // while getModel() has constrained generic types for known providers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (getModel as any)(agentConfig.provider, agentConfig.model);

  // Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
  const memory = await getMemory(conversationDir);
  const skills = loadMamaSkills(conversationDir, workspacePath);
  const emptyPlatform: PlatformInfo = {
    name: "slack",
    formattingGuide: "",
    channels: [],
    users: [],
  };
  const systemPrompt = buildSystemPrompt(
    workspacePath,
    conversationId,
    undefined,
    memory,
    sandboxConfig,
    emptyPlatform,
    skills,
  );

  // Create session manager and settings manager.
  // Top-level conversation sessions use {conversationDir}/sessions/current.
  // Thread sessions use fixed files: {conversationDir}/sessions/{threadTs}.jsonl.
  const sessionDir = getChannelSessionDir(conversationDir);
  const isThread = sessionKey.includes(":");

  let sessionManager!: SessionManager;
  let sessionFile!: string;

  if (isThread) {
    const threadFile = getThreadSessionFile(conversationDir, sessionKey);
    const existing = tryResolveThreadSession(threadFile);
    if (existing) {
      sessionFile = existing;
      sessionManager = openManagedSession(sessionFile, sessionDir, conversationDir);
    } else {
      const conversationSource = resolveChannelSessionFile(conversationDir);
      if (conversationSource) {
        try {
          sessionFile = forkThreadSessionFile(conversationSource, threadFile, conversationDir);
          sessionManager = openManagedSession(sessionFile, sessionDir, conversationDir);
        } catch {
          sessionFile = createManagedSessionFileAtPath(threadFile, conversationDir);
          sessionManager = openManagedSession(sessionFile, sessionDir, conversationDir);
        }
      } else {
        sessionFile = createManagedSessionFileAtPath(threadFile, conversationDir);
        sessionManager = openManagedSession(sessionFile, sessionDir, conversationDir);
      }
    }
  } else {
    // Top-level conversation session: resolve the current session file.
    sessionFile = resolveManagedSessionFile(sessionDir, conversationDir);
    sessionManager = openManagedSession(sessionFile, sessionDir, conversationDir);
  }
  const sessionUuid = extractSessionUuid(sessionFile);
  // Used for Slack thread filtering — for non-Slack platforms this is effectively a no-op
  const rootTs = extractSessionSuffix(sessionKey);
  const settingsManager = createMamaSettingsManager(join(conversationDir, ".."));

  // Create AuthStorage and ModelRegistry
  // Auth stored outside workspace so agent can't access it
  const authStorage = AuthStorage.create(join(homedir(), ".pi", "mama", "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage);

  // Create agent
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel:
        (agentConfig.thinkingLevel as "off" | "low" | "medium" | "high" | undefined) ?? "off",
      tools,
    },
    convertToLlm,
    getApiKey: async () => {
      const key = await modelRegistry.getApiKeyForProvider(model.provider);
      if (!key)
        throw new Error(
          `No API key for provider "${model.provider}". Set the appropriate environment variable or configure via auth.json`,
        );
      return key;
    },
  });

  // Load existing messages
  const loadedSession = sessionManager.buildSessionContext();
  if (loadedSession.messages.length > 0) {
    agent.state.messages = loadedSession.messages;
    log.logInfo(
      `[${conversationId}] Loaded ${loadedSession.messages.length} messages from session file`,
    );
  }

  // Load extensions, skills, prompts, themes via DefaultResourceLoader
  // This reads ~/.pi/agent/settings.json (packages, extensions enable/disable)
  // and discovers resources from standard locations + npm/git packages.
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: getAgentDir(),
    systemPrompt,
  });
  try {
    await resourceLoader.reload();
    const extResult = resourceLoader.getExtensions();
    if (extResult.errors.length > 0) {
      for (const err of extResult.errors) {
        log.logWarning(`[${conversationId}] Extension load error: ${err.path}`, err.error);
      }
    }
    log.logInfo(
      `[${conversationId}] Loaded ${extResult.extensions.length} extension(s): ${extResult.extensions.map((e) => e.path).join(", ")}`,
    );
  } catch (error) {
    log.logWarning(`[${conversationId}] Failed to load resources`, String(error));
  }

  const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  // Create AgentSession wrapper
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: workspaceDir,
    modelRegistry,
    resourceLoader,
    baseToolsOverride,
  });

  // Mutable per-run state - event handler references this
  const runState = {
    responseCtx: null as ChatResponseContext | null,
    logCtx: null as {
      conversationId: string;
      userName?: string;
      conversationName?: string;
      sessionId?: string;
    } | null,
    queue: null as {
      enqueue(fn: () => Promise<void>, errorContext: string): void;
      enqueueMessage(
        text: string,
        target: "main" | "thread",
        errorContext: string,
        doLog?: boolean,
      ): void;
    } | null,
    pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
    totalUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    llmCallCount: 0,
    stopReason: "stop",
    errorMessage: undefined as string | undefined,
  };

  // Subscribe to events ONCE
  session.subscribe(async (event) => {
    // Skip if no active run
    if (!runState.responseCtx || !runState.logCtx || !runState.queue) return;

    const { responseCtx, logCtx, queue, pendingTools } = runState;
    const baseAttrs = { channel_id: logCtx.conversationId, session_id: logCtx.sessionId };

    if (event.type === "tool_execution_start") {
      const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
      const args = agentEvent.args as { label?: string };
      const label = args.label || agentEvent.toolName;

      pendingTools.set(agentEvent.toolCallId, {
        toolName: agentEvent.toolName,
        args: agentEvent.args,
        startTime: Date.now(),
      });
      addLifecycleBreadcrumb("agent.tool.started", {
        tool: agentEvent.toolName,
        ...baseAttrs,
      });

      log.logToolStart(
        logCtx,
        agentEvent.toolName,
        label,
        agentEvent.args as Record<string, unknown>,
      );
      // Tool labels are omitted from the main message to reduce Slack noise.
      // Tool execution details are still posted to the thread (see tool_execution_end).
    } else if (event.type === "tool_execution_end") {
      const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
      const resultStr = extractToolResultText(agentEvent.result);
      const pending = pendingTools.get(agentEvent.toolCallId);
      pendingTools.delete(agentEvent.toolCallId);

      const durationMs = pending ? Date.now() - pending.startTime : 0;

      Sentry.metrics.count("agent.tool.calls", 1, {
        attributes: metricAttributes({
          tool: agentEvent.toolName,
          error: String(agentEvent.isError),
          ...baseAttrs,
        }),
      });
      Sentry.metrics.distribution("agent.tool.duration", durationMs, {
        unit: "millisecond",
        attributes: metricAttributes({
          tool: agentEvent.toolName,
          ...baseAttrs,
        }),
      });
      addLifecycleBreadcrumb("agent.tool.completed", {
        tool: agentEvent.toolName,
        error: agentEvent.isError,
        duration_ms: durationMs,
        ...baseAttrs,
      });

      if (agentEvent.isError) {
        log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
      } else {
        log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
      }

      // Post args + result to thread
      const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
      const argsFormatted = pending
        ? formatToolArgsForSlack(agentEvent.toolName, pending.args as Record<string, unknown>)
        : "(args not found)";
      const duration = (durationMs / 1000).toFixed(1);
      let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
      if (label) threadMessage += `: ${label}`;
      threadMessage += ` (${duration}s)\n`;
      if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
      threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

      // Only post thread details for tools with meaningful output (bash, attach).
      // Skip read/write/edit to reduce Slack noise — their results are in the log.
      const quietTools = new Set(["read", "write", "edit"]);
      if (!quietTools.has(agentEvent.toolName)) {
        queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
      }

      if (agentEvent.isError) {
        queue.enqueue(
          () => responseCtx.respond(`_Error: ${truncate(resultStr, 200)}_`),
          "tool error",
        );
      }
    } else if (event.type === "message_start") {
      const agentEvent = event as AgentEvent & { type: "message_start" };
      if (agentEvent.message.role === "assistant") {
        runState.llmCallCount += 1;
        addLifecycleBreadcrumb("agent.llm.call.started", {
          call_index: runState.llmCallCount,
          provider: model.provider,
          model: agentConfig.model,
          ...baseAttrs,
        });
        log.logResponseStart(logCtx);
      }
    } else if (event.type === "message_end") {
      const agentEvent = event as AgentEvent & { type: "message_end" };
      if (agentEvent.message.role === "assistant") {
        const assistantMsg = agentEvent.message as any;

        if (assistantMsg.stopReason) {
          runState.stopReason = assistantMsg.stopReason;
        }
        if (assistantMsg.errorMessage) {
          runState.errorMessage = assistantMsg.errorMessage;
        }

        if (assistantMsg.usage) {
          runState.totalUsage.input += assistantMsg.usage.input;
          runState.totalUsage.output += assistantMsg.usage.output;
          runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
          runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
          runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
          runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
          runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
          runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
          runState.totalUsage.cost.total += assistantMsg.usage.cost.total;

          // Per-turn LLM metrics
          const llmAttributes = metricAttributes({
            provider: model.provider,
            model: agentConfig.model,
            ...baseAttrs,
            stop_reason: assistantMsg.stopReason,
            error: Boolean(assistantMsg.errorMessage),
          });
          Sentry.metrics.count("agent.llm.calls", 1, { attributes: llmAttributes });
          Sentry.metrics.distribution("agent.llm.tokens_in", assistantMsg.usage.input, {
            attributes: llmAttributes,
          });
          Sentry.metrics.distribution("agent.llm.tokens_out", assistantMsg.usage.output, {
            attributes: llmAttributes,
          });
          if (assistantMsg.usage.cacheRead > 0) {
            Sentry.metrics.distribution("agent.llm.cache_read", assistantMsg.usage.cacheRead, {
              attributes: llmAttributes,
            });
          }
          if (assistantMsg.usage.cacheWrite > 0) {
            Sentry.metrics.distribution("agent.llm.cache_write", assistantMsg.usage.cacheWrite, {
              attributes: llmAttributes,
            });
          }
          Sentry.metrics.distribution("agent.llm.cost_per_turn", assistantMsg.usage.cost.total, {
            attributes: llmAttributes,
          });
          addLifecycleBreadcrumb("agent.llm.call.completed", {
            call_index: runState.llmCallCount,
            provider: model.provider,
            model: agentConfig.model,
            stop_reason: assistantMsg.stopReason,
            error: Boolean(assistantMsg.errorMessage),
            input_tokens: assistantMsg.usage.input,
            output_tokens: assistantMsg.usage.output,
            cost_total_usd: assistantMsg.usage.cost.total,
          });
        }

        const content = agentEvent.message.content;
        const thinkingParts: string[] = [];
        const textParts: string[] = [];
        for (const part of content) {
          if (part.type === "thinking") {
            thinkingParts.push((part as any).thinking);
          } else if (part.type === "text") {
            textParts.push((part as any).text);
          }
        }

        const text = textParts.join("\n");

        for (const thinking of thinkingParts) {
          log.logThinking(logCtx, thinking);
          queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
          queue.enqueueMessage(`_${thinking}_`, "thread", "thinking thread", false);
        }

        if (text.trim()) {
          log.logResponse(logCtx, text);
          queue.enqueueMessage(text, "main", "response main");
          // Only overflow to thread for texts that will be truncated in main
          if (text.length > SLACK_MAX_LENGTH) {
            queue.enqueueMessage(text, "thread", "response thread", false);
          }
        }
      }
    } else if (event.type === "compaction_start") {
      log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
      queue.enqueue(() => responseCtx.respond("_Compacting context..._"), "compaction start");
    } else if (event.type === "compaction_end") {
      const compEvent = event as any;
      if (compEvent.result) {
        log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
      } else if (compEvent.aborted) {
        log.logInfo("Auto-compaction aborted");
      }
    } else if (event.type === "auto_retry_start") {
      const retryEvent = event as any;
      log.logWarning(
        `Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`,
        retryEvent.errorMessage,
      );
      queue.enqueue(
        () =>
          responseCtx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`),
        "retry",
      );
    }
  });

  // Message limit constant
  const SLACK_MAX_LENGTH = 40000;
  const splitForSlack = (text: string): string[] => {
    if (text.length <= SLACK_MAX_LENGTH) return [text];
    const parts: string[] = [];
    let remaining = text;
    let partNum = 1;
    while (remaining.length > 0) {
      const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
      remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
      const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
      parts.push(chunk + suffix);
      partNum++;
    }
    return parts;
  };

  return {
    async run(
      message: ChatMessage,
      responseCtx: ChatResponseContext,
      platform: PlatformInfo,
    ): Promise<{ stopReason: string; errorMessage?: string }> {
      // Extract conversationId from sessionKey (format: "conversationId:rootTs" or just "conversationId")
      const sessionConversationId = message.sessionKey.split(":")[0];

      // Ensure the conversation directory exists
      await mkdir(conversationDir, { recursive: true });

      // Refresh vault config and clear executor cache so credential changes
      // (env file updates, vault.json edits, token rotations) take effect.
      // Then set the active actor BEFORE building system prompt, so workspacePath
      // reflects the actor's sandbox type.
      if (executionResolver) {
        executionResolver.refresh();
        activeExecutor = await executionResolver.resolve({
          platform: platform.name,
          userId: message.userId,
        });
        workspacePath = getWorkspacePath();
      }

      // Sync messages from log.jsonl that arrived while we were offline or busy
      // Exclude the current message (it will be added via prompt())
      // Default sync range is 10 days (handled by syncLogToSessionManager)
      // Thread filter ensures only messages from this session's thread are synced
      const threadFilter = message.sessionKey.includes(":")
        ? { scope: "thread" as const, rootTs, threadTs: message.threadTs }
        : { scope: "top-level" as const, rootTs };
      const syncedCount = await syncLogToSessionManager(
        sessionManager,
        conversationDir,
        message.id,
        undefined,
        threadFilter,
      );
      if (syncedCount > 0) {
        log.logInfo(`[${conversationId}] Synced ${syncedCount} messages from log.jsonl`);
      }

      // Reload messages from the session file.
      // This picks up any messages synced above.
      const reloadedSession = sessionManager.buildSessionContext();
      if (reloadedSession.messages.length > 0) {
        agent.state.messages = reloadedSession.messages;
        log.logInfo(
          `[${conversationId}] Reloaded ${reloadedSession.messages.length} messages from context`,
        );
      }

      // Update system prompt with fresh memory, channel/user info, and skills
      // Use the actual executor's sandbox config, not the initial config,
      // to ensure accurate environment description for the model
      const memory = await getMemory(conversationDir);
      const skills = loadMamaSkills(conversationDir, workspacePath);
      const actualSandboxConfig = executor.getSandboxConfig();
      const systemPrompt = buildSystemPrompt(
        workspacePath,
        conversationId,
        message.userId,
        memory,
        actualSandboxConfig,
        platform,
        skills,
      );
      session.agent.state.systemPrompt = systemPrompt;

      // Set up file upload function
      setUploadFunction(async (filePath: string, title?: string) => {
        const hostPath = translateToHostPath(
          filePath,
          conversationDir,
          workspacePath,
          conversationId,
        );
        await responseCtx.uploadFile(hostPath, title);
      });
      setEventContext({
        platform: platform.name,
        conversationId,
        userId: message.userId,
      });

      // Reset per-run state
      runState.responseCtx = responseCtx;
      runState.logCtx = {
        conversationId: sessionConversationId,
        userName: message.userName,
        conversationName: undefined,
        sessionId: sessionUuid,
      };
      runState.pendingTools.clear();
      runState.totalUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      runState.llmCallCount = 0;
      runState.stopReason = "stop";
      runState.errorMessage = undefined;

      // Create queue for this run
      let queueChain = Promise.resolve();
      runState.queue = {
        enqueue(fn: () => Promise<void>, errorContext: string): void {
          queueChain = queueChain.then(async () => {
            try {
              await fn();
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              log.logWarning(`API error (${errorContext})`, errMsg);
              try {
                // Split long error messages to avoid msg_too_long
                const errParts = splitForSlack(`_Error: ${errMsg}_`);
                for (const part of errParts) {
                  await responseCtx.respondInThread(part);
                }
              } catch {
                // Ignore
              }
            }
          });
        },
        enqueueMessage(
          text: string,
          target: "main" | "thread",
          errorContext: string,
          _doLog = true,
        ): void {
          const parts = splitForSlack(text);
          for (const part of parts) {
            this.enqueue(
              () =>
                target === "main" ? responseCtx.respond(part) : responseCtx.respondInThread(part),
              errorContext,
            );
          }
        },
      };

      // Log context info
      log.logInfo(
        `Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`,
      );
      log.logInfo(`Channels: ${platform.channels.length}, Users: ${platform.users.length}`);

      // Build user message with timestamp and username prefix
      // Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, "0");
      const offset = -now.getTimezoneOffset();
      const offsetSign = offset >= 0 ? "+" : "-";
      const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
      const offsetMins = pad(Math.abs(offset) % 60);
      const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
      const threadContext = message.threadTs ? ` [in-thread:${message.threadTs}]` : "";
      let userMessage = `[${timestamp}] [${message.userName || "unknown"}]${threadContext}: ${message.text}`;

      const imageAttachments: ImageContent[] = [];
      const nonImagePaths: string[] = [];

      for (const a of message.attachments || []) {
        // a.localPath is the path relative to the workspace
        const fullPath = `${workspacePath}/${a.localPath}`;
        const mimeType = getImageMimeType(a.localPath);

        if (mimeType && existsSync(fullPath)) {
          try {
            imageAttachments.push({
              type: "image",
              mimeType,
              data: readFileSync(fullPath).toString("base64"),
            });
          } catch {
            nonImagePaths.push(fullPath);
          }
        } else {
          nonImagePaths.push(fullPath);
        }
      }

      if (nonImagePaths.length > 0) {
        userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
      }

      // Debug: write context to last_prompt.jsonl
      const debugContext = {
        systemPrompt,
        messages: session.messages,
        newUserMessage: userMessage,
        imageAttachmentCount: imageAttachments.length,
      };
      await writeFile(
        join(conversationDir, "last_prompt.jsonl"),
        JSON.stringify(debugContext, null, 2),
      );
      addLifecycleBreadcrumb("agent.prompt.sent", {
        provider: model.provider,
        model: agentConfig.model,
        channel_id: sessionConversationId,
        session_id: sessionUuid,
        attachment_count: message.attachments?.length ?? 0,
        image_attachment_count: imageAttachments.length,
      });

      await session.prompt(
        userMessage,
        imageAttachments.length > 0 ? { images: imageAttachments } : undefined,
      );

      // Wait for queued messages
      await queueChain;

      // Handle error case - update main message and post error to thread
      if (runState.stopReason === "error" && runState.errorMessage) {
        try {
          await responseCtx.replaceResponse("_Sorry, something went wrong_");
          // Split long error messages to avoid msg_too_long
          const errorParts = splitForSlack(`_Error: ${runState.errorMessage}_`);
          for (const part of errorParts) {
            await responseCtx.respondInThread(part);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.logWarning("Failed to post error message", errMsg);
        }
      } else {
        // Final message update
        const messages = session.messages;
        const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
        const finalText =
          lastAssistant?.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n") || "";

        // Check for [SILENT] marker - delete message and thread instead of posting
        if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
          try {
            await responseCtx.deleteResponse();
            log.logInfo("Silent response - deleted message and thread");
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.logWarning("Failed to delete message for silent response", errMsg);
          }
        } else if (finalText.trim()) {
          try {
            const mainText =
              finalText.length > SLACK_MAX_LENGTH
                ? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
                : finalText;
            await responseCtx.replaceResponse(mainText);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.logWarning("Failed to replace message with final text", errMsg);
          }
        }
      }

      // Log usage summary with context info
      if (runState.totalUsage.cost.total > 0) {
        // Get last non-aborted assistant message for context calculation
        const messages = session.messages;
        const lastAssistantMessage = messages
          .slice()
          .reverse()
          .find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

        const contextTokens = lastAssistantMessage
          ? lastAssistantMessage.usage.input +
            lastAssistantMessage.usage.output +
            lastAssistantMessage.usage.cacheRead +
            lastAssistantMessage.usage.cacheWrite
          : 0;
        const contextWindow = model.contextWindow || 200000;

        // Run-level Sentry metrics
        const { totalUsage } = runState;
        const runMetricAttributes = metricAttributes({
          provider: model.provider,
          model: agentConfig.model,
          channel_id: sessionConversationId,
          session_id: sessionUuid,
          stop_reason: runState.stopReason,
          llm_calls: runState.llmCallCount,
        });
        Sentry.metrics.distribution("agent.run.tokens_in", totalUsage.input, {
          attributes: runMetricAttributes,
        });
        Sentry.metrics.distribution("agent.run.tokens_out", totalUsage.output, {
          attributes: runMetricAttributes,
        });
        Sentry.metrics.distribution("agent.run.cache_read", totalUsage.cacheRead, {
          attributes: runMetricAttributes,
        });
        Sentry.metrics.distribution("agent.run.cache_write", totalUsage.cacheWrite, {
          attributes: runMetricAttributes,
        });
        Sentry.metrics.distribution("agent.run.cost", totalUsage.cost.total, {
          attributes: runMetricAttributes,
        });
        Sentry.metrics.gauge("agent.context.utilization", contextTokens / contextWindow, {
          unit: "ratio",
          attributes: runMetricAttributes,
        });

        const summary = log.logUsageSummary(
          runState.logCtx!,
          runState.totalUsage,
          contextTokens,
          contextWindow,
        );
        // Split long summaries to avoid msg_too_long
        const summaryParts = splitForSlack(summary);
        for (const part of summaryParts) {
          runState.queue!.enqueue(
            () => responseCtx.respondInThread(part, { style: "muted" }),
            "usage summary",
          );
        }
        await queueChain;
      }

      // Clear run state
      runState.responseCtx = null;
      runState.logCtx = null;
      runState.queue = null;

      return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
    },

    abort(): void {
      session.abort();
    },

    getCurrentStep(): { toolName?: string; label?: string } | undefined {
      const pending = runState.pendingTools;
      if (pending.size === 0) return undefined;
      // Get the first pending tool
      const first = pending.values().next().value;
      if (!first) return undefined;
      return {
        toolName: first.toolName,
        label: (first.args as { label?: string })?.label,
      };
    },
  };
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
  containerPath: string,
  conversationDir: string,
  workspacePath: string,
  conversationId: string,
): string {
  if (workspacePath === "/workspace") {
    const prefix = `/workspace/${conversationId}/`;
    if (containerPath.startsWith(prefix)) {
      return join(conversationDir, containerPath.slice(prefix.length));
    }
    if (containerPath.startsWith("/workspace/")) {
      return join(conversationDir, "..", containerPath.slice("/workspace/".length));
    }
  }
  return containerPath;
}
