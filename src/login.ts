export type LoginCredentialKind = "api_key" | "oauth";

export interface OAuthService {
  id: string;
  label: string;
  aliases: string[];
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnvKey: string;
  clientSecretEnvKey: string;
  accessTokenEnvKey: string;
  additionalAccessTokenEnvKeys?: string[];
  refreshTokenEnvKey?: string;
}

export interface LoginPreset {
  id: string;
  kind: LoginCredentialKind;
  label: string;
  secretLabel: string;
  envKey: string;
  placeholder: string;
  helpText: string;
  aliases: string[];
  oauthClientIdEnvKey?: string;
  oauthClientSecretEnvKey?: string;
  oauthRefreshTokenEnvKey?: string;
}

export interface ParsedLoginCommand {
  rawKey?: string;
  envKeyHint?: string;
  preset?: LoginPreset;
  modeHint?: LoginCredentialKind;
  oauthServiceIdHint?: string;
  extraArgs: string[];
}

const LOGIN_PRESETS: LoginPreset[] = [
  {
    id: "anthropic",
    kind: "api_key",
    label: "Anthropic API key",
    secretLabel: "API key",
    envKey: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-...",
    helpText: "Stored as ANTHROPIC_API_KEY in your vault env file.",
    aliases: ["anthropic", "anthropic_api_key", "claude"],
  },
  {
    id: "github",
    kind: "api_key",
    label: "GitHub token",
    secretLabel: "Personal access token",
    envKey: "GITHUB_TOKEN",
    placeholder: "ghp_...",
    helpText: "Stored as GITHUB_TOKEN in your vault env file.",
    aliases: ["github", "github_token", "gh", "gh_token"],
  },
  {
    id: "openai",
    kind: "api_key",
    label: "OpenAI API key",
    secretLabel: "API key",
    envKey: "OPENAI_API_KEY",
    placeholder: "sk-...",
    helpText: "Stored as OPENAI_API_KEY in your vault env file.",
    aliases: ["openai", "openai_api_key", "chatgpt"],
  },
  {
    id: "oauth",
    kind: "oauth",
    label: "OAuth credential",
    secretLabel: "Client secret",
    envKey: "OAUTH_CLIENT_SECRET",
    placeholder: "client-secret-...",
    helpText: "Stores OAuth client credentials in your vault env file.",
    aliases: ["oauth", "oauth_credential"],
    oauthClientIdEnvKey: "OAUTH_CLIENT_ID",
    oauthClientSecretEnvKey: "OAUTH_CLIENT_SECRET",
    oauthRefreshTokenEnvKey: "OAUTH_REFRESH_TOKEN",
  },
];

const BUILTIN_OAUTH_SERVICES: OAuthService[] = [
  {
    id: "github",
    label: "GitHub",
    aliases: ["github", "github_oauth", "gh_oauth"],
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:user", "user:email", "read:org"],
    clientIdEnvKey: "GITHUB_OAUTH_CLIENT_ID",
    clientSecretEnvKey: "GITHUB_OAUTH_CLIENT_SECRET",
    accessTokenEnvKey: "GITHUB_OAUTH_ACCESS_TOKEN",
    additionalAccessTokenEnvKeys: ["GH_TOKEN"],
    refreshTokenEnvKey: "GITHUB_OAUTH_REFRESH_TOKEN",
  },
];

export function getLoginPresets(): LoginPreset[] {
  return LOGIN_PRESETS;
}

export function resolveLoginPreset(input: string): LoginPreset | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  return LOGIN_PRESETS.find(
    (preset) =>
      preset.id === normalized ||
      preset.envKey.toLowerCase() === normalized ||
      preset.aliases.includes(normalized),
  );
}

