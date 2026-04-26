import { existsSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startLinkServer } from "../src/link-server.js";
import { InMemoryLinkTokenStore } from "../src/link-token.js";
import { FileVaultManager } from "../src/vault.js";

async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once("listening", resolve));
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Link server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("link server", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalGitHubClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const originalGitHubClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalGitHubClientId === undefined) {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
    } else {
      process.env.GITHUB_OAUTH_CLIENT_ID = originalGitHubClientId;
    }
    if (originalGitHubClientSecret === undefined) {
      delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    } else {
      process.env.GITHUB_OAUTH_CLIENT_SECRET = originalGitHubClientSecret;
    }

    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );

    for (const dir of dirs.splice(0)) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/link shows stored secret names and mounted files, but not secret values", async () => {
    const stateDir = join(tmpdir(), `mama-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);
    vaultManager.addEntry("vault-u123", { displayName: "Alice" });
    vaultManager.upsertEnv("vault-u123", {
      OPENAI_API_KEY: "sk-secret-value",
      GH_TOKEN: "ghp-secret-value",
    });
    vaultManager.upsertFile(
      "vault-u123",
      "gws.json",
      '{\n  "type": "authorized_user"\n}\n',
      "/root/.config/gws/credentials.json",
    );

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U123", "123", "vault-u123", "");
    const server = startLinkServer(0, tokenStore, vaultManager, async () => {});
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/link?token=${token.token}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Currently stored");
    expect(html).toContain("OPENAI_API_KEY");
    expect(html).toContain("GH_TOKEN");
    expect(html).toContain("/root/.config/gws/credentials.json");
    expect(html).not.toContain("sk-secret-value");
    expect(html).not.toContain("ghp-secret-value");
  });

  test("/api/oauth/start returns an OAuth redirect URL for GitHub", async () => {
    const stateDir = join(tmpdir(), `mama-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-client-secret";

    const vaultManager = new FileVaultManager(stateDir);
    vaultManager.addEntry("vault-u234", { displayName: "Carol" });

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U234", "234", "vault-u234", "");
    const server = startLinkServer(0, tokenStore, vaultManager, async () => {});
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/api/oauth/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl(server),
      },
      body: JSON.stringify({ token: token.token, serviceId: "github" }),
    });
    const body = (await response.json()) as { redirectUrl: string };
    const redirectUrl = new URL(body.redirectUrl);

    expect(response.status).toBe(200);
    expect(redirectUrl.origin).toBe("https://github.com");
    expect(redirectUrl.pathname).toBe("/login/oauth/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe("github-client-id");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(`${baseUrl(server)}/oauth/callback`);
    expect(redirectUrl.searchParams.get("scope")).toContain("repo");
    expect(redirectUrl.searchParams.get("state")).toBeTruthy();
    expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirectUrl.searchParams.get("code_challenge")).toBeTruthy();
  });

  test("OAuth callback stores GitHub tokens in the vault", async () => {
    const stateDir = join(tmpdir(), `mama-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    process.env.GITHUB_OAUTH_CLIENT_ID = "github-client-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "github-client-secret";

    const vaultManager = new FileVaultManager(stateDir);
    vaultManager.addEntry("vault-u345", { displayName: "Dana" });

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U345", "345", "vault-u345", "");
    const notify = vi.fn().mockResolvedValue(undefined);
    const server = startLinkServer(0, tokenStore, vaultManager, notify);
    servers.push(server);
    await waitForListening(server);

    const startResponse = await originalFetch(`${baseUrl(server)}/api/oauth/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl(server),
      },
      body: JSON.stringify({ token: token.token, serviceId: "github" }),
    });
    const startBody = (await startResponse.json()) as { redirectUrl: string };
    const redirectUrl = new URL(startBody.redirectUrl);
    const state = redirectUrl.searchParams.get("state");

    expect(state).toBeTruthy();

    const tokenExchangeFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({
          access_token: "gho_test_access_token",
          refresh_token: "ghr_test_refresh_token",
        }),
    });
    globalThis.fetch = tokenExchangeFetch as typeof fetch;

    const callbackResponse = await originalFetch(
      `${baseUrl(server)}/oauth/callback?state=${state}&code=test-code`,
    );
    const callbackHtml = await callbackResponse.text();

    expect(callbackResponse.status).toBe(200);
    expect(callbackHtml).toContain("GitHub OAuth connected successfully.");
    expect(vaultManager.resolve("vault-u345")?.env).toMatchObject({
      GITHUB_OAUTH_ACCESS_TOKEN: "gho_test_access_token",
      GH_TOKEN: "gho_test_access_token",
      GITHUB_OAUTH_REFRESH_TOKEN: "ghr_test_refresh_token",
    });
    expect(notify).toHaveBeenCalledWith(
      "telegram",
      "345",
      expect.stringContaining("GitHub OAuth stored"),
    );
    expect(tokenExchangeFetch).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("/link shows an empty-state message when the vault has no secrets yet", async () => {
    const stateDir = join(tmpdir(), `mama-link-server-${Date.now()}-${Math.random()}`);
    dirs.push(stateDir);

    const vaultManager = new FileVaultManager(stateDir);
    vaultManager.addEntry("vault-u999", { displayName: "Bob" });

    const tokenStore = new InMemoryLinkTokenStore();
    const token = tokenStore.create("telegram", "U999", "999", "vault-u999", "");
    const server = startLinkServer(0, tokenStore, vaultManager, async () => {});
    servers.push(server);
    await waitForListening(server);

    const response = await originalFetch(`${baseUrl(server)}/link?token=${token.token}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("No secrets are stored in this vault yet.");
  });
});
