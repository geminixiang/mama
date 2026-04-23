import { randomBytes } from "crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LinkToken {
  token: string;
  platform: "slack" | "discord" | "telegram";
  platformUserId: string;
  vaultId: string;
  providerId: string;
  /** Conversation to notify when binding completes */
  conversationId: string;
  expiresAt: number;
  used: boolean;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── InMemoryLinkTokenStore ─────────────────────────────────────────────────────

export class InMemoryLinkTokenStore {
  private tokens = new Map<string, LinkToken>();

  /**
   * Create a link token for a platform user.
   * Invalidates any existing unused token for the same user before creating a new one.
   */
  create(
    platform: "slack" | "discord" | "telegram",
    platformUserId: string,
    conversationId: string,
    vaultId: string,
    providerId: string,
  ): LinkToken {
    // Invalidate any existing token for this user so old links stop working
    for (const [key, t] of this.tokens) {
      if (t.platform === platform && t.platformUserId === platformUserId) {
        this.tokens.delete(key);
      }
    }

    const token: LinkToken = {
      token: randomBytes(16).toString("hex"),
      platform,
      platformUserId,
      vaultId,
      providerId,
      conversationId,
      expiresAt: Date.now() + TTL_MS,
      used: false,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  /**
   * Peek at a token without consuming it. Returns undefined if invalid or expired.
   * Use this for read-only lookups (e.g. rendering the link page).
   */
  peek(rawToken: string): LinkToken | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry || entry.used || Date.now() > entry.expiresAt) return undefined;
    return entry;
  }

  /**
   * Consume a token: validate, mark used, and return the token data.
   * Returns undefined if the token is invalid, expired, or already used.
   */
  consume(rawToken: string): LinkToken | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry) return undefined;
    if (entry.used || Date.now() > entry.expiresAt) {
      this.tokens.delete(rawToken);
      return undefined;
    }
    entry.used = true;
    this.tokens.delete(rawToken);
    return entry;
  }

  /** Remove expired or used tokens. Call periodically to bound memory usage. */
  purge(): void {
    const now = Date.now();
    for (const [key, t] of this.tokens) {
      if (t.used || now > t.expiresAt) {
        this.tokens.delete(key);
      }
    }
  }
}
