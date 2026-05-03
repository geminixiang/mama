import type { Bot, BotAdapters, BotEvent, BotHandler, RunningSession } from "../adapter.js";
import {
  hasMaterializedSlackBranchSession,
  resolveSlackSessionScope,
  waitForSlackBranchBootstrap,
} from "../adapters/slack/branch-manager.js";
import { type AgentRunner, createRunner } from "../agent.js";
import { CommandRegistry, createDefaultCommandRegistry } from "../commands/index.js";
import type { CommandServices } from "../commands/index.js";
import * as log from "../log.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getChannelSessionDir,
  getThreadSessionFile,
  resolveGenericSessionScope,
  type ResolvedSessionScope,
} from "../session-store.js";
import { addLifecycleBreadcrumb, applyRunScope } from "../sentry.js";
import { formatNothingRunning, formatStopped, formatStopping } from "../ui-copy.js";
import * as Sentry from "@sentry/node";
import { join } from "path";

interface ConversationState {
  running: boolean;
  runner: AgentRunner;
  stopRequested: boolean;
  stopMessageTs?: string;
  lastAccessedAt: number;
  startedAt?: number;
  lastActivityAt?: number;
}

export interface RunSessionOptions {
  event: BotEvent;
  bot: Bot;
  adapters: BotAdapters;
  isEvent?: boolean;
}

export interface CreateSessionSandboxOptions {
  conversationId: string;
  platformName: string;
  sessionKey: string;
}

export interface SessionRuntimeOptions extends CommandServices {
  /** Override the default command registry (e.g., to add /help, /status). */
  commandRegistry?: CommandRegistry;
}

export interface SessionRuntime extends BotHandler {
  runSession(options: RunSessionOptions): Promise<void>;
  createSessionSandbox(options: CreateSessionSandboxOptions): Promise<AgentRunner>;
  shutdown(timeoutMs?: number): Promise<void>;
}

const MAX_SESSIONS = 500;
const IDLE_TIMEOUT_MS = 3_600_000;

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  return new MamaSessionRuntime(options);
}

class MamaSessionRuntime implements SessionRuntime {
  private readonly conversationStates = new Map<string, ConversationState>();
  private readonly inFlightRuns = new Set<Promise<void>>();
  private readonly commandRegistry: CommandRegistry;
  private isShuttingDown = false;

  constructor(private readonly options: SessionRuntimeOptions) {
    this.commandRegistry = options.commandRegistry ?? createDefaultCommandRegistry();
  }

  isRunning(sessionKey: string): boolean {
    const state = this.conversationStates.get(sessionKey);
    return !!state?.running;
  }

  getRunningSessions(): RunningSession[] {
    const sessions: RunningSession[] = [];
    for (const [sessionKey, state] of this.conversationStates) {
      if (state.running && state.startedAt) {
        const currentStep = state.runner.getCurrentStep();
        sessions.push({
          sessionKey,
          startedAt: state.startedAt,
          lastActivityAt: state.lastActivityAt,
          currentTool: currentStep?.label || currentStep?.toolName,
        });
      }
    }
    return sessions;
  }

  async handleStop(sessionKey: string, conversationId: string, bot: Bot): Promise<void> {
    const state = this.conversationStates.get(sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
      const ts = await bot.postMessage(conversationId, formatStopping(bot));
      state.stopMessageTs = ts;
    } else {
      await bot.postMessage(conversationId, formatNothingRunning(bot));
    }
  }

  forceStop(sessionKey: string): void {
    const state = this.conversationStates.get(sessionKey);
    if (state?.running) {
      log.logInfo(`[Force Stop] Force stopping session: ${sessionKey}`);
      state.stopRequested = true;
      state.runner.abort();
      state.running = false;
    }
  }

