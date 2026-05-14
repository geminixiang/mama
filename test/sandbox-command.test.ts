import { describe, expect, test } from "vitest";
import { parseSandboxCommand } from "../src/commands/sandbox.js";

describe("sandbox command parsing", () => {
  test("parses status command", () => {
    expect(parseSandboxCommand("/pi-sandbox")).toEqual({ command: "/pi-sandbox" });
  });

  test("parses boost command", () => {
    expect(parseSandboxCommand("/pi-sandbox boost")).toEqual({
      command: "/pi-sandbox",
      action: "boost",
    });
  });

  test("parses Telegram sandbox alias", () => {
    expect(parseSandboxCommand("/sandbox@my_bot boost")).toEqual({
      command: "/sandbox",
      action: "boost",
    });
  });

  test("ignores other commands", () => {
    expect(parseSandboxCommand("/pi-model anthropic/claude-sonnet-4-6")).toBeNull();
  });
});
