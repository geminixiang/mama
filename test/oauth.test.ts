import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// ============================================================================
// Hoisted mocks — defined before vi.mock() calls (vitest hoists vi.mock to top)
// ============================================================================

const googleMocks = vi.hoisted(() => ({
  generateAuthUrl: vi.fn(),
  exchangeCode: vi.fn(),
  refreshAccessToken: vi.fn(),
  getUserEmail: vi.fn(),
}));

// Individual spy functions shared by all SecretManagerServiceClient instances
const smFns = vi.hoisted(() => ({
  addSecretVersion: vi.fn(),
  createSecret: vi.fn(),
  accessSecretVersion: vi.fn(),
  deleteSecret: vi.fn(),
}));

// ── Module stubs ─────────────────────────────────────────────────────────────

vi.mock("../src/oauth/google.js", () => googleMocks);

vi.mock("@google-cloud/secret-manager", () => ({
  // Must use a regular function (not arrow) so it can be called with `new`
  SecretManagerServiceClient: vi.fn(function () {
    return {
      addSecretVersion: smFns.addSecretVersion,
      createSecret: smFns.createSecret,
      accessSecretVersion: smFns.accessSecretVersion,
      deleteSecret: smFns.deleteSecret,
    };
  }),
}));

// ── Static imports (resolved after mocks are registered) ─────────────────────

import { OAuthManager } from "../src/oauth/manager.js";
import { SecretManagerStore } from "../src/oauth/secretManager.js";
import { startOAuthServer } from "../src/oauth/server.js";

// ============================================================================
// Helpers
// ============================================================================

function makeManager() {
  return new OAuthManager({
    clientId: "CLIENT_ID",
    clientSecret: "CLIENT_SECRET",
    redirectUri: "https://example.com/oauth/callback",
    projectId: "test-project",
  });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

// ============================================================================
// SecretManagerStore
// ============================================================================

describe("SecretManagerStore", () => {
  beforeEach(() => vi.clearAllMocks());

  test("storeTokens: creates secret then adds version when secret does not exist", async () => {
    // First addSecretVersion throws NOT_FOUND; after createSecret it succeeds
    smFns.addSecretVersion
      .mockRejectedValueOnce(Object.assign(new Error("NOT_FOUND"), { code: 5 }))
      .mockResolvedValueOnce([{}]);
    smFns.createSecret.mockResolvedValue([{}]);

    const store = new SecretManagerStore("test-project");
    await store.storeTokens("U001", { refresh_token: "rt1" });

    expect(smFns.createSecret).toHaveBeenCalledOnce();
    expect(smFns.addSecretVersion).toHaveBeenCalledTimes(2);
  });

  test("storeTokens: adds version directly when secret already exists", async () => {
    smFns.addSecretVersion.mockResolvedValue([{}]);

    const store = new SecretManagerStore("test-project");
    await store.storeTokens("U002", { refresh_token: "rt2" });

    expect(smFns.addSecretVersion).toHaveBeenCalledOnce();
    expect(smFns.createSecret).not.toHaveBeenCalled();
  });

  test("storeTokens: passes serialised JSON payload to Secret Manager", async () => {
    smFns.addSecretVersion.mockResolvedValue([{}]);

    const tokens = { refresh_token: "rt", access_token: "at", email: "a@b.com" };
    const store = new SecretManagerStore("test-project");
    await store.storeTokens("U003", tokens);

    const [call] = smFns.addSecretVersion.mock.calls;
    const payloadStr = (call[0] as { payload: { data: Buffer } }).payload.data.toString();
    expect(JSON.parse(payloadStr)).toEqual(tokens);
  });

  test("getTokens: returns parsed TokenData", async () => {
    const tokens = { refresh_token: "rt3", email: "user@example.com" };
    smFns.accessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from(JSON.stringify(tokens)) } },
    ]);

    const store = new SecretManagerStore("test-project");
    expect(await store.getTokens("U004")).toEqual(tokens);
  });

  test("getTokens: returns null when secret does not exist", async () => {
    smFns.accessSecretVersion.mockRejectedValue(
      Object.assign(new Error("NOT_FOUND"), { code: 5 }),
    );

    const store = new SecretManagerStore("test-project");
    expect(await store.getTokens("U_MISSING")).toBeNull();
  });

  test("deleteTokens: calls deleteSecret with the correct resource name", async () => {
    smFns.deleteSecret.mockResolvedValue([{}]);

    const store = new SecretManagerStore("test-project");
    await store.deleteTokens("U005");

    expect(smFns.deleteSecret).toHaveBeenCalledWith({
      name: "projects/test-project/secrets/gdc-sandbox-token-U005",
    });
  });

  test("deleteTokens: silently ignores errors", async () => {
    smFns.deleteSecret.mockRejectedValue(new Error("already gone"));

    const store = new SecretManagerStore("test-project");
    await expect(store.deleteTokens("U006")).resolves.toBeUndefined();
  });
});

