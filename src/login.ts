export type LoginCredentialKind = "api_key" | "oauth";

export interface OAuthAuthorizedUserFileOutput {
  type: "authorized_user";
  relativePath: string;
  targetPath?: string;
  envKey?: string;
}

export interface OAuthService {
  id: string;
  label: string;
  aliases: string[];
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnvKey: string;
  clientSecretEnvKey: string;
  accessTokenEnvKey?: string;
  additionalAccessTokenEnvKeys?: string[];
  refreshTokenEnvKey?: string;
  authorizationParams?: Record<string, string>;
  fileOutput?: OAuthAuthorizedUserFileOutput;
}

export interface ParsedLoginCommand {
  command: "login" | "/login";
}

const DEFAULT_GOOGLE_WORKSPACE_CLI_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/chat.messages.create",
];

function resolveGoogleWorkspaceCliScopes(): string[] {
  const raw = process.env.MOM_GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES?.trim();
  if (!raw) {
    return DEFAULT_GOOGLE_WORKSPACE_CLI_SCOPES;
  }

  const scopes = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return scopes.length > 0 ? scopes : DEFAULT_GOOGLE_WORKSPACE_CLI_SCOPES;
}

function getBuiltinOAuthServices(): OAuthService[] {
  return [
    {
      id: "github",
      label: "GitHub",
      aliases: ["github", "github_oauth", "gh_oauth"],
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: [
        "repo",
        "read:user",
        "user:email",
        "read:org",
        "gist",
        "project",
        "workflow",
        "write:packages",
      ],
      clientIdEnvKey: "GITHUB_OAUTH_CLIENT_ID",
      clientSecretEnvKey: "GITHUB_OAUTH_CLIENT_SECRET",
      accessTokenEnvKey: "GITHUB_OAUTH_ACCESS_TOKEN",
      additionalAccessTokenEnvKeys: ["GH_TOKEN"],
      refreshTokenEnvKey: "GITHUB_OAUTH_REFRESH_TOKEN",
    },
    {
      id: "google_workspace_cli",
      label: "Google Workspace CLI",
      aliases: ["google_workspace_cli", "gws", "googleworkspace", "google-workspace-cli"],
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: resolveGoogleWorkspaceCliScopes(),
      clientIdEnvKey: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      clientSecretEnvKey: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
      authorizationParams: {
        access_type: "offline",
        include_granted_scopes: "true",
        prompt: "consent",
      },
      fileOutput: {
        type: "authorized_user",
        relativePath: "gws.json",
        targetPath: "/root/.config/gws/credentials.json",
      },
    },
  ];
}

export function getOAuthServices(): OAuthService[] {
  const raw = process.env.MOM_OAUTH_SERVICES_JSON?.trim();
  const builtins = getBuiltinOAuthServices();
  if (!raw) return builtins;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return builtins;

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
          typeof obj.accessTokenEnvKey === "string" ? obj.accessTokenEnvKey.trim() : undefined;
        if (
          !id ||
          !label ||
          !authorizationUrl ||
          !tokenUrl ||
          !clientIdEnvKey ||
          !clientSecretEnvKey
        ) {
          return null;
        }

        let fileOutput: OAuthService["fileOutput"];
        if (obj.fileOutput && typeof obj.fileOutput === "object") {
          const fileOutputObj = obj.fileOutput as Record<string, unknown>;
          const type = typeof fileOutputObj.type === "string" ? fileOutputObj.type.trim() : "";
          const relativePath =
            typeof fileOutputObj.relativePath === "string" ? fileOutputObj.relativePath.trim() : "";
          const targetPath =
            typeof fileOutputObj.targetPath === "string"
              ? fileOutputObj.targetPath.trim()
              : undefined;
          const envKey =
            typeof fileOutputObj.envKey === "string" ? fileOutputObj.envKey.trim() : undefined;
          if (type === "authorized_user" && relativePath) {
            fileOutput = { type: "authorized_user", relativePath, targetPath, envKey };
          }
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
          authorizationParams:
            obj.authorizationParams && typeof obj.authorizationParams === "object"
              ? Object.fromEntries(
                  Object.entries(obj.authorizationParams as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                )
              : undefined,
          fileOutput,
        };
      })
      .filter((service): service is OAuthService => service !== null);

    const byId = new Map<string, OAuthService>();
    for (const service of builtins) byId.set(service.id, service);
    for (const service of custom) byId.set(service.id, service);
    return [...byId.values()];
  } catch {
    return builtins;
  }
}

export function resolveOAuthService(input: string): OAuthService | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  return getOAuthServices().find(
    (service) => service.id === normalized || service.aliases.includes(normalized),
  );
}

export function parseLoginCommand(text: string): ParsedLoginCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const command = tokens[0].toLowerCase();
  if (command !== "login" && command !== "/login") {
    return null;
  }

  return { command: command as "login" | "/login" };
}
