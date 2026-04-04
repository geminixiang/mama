import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createAttachmentTarget,
  downloadAttachmentToFile,
} from "../src/adapters/shared/attachments.js";

describe("attachment helpers", () => {
  let workingDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mama-shared-attachments-${Date.now()}`);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(workingDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("createAttachmentTarget sanitizes names and returns deterministic paths", () => {
    const target = createAttachmentTarget(workingDir, "C123", "my report (final).pdf", 123456);

    expect(target).toEqual({
      filename: "123456_my_report__final_.pdf",
      localPath: "C123/attachments/123456_my_report__final_.pdf",
      directory: join(workingDir, "C123", "attachments"),
    });
  });

  test("downloadAttachmentToFile creates parent directories and writes the fetched bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const dir = join(workingDir, "C123", "attachments");
    await downloadAttachmentToFile(dir, "file.bin", "https://example.com/file.bin");

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/file.bin", undefined);
    const filePath = join(dir, "file.bin");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("downloadAttachmentToFile forwards fetch init when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await downloadAttachmentToFile(join(workingDir, "nested"), "file.bin", "https://example.com", {
      headers: { Authorization: "Bearer token" },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://example.com", {
      headers: { Authorization: "Bearer token" },
    });
  });

  test("downloadAttachmentToFile throws a descriptive error for failed responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      downloadAttachmentToFile(
        join(workingDir, "C123"),
        "secret.txt",
        "https://example.com/secret",
      ),
    ).rejects.toThrow("HTTP 403: Forbidden");

    expect(existsSync(join(workingDir, "C123", "secret.txt"))).toBe(false);
  });
});
