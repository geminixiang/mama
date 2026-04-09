import { describe, expect, test } from "vitest";
import {
  formatSupportedLoginProviders,
  parseLoginCommand,
  resolveLoginProvider,
} from "../src/login.js";

describe("login providers", () => {
  test("resolveLoginProvider returns known providers", () => {
    expect(resolveLoginProvider("openai")?.envKey).toBe("OPENAI_API_KEY");
    expect(resolveLoginProvider("github")?.envKey).toBe("GITHUB_TOKEN");
    expect(resolveLoginProvider("anthropic")?.envKey).toBe("ANTHROPIC_API_KEY");
  });

  test("parseLoginCommand parses provider commands", () => {
    expect(parseLoginCommand("login openai")).toMatchObject({
      providerId: "openai",
      provider: { id: "openai" },
      extraArgs: [],
    });
    expect(parseLoginCommand("/login github")).toMatchObject({
      providerId: "github",
      provider: { id: "github" },
      extraArgs: [],
    });
  });

  test("parseLoginCommand handles missing and unsupported providers", () => {
    expect(parseLoginCommand("login")).toMatchObject({
      providerId: undefined,
      provider: undefined,
      extraArgs: [],
    });
    expect(parseLoginCommand("login custom")).toMatchObject({
      providerId: "custom",
      provider: undefined,
      extraArgs: [],
    });
  });

  test("parseLoginCommand preserves extra args so callers can reject pasted secrets", () => {
    expect(parseLoginCommand("login openai sk-secret")).toMatchObject({
      providerId: "openai",
      provider: { id: "openai" },
      extraArgs: ["sk-secret"],
    });
  });

  test("formatSupportedLoginProviders lists supported ids", () => {
    expect(formatSupportedLoginProviders()).toBe("`anthropic`, `github`, `openai`");
  });
});
