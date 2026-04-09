import { describe, expect, test, vi } from "vitest";
import { DockerContainerManager } from "../src/provisioner.js";

describe("DockerContainerManager", () => {
  test("re-checks a cached container and starts it when it was stopped", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "false\n" })
      .mockResolvedValueOnce({ stdout: "started\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.provision("slack-u123");
    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(1, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(2, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(3, "docker", ["start", "mama-sandbox-slack-u123"]);
  });

  test("re-checks a cached container and recreates it when it was deleted", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.provision("slack-u123");
    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(1, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(2, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(3, "docker", [
      "run",
      "-d",
      "--name",
      "mama-sandbox-slack-u123",
      "-v",
      "/tmp/workspace:/workspace",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("stop issues docker stop and updates state", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" }) // inspect → running
      .mockResolvedValueOnce({ stdout: "" }); // docker stop
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.provision("slack-u123");
    await manager.stop("slack-u123");

    expect(execMock).toHaveBeenLastCalledWith("docker", ["stop", "mama-sandbox-slack-u123"]);
  });

  test("stopIdle stops only containers idle longer than threshold", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValue({ stdout: "true\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.provision("slack-u111");
    await manager.provision("slack-u222");

    // Backdate lastUsed for u111 to simulate idleness
    const stateField = (manager as any).state as Map<string, { status: string; lastUsed: number }>;
    stateField.get("slack-u111")!.lastUsed = Date.now() - 7200000; // 2 hours ago

    execMock.mockResolvedValue({ stdout: "" }); // docker stop responses
    await manager.stopIdle(3600000); // 1 hour threshold

    const stopCalls = execMock.mock.calls.filter((c) => c[0] === "docker" && c[1][0] === "stop");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0][1]).toEqual(["stop", "mama-sandbox-slack-u111"]);
  });
});
