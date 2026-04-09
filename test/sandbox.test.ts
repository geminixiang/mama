import { describe, expect, test } from "vitest";
import { buildDockerExecCommand } from "../src/sandbox.js";

describe("DockerExecutor", () => {
  test("uses /workspace as the initial working directory inside docker", async () => {
    expect(buildDockerExecCommand("mama-sandbox-test", "pwd")).toBe(
      "docker exec -w /workspace mama-sandbox-test sh -c 'pwd'",
    );
  });
});
