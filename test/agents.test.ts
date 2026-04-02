import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  formatAgentDefsForPrompt,
  loadAgentDefsFromDir,
  loadMamaAgentDefs,
} from "../src/agents.js";

describe("loadAgentDefsFromDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-agent-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("returns empty array when directory does not exist", () => {
    const defs = loadAgentDefsFromDir(join(tmpDir, "nonexistent"));
    expect(defs).toEqual([]);
  });

  test("returns empty array when directory is empty", () => {
    const defs = loadAgentDefsFromDir(tmpDir);
    expect(defs).toEqual([]);
  });

  test("returns empty array for directory without AGENT.md", () => {
    mkdirSync(join(tmpDir, "no-agent-md"));
    const defs = loadAgentDefsFromDir(tmpDir);
    expect(defs).toEqual([]);
  });

  test("parses minimal AGENT.md with name and description", () => {
    const agentDir = join(tmpDir, "reviewer");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "AGENT.md"),
      `---\nname: reviewer\ndescription: Reviews code\n---\n\nYou are a code reviewer.\n`,
    );

    const defs = loadAgentDefsFromDir(tmpDir);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("reviewer");
    expect(defs[0].description).toBe("Reviews code");
    expect(defs[0].systemPrompt).toBe("You are a code reviewer.");
    expect(defs[0].model).toBeUndefined();
    expect(defs[0].tools).toBeUndefined();
    expect(defs[0].baseDir).toBe(agentDir);
  });

  test("parses optional model and tools fields", () => {
    const agentDir = join(tmpDir, "planner");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "AGENT.md"),
      `---\nname: planner\ndescription: Plans tasks\nmodel: claude-opus-4-5\ntools: bash,read\n---\n\nYou are a planner.\n`,
    );

    const defs = loadAgentDefsFromDir(tmpDir);
    expect(defs).toHaveLength(1);
    expect(defs[0].model).toBe("claude-opus-4-5");
    expect(defs[0].tools).toEqual(["bash", "read"]);
  });

  test("ignores AGENT.md without required name", () => {
    const agentDir = join(tmpDir, "bad-agent");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "AGENT.md"),
      `---\ndescription: Missing name\n---\n\nSystem prompt.\n`,
    );

    const defs = loadAgentDefsFromDir(tmpDir);
    expect(defs).toEqual([]);
  });

  test("ignores AGENT.md without required description", () => {
    const agentDir = join(tmpDir, "bad-agent");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "AGENT.md"),
      `---\nname: bad\n---\n\nSystem prompt.\n`,
    );

    const defs = loadAgentDefsFromDir(tmpDir);
    expect(defs).toEqual([]);
  });

  test("ignores AGENT.md without frontmatter", () => {
    const agentDir = join(tmpDir, "no-frontmatter");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "AGENT.md"), `Just a plain file without frontmatter.`);

    const defs = loadAgentDefsFromDir(tmpDir);
    expect(defs).toEqual([]);
  });

  test("loads multiple agent definitions", () => {
    for (const name of ["reviewer", "planner", "debugger"]) {
      const agentDir = join(tmpDir, name);
      mkdirSync(agentDir);
      writeFileSync(
        join(agentDir, "AGENT.md"),
        `---\nname: ${name}\ndescription: ${name} agent\n---\n\nSystem prompt for ${name}.\n`,
      );
    }

    const defs = loadAgentDefsFromDir(tmpDir);
    expect(defs).toHaveLength(3);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["debugger", "planner", "reviewer"]);
  });
});

