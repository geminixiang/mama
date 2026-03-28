export interface TokenData {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
  email?: string;
}

export interface PendingAuthState {
  slackUserId: string;
  channelId: string;
  createdAt: number;
}
