import { existsSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ContainerExecutor,
  FirecrackerExecutor,
  HostExecutor,
  SandboxError,
  buildContainerExecCommand,
  createExecutor,
  parseSandboxArg,
} from "../src/sandbox.js";

describe("parseSandboxArg", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("parses host sandbox", () => {
    expect(parseSandboxArg("host")).toEqual({ type: "host" });
  });

  test("parses container sandbox", () => {
    expect(parseSandboxArg("container:mama-sandbox")).toEqual({
      type: "container",
      container: "mama-sandbox",
    });
  });

  test("parses image sandbox for managed per-user containers", () => {
    expect(parseSandboxArg("image:ubuntu:24.04")).toEqual({
      type: "image",
      image: "ubuntu:24.04",
    });
  });

  test("parses firecracker sandbox with defaults", () => {
    expect(parseSandboxArg("firecracker:172.16.0.2:/home/user/workspace")).toEqual({
      type: "firecracker",
      vmId: "172.16.0.2",
      hostPath: "/home/user/workspace",
      sshUser: "root",
      sshPort: 22,
    });
  });

  test("parses firecracker sandbox with custom SSH user and port", () => {
    expect(parseSandboxArg("firecracker:vm1:/srv/workspace:ubuntu:2222")).toEqual({
      type: "firecracker",
      vmId: "vm1",
      hostPath: "/srv/workspace",
      sshUser: "ubuntu",
      sshPort: 2222,
    });
  });

  test("rejects invalid firecracker SSH port", () => {
    expect(() => parseSandboxArg("firecracker:vm1:/srv/workspace:root:99999")).toThrowError(
      SandboxError,
    );
    expect(() => parseSandboxArg("firecracker:vm1:/srv/workspace:root:99999")).toThrow(
      "Error: invalid SSH port",
    );
  });

  test("rejects unsupported sandbox type", () => {
    expect(() => parseSandboxArg("podman:mama")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("podman:mama")).toThrow(
      "Error: Invalid sandbox type 'podman:mama'",
    );
  });

  test("rejects docker mode with migration hint", () => {
    expect(() => parseSandboxArg("docker:mama-sandbox")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("docker:mama-sandbox")).toThrow(
      "Use 'container:<container-name>' for the shared-container mode",
    );
  });
});

describe("createExecutor", () => {
  test("creates host executor", () => {
    expect(createExecutor({ type: "host" })).toBeInstanceOf(HostExecutor);
  });

  test("creates container executor", () => {
    expect(createExecutor({ type: "container", container: "mama-sandbox" })).toBeInstanceOf(
      ContainerExecutor,
    );
  });

  test("rejects unresolved image executor", () => {
    expect(() => createExecutor({ type: "image", image: "ubuntu:24.04" })).toThrowError(
      SandboxError,
    );
  });

  test("creates firecracker executor", () => {
    expect(
      createExecutor({
        type: "firecracker",
        vmId: "172.16.0.2",
        hostPath: "/home/user/workspace",
      }),
    ).toBeInstanceOf(FirecrackerExecutor);
  });
});

describe("ContainerExecutor", () => {
  test("uses /workspace as the initial working directory inside the container", () => {
    expect(buildContainerExecCommand("mama-sandbox-test", "pwd")).toBe(
      "docker exec -w /workspace mama-sandbox-test sh -c 'pwd'",
    );
  });

  test("injects environment variables into docker exec via env file", () => {
    expect(buildContainerExecCommand("mama-sandbox-test", "echo $TOKEN", "/tmp/env.list")).toBe(
      "docker exec --env-file '/tmp/env.list' -w /workspace mama-sandbox-test sh -c 'echo $TOKEN'",
    );
  });

  test("does not expose secret values in the docker command line", async () => {
    const secret = "sk-top-secret";
    let capturedCmd = "";
    const exec = vi.spyOn(HostExecutor.prototype, "exec").mockImplementation(async (cmd) => {
      capturedCmd = cmd as string;
      return { stdout: "", stderr: "", code: 0 };
    });

    const executor = new ContainerExecutor(
      "mama-sandbox-test",
      { OPENAI_API_KEY: secret },
      async () => {},
    );
    await executor.exec("echo ok");

    expect(exec).toHaveBeenCalled();
    expect(capturedCmd).toContain("--env-file");
    expect(capturedCmd).not.toContain(secret);

    const match = capturedCmd.match(/--env-file '([^']+)'/);
    expect(match).toBeTruthy();
    if (match) {
      expect(existsSync(match[1])).toBe(false);
    }
  });
});

describe("FirecrackerExecutor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("uses /workspace as the guest workspace path", () => {
    const executor = new FirecrackerExecutor("172.16.0.2", "/home/user/workspace");
    expect(executor.getWorkspacePath("/home/user/workspace")).toBe("/workspace");
  });

  test("executes commands through SSH with the default port", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "ok\n", stderr: "", code: 0 });
    const executor = new FirecrackerExecutor("172.16.0.2", "/home/user/workspace");

    await expect(executor.exec("echo 'hello'")).resolves.toEqual({
      stdout: "ok\n",
      stderr: "",
      code: 0,
    });

    expect(exec).toHaveBeenCalledWith(
      "ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@172.16.0.2 sh -c 'echo '\\''hello'\\'''",
      undefined,
    );
  });

  test("executes commands through SSH with a custom user and port", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new FirecrackerExecutor("vm1", "/srv/workspace", "ubuntu", 2222);

    await executor.exec("pwd", { timeout: 5 });

    expect(exec).toHaveBeenCalledWith(
      "ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p 2222 ubuntu@vm1 sh -c 'pwd'",
      { timeout: 5 },
    );
  });
});
