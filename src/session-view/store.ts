import { randomBytes } from "crypto";

export interface SessionViewToken {
  token: string;
  platform: "slack" | "discord" | "telegram";
  platformUserId: string;
  conversationId: string;
  sessionKey: string;
  sessionFile: string;
  expiresAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;

export class InMemorySessionViewTokenStore {
  private tokens = new Map<string, SessionViewToken>();

  create(
    platform: "slack" | "discord" | "telegram",
    platformUserId: string,
    conversationId: string,
    sessionKey: string,
    sessionFile: string,
  ): SessionViewToken {
    const token: SessionViewToken = {
      token: randomBytes(16).toString("hex"),
      platform,
      platformUserId,
      conversationId,
      sessionKey,
      sessionFile,
      expiresAt: Date.now() + TTL_MS,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  peek(rawToken: string): SessionViewToken | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.tokens.delete(rawToken);
      return undefined;
    }
    return entry;
  }

  purge(): void {
    const now = Date.now();
    for (const [key, value] of this.tokens) {
      if (now > value.expiresAt) {
        this.tokens.delete(key);
      }
    }
  }
}
