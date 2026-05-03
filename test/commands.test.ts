import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Bot, ChatResponseContext } from "../src/adapter.js";
import type { UserBindingStore } from "../src/bindings.js";
import { CommandRegistry } from "../src/commands/registry.js";
import { LoginCommandHandler } from "../src/commands/login.js";
import { SessionViewCommandHandler } from "../src/commands/session-view.js";
import type { CommandContext, CommandHandler, CommandServices } from "../src/commands/types.js";
import { createManagedSessionFile, getChannelSessionDir } from "../src/session-store.js";
import type { SandboxConfig } from "../src/sandbox.js";
import type { VaultEntry, VaultManager } from "../src/vault.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

interface RecordingResponseCtx extends ChatResponseContext {
  responses: string[];
}

function fakeResponseCtx(): RecordingResponseCtx {
  const responses: string[] = [];
  return {
    responses,
    respond: vi.fn(async (text: string) => {
      responses.push(text);
    }),
    replaceResponse: vi.fn(async () => {}),
    respondDiagnostic: vi.fn(async () => {}),
    respondToolResult: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    setWorking: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => {}),
    deleteResponse: vi.fn(async () => {}),
  } as RecordingResponseCtx;
}

function fakeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    start: vi.fn(async () => {}),
    postMessage: vi.fn(async () => "ts-1"),
    updateMessage: vi.fn(async () => {}),
    enqueueEvent: vi.fn(() => true),
    getPlatformInfo: vi.fn(() => ({
      name: "slack",
      formattingGuide: "",
      channels: [],
      users: [],
    })),
    ...overrides,
  };
}

function fakeVaultManager(): VaultManager & { entries: Map<string, VaultEntry> } {
  const entries = new Map<string, VaultEntry>();
  return {
    entries,
    hasEntry: (key) => entries.has(key),
    resolve: () => undefined,
    getSandboxConfig: (_uid, base) => base,
    list: () => [],
    reload: () => {},
    isEnabled: () => true,
    addEntry: (key, entry) => {
      if (!entries.has(key)) entries.set(key, entry);
    },
    ensureImageSandboxEntry: (key, entry) => entries.set(key, entry),
    upsertEnv: () => {},
    upsertFile: () => {},
  };
}

function fakeBindingStore(): UserBindingStore {
  return {
    isEnabled: () => true,
    resolve: () => undefined,
    list: () => [],
    create: () => {
      throw new Error("not used");
    },
    activate: () => {
      throw new Error("not used");
    },
    revoke: () => {},
  };
}

interface RecordedLinkToken {
  platform: string;
  platformUserId: string;
  conversationId: string;
  vaultId: string;
  providerId: string;
}

function fakeLinkTokenStore() {
  const created: RecordedLinkToken[] = [];
  return {
    created,
    create(
      platform: "slack" | "discord" | "telegram",
      platformUserId: string,
      conversationId: string,
      vaultId: string,
      providerId: string,
    ) {
      created.push({ platform, platformUserId, conversationId, vaultId, providerId });
      return { token: "tok-link" };
    },
  };
}

function fakeSessionViewTokenStore() {
  const created: { sessionFile: string }[] = [];
  return {
    created,
    create(
      _platform: "slack" | "discord" | "telegram",
      _userId: string,
      _conversationId: string,
      _sessionKey: string,
      sessionFile: string,
    ) {
      created.push({ sessionFile });
      return { token: "tok-sv" };
    },
  };
}

interface BuildContextArgs {
  commandText: string;
  privateConversation?: boolean;
  bot?: Bot;
  services?: Partial<CommandServices>;
  platform?: "slack" | "discord" | "telegram";
}

function buildContext(args: BuildContextArgs): CommandContext & {
  responseCtx: RecordingResponseCtx;
} {
  const sandbox: SandboxConfig = { type: "host" };
  const responseCtx = fakeResponseCtx();
  const services: CommandServices = {
    workingDir: "/tmp/no-such-working-dir",
    sandbox,
    vaultManager: fakeVaultManager(),
    bindingStore: fakeBindingStore(),
    linkTokenStore: fakeLinkTokenStore(),
    sessionViewTokenStore: fakeSessionViewTokenStore(),
    portalBaseUrl: "https://portal.example",
    ...args.services,
  };
  return {
    bot: args.bot ?? fakeBot(),
    responseCtx,
    platform: args.platform ?? "slack",
    platformUserId: "U123",
    conversationId: "C123",
    sessionKey: "C123",
    commandText: args.commandText,
    privateConversation: args.privateConversation ?? false,
    services,
  };
}

// ── CommandRegistry ──────────────────────────────────────────────────────────

