import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export function appendChannelLog(workingDir: string, channelId: string, entry: object): void {
  const dir = join(workingDir, channelId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
}

export function createBotLogEntry(text: string, ts: string, threadTs?: string): object {
  return {
    date: new Date().toISOString(),
    ts,
    threadTs,
    user: "bot",
    text,
    attachments: [],
    isBot: true,
  };
}