  async handleNew(sessionKey: string, conversationId: string, bot: Bot): Promise<void> {
    const state = this.conversationStates.get(sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
    }

    const conversationDir = join(this.options.workingDir, conversationId);
    if (sessionKey.includes(":")) {
      createManagedSessionFileAtPath(
        getThreadSessionFile(conversationDir, sessionKey),
        conversationDir,
      );
    } else {
      createManagedSessionFile(getChannelSessionDir(conversationDir), conversationDir);
    }

    this.conversationStates.delete(sessionKey);

    log.logInfo(`[${conversationId}] Session reset: ${sessionKey}`);
    await bot.postMessage(conversationId, "Conversation reset. Send a new message to start fresh.");
  }

  async handleEvent(
    event: BotEvent,
    bot: Bot,
    adapters: BotAdapters,
    isEvent?: boolean,
  ): Promise<void> {
    await this.runSession({ event, bot, adapters, isEvent });
  }

  async runSession({ event, bot, adapters, isEvent }: RunSessionOptions): Promise<void> {
    const conversationId = event.conversationId;
    if (this.isShuttingDown) {
      log.logInfo(
        `[${conversationId}] Rejected event during shutdown: ${event.text.substring(0, 50)}`,
      );
      return;
    }

    const sessionKey = event.sessionKey ?? `${conversationId}:${event.thread_ts ?? event.ts}`;
    const privateConversation = isPrivateConversation(event);
    const handledCommand = await this.commandRegistry.handle({
      bot,
      responseCtx: adapters.responseCtx,
      platform: adapters.platform.name,
      platformUserId: event.user,
      conversationId,
      sessionKey,
      commandText: event.text,
      privateConversation,
      services: this.options,
    });
    if (handledCommand) return;

    const conversationDir = join(this.options.workingDir, conversationId);
    const waitedForParent =
      adapters.platform.name === "slack"
        ? await waitForSlackBranchBootstrap({
            parentSessionKey: conversationId,
            sessionKey,
            hasThreadSession: () => hasMaterializedSlackBranchSession(conversationDir, sessionKey),
            isParentRunning: () => this.conversationStates.get(conversationId)?.running === true,
          })
        : false;
    if (waitedForParent) {
      log.logInfo(
        `[${conversationId}] Delayed thread bootstrap until parent session sealed: ${sessionKey}`,
      );
    }

    const runner = await this.createSessionSandbox({
      conversationId,
      platformName: adapters.platform.name,
      sessionKey,
    });
    const state = this.conversationStates.get(sessionKey)!;

    state.running = true;
    state.runner = runner;
    state.stopRequested = false;
    state.startedAt = Date.now();
    state.lastActivityAt = Date.now();

    log.logInfo(`[${conversationId}] Starting run: ${event.text.substring(0, 50)}`);

    Sentry.metrics.count("agent.run.started", 1, {
      attributes: { channel: conversationId },
    });
    Sentry.metrics.gauge("agent.sessions.active", this.inFlightRuns.size + 1);

    const runPromise = Sentry.startSpan(
      { name: "agent.run", op: "agent", attributes: { conversationId, sessionKey } },
      async () => {
        return Sentry.withScope(async (scope) => {
          const { message, responseCtx, platform } = adapters;
          applyRunScope(scope, {
            conversationId,
            sessionKey,
            messageId: message.id,
            platform: platform.name,
            userId: message.userId,
            userName: message.userName,
            threadTs: message.threadTs,
            isEvent,
          });
          addLifecycleBreadcrumb("agent.run.started", {
            channel_id: conversationId,
            platform: platform.name,
            has_attachments: (message.attachments?.length ?? 0) > 0,
          });

          try {
            await responseCtx.setTyping(true);
            await responseCtx.setWorking(true);
            const result = await state.runner.run(message, responseCtx, platform);
            await responseCtx.setWorking(false);

            const durationMs = Date.now() - state.startedAt!;
            Sentry.metrics.distribution("agent.run.duration", durationMs, {
              unit: "millisecond",
              attributes: {
                channel: conversationId,
                platform: platform.name,
                stop_reason: result.stopReason,
              },
            });
            Sentry.metrics.count("agent.run.completed", 1, {
              attributes: {
                channel: conversationId,
                platform: platform.name,
                stop_reason: result.stopReason,
              },
            });
            addLifecycleBreadcrumb("agent.run.completed", {
              channel_id: conversationId,
              platform: platform.name,
              stop_reason: result.stopReason,
              duration_ms: durationMs,
            });

            if (result.stopReason === "aborted" && state.stopRequested) {
              if (state.stopMessageTs) {
                await bot.updateMessage(conversationId, state.stopMessageTs, formatStopped(bot));
                state.stopMessageTs = undefined;
              } else {
                await bot.postMessage(conversationId, formatStopped(bot));
              }
            }
          } catch (err) {
            scope.setContext("agent_run_error", {
              conversationId,
              sessionKey,
              platform: adapters.platform.name,
              messageId: adapters.message.id,
              threadTs: adapters.message.threadTs,
            });
            Sentry.captureException(err);
            Sentry.metrics.count("agent.run.errors", 1, {
              attributes: { channel: conversationId, platform: adapters.platform.name },
            });
            log.logWarning(
              `[${conversationId}] Run error`,
              err instanceof Error ? err.message : String(err),
            );
          } finally {
            state.running = false;
            state.lastAccessedAt = Date.now();
            Sentry.metrics.gauge("agent.sessions.active", this.inFlightRuns.size - 1);
            this.evictIdleSessions();
          }
        });
      },
    );

    this.inFlightRuns.add(runPromise);
    try {
      await runPromise;
    } finally {
      this.inFlightRuns.delete(runPromise);
    }
  }