describe("CommandRegistry", () => {
  test("returns false when no handler accepts the command", async () => {
    const a: CommandHandler = { tryHandle: vi.fn(async () => false) };
    const b: CommandHandler = { tryHandle: vi.fn(async () => false) };
    const registry = new CommandRegistry([a, b]);
    const ctx = buildContext({ commandText: "hello" });

    const handled = await registry.handle(ctx);

    expect(handled).toBe(false);
    expect(a.tryHandle).toHaveBeenCalledOnce();
    expect(b.tryHandle).toHaveBeenCalledOnce();
  });

  test("short-circuits on the first handler that accepts", async () => {
    const a: CommandHandler = { tryHandle: vi.fn(async () => true) };
    const b: CommandHandler = { tryHandle: vi.fn(async () => true) };
    const registry = new CommandRegistry([a, b]);
    const ctx = buildContext({ commandText: "/login" });

    const handled = await registry.handle(ctx);

    expect(handled).toBe(true);
    expect(a.tryHandle).toHaveBeenCalledOnce();
    expect(b.tryHandle).not.toHaveBeenCalled();
  });

  test("falls through to the next handler when the first declines", async () => {
    const a: CommandHandler = { tryHandle: vi.fn(async () => false) };
    const b: CommandHandler = { tryHandle: vi.fn(async () => true) };
    const registry = new CommandRegistry([a, b]);
    const ctx = buildContext({ commandText: "/session" });

    const handled = await registry.handle(ctx);

    expect(handled).toBe(true);
    expect(a.tryHandle).toHaveBeenCalledOnce();
    expect(b.tryHandle).toHaveBeenCalledOnce();
  });
});

// ── LoginCommandHandler ──────────────────────────────────────────────────────

describe("LoginCommandHandler", () => {
  const handler = new LoginCommandHandler();

  test("declines unrelated commands", async () => {
    const ctx = buildContext({ commandText: "hello" });
    expect(await handler.tryHandle(ctx)).toBe(false);
  });

  test("rejects in non-private conversations without creating a token", async () => {
    const linkTokenStore = fakeLinkTokenStore();
    const ctx = buildContext({
      commandText: "/login",
      privateConversation: false,
      services: { linkTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(linkTokenStore.created).toHaveLength(0);
    expect(ctx.responseCtx.responses[0]).toContain("私訊");
  });

  test("reports missing portalBaseUrl", async () => {
    const linkTokenStore = fakeLinkTokenStore();
    const ctx = buildContext({
      commandText: "/login",
      privateConversation: true,
      services: { linkTokenStore, portalBaseUrl: undefined },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(linkTokenStore.created).toHaveLength(0);
    expect(ctx.responseCtx.responses[0]).toContain("MOM_LINK_URL");
  });

  test("creates a link token and replies with the portal URL", async () => {
    const linkTokenStore = fakeLinkTokenStore();
    const ctx = buildContext({
      commandText: "/login",
      privateConversation: true,
      services: { linkTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(linkTokenStore.created).toEqual([
      {
        platform: "slack",
        platformUserId: "U123",
        conversationId: "C123",
        vaultId: "U123",
        providerId: "",
      },
    ]);
    expect(ctx.responseCtx.responses[0]).toContain("https://portal.example/link?token=tok-link");
  });
});

// ── SessionViewCommandHandler ────────────────────────────────────────────────

describe("SessionViewCommandHandler", () => {
  const handler = new SessionViewCommandHandler();
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(
      tmpdir(),
      `cmd-session-view-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  test("declines unrelated commands", async () => {
    const ctx = buildContext({ commandText: "hello" });
    expect(await handler.tryHandle(ctx)).toBe(false);
  });

  test("uses bot.postPrivate for shared conversations when available", async () => {
    const conversationId = "C123";
    const conversationDir = join(workingDir, conversationId);
    mkdirSync(conversationDir, { recursive: true });
    createManagedSessionFile(getChannelSessionDir(conversationDir), conversationDir);

    const postPrivate = vi.fn(async () => {});
    const bot = fakeBot({ postPrivate });
    const sessionViewTokenStore = fakeSessionViewTokenStore();
    const ctx = buildContext({
      commandText: "/session",
      privateConversation: false,
      bot,
      services: { workingDir, sessionViewTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(postPrivate).toHaveBeenCalledOnce();
    expect(postPrivate.mock.calls[0][0]).toBe("C123");
    expect(postPrivate.mock.calls[0][1]).toBe("U123");
    expect(postPrivate.mock.calls[0][2]).toContain("/session?token=tok-sv");
    expect(sessionViewTokenStore.created).toHaveLength(1);
  });

  test("rejects shared conversations on platforms without postPrivate", async () => {
    const bot = fakeBot();
    delete (bot as { postPrivate?: unknown }).postPrivate;
    const sessionViewTokenStore = fakeSessionViewTokenStore();
    const ctx = buildContext({
      commandText: "/session",
      privateConversation: false,
      bot,
      services: { workingDir, sessionViewTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(sessionViewTokenStore.created).toHaveLength(0);
    expect(ctx.responseCtx.responses[0]).toContain("私訊");
  });

  test("reports missing session file", async () => {
    const sessionViewTokenStore = fakeSessionViewTokenStore();
    const ctx = buildContext({
      commandText: "/session",
      privateConversation: true,
      services: { workingDir, sessionViewTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(sessionViewTokenStore.created).toHaveLength(0);
    expect(ctx.responseCtx.responses[0]).toContain("還沒有可查看的 session");
  });

  test("creates a token and replies with the portal URL in private conversations", async () => {
    const conversationId = "C123";
    const conversationDir = join(workingDir, conversationId);
    mkdirSync(conversationDir, { recursive: true });
    const expectedFile = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );

    const sessionViewTokenStore = fakeSessionViewTokenStore();
    const ctx = buildContext({
      commandText: "/session",
      privateConversation: true,
      services: { workingDir, sessionViewTokenStore },
    });

    expect(await handler.tryHandle(ctx)).toBe(true);
    expect(sessionViewTokenStore.created).toEqual([{ sessionFile: expectedFile }]);
    expect(ctx.responseCtx.responses[0]).toContain("https://portal.example/session?token=tok-sv");
  });
});
