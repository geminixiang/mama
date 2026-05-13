import { existsSync, mkdirSync, readFileSync } from "fs";

export function ensureDirExists(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readTextFileIfExists(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  return readFileSync(path, "utf-8");
}

export function readJsonFileIfExists<T>(
  path: string,
  validate: (value: unknown) => value is T,
  malformedMessage: (detail: string) => string,
): T | undefined {
  const raw = readTextFileIfExists(path);
  if (raw === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(malformedMessage(detail));
  }

  if (!validate(parsed)) {
    throw new Error(malformedMessage("unexpected JSON shape"));
  }

  return parsed;
}

export function parseJsonValue<T>(
  raw: string,
  validate: (value: unknown) => value is T,
  malformedMessage: (detail: string) => string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(malformedMessage(detail));
  }

  if (!validate(parsed)) {
    throw new Error(malformedMessage("unexpected JSON shape"));
  }

  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
