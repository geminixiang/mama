import { describe, expect, test } from "vitest";
import {
  buildEventFilesystemInstructions,
  buildInitialPathContextForTest,
  translateRuntimePathToHost,
} from "../src/agent.js";

describe("agent prompt event filesystem instructions", () => {
  test("host-mounted sandboxes may show manual event file paths", () => {
    const instructions = buildEventFilesystemInstructions("image", "/workspace");

    expect(instructions).toContain("cat > /workspace/events/dentist-reminder-$(date +%s).json");
    expect(instructions).toContain("Prefer the `event` tool");
  });

  test("remote sandboxes do not encourage writing event files in runtime filesystem", () => {
    const instructions = buildEventFilesystemInstructions("cloudflare", "/workspace");

    expect(instructions).toContain("host-side mama control plane");
    expect(instructions).toContain("Use the `event` tool");
    expect(instructions).toContain("Do not create event files with bash");
    expect(instructions).not.toContain("cat > /workspace/events");
  });
});

describe("runtime path context", () => {
  test("container runtime paths translate back to host paths", () => {
    const pathContext = buildInitialPathContextForTest(
      { type: "container", container: "mama-sandbox" },
      "/host/workspace",
    );

    expect(pathContext).toMatchObject({
      hostWorkspaceRoot: "/host/workspace",
      runtimeWorkspaceRoot: "/workspace",
    });
    expect(pathContext.runtimeToHostPath).toBeTypeOf("function");
    expect(translateRuntimePathToHost("/workspace/C123/report.txt", pathContext)).toBe(
      "/host/workspace/C123/report.txt",
    );
  });

  test("image sandbox has an initial runtime path before resolving to a container", () => {
    const pathContext = buildInitialPathContextForTest(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(pathContext).toMatchObject({
      hostWorkspaceRoot: "/host/workspace",
      runtimeWorkspaceRoot: "/workspace",
    });
    expect(pathContext.runtimeToHostPath).toBeTypeOf("function");
    expect(translateRuntimePathToHost("/workspace/C123/report.txt", pathContext)).toBe(
      "/host/workspace/C123/report.txt",
    );
  });

  test("cloudflare keeps runtime paths remote and event control plane on host", () => {
    const pathContext = buildInitialPathContextForTest(
      { type: "cloudflare", sandboxId: "slack-u123" },
      "/host/workspace",
    );

    expect(pathContext).toMatchObject({
      hostWorkspaceRoot: "/host/workspace",
      runtimeWorkspaceRoot: "/workspace",
    });
    expect(pathContext.runtimeToHostPath).toBeUndefined();
    expect(translateRuntimePathToHost("/workspace/C123/report.txt", pathContext)).toBe(
      "/workspace/C123/report.txt",
    );
  });
});
