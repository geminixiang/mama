import { describe, expect, test, vi } from "vitest";
import { DockerProvisioner } from "../src/provisioner.js";

describe("DockerProvisioner", () => {
  test("re-checks a cached container and starts it when it was stopped", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "false\n" })
      .mockResolvedValueOnce({ stdout: "started\n" });
    const provisioner = new DockerProvisioner("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await provisioner.provision("slack-u123");
    await provisioner.provision("slack-u123");

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
    const provisioner = new DockerProvisioner("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await provisioner.provision("slack-u123");
    await provisioner.provision("slack-u123");

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
});
