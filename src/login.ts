export interface LoginProvider {
  id: "anthropic" | "github" | "openai";
  label: string;
  secretLabel: string;
  envKey: string;
  placeholder: string;
  helpText: string;
}

export interface ParsedLoginCommand {
  providerId?: string;
  provider?: LoginProvider;
  extraArgs: string[];
}

const LOGIN_PROVIDERS: Record<LoginProvider["id"], LoginProvider> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic API key",
    secretLabel: "API key",
    envKey: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-...",
    helpText: "Stored as ANTHROPIC_API_KEY in your vault env file.",
  },
  github: {
    id: "github",
    label: "GitHub token",
    secretLabel: "Personal access token",
    envKey: "GITHUB_TOKEN",
    placeholder: "ghp_...",
    helpText: "Stored as GITHUB_TOKEN in your vault env file.",
  },
  openai: {
    id: "openai",
    label: "OpenAI API key",
    secretLabel: "API key",
    envKey: "OPENAI_API_KEY",
    placeholder: "sk-...",
    helpText: "Stored as OPENAI_API_KEY in your vault env file.",
  },
};

export function getLoginProviders(): LoginProvider[] {
  return Object.values(LOGIN_PROVIDERS);
}

export function resolveLoginProvider(providerId: string): LoginProvider | undefined {
  const normalized = providerId.trim().toLowerCase();
  if (!normalized) return undefined;
  return LOGIN_PROVIDERS[normalized as LoginProvider["id"]];
}

export function parseLoginCommand(text: string): ParsedLoginCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const command = tokens[0].toLowerCase();
  if (command !== "login" && command !== "/login") {
    return null;
  }

  const providerId = tokens[1]?.toLowerCase();
  return {
    providerId,
    provider: providerId ? resolveLoginProvider(providerId) : undefined,
    extraArgs: tokens.slice(2),
  };
}

export function formatSupportedLoginProviders(): string {
  return getLoginProviders()
    .map((provider) => `\`${provider.id}\``)
    .join(", ");
}
