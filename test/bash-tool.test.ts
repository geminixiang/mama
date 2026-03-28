import { describe, expect, test, vi } from "vitest";
import type { Executor } from "../src/sandbox.js";
import { createBashTool } from "../src/tools/bash.js";

describe("createBashTool", () => {
  test("passes per-run execution env to executor", async () => {
    const executor: Executor = {
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0 }),
      getWorkspacePath: vi.fn().mockReturnValue("/workspace"),
    };

    const tool = createBashTool(executor, () => ({
      MAMA_SLACK_USER_ID: "U001",
      MAMA_GOOGLE_ACCESS_TOKEN_URL: "http://127.0.0.1:8080/api/token/U001",
    }));

    const result = await tool.execute("tool-1", {
      label: "Check env injection",
      command: "echo ok",
    });

    expect(executor.exec).toHaveBeenCalledWith(
      "echo ok",
      expect.objectContaining({
        env: {
          MAMA_SLACK_USER_ID: "U001",
          MAMA_GOOGLE_ACCESS_TOKEN_URL: "http://127.0.0.1:8080/api/token/U001",
        },
      }),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: undefined,
    });
  });
});