// ============================================================================
// OAuthManager
// ============================================================================

describe("OAuthManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default URL generation delegates to google mock
    googleMocks.generateAuthUrl.mockImplementation(
      (_cid: string, _uri: string, state: string) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    );
  });

  // ── URL generation ──────────────────────────────────────────────────────────

  test("generateAuthUrl: returns a Google auth URL containing the state", () => {
    const mgr = makeManager();
    const url = mgr.generateAuthUrl("U001", "C001");

    expect(url).toMatch(/accounts\.google\.com/);
    expect(url).toMatch(/state=/);
    expect(googleMocks.generateAuthUrl).toHaveBeenCalledOnce();
  });

  test("generateAuthUrl: encodes userId into the state so users can be matched later", () => {
    const mgr = makeManager();
    const url = mgr.generateAuthUrl("U001", "C001");
    // Our manager passes a state that starts with the userId
    const state = new URL(url).searchParams.get("state") ?? "";
    expect(state.startsWith("U001_")).toBe(true);
  });

  test("generateAuthUrl: generates unique states for concurrent requests", () => {
    const mgr = makeManager();
    const url1 = mgr.generateAuthUrl("U001", "C001");
    const url2 = mgr.generateAuthUrl("U001", "C001");
    const s1 = new URL(url1).searchParams.get("state");
    const s2 = new URL(url2).searchParams.get("state");
    expect(s1).not.toBe(s2);
  });

  // ── Callback handling ───────────────────────────────────────────────────────

  test("handleCallback: returns null for an unknown state", async () => {
    const mgr = makeManager();
    expect(await mgr.handleCallback("code", "UNKNOWN_STATE")).toBeNull();
  });

  test("handleCallback: returns null for an expired state (> 10 minutes)", async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    const url = mgr.generateAuthUrl("U001", "C001");
    const state = new URL(url).searchParams.get("state") ?? "";

    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(await mgr.handleCallback("code", state)).toBeNull();
    vi.useRealTimers();
  });

  test("handleCallback: exchanges code, persists tokens, returns user info", async () => {
    googleMocks.exchangeCode.mockResolvedValue({
      access_token: "access_tok",
      refresh_token: "refresh_tok",
      expires_in: 3600,
    });
    googleMocks.getUserEmail.mockResolvedValue("alice@example.com");
    smFns.addSecretVersion.mockResolvedValue([{}]);

    const mgr = makeManager();
    const url = mgr.generateAuthUrl("U001", "C001");
    const state = new URL(url).searchParams.get("state") ?? "";

    const result = await mgr.handleCallback("auth_code", state);

    expect(result).toEqual({ slackUserId: "U001", channelId: "C001", email: "alice@example.com" });
    expect(googleMocks.exchangeCode).toHaveBeenCalledWith(
      "CLIENT_ID",
      "CLIENT_SECRET",
      "https://example.com/oauth/callback",
      "auth_code",
    );
    expect(smFns.addSecretVersion).toHaveBeenCalledOnce();
  });

  test("handleCallback: falls back to '(unknown)' email when getUserEmail fails", async () => {
    googleMocks.exchangeCode.mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
    });
    googleMocks.getUserEmail.mockRejectedValue(new Error("network error"));
    smFns.addSecretVersion.mockResolvedValue([{}]);

    const mgr = makeManager();
    const url = mgr.generateAuthUrl("U001", "C001");
    const state = new URL(url).searchParams.get("state") ?? "";

    const result = await mgr.handleCallback("code", state);
    expect(result?.email).toBe("(unknown)");
  });

  test("handleCallback: returns null when exchangeCode throws", async () => {
    googleMocks.exchangeCode.mockRejectedValue(new Error("invalid_grant"));

    const mgr = makeManager();
    const url = mgr.generateAuthUrl("U001", "C001");
    const state = new URL(url).searchParams.get("state") ?? "";

    expect(await mgr.handleCallback("bad_code", state)).toBeNull();
  });

  test("handleCallback: state is one-time-use and cannot be replayed", async () => {
    googleMocks.exchangeCode.mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
    });
    googleMocks.getUserEmail.mockResolvedValue("u@e.com");
    smFns.addSecretVersion.mockResolvedValue([{}]);

    const mgr = makeManager();
    const url = mgr.generateAuthUrl("U001", "C001");
    const state = new URL(url).searchParams.get("state") ?? "";

    await mgr.handleCallback("code", state);
    expect(await mgr.handleCallback("code", state)).toBeNull();
  });

  // ── Token retrieval ─────────────────────────────────────────────────────────

  test("getAccessToken: returns null when user has no stored token", async () => {
    smFns.accessSecretVersion.mockRejectedValue(
      Object.assign(new Error("NOT_FOUND"), { code: 5 }),
    );

    expect(await makeManager().getAccessToken("U_NONE")).toBeNull();
  });

  test("getAccessToken: returns cached token when it has not yet expired", async () => {
    const stored = {
      refresh_token: "rt",
      access_token: "still_valid",
      expires_at: Date.now() + 60 * 60 * 1000,
    };
    smFns.accessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from(JSON.stringify(stored)) } },
    ]);

    expect(await makeManager().getAccessToken("U001")).toBe("still_valid");
    expect(googleMocks.refreshAccessToken).not.toHaveBeenCalled();
  });

  test("getAccessToken: auto-refreshes an expired token and persists the new one", async () => {
    const stored = {
      refresh_token: "rt_old",
      access_token: "expired",
      expires_at: Date.now() - 1000,
    };
    smFns.accessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from(JSON.stringify(stored)) } },
    ]);
    googleMocks.refreshAccessToken.mockResolvedValue({
      access_token: "new_token",
      expires_in: 3600,
    });
    smFns.addSecretVersion.mockResolvedValue([{}]);

    const token = await makeManager().getAccessToken("U001");

    expect(token).toBe("new_token");
    expect(googleMocks.refreshAccessToken).toHaveBeenCalledWith(
      "CLIENT_ID",
      "CLIENT_SECRET",
      "rt_old",
    );
    // Updated token should be persisted
    expect(smFns.addSecretVersion).toHaveBeenCalledOnce();
  });

  test("getAccessToken: returns null when the refresh request fails", async () => {
    const stored = { refresh_token: "rt", access_token: "expired", expires_at: Date.now() - 1 };
    smFns.accessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from(JSON.stringify(stored)) } },
    ]);
    googleMocks.refreshAccessToken.mockRejectedValue(new Error("token_revoked"));

    expect(await makeManager().getAccessToken("U001")).toBeNull();
  });

  // ── hasToken ────────────────────────────────────────────────────────────────

  test("hasToken: returns false when no token is stored", async () => {
    smFns.accessSecretVersion.mockRejectedValue(new Error("NOT_FOUND"));
    expect(await makeManager().hasToken("U_NONE")).toBe(false);
  });

  test("hasToken: returns true when a refresh_token is stored", async () => {
    smFns.accessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from(JSON.stringify({ refresh_token: "rt" })) } },
    ]);
    expect(await makeManager().hasToken("U001")).toBe(true);
  });

  // ── revokeToken ─────────────────────────────────────────────────────────────

  test("revokeToken: deletes the secret for the given user", async () => {
    smFns.deleteSecret.mockResolvedValue([{}]);

    await makeManager().revokeToken("U001");

    expect(smFns.deleteSecret).toHaveBeenCalledWith({
      name: "projects/test-project/secrets/gdc-sandbox-token-U001",
    });
  });
});