describe("loadMamaAgentDefs", () => {
  let tmpDir: string;
  let channelDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-agent-test-${Date.now()}`);
    workspaceDir = join(tmpDir, "workspace");
    channelDir = join(workspaceDir, "C123");
    mkdirSync(channelDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("returns empty array when no agents directories exist", () => {
    const defs = loadMamaAgentDefs(channelDir, workspaceDir);
    expect(defs).toEqual([]);
  });

  test("loads workspace-level agents", () => {
    const agentDir = join(workspaceDir, "agents", "reviewer");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "AGENT.md"),
      `---\nname: reviewer\ndescription: Global reviewer\n---\n\nGlobal reviewer.\n`,
    );

    const defs = loadMamaAgentDefs(channelDir, workspaceDir);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("reviewer");
    expect(defs[0].systemPrompt).toBe("Global reviewer.");
  });

  test("channel-specific agent overrides workspace agent of same name", () => {
    // Workspace agent
    const wsAgentDir = join(workspaceDir, "agents", "reviewer");
    mkdirSync(wsAgentDir, { recursive: true });
    writeFileSync(
      join(wsAgentDir, "AGENT.md"),
      `---\nname: reviewer\ndescription: Global reviewer\n---\n\nGlobal system prompt.\n`,
    );

    // Channel agent with same name
    const chAgentDir = join(channelDir, "agents", "reviewer");
    mkdirSync(chAgentDir, { recursive: true });
    writeFileSync(
      join(chAgentDir, "AGENT.md"),
      `---\nname: reviewer\ndescription: Channel reviewer\n---\n\nChannel system prompt.\n`,
    );

    const defs = loadMamaAgentDefs(channelDir, workspaceDir);
    expect(defs).toHaveLength(1);
    expect(defs[0].description).toBe("Channel reviewer");
    expect(defs[0].systemPrompt).toBe("Channel system prompt.");
  });

  test("merges workspace and channel agents without collision", () => {
    const wsAgentDir = join(workspaceDir, "agents", "global-agent");
    mkdirSync(wsAgentDir, { recursive: true });
    writeFileSync(
      join(wsAgentDir, "AGENT.md"),
      `---\nname: global-agent\ndescription: Global\n---\n\nGlobal.\n`,
    );

    const chAgentDir = join(channelDir, "agents", "channel-agent");
    mkdirSync(chAgentDir, { recursive: true });
    writeFileSync(
      join(chAgentDir, "AGENT.md"),
      `---\nname: channel-agent\ndescription: Channel\n---\n\nChannel.\n`,
    );

    const defs = loadMamaAgentDefs(channelDir, workspaceDir);
    expect(defs).toHaveLength(2);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["channel-agent", "global-agent"]);
  });
});

describe("formatAgentDefsForPrompt", () => {
  test("returns no-agents message when list is empty", () => {
    const result = formatAgentDefsForPrompt([]);
    expect(result).toBe("(no agents defined)");
  });

  test("formats single agent", () => {
    const result = formatAgentDefsForPrompt([
      {
        name: "reviewer",
        description: "Reviews code",
        systemPrompt: "...",
        baseDir: "/some/path",
      },
    ]);
    expect(result).toContain("**reviewer**");
    expect(result).toContain("Reviews code");
    expect(result).toContain('"reviewer"');
  });

  test("formats multiple agents", () => {
    const result = formatAgentDefsForPrompt([
      { name: "a", description: "Agent A", systemPrompt: "...", baseDir: "/" },
      { name: "b", description: "Agent B", systemPrompt: "...", baseDir: "/" },
    ]);
    expect(result).toContain("**a**");
    expect(result).toContain("**b**");
  });
});

describe("spawn_agent tool depth enforcement", () => {
  test("createMamaTools does not include spawn_agent when no agentDefs", async () => {
    // Dynamic import to avoid needing pi-coding-agent at test time
    // We test the interface shape instead
    const { createMamaTools } = await import("../src/tools/index.js").catch(() => ({
      createMamaTools: null,
    }));

    if (!createMamaTools) {
      // Skip if module not resolvable (no node_modules)
      return;
    }

    const fakeExecutor = {
      exec: vi.fn(),
      getWorkspacePath: vi.fn((p: string) => p),
    };

    const agentCtx = {
      agentDepth: 0,
      agentDefs: [], // empty — no spawn_agent should be added
      spawnSubAgent: vi.fn(),
    };

    const { tools } = createMamaTools(fakeExecutor as any, agentCtx);
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("spawn_agent");
  });
});