  async createSessionSandbox({
    conversationId,
    platformName,
    sessionKey,
  }: CreateSessionSandboxOptions): Promise<AgentRunner> {
    let state = this.conversationStates.get(sessionKey);
    if (!state) {
      const conversationDir = join(this.options.workingDir, conversationId);
      const sessionScope = await this.resolveSessionScope(
        platformName,
        conversationDir,
        sessionKey,
      );
      state = {
        running: false,
        runner: await createRunner(
          this.options.sandbox,
          sessionKey,
          conversationId,
          conversationDir,
          this.options.workingDir,
          sessionScope,
          this.options.vaultManager,
          this.options.bindingStore,
          this.options.provisioner,
        ),
        stopRequested: false,
        lastAccessedAt: Date.now(),
      };
      this.conversationStates.set(sessionKey, state);
    } else {
      state.lastAccessedAt = Date.now();
    }
    return state.runner;
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    log.logInfo("Shutting down gracefully...");

    const timeout = Date.now() + timeoutMs;
    while (this.inFlightRuns.size > 0 && Date.now() < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.inFlightRuns.size > 0) {
      log.logWarning(`Forcing exit with ${this.inFlightRuns.size} runs still in progress`);
    }
  }

  private async resolveSessionScope(
    platformName: string,
    conversationDir: string,
    sessionKey: string,
  ): Promise<ResolvedSessionScope> {
    if (platformName === "slack") {
      return resolveSlackSessionScope({ conversationDir, sessionKey });
    }
    return resolveGenericSessionScope({ conversationDir, sessionKey });
  }

  private evictIdleSessions(): void {
    const now = Date.now();

    for (const [key, state] of this.conversationStates) {
      if (!state.running && now - state.lastAccessedAt > IDLE_TIMEOUT_MS) {
        this.conversationStates.delete(key);
      }
    }

    if (this.conversationStates.size > MAX_SESSIONS) {
      const idleSessions: Array<{ key: string; lastAccessedAt: number }> = [];
      for (const [key, state] of this.conversationStates) {
        if (!state.running) {
          idleSessions.push({ key, lastAccessedAt: state.lastAccessedAt });
        }
      }

      idleSessions.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

      const toEvict = this.conversationStates.size - MAX_SESSIONS;
      for (let i = 0; i < toEvict && i < idleSessions.length; i++) {
        this.conversationStates.delete(idleSessions[i].key);
      }
    }
  }
}

function isPrivateConversation(event: BotEvent): boolean {
  return event.conversationKind === "direct" || event.type === "dm";
}
