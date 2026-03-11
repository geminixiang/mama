import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadAgentConfig, saveAgentConfig } from "../src/config.js";

describe("loadAgentConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `mama-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	test("returns defaults when no settings.json and no env vars", () => {
		const config = loadAgentConfig(tmpDir);
		expect(config.provider).toBe("anthropic");
		expect(config.model).toBe("claude-sonnet-4-5");
		expect(config.thinkingLevel).toBe("off");
		expect(config.sessionScope).toBe("thread");
	});

	test("reads provider and model from settings.json", () => {
		saveAgentConfig(tmpDir, { provider: "openai", model: "gpt-4o" });
		const config = loadAgentConfig(tmpDir);
		expect(config.provider).toBe("openai");
		expect(config.model).toBe("gpt-4o");
	});

	test("reads sessionScope from settings.json", () => {
		saveAgentConfig(tmpDir, { sessionScope: "channel" });
		const config = loadAgentConfig(tmpDir);
		expect(config.sessionScope).toBe("channel");
	});

	test("env vars override defaults but not settings.json", () => {
		// With env var only (no settings.json)
		process.env.MOM_AI_PROVIDER = "google";
		process.env.MOM_AI_MODEL = "gemini-2.0-flash";
		try {
			const config = loadAgentConfig(tmpDir);
			expect(config.provider).toBe("google");
			expect(config.model).toBe("gemini-2.0-flash");
		} finally {
			delete process.env.MOM_AI_PROVIDER;
			delete process.env.MOM_AI_MODEL;
		}
	});

	test("settings.json values override env vars", () => {
		saveAgentConfig(tmpDir, { provider: "openai", model: "gpt-4o" });
		process.env.MOM_AI_PROVIDER = "google";
		process.env.MOM_AI_MODEL = "gemini-2.0-flash";
		try {
			const config = loadAgentConfig(tmpDir);
			expect(config.provider).toBe("openai");
			expect(config.model).toBe("gpt-4o");
		} finally {
			delete process.env.MOM_AI_PROVIDER;
			delete process.env.MOM_AI_MODEL;
		}
	});

	test("silently ignores malformed settings.json and falls back to defaults", () => {
		const { writeFileSync } = require("node:fs");
		writeFileSync(join(tmpDir, "settings.json"), "{ invalid json }", "utf-8");
		const config = loadAgentConfig(tmpDir);
		expect(config.provider).toBe("anthropic");
		expect(config.model).toBe("claude-sonnet-4-5");
	});
});

describe("saveAgentConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `mama-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	test("creates settings.json with given config", () => {
		saveAgentConfig(tmpDir, { provider: "google", model: "gemini-2.0-flash" });
		const config = loadAgentConfig(tmpDir);
		expect(config.provider).toBe("google");
		expect(config.model).toBe("gemini-2.0-flash");
	});

	test("merges with existing settings — preserves unrelated fields", () => {
		saveAgentConfig(tmpDir, { provider: "openai", model: "gpt-4o", sessionScope: "channel" });
		saveAgentConfig(tmpDir, { model: "gpt-4o-mini" });
		const config = loadAgentConfig(tmpDir);
		expect(config.provider).toBe("openai"); // preserved
		expect(config.model).toBe("gpt-4o-mini"); // updated
		expect(config.sessionScope).toBe("channel"); // preserved
	});

	test("creates parent directories if they don't exist", () => {
		const nested = join(tmpDir, "a", "b", "c");
		saveAgentConfig(nested, { provider: "anthropic" });
		expect(existsSync(join(nested, "settings.json"))).toBe(true);
	});
});
