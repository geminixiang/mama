#!/usr/bin/env node

import { join, resolve } from "path";
import {
	createSlackAdapters,
	type MomHandler,
	type SlackBot,
	SlackBot as SlackBotClass,
	type SlackEvent,
} from "./adapters/slack/index.js";
import { type AgentRunner, createRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mama [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mama --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	stopRequested: boolean;
	stopMessageTs?: string;
	lastAccessedAt: number;
}

const channelStates = new Map<string, ChannelState>();

/** Maximum number of cached sessions */
const MAX_SESSIONS = 500;
/** Idle timeout before a non-running session can be evicted (1 hour) */
const IDLE_TIMEOUT_MS = 3600000;

async function getState(channelId: string, sessionKey?: string): Promise<ChannelState> {
	const key = sessionKey ?? channelId;
	let state = channelStates.get(key);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: await createRunner(sandbox, key, channelId, channelDir, workingDir),
			stopRequested: false,
			lastAccessedAt: Date.now(),
		};
		channelStates.set(key, state);
	} else {
		state.lastAccessedAt = Date.now();
	}
	return state;
}

/**
 * Evict idle sessions from channelStates to bound memory usage.
 * Called after each handleEvent completes.
 *
 * Eviction rules:
 * - Never evict sessions that are currently running
 * - Evict sessions idle for more than IDLE_TIMEOUT_MS
 * - If still over MAX_SESSIONS, evict oldest idle sessions first
 */
function evictIdleSessions(): void {
	const now = Date.now();

	// First pass: evict sessions that are idle and past the timeout
	for (const [key, state] of channelStates) {
		if (!state.running && now - state.lastAccessedAt > IDLE_TIMEOUT_MS) {
			channelStates.delete(key);
		}
	}

	// Second pass: if still over capacity, evict oldest idle sessions
	if (channelStates.size > MAX_SESSIONS) {
		// Collect all non-running sessions with their last access time
		const idleSessions: Array<{ key: string; lastAccessedAt: number }> = [];
		for (const [key, state] of channelStates) {
			if (!state.running) {
				idleSessions.push({ key, lastAccessedAt: state.lastAccessedAt });
			}
		}

		// Sort oldest first
		idleSessions.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

		// Evict until under capacity
		const toEvict = channelStates.size - MAX_SESSIONS;
		for (let i = 0; i < toEvict && i < idleSessions.length; i++) {
			channelStates.delete(idleSessions[i].key);
		}
	}
}

// ============================================================================
// Handler
// ============================================================================

const handler: MomHandler = {
	isRunning(sessionKey: string): boolean {
		const state = channelStates.get(sessionKey);
		return state?.running ?? false;
	},

	async handleStop(sessionKey: string, channelId: string, slack: SlackBot): Promise<void> {
		const state = channelStates.get(sessionKey);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts; // Save for updating later
		} else {
			await slack.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const sessionKey = `${event.channel}:${event.thread_ts ?? event.ts}`;
		const state = await getState(event.channel, sessionKey);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// Create platform-agnostic adapter objects
			const { message, responseCtx, platform } = createSlackAdapters(event, slack, isEvent);

			// Run the agent
			await responseCtx.setTyping(true);
			await responseCtx.setWorking(true);
			const result = await state.runner.run(message, responseCtx, platform);
			await responseCtx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
			state.lastAccessedAt = Date.now();
			evictIdleSessions();
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Shared store for attachment downloads (also used per-channel in getState)
const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });

const bot = new SlackBotClass(handler, {
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
	workingDir,
	store: sharedStore,
});

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

bot.start();
