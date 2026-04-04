import { Logging } from "@google-cloud/logging";
import { Writable } from "node:stream";
import chalk from "chalk";
import pino from "pino";

const PINO_TO_GCP: Record<number, string> = {
  10: "DEBUG",
  20: "DEBUG",
  30: "INFO",
  40: "WARNING",
  50: "ERROR",
  60: "CRITICAL",
};

function createGcpStream(): Writable {
  const log = new Logging().log("mama");
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const line = chunk.toString().trim();
        if (line) {
          const { level, time, pid: _pid, hostname: _hostname, msg, ...rest } = JSON.parse(line);
          const entry = log.entry(
            { severity: PINO_TO_GCP[level] ?? "DEFAULT", timestamp: new Date(time) },
            { message: msg, ...rest },
          );
          log.write(entry).catch((err) => console.error("GCP log write failed:", err));
        }
      } catch {
        // ignore parse errors
      }
      callback();
    },
  });
}

export interface LogContext {
  channelId: string;
  userName?: string;
  channelName?: string; // For display like #dev-team vs C16HET4EQ
  sessionId?: string;
}

export interface LogConfig {
  logFormat?: "console" | "json";
  logLevel?: "trace" | "debug" | "info" | "warn" | "error";
}

let logger: pino.Logger | null = null;

export function initLogger(config?: LogConfig): void {
  if (logger) return;

  const format = config?.logFormat ?? "console";
  const level = config?.logLevel ?? "info";

  if (format === "json") {
    try {
      logger = pino({ level }, createGcpStream());
      console.log(`📝 GCP logging enabled (level: ${level})`);
    } catch (err) {
      console.warn("⚠️ Failed to init GCP logger, JSON logging disabled:", err);
    }
  }
}

/** Only for use in tests. */
export function __resetLoggerForTest(): void {
  logger = null;
}

function ctxFields(ctx: LogContext): Record<string, string> {
  const out: Record<string, string> = { channel: ctx.channelId };
  if (ctx.userName) out.user = ctx.userName;
  if (ctx.channelName) out.channelName = ctx.channelName;
  if (ctx.sessionId) out.sessionId = ctx.sessionId;
  return out;
}

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `[${hh}:${mm}:${ss}]`;
}

function formatContext(ctx: LogContext): string {
  const session = ctx.sessionId ? `:${ctx.sessionId}` : "";
  if (ctx.channelId.startsWith("D")) {
    return `[DM:${ctx.userName || ctx.channelId}${session}]`;
  }
  const channel = ctx.channelName || ctx.channelId;
  const user = ctx.userName || "unknown";
  return `[${channel.startsWith("#") ? channel : `#${channel}`}:${user}${session}]`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.substring(0, maxLen)}\n(truncated at ${maxLen} chars)`;
}

function formatToolArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    // Skip the label - it's already shown in the tool name
    if (key === "label") continue;

    // For read tool, format path with offset/limit
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

    // Skip offset/limit since we already handled them
    if (key === "offset" || key === "limit") continue;

    // For other values, format them
    if (typeof value === "string") {
      // Multi-line strings get indented
      if (value.includes("\n")) {
        lines.push(value);
      } else {
        lines.push(value);
      }
    } else {
      lines.push(JSON.stringify(value));
    }
  }

  return lines.join("\n");
}

// User messages
export function logUserMessage(ctx: LogContext, text: string): void {
  if (logger) logger.info({ event: "user_message", ...ctxFields(ctx), text }, text);
  console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} ${text}`));
}

// Tool execution
export function logToolStart(
  ctx: LogContext,
  toolName: string,
  label: string,
  args: Record<string, unknown>,
): void {
  if (logger)
    logger.debug(
      { event: "tool_start", ...ctxFields(ctx), tool: toolName, label, args },
      `${toolName}: ${label}`,
    );
  const formattedArgs = formatToolArgs(args);
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↳ ${toolName}: ${label}`));
  if (formattedArgs) {
    // Indent the args
    const indented = formattedArgs
      .split("\n")
      .map((line) => `           ${line}`)
      .join("\n");
    console.log(chalk.dim(indented));
  }
}

