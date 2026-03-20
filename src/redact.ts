const registeredSecrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value && value.length >= 8) registeredSecrets.add(value);
}

/** Only for use in tests. */
export function __resetSecretsForTest(): void {
  registeredSecrets.clear();
}

export function redact(text: string): string {
  if (registeredSecrets.size === 0) return text;
  let result = text;
  for (const secret of registeredSecrets) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}
