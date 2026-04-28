export interface ParsedSessionViewCommand {
  command: "session" | "/session" | "/pi-session";
}

export function parseSessionViewCommand(text: string): ParsedSessionViewCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const command = tokens[0].toLowerCase();
  if (command !== "session" && command !== "/session" && command !== "/pi-session") {
    return null;
  }

  return { command: command as ParsedSessionViewCommand["command"] };
}
