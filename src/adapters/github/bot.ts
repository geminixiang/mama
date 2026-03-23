import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { execSync } from "child_process";
import type { Bot, BotEvent, BotHandler, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import { createGitHubAdapters } from "./context.js";

// ============================================================================
// Types
// ============================================================================

export interface GitHubBotConfig {
  workingDir: string;
  /** GitHub token for API calls (posting comments, fetching context) */
  token?: string;
  /** Webhook secret for signature verification */
  webhookSecret?: string;
  /** Port for the webhook HTTP server (default: 3000) */
  webhookPort?: number;
}

export interface GitHubUser {
  id: string;
  login: string;
}

export interface GitHubComment {
  body: string;
  user: GitHubUser;
  created_at: string;
}

/** Webhook payload for issue_comment event */
interface IssueCommentPayload {
  action: "created" | "edited" | "deleted";
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: GitHubUser;
  };
  comment: {
    id: number;
    body: string;
    user: GitHubUser;
    created_at: string;
    html_url: string;
  };
  repository: {
    full_name: string;
    name: string;
    owner: { login: string };
  };
  sender: GitHubUser;
}

/** Webhook payload for issues event */
interface IssuesPayload {
  action: "opened" | "edited" | "closed" | "reopened" | string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: GitHubUser;
  };
  repository: {
    full_name: string;
    name: string;
    owner: { login: string };
  };
  sender: GitHubUser;
}

// ============================================================================
// GitHub API Helper
// ============================================================================

class GitHubAPI {
  private token: string;