// ============================================================================
// OAuth HTTP server
// ============================================================================

describe("OAuth server", () => {
  const PORT = 19877;
  let stopServer: () => void;

  const onCallback = vi.fn<[string, string], Promise<{ success: boolean; email?: string }>>();
  const onTokenRequest = vi.fn<[string], Promise<string | null>>();

  beforeAll(() => {
    stopServer = startOAuthServer(PORT, onCallback, onTokenRequest);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    onCallback.mockReset();
    onTokenRequest.mockReset();
  });

  // ── /oauth/callback ─────────────────────────────────────────────────────────

  test("returns 200 success HTML on a valid callback", async () => {
    onCallback.mockResolvedValue({ success: true, email: "alice@example.com" });

    const { status, body } = await httpGet(PORT, "/oauth/callback?code=CODE&state=STATE");

    expect(status).toBe(200);
    expect(body).toContain("Authorization Successful");
    expect(body).toContain("alice@example.com");
    expect(onCallback).toHaveBeenCalledWith("CODE", "STATE");
  });

  test("returns 500 when the callback handler signals failure", async () => {
    onCallback.mockResolvedValue({ success: false });

    const { status, body } = await httpGet(PORT, "/oauth/callback?code=CODE&state=STATE");

    expect(status).toBe(500);
    expect(body).toContain("Authorization Failed");
  });

  test("returns 400 when Google sends an error param (e.g. access_denied)", async () => {
    const { status, body } = await httpGet(PORT, "/oauth/callback?error=access_denied");

    expect(status).toBe(400);
    expect(body).toContain("access_denied");
    expect(onCallback).not.toHaveBeenCalled();
  });

  test("returns 400 when code or state is missing from the query", async () => {
    const { status } = await httpGet(PORT, "/oauth/callback?code=ONLY_CODE");
    expect(status).toBe(400);
  });

  test("returns 500 when the callback handler throws", async () => {
    onCallback.mockRejectedValue(new Error("storage error"));

    const { status } = await httpGet(PORT, "/oauth/callback?code=C&state=S");
    expect(status).toBe(500);
  });

  // ── /api/token/:userId ──────────────────────────────────────────────────────

  test("returns 200 with the access token for a valid user", async () => {
    onTokenRequest.mockResolvedValue("ya29.ACCESS_TOKEN");

    const { status, body } = await httpGet(PORT, "/api/token/U001");

    expect(status).toBe(200);
    expect(body).toBe("ya29.ACCESS_TOKEN");
    expect(onTokenRequest).toHaveBeenCalledWith("U001");
  });

  test("returns 404 'no_token' when the user has no stored token", async () => {
    onTokenRequest.mockResolvedValue(null);

    const { status, body } = await httpGet(PORT, "/api/token/U_NONE");

    expect(status).toBe(404);
    expect(body).toBe("no_token");
  });

  // ── Other paths ─────────────────────────────────────────────────────────────

  test("returns 404 for unrecognised paths", async () => {
    const { status } = await httpGet(PORT, "/healthz");
    expect(status).toBe(404);
  });
});
