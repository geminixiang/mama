import { describe, expect, test } from "vitest";
import { getOAuthServices, parseLoginCommand, resolveOAuthService } from "../src/login.js";

describe("login command parsing", () => {
  test("parseLoginCommand recognizes login commands only", () => {
    expect(parseLoginCommand("/login")).toEqual({ command: "/login" });
    expect(parseLoginCommand("login")).toEqual({ command: "login" });
    expect(parseLoginCommand("/login github_oauth")).toEqual({ command: "/login" });
    expect(parseLoginCommand("/pi-login github")).toEqual({ command: "/pi-login" });
    expect(parseLoginCommand("help")).toBeNull();
  });

  test("resolveOAuthService returns known services and aliases", () => {
    expect(resolveOAuthService("github")?.id).toBe("github");
    expect(resolveOAuthService("github_oauth")?.id).toBe("github");
    expect(resolveOAuthService("gws")?.id).toBe("google_workspace_cli");
    expect(getOAuthServices().some((s) => s.id === "github")).toBe(true);
    expect(getOAuthServices().some((s) => s.id === "google_workspace_cli")).toBe(true);
    expect(resolveOAuthService("github")?.additionalAccessTokenEnvKeys).toContain("GH_TOKEN");
    expect(resolveOAuthService("google_workspace_cli")?.fileOutput).toEqual({
      type: "authorized_user",
      relativePath: "gws.json",
      targetPath: "/root/.config/gws/credentials.json",
    });
  });
});