export function logToolSuccess(
  ctx: LogContext,
  toolName: string,
  durationMs: number,
  result: string,
): void {
  if (logger)
    logger.debug(
      { event: "tool_success", ...ctxFields(ctx), tool: toolName, durationMs, result },
      `${toolName} completed`,
    );
  const duration = (durationMs / 1000).toFixed(1);
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✓ ${toolName} (${duration}s)`));

  const truncated = truncate(result, 1000);
  if (truncated) {
    const indented = truncated
      .split("\n")
      .map((line) => `           ${line}`)
      .join("\n");
    console.log(chalk.dim(indented));
  }
}

export function logToolError(
  ctx: LogContext,
  toolName: string,
  durationMs: number,
  error: string,
): void {
  if (logger)
    logger.warn(
      { event: "tool_error", ...ctxFields(ctx), tool: toolName, durationMs, error },
      `${toolName} failed`,
    );
  const duration = (durationMs / 1000).toFixed(1);
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ ${toolName} (${duration}s)`));

  const truncated = truncate(error, 1000);
  const indented = truncated
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
  console.log(chalk.dim(indented));
}

// Response streaming
export function logResponseStart(ctx: LogContext): void {
  if (logger) logger.debug({ event: "response_start", ...ctxFields(ctx) }, "Streaming response");
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} → Streaming response...`));
}

export function logThinking(ctx: LogContext, thinking: string): void {
  if (logger) logger.debug({ event: "thinking", ...ctxFields(ctx), text: thinking }, "Thinking");
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💭 Thinking`));
  const truncated = truncate(thinking, 1000);
  const indented = truncated
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
  console.log(chalk.dim(indented));
}

export function logResponse(ctx: LogContext, text: string): void {
  if (logger) logger.info({ event: "response", ...ctxFields(ctx), text }, "Response");
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💬 Response`));
  const truncated = truncate(text, 1000);
  const indented = truncated
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
  console.log(chalk.dim(indented));
}

// Attachments
export function logDownloadStart(ctx: LogContext, filename: string, localPath: string): void {
  if (logger)
    logger.debug(
      { event: "download_start", ...ctxFields(ctx), filename, localPath },
      `Downloading ${filename}`,
    );
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↓ Downloading attachment`));
  console.log(chalk.dim(`           ${filename} → ${localPath}`));
}

export function logDownloadSuccess(ctx: LogContext, sizeKB: number): void {
  if (logger)
    logger.info(
      { event: "download_success", ...ctxFields(ctx), sizeKB },
      `Downloaded (${sizeKB} KB)`,
    );
  console.log(
    chalk.yellow(
      `${timestamp()} ${formatContext(ctx)} ✓ Downloaded (${sizeKB.toLocaleString()} KB)`,
    ),
  );
}

