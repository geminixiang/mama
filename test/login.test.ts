import { describe, expect, test } from "vitest";
import {
  formatSupportedLoginMappings,
  getOAuthServices,
  parseLoginCommand,
  resolveLoginPreset,
  resolveOAuthService,
} from "../src/login.js";

describe("login command parsing", () => {
  test("resolveLoginPreset returns known presets and aliases", () => {
    expect(resolveLoginPreset("openai")?.envKey).toBe("OPENAI_API_KEY");
    expect(resolveLoginPreset("OPENAI_API_KEY")?.id).toBe("openai");
    expect(resolveLoginPreset("github")?.envKey).toBe("GITHUB_TOKEN");
    expect(resolveLoginPreset("anthropic")?.envKey).toBe("ANTHROPIC_API_KEY");
    expect(resolveLoginPreset("oauth")?.kind).toBe("oauth");
  });

  test("resolveOAuthService returns known services and aliases", () => {
    expect(resolveOAuthService("github")?.id).toBe("github");
    expect(resolveOAuthService("github_oauth")?.id).toBe("github");
    expect(getOAuthServices().some((s) => s.id === "github")).toBe(true);
    expect(resolveOAuthService("github")?.additionalAccessTokenEnvKeys).toContain("GH_TOKEN");
  });

  test("parseLoginCommand maps preset aliases to env keys", () => {
    expect(parseLoginCommand("login openai")).toMatchObject({
      rawKey: "openai",
      envKeyHint: "OPENAI_API_KEY",
      preset: { id: "openai" },
      extraArgs: [],
    });
    expect(parseLoginCommand("/login github")).toMatchObject({
      rawKey: "github",
      envKeyHint: "GITHUB_TOKEN",
      preset: { id: "github" },
      extraArgs: [],
    });
  });

  test("parseLoginCommand allows missing key and custom env keys", () => {
    expect(parseLoginCommand("login")).toMatchObject({
      rawKey: undefined,
      envKeyHint: undefined,
      preset: undefined,
      extraArgs: [],
    });
    expect(parseLoginCommand("login MY_PRIVATE_KEY")).toMatchObject({
      rawKey: "MY_PRIVATE_KEY",
      envKeyHint: "MY_PRIVATE_KEY",
      preset: undefined,
      extraArgs: [],
    });
    expect(parseLoginCommand("login github_oauth")).toMatchObject({
      rawKey: "github_oauth",
      envKeyHint: undefined,
      preset: { id: "oauth" },
      modeHint: "oauth",
      oauthServiceIdHint: "github",
      extraArgs: [],
    });
  });

  test("parseLoginCommand marks invalid env key hints as unresolved", () => {
    expect(parseLoginCommand("login invalid-key")).toMatchObject({
      rawKey: "invalid-key",
      envKeyHint: undefined,
      preset: undefined,
      extraArgs: [],
    });
  });

  test("parseLoginCommand preserves extra args so callers can reject pasted values", () => {
    expect(parseLoginCommand("login openai sk-secret")).toMatchObject({
      rawKey: "openai",
      envKeyHint: "OPENAI_API_KEY",
      preset: { id: "openai" },
      extraArgs: ["sk-secret"],
    });
  });

  test("formatSupportedLoginMappings lists built-in mappings", () => {
    expect(formatSupportedLoginMappings()).toBe(
      "`anthropic` -> `ANTHROPIC_API_KEY`, `github` -> `GITHUB_TOKEN`, `openai` -> `OPENAI_API_KEY`, `oauth` -> `OAUTH_CLIENT_SECRET`",
    );
  });
});
