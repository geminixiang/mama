import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import type { TokenData } from "./types.js";

const SECRET_PREFIX = "gdc-sandbox-token";

export class SecretManagerStore {
  private client: SecretManagerServiceClient;
  private projectId: string;

  constructor(projectId: string) {
    this.client = new SecretManagerServiceClient();
    this.projectId = projectId;
  }

  private secretId(slackUserId: string): string {
    return `${SECRET_PREFIX}-${slackUserId}`;
  }

  private secretName(slackUserId: string): string {
    return `projects/${this.projectId}/secrets/${this.secretId(slackUserId)}`;
  }

  async storeTokens(slackUserId: string, tokens: TokenData): Promise<void> {
    const payload = JSON.stringify(tokens);
    const payloadBuffer = Buffer.from(payload);

    try {
      // Try to add a new version (secret already exists)
      await this.client.addSecretVersion({
        parent: this.secretName(slackUserId),
        payload: { data: payloadBuffer },
      });
    } catch {
      // Secret doesn't exist yet — create it, then add a version
      await this.client.createSecret({
        parent: `projects/${this.projectId}`,
        secretId: this.secretId(slackUserId),
        secret: { replication: { automatic: {} } },
      });
      await this.client.addSecretVersion({
        parent: this.secretName(slackUserId),
        payload: { data: payloadBuffer },
      });
    }
  }

  async getTokens(slackUserId: string): Promise<TokenData | null> {
    try {
      const [version] = await this.client.accessSecretVersion({
        name: `${this.secretName(slackUserId)}/versions/latest`,
      });
      const data = version.payload?.data;
      if (!data) return null;
      return JSON.parse(data.toString()) as TokenData;
    } catch {
      return null;
    }
  }

  async deleteTokens(slackUserId: string): Promise<void> {
    try {
      await this.client.deleteSecret({ name: this.secretName(slackUserId) });
    } catch {
      // Ignore if secret doesn't exist
    }
  }
}
