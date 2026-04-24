import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface DownloadedAttachment {
  name: string;
  localPath: string;
}

export interface AttachmentTarget {
  filename: string;
  localPath: string;
  directory: string;
}

export function createAttachmentTarget(
  workingDir: string,
  channelId: string,
  originalName: string,
  timestamp: number,
): AttachmentTarget {
  const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${timestamp}_${sanitizedName}`;

  return {
    filename,
    localPath: `${channelId}/attachments/${filename}`,
    directory: join(workingDir, channelId, "attachments"),
  };
}

export async function downloadAttachmentToFile(
  directory: string,
  filename: string,
  url: string,
  init?: RequestInit,
): Promise<void> {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  writeFileSync(join(directory, filename), Buffer.from(buffer));
}