export function logDownloadError(ctx: LogContext, filename: string, error: string): void {
  if (logger)
    logger.warn(
      { event: "download_error", ...ctxFields(ctx), filename, error },
      `Download failed: ${filename}`,
    );
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ Download failed`));
  console.log(chalk.dim(`           ${filename}: ${error}`));
}

// Control
export function logStopRequest(ctx: LogContext): void {
  if (logger) logger.info({ event: "stop_request", ...ctxFields(ctx) }, "Stop requested");
  console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} stop`));
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ⊗ Stop requested - aborting`));
}

// System
export function logInfo(message: string): void {
  if (logger) logger.info({ event: "info" }, message);
  console.log(chalk.blue(`${timestamp()} [system] ${message}`));
}

export function logWarning(message: string, details?: string): void {
  if (logger) logger.warn({ event: "warning", ...(details ? { details } : {}) }, message);
  console.log(chalk.yellow(`${timestamp()} [system] ⚠ ${message}`));
  if (details) {
    const indented = details
      .split("\n")
      .map((line) => `           ${line}`)
      .join("\n");
    console.log(chalk.dim(indented));
  }
}

export function logAgentError(ctx: LogContext | "system", error: string): void {
  if (logger) {
    const extra = ctx === "system" ? { error } : { ...ctxFields(ctx), error };
    logger.error({ event: "agent_error", ...extra }, "Agent error");
  }
  const context = ctx === "system" ? "[system]" : formatContext(ctx);
  console.log(chalk.yellow(`${timestamp()} ${context} ✗ Agent error`));
  const indented = error
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
  console.log(chalk.dim(indented));
}

// Usage summary
export function logUsageSummary(
  ctx: LogContext,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  },
  contextTokens?: number,
  contextWindow?: number,
): string {
  const formatTokens = (count: number): string => {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
  };

  const lines: string[] = [];
  lines.push("_Usage Summary_");
  lines.push(`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`);
  if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
    lines.push(
      `Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`,
    );
  }
  if (contextTokens && contextWindow) {
    const contextPercent = ((contextTokens / contextWindow) * 100).toFixed(1);
    lines.push(
      `Context: ${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} (${contextPercent}%)`,
    );
  }
  lines.push(
    `Cost: $${usage.cost.input.toFixed(4)} in, $${usage.cost.output.toFixed(4)} out` +
      (usage.cacheRead > 0 || usage.cacheWrite > 0
        ? `, $${usage.cost.cacheRead.toFixed(4)} cache read, $${usage.cost.cacheWrite.toFixed(4)} cache write`
        : ""),
  );
  lines.push(`*Total: $${usage.cost.total.toFixed(4)}*`);

  const summary = lines.join("\n");

  // Log to console
  if (logger) {
    logger.info(
      {
        event: "usage",
        ...ctxFields(ctx),
        tokensIn: usage.input,
        tokensOut: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cost: usage.cost.total,
      },
      `Usage: $${usage.cost.total.toFixed(4)}`,
    );
  }
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💰 Usage`));
  console.log(
    chalk.dim(
      `           ${usage.input.toLocaleString()} in + ${usage.output.toLocaleString()} out` +
        (usage.cacheRead > 0 || usage.cacheWrite > 0
          ? ` (${usage.cacheRead.toLocaleString()} cache read, ${usage.cacheWrite.toLocaleString()} cache write)`
          : "") +
        ` = $${usage.cost.total.toFixed(4)}`,
    ),
  );

  return summary;
}

// Startup (no context needed)
export function logStartup(workingDir: string, sandbox: string): void {
  if (logger) logger.info({ event: "startup", workingDir, sandbox }, "Starting mama");
  console.log("Starting mama...");
  console.log(`  Working directory: ${workingDir}`);
  console.log(`  Sandbox: ${sandbox}`);
}

export function logConnected(): void {
  if (logger) logger.info({ event: "connected" }, "Mama connected and listening");
  console.log("⚡️ Mama connected and listening!");
  console.log("");
}

export function logDisconnected(): void {
  if (logger) logger.info({ event: "disconnected" }, "Mama disconnected");
  console.log("Mama disconnected.");
}

// Backfill
export function logBackfillStart(channelCount: number): void {
  if (logger)
    logger.info({ event: "backfill_start", channelCount }, `Backfilling ${channelCount} channels`);
  console.log(chalk.blue(`${timestamp()} [system] Backfilling ${channelCount} channels...`));
}

export function logBackfillChannel(channelName: string, messageCount: number): void {
  if (logger)
    logger.debug(
      { event: "backfill_channel", channelName, messageCount },
      `#${channelName}: ${messageCount} messages`,
    );
  console.log(chalk.blue(`${timestamp()} [system]   #${channelName}: ${messageCount} messages`));
}

export function logBackfillComplete(totalMessages: number, durationMs: number): void {
  if (logger)
    logger.info(
      { event: "backfill_complete", totalMessages, durationMs },
      `Backfill complete: ${totalMessages} messages`,
    );
  const duration = (durationMs / 1000).toFixed(1);
  console.log(
    chalk.blue(
      `${timestamp()} [system] Backfill complete: ${totalMessages} messages in ${duration}s`,
    ),
  );
}
