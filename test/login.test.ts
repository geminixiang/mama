import { describe, expect, test } from "vitest";
import { getOAuthServices, parseLoginCommand, resolveOAuthService } from "../src/login.js";

describe("login command parsing", () => {
  test("parseLoginCommand recognizes login commands only", () => {
    expect(parseLoginCommand("/login")).toEqual({ command: "/login" });
    expect(parseLoginCommand("login")).toEqual({ command: "login" });
    expect(parseLoginCommand("/login github_oauth")).toEqual({ command: "/login" });
    expect(parseLoginCommand("help")).toBeNull();
  });

  test("resolveOAuthService returns known services and aliases", () => {
    expect(resolveOAuthService("github")?.id).toBe("github");
    expect(resolveOAuthService("github_oauth")?.id).toBe("github");
    expect(getOAuthServices().some((s) => s.id === "github")).toBe(true);
    expect(resolveOAuthService("github")?.additionalAccessTokenEnvKeys).toContain("GH_TOKEN");
  });
});
