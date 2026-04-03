import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveSttApiKey, transcribeAudio } from "../src/adapters/telegram/transcribe.js";

describe("transcribeAudio", () => {
  let workingDir: string;
  let audioFile: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-transcribe-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    audioFile = join(workingDir, "voice.ogg");
    writeFileSync(audioFile, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // fake OGG header
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("sends correct request and returns transcription", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello world" } }],
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await transcribeAudio(audioFile, {
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      apiKey: "test-key",
    });

    expect(result).toBe("Hello world");
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-key");

    const body = JSON.parse(opts.body);
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.messages[0].content[0].type).toBe("input_audio");
    expect(body.messages[0].content[0].input_audio.format).toBe("ogg");
    expect(body.messages[0].content[1].type).toBe("text");
  });

  test("throws on API error response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      transcribeAudio(audioFile, {
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        apiKey: "bad-key",
      }),
    ).rejects.toThrow("STT API error 401: Unauthorized");
  });

  test("throws on empty transcription", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      transcribeAudio(audioFile, {
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("STT API returned empty transcription");
  });

  test("trims whitespace from transcription", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "  hello world  \n" } }],
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await transcribeAudio(audioFile, {
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      apiKey: "test-key",
    });
    expect(result).toBe("hello world");
  });
});

describe("resolveSttApiKey", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("resolves OPENROUTER_API_KEY for openrouter provider", () => {
    process.env.OPENROUTER_API_KEY = "or-key-123";
    expect(resolveSttApiKey("openrouter")).toBe("or-key-123");
  });

  test("resolves OPENAI_API_KEY for openai provider", () => {
    process.env.OPENAI_API_KEY = "sk-key-123";
    expect(resolveSttApiKey("openai")).toBe("sk-key-123");
  });

  test("resolves GEMINI_API_KEY for google provider", () => {
    process.env.GEMINI_API_KEY = "gem-key-123";
    expect(resolveSttApiKey("google")).toBe("gem-key-123");
  });

  test("falls back to MOM_STT_API_KEY for unknown provider", () => {
    process.env.MOM_STT_API_KEY = "custom-key";
    expect(resolveSttApiKey("custom-provider")).toBe("custom-key");
  });

  test("returns undefined when no key is set", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.MOM_STT_API_KEY;
    expect(resolveSttApiKey("openrouter")).toBeUndefined();
  });
});