  constructor(token?: string) {
    this.token = token || execSync("gh auth token", { encoding: "utf-8" }).trim();
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `https://api.github.com${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${error}`);
    }

    // Some endpoints (e.g. PATCH) return 204/205 with no body
    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (e) {
      log.logError(`JSON parse error: ${e.message}`);
      throw new Error(`Failed to parse JSON: ${text.substring(0, 200)}`);
    }
  }

  async getIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<GitHubComment[]> {
    return this.request<GitHubComment[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`);
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: string; html_url: string }> {
    return this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    commentId: string,
    body: string,
  ): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async addReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: string,
  ): Promise<void> {
    try {
      await this.request(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
        method: "POST",
        body: JSON.stringify({ content }),
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      log.logWarning("Failed to add reaction", String(e));
    }
  }

  async getAuthenticatedUser(): Promise<GitHubUser> {
    return this.request<GitHubUser>("/user");
  }
}

// ============================================================================
// Bot Implementation
// ============================================================================

export class GitHubBot implements Bot {
  private api: GitHubAPI;
  private handler: BotHandler;
  private workingDir: string;
  private webhookSecret: string;
  private webhookPort: number;
  private user: GitHubUser | null = null;
  private server: Server | null = null;
  private platformInfo: PlatformInfo;
  private botUsername: string = "bot";

  constructor(handler: BotHandler, config: GitHubBotConfig) {
    this.handler = handler;
    this.workingDir = config.workingDir;
    this.webhookSecret = config.webhookSecret || "";
    this.webhookPort = config.webhookPort || 3000;
    this.api = new GitHubAPI(config.token);
    this.platformInfo = {
      name: "github",
      formattingGuide: "GitHub uses Markdown formatting",
      channels: [],
      users: [],
    };
  }

  async start(): Promise<void> {
    log.logInfo("Starting GitHub bot...");

    // Get authenticated user
    this.user = await this.api.getAuthenticatedUser();
    this.botUsername = this.user.login;
    log.logInfo(`Logged in as GitHub user: ${this.botUsername}`);

    // Start webhook server
    await this.startWebhookServer();
  }

  async stop(): Promise<void> {
    log.logInfo("Stopping GitHub bot...");
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private startWebhookServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err) => {
        log.logWarning("Webhook server error", String(err));
        reject(err);
      });

      this.server.listen(this.webhookPort, () => {
        log.logInfo(`Webhook server listening on port ${this.webhookPort}`);
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Health check
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", bot: this.botUsername }));
      return;
    }

    // Only accept POST to /webhook
    if (req.method !== "POST" || (req.url !== "/webhook" && req.url !== "/")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // Read body
    const body = await this.readBody(req);
    if (!body) {
      res.writeHead(400);
      res.end("Empty body");
      return;
    }

    // Verify signature if secret is configured
    if (this.webhookSecret) {
      const signature = req.headers["x-hub-signature-256"] as string;
      if (!signature || !this.verifySignature(body, signature)) {
        log.logWarning("Webhook signature verification failed");
        res.writeHead(401);
        res.end("Invalid signature");
        return;
      }
    }

    // Respond immediately (GitHub expects < 10s response)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    // Process event asynchronously
    const event = req.headers["x-github-event"] as string;
    try {
      const payload = JSON.parse(body);
      await this.routeEvent(event, payload);
    } catch (e) {
      log.logWarning("Failed to process webhook event", String(e));
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", () => resolve(""));
    });
  }

  private verifySignature(payload: string, signature: string): boolean {
    const expected =
      "sha256=" + createHmac("sha256", this.webhookSecret).update(payload).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  private async routeEvent(eventType: string, payload: unknown): Promise<void> {
    switch (eventType) {
      case "issue_comment":
        await this.handleIssueComment(payload as IssueCommentPayload);
        break;
      case "issues":
        await this.handleIssueOpened(payload as IssuesPayload);
        break;
      default:
        // Ignore other event types
        break;
    }
  }

  private async handleIssueComment(payload: IssueCommentPayload): Promise<void> {
    // Only handle new comments
    if (payload.action !== "created") return;

    // Ignore bot's own comments
    if (payload.comment.user.login === this.botUsername) return;

    // Check if the comment mentions the bot
    if (!this.isMentioned(payload.comment.body)) return;

    const { owner, repo, issueNumber } = this.extractRepoInfo(payload);

    log.logInfo(
      `Mention by @${payload.comment.user.login} in ${owner}/${repo}#${issueNumber}: ${payload.issue.title}`,
    );

    // React with 👀 to acknowledge
    await this.api.addReaction(owner, repo, payload.comment.id, "eyes");

    // Build context from webhook payload + recent comments
    let contextText = `#${issueNumber}: ${payload.issue.title}\n\n`;
    if (payload.issue.body) {
      contextText += `${payload.issue.body}\n\n`;
    }

    // Fetch recent comments for full context
    try {
      const comments = await this.api.getIssueComments(owner, repo, issueNumber);
      for (const comment of comments.slice(-10)) {
        if (comment.user.login === this.botUsername) continue;
        contextText += `**@${comment.user.login}** commented:\n${comment.body}\n\n`;
      }
    } catch (e) {
      // Fallback: use just the triggering comment
      log.logWarning("Failed to fetch comments, using trigger comment only", String(e));
      contextText += `**@${payload.comment.user.login}** commented:\n${payload.comment.body}\n\n`;
    }

    const event: BotEvent = {
      type: "mention",
      channel: `${owner}/${repo}`,
      ts: payload.comment.created_at,
      user: payload.comment.user.id.toString(),
      text: contextText,
    };

    this.enqueueEvent(event, issueNumber);
  }

  private async handleIssueOpened(payload: IssuesPayload): Promise<void> {
    // Only handle newly opened issues
    if (payload.action !== "opened") return;

    // Check if the issue body mentions the bot
    if (!payload.issue.body || !this.isMentioned(payload.issue.body)) return;

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const issueNumber = payload.issue.number;

    log.logInfo(
      `Mentioned in new issue by @${payload.sender.login}: ${owner}/${repo}#${issueNumber}: ${payload.issue.title}`,
    );

    let contextText = `#${issueNumber}: ${payload.issue.title}\n\n`;
    if (payload.issue.body) {
      contextText += `${payload.issue.body}\n\n`;
    }

    const event: BotEvent = {
      type: "mention",
      channel: `${owner}/${repo}`,
      ts: new Date().toISOString(),
      user: payload.sender.id.toString(),
      text: contextText,
    };

    this.enqueueEvent(event, issueNumber);
  }

  private isMentioned(text: string): boolean {
    // Match @username (case-insensitive)
    const pattern = new RegExp(`@${this.botUsername}\\b`, "i");
    return pattern.test(text);
  }

  private extractRepoInfo(payload: IssueCommentPayload): {
    owner: string;
    repo: string;
    issueNumber: number;
  } {
    return {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issueNumber: payload.issue.number,
    };
  }

  // ---- Bot interface ----

  async postMessage(channel: string, text: string): Promise<string> {
    const [owner, repo] = channel.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid channel format: ${channel}`);
    }
    const issueNumber = (this as any)._currentIssueNumber;
    if (!issueNumber) {
      throw new Error("No active issue context");
    }
    const result = await this.api.createIssueComment(owner, repo, issueNumber, text);
    return result.id.toString();
  }

  async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {
    log.logWarning("GitHub: updateMessage not fully supported");
  }

  enqueueEvent(event: BotEvent, issueNumber?: number): boolean {
    const issueNum =
      issueNumber ??
      (() => {
        const match = event.text.match(/#(\d+)/);
        return match ? parseInt(match[1], 10) : null;
      })();

    (this as any)._currentIssueNumber = issueNum;

    const botProxy = {
      postMessage: (channel: string, text: string) => this.postMessage(channel, text),
      updateMessage: (channel: string, ts: string, text: string) =>
        this.updateMessage(channel, ts, text),
      getAPI: () => this.api,
    };
    const adapters = createGitHubAdapters(botProxy, event.channel, issueNum);

    this.handler.handleEvent(event, this, adapters).catch((err) => {
      log.logWarning("Error handling GitHub event", String(err));
    });

    return true;
  }

  getPlatformInfo(): PlatformInfo {
    return this.platformInfo;
  }
}
