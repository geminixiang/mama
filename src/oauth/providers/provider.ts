/**
 * Generic OAuth Provider Interface
 * 各平台 OAuth 實現需遵守此接口
 */

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  token_type?: string;
}

export interface OAuthUserInfo {
  id: string;
  email?: string;
  name?: string;
  picture?: string;
  [key: string]: unknown;
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OAuthProvider {
  /** 平台名稱 */
  readonly name: string;
  
  /** OAuth 授權 URL */
  getAuthorizationUrl(state: string): string;
  
  /** 交換授權碼為 Token */
  exchangeCode(code: string): Promise<OAuthTokens>;
  
  /** 刷新 Access Token */
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
  
  /** 取得用戶資訊 */
  getUserInfo(accessToken: string): Promise<OAuthUserInfo>;
  
  /** 取得預設Scopes */
  getDefaultScopes(): string[];
}

export interface StoredTokenData {
  provider: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  email?: string;
  userId?: string;
  userInfo?: OAuthUserInfo;
}

export interface PendingAuthState {
  slackUserId: string;
  channelId: string;
  provider: string;
  createdAt: number;
}
