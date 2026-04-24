import { describe, expect, test, vi } from "vitest";
import { DockerContainerManager } from "../src/provisioner.js";

describe("DockerContainerManager", () => {
  test("re-checks a cached container and starts it when it was stopped", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: '["/tmp/workspace:/workspace"]\n' })
      .mockResolvedValueOnce({ stdout: "false\n" })
      .mockResolvedValueOnce({ stdout: '["/tmp/workspace:/workspace"]\n' })
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
      "{{json .HostConfig.Binds}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(3, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "inspect",
      "-f",
      "{{json .HostConfig.Binds}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(5, "docker", ["start", "mama-sandbox-slack-u123"]);
  });

  test("re-checks a cached container and recreates it when it was deleted", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: '["/tmp/workspace:/workspace"]\n' })
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
      "{{json .HostConfig.Binds}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(3, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "mama-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "run",
      "-d",
      "--name",
      "mama-sandbox-slack-u123",
      "--label",
      "mama.managed=true",
      "--label",
      "mama.sandbox=image",
      "--label",
      "mama.vault-id=slack-u123",
      "-v",
      "/tmp/workspace:/workspace",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("provisions custom container names with extra vault mounts", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.provision("alice", {
      containerName: "alice-box",
      mounts: [{ source: "/tmp/vaults/alice/.ssh", target: "/root/.ssh" }],
    });
    await manager.stop("alice");

    expect(execMock).toHaveBeenNthCalledWith(1, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "alice-box",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(2, "docker", [
      "run",
      "-d",
      "--name",
      "alice-box",
      "--label",
      "mama.managed=true",
      "--label",
      "mama.sandbox=image",
      "--label",
      "mama.vault-id=alice",
      "-v",
      "/tmp/workspace:/workspace",
      "-v",
      "/tmp/vaults/alice/.ssh:/root/.ssh",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(3, "docker", ["stop", "alice-box"]);
  });

  test("recreates existing containers when vault mounts change", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({
        stdout: '["/tmp/workspace:/workspace","/tmp/vaults/alice/.ssh:/root/.ssh"]\n',
      })
      .mockResolvedValueOnce({ stdout: "removed\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.provision("alice", {
      containerName: "alice-box",
      mounts: [{ source: "/tmp/vaults/alice/.kube", target: "/root/.kube" }],
    });

    expect(execMock).toHaveBeenNthCalledWith(1, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "alice-box",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(2, "docker", [
      "inspect",
      "-f",
      "{{json .HostConfig.Binds}}",
      "alice-box",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(3, "docker", ["rm", "-f", "alice-box"]);
    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "run",
      "-d",
      "--name",
      "alice-box",
      "--label",
      "mama.managed=true",
      "--label",
      "mama.sandbox=image",
      "--label",
      "mama.vault-id=alice",
      "-v",
      "/tmp/workspace:/workspace",
      "-v",
      "/tmp/vaults/alice/.kube:/root/.kube",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("stop issues docker stop and updates state", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" }) // inspect → running
      .mockResolvedValueOnce({ stdout: '["/tmp/workspace:/workspace"]\n' }) // bind mounts
      .mockResolvedValueOnce({ stdout: "" }); // docker stop
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.provision("slack-u123");
    await manager.stop("slack-u123");

    expect(execMock).toHaveBeenLastCalledWith("docker", ["stop", "mama-sandbox-slack-u123"]);
  });

  test("stopIdle stops only containers idle longer than threshold", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: '["/tmp/workspace:/workspace"]\n' })
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: '["/tmp/workspace:/workspace"]\n' });
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

  test("reconcile discovers labeled containers and restores state", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "mama-sandbox-slack-u123\n" }) // labeled list
      .mockResolvedValueOnce({ stdout: "" }) // legacy list
      .mockResolvedValueOnce({
        stdout: "true\t2026-04-22T00:00:00.000000000Z\tslack-u123\n",
      }); // inspect details
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.reconcile();

    const stateField = (manager as any).state as Map<string, { status: string; lastUsed: number }>;
    expect(stateField.get("slack-u123")?.status).toBe("running");
    expect(stateField.get("slack-u123")?.lastUsed).toBe(Date.parse("2026-04-22T00:00:00.000Z"));
  });

  test("concurrent provision calls for the same vaultId share one docker run", async () => {
    let startResolve: (value: { stdout: string }) => void = () => {};
    const startPromise = new Promise<{ stdout: string }>((resolvePromise) => {
      startResolve = resolvePromise;
    });
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object")) // first inspect → missing
      .mockReturnValueOnce(startPromise); // first docker run (pending)

    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    const first = manager.provision("slack-u123");
    const second = manager.provision("slack-u123");

    startResolve({ stdout: "new-container-id\n" });
    await Promise.all([first, second]);

    // Exactly two docker calls total: one inspect, one run — the second
    // provision() piggybacked on the first instead of racing a duplicate run.
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0][1][0]).toBe("inspect");
    expect(execMock.mock.calls[1][1][0]).toBe("run");
  });

  test("failed docker start clears cached state and allows re-inspection", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      // First attempt: container exists but stopped, start fails.
      .mockResolvedValueOnce({ stdout: "false\n" })
      .mockRejectedValueOnce(new Error("docker start failed"))
      // Second attempt: inspect again, still missing, then docker run succeeds.
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "new-id\n" });

    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await expect(manager.provision("slack-u123")).rejects.toThrow(/start failed/);

    // State should have been dropped — next call re-inspects from scratch.
    const stateField = (manager as any).state as Map<string, unknown>;
    expect(stateField.has("slack-u123")).toBe(false);

    await expect(manager.provision("slack-u123")).resolves.toBe("mama-sandbox-slack-u123");
    // Third call in the mock queue must be an inspect (not a start on stale state).
    expect(execMock.mock.calls[2][1][0]).toBe("inspect");
  });

  test("reconcile falls back to legacy name prefix when label is missing", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "" }) // labeled list
      .mockResolvedValueOnce({ stdout: "mama-sandbox-discord-u999\n" }) // legacy list
      .mockResolvedValueOnce({
        stdout: "false\t0001-01-01T00:00:00Z\t<no value>\n",
      }); // inspect details
    const manager = new DockerContainerManager("ubuntu:24.04", "/tmp/workspace", execMock as any);

    await manager.reconcile();

    const stateField = (manager as any).state as Map<string, { status: string; lastUsed: number }>;
    expect(stateField.get("discord-u999")?.status).toBe("stopped");
    expect(stateField.get("discord-u999")).toBeDefined();
  });
});