export function getOAuthServices(): OAuthService[] {
  const raw = process.env.MOM_OAUTH_SERVICES_JSON?.trim();
  if (!raw) return BUILTIN_OAUTH_SERVICES;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return BUILTIN_OAUTH_SERVICES;

    const custom = parsed
      .map((entry): OAuthService | null => {
        if (!entry || typeof entry !== "object") return null;
        const obj = entry as Record<string, unknown>;
        const id = typeof obj.id === "string" ? obj.id.trim() : "";
        const label = typeof obj.label === "string" ? obj.label.trim() : "";
        const authorizationUrl =
          typeof obj.authorizationUrl === "string" ? obj.authorizationUrl.trim() : "";
        const tokenUrl = typeof obj.tokenUrl === "string" ? obj.tokenUrl.trim() : "";
        const clientIdEnvKey =
          typeof obj.clientIdEnvKey === "string" ? obj.clientIdEnvKey.trim() : "";
        const clientSecretEnvKey =
          typeof obj.clientSecretEnvKey === "string" ? obj.clientSecretEnvKey.trim() : "";
        const accessTokenEnvKey =
          typeof obj.accessTokenEnvKey === "string" ? obj.accessTokenEnvKey.trim() : "";
        if (
          !id ||
          !label ||
          !authorizationUrl ||
          !tokenUrl ||
          !clientIdEnvKey ||
          !clientSecretEnvKey ||
          !accessTokenEnvKey
        ) {
          return null;
        }
        return {
          id: id.toLowerCase(),
          label,
          aliases: Array.isArray(obj.aliases)
            ? obj.aliases
                .filter((v): v is string => typeof v === "string")
                .map((v) => v.toLowerCase())
            : [id.toLowerCase()],
          authorizationUrl,
          tokenUrl,
          scopes: Array.isArray(obj.scopes)
            ? obj.scopes.filter((v): v is string => typeof v === "string")
            : [],
          clientIdEnvKey,
          clientSecretEnvKey,
          accessTokenEnvKey,
          additionalAccessTokenEnvKeys: Array.isArray(obj.additionalAccessTokenEnvKeys)
            ? obj.additionalAccessTokenEnvKeys.filter((v): v is string => typeof v === "string")
            : undefined,
          refreshTokenEnvKey:
            typeof obj.refreshTokenEnvKey === "string" ? obj.refreshTokenEnvKey.trim() : undefined,
        };
      })
      .filter((service): service is OAuthService => service !== null);

    const byId = new Map<string, OAuthService>();
    for (const service of BUILTIN_OAUTH_SERVICES) byId.set(service.id, service);
    for (const service of custom) byId.set(service.id, service);
    return [...byId.values()];
  } catch {
    return BUILTIN_OAUTH_SERVICES;
  }
}

export function resolveOAuthService(input: string): OAuthService | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  return getOAuthServices().find(
    (service) => service.id === normalized || service.aliases.includes(normalized),
  );
}

function isValidEnvKey(input: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(input);
}

export function parseLoginCommand(text: string): ParsedLoginCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const command = tokens[0].toLowerCase();
  if (command !== "login" && command !== "/login") {
    return null;
  }

  const rawKey = tokens[1];
  const oauthService = rawKey ? resolveOAuthService(rawKey) : undefined;
  const preset = rawKey
    ? (resolveLoginPreset(rawKey) ?? (oauthService ? resolveLoginPreset("oauth") : undefined))
    : undefined;
  const modeHint: LoginCredentialKind | undefined =
    preset?.kind ?? (oauthService ? "oauth" : undefined);
  const envKeyHint =
    modeHint === "oauth"
      ? undefined
      : (preset?.envKey ?? (rawKey && isValidEnvKey(rawKey) ? rawKey : undefined));
  return {
    rawKey,
    envKeyHint,
    preset,
    modeHint,
    oauthServiceIdHint: oauthService?.id,
    extraArgs: tokens.slice(2),
  };
}

export function formatSupportedLoginMappings(): string {
  return getLoginPresets()
    .map((preset) => `\`${preset.id}\` -> \`${preset.envKey}\``)
    .join(", ");
}
