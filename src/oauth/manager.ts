import * as log from "../log.js";
import { exchangeCode, generateAuthUrl, getUserEmail, refreshAccessToken } from "./google.js";
import { SecretManagerStore } from "./secretManager.js";
import type { PendingAuthState, TokenData } from "./types.js";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class OAuthManager {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private store: SecretManagerStore;
  private pendingStates = new Map<string, PendingAuthState>();

  constructor(config: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    projectId: string;
  }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.store = new SecretManagerStore(config.projectId);
  }

  /**
   * Generate an OAuth URL for the given Slack user.
   * The URL sends them through Google's consent screen.
   */
  generateAuthUrl(slackUserId: string, channelId: string): string {
    this.cleanupExpiredStates();
    const stateKey = `${slackUserId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.pendingStates.set(stateKey, { slackUserId, channelId, createdAt: Date.now() });
    return generateAuthUrl(this.clientId, this.redirectUri, stateKey);
  }

  /**
   * Handle the OAuth redirect callback.
   * Exchanges the code for tokens and persists them to Secret Manager.
   * Returns the Slack user info so the caller can notify them.
   */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ slackUserId: string; channelId: string; email: string } | null> {
    const pending = this.pendingStates.get(state);
    if (!pending) {
      log.logWarning("OAuth callback: unknown or already-used state");
      return null;
    }
    if (Date.now() - pending.createdAt > STATE_TTL_MS) {
      this.pendingStates.delete(state);
      log.logWarning("OAuth callback: state expired");
      return null;
    }
    this.pendingStates.delete(state);

    try {
      const tokens = await exchangeCode(
        this.clientId,
        this.clientSecret,
        this.redirectUri,
        code,
      );

      let email = "(unknown)";
      try {
        email = await getUserEmail(tokens.access_token);
      } catch {
        // Non-fatal; continue without email
      }

      const tokenData: TokenData = {
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        email,
      };

      await this.store.storeTokens(pending.slackUserId, tokenData);
      log.logInfo(`OAuth: stored tokens for Slack user ${pending.slackUserId} (${email})`);

      return { slackUserId: pending.slackUserId, channelId: pending.channelId, email };
    } catch (err) {
      log.logWarning("OAuth handleCallback error", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Return a valid access token for the given Slack user, refreshing if necessary.
   * Returns null if the user has never authorized.
   */
  async getAccessToken(slackUserId: string): Promise<string | null> {
    const tokens = await this.store.getTokens(slackUserId);
    if (!tokens?.refresh_token) return null;

    // Still valid (with a 5-minute buffer)?
    if (tokens.access_token && tokens.expires_at && tokens.expires_at > Date.now() + 300_000) {
      return tokens.access_token;
    }

    // Refresh
    try {
      const refreshed = await refreshAccessToken(
        this.clientId,
        this.clientSecret,
        tokens.refresh_token,
      );
      const updated: TokenData = {
        ...tokens,
        access_token: refreshed.access_token,
        expires_at: Date.now() + refreshed.expires_in * 1000,
      };
      await this.store.storeTokens(slackUserId, updated);
      return refreshed.access_token;
    } catch (err) {
      log.logWarning(
        `OAuth refresh failed for ${slackUserId}`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /** Returns true if the user has a stored refresh token. */
  async hasToken(slackUserId: string): Promise<boolean> {
    const tokens = await this.store.getTokens(slackUserId);
    return !!tokens?.refresh_token;
  }

  /** Remove stored tokens for the user. */
  async revokeToken(slackUserId: string): Promise<void> {
    await this.store.deleteTokens(slackUserId);
    log.logInfo(`OAuth: revoked tokens for Slack user ${slackUserId}`);
  }

  private cleanupExpiredStates(): void {
    const now = Date.now();
    for (const [key, state] of this.pendingStates) {
      if (now - state.createdAt > STATE_TTL_MS) this.pendingStates.delete(key);
    }
  }
}
