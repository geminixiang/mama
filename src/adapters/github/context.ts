import type { ChatMessage, ChatResponseContext, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";

/**
 * Create GitHub-specific adapters for responding to issues/PRs.
 * All responses are collected into a single GitHub comment.
 */
export function createGitHubAdapters(
  bot: {
    postMessage(channel: string, text: string): Promise<string>;
    updateMessage(channel: string, ts: string, text: string): Promise<void>;
    getAPI(): {
      createIssueComment(
        owner: string,
        repo: string,
        issueNumber: number,
        body: string,
      ): Promise<{
        id: string;
        html_url: string;
      }>;
      updateIssueComment(
        owner: string,
        repo: string,
        commentId: string,
        body: string,
      ): Promise<void>;
    };
  },
  channel: string,
  issueNumber: number | null,
): {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
} {
  const [owner, repo] = channel.split("/");
  const validIssueNumber = issueNumber;

  // Single comment tracking
  let commentId: string | null = null;
  let commentBody = "";

  async function upsertComment(body: string): Promise<void> {
    if (!validIssueNumber) {
      log.logWarning("GitHub: No issue number available for response");
      return;
    }

    try {
      if (commentId) {
        // Update existing comment
        await bot.getAPI().updateIssueComment(owner, repo, commentId, body);
      } else {
        // Create new comment
        const result = await bot.getAPI().createIssueComment(owner, repo, validIssueNumber, body);
        commentId = result.id.toString();
      }
      log.logInfo(`GitHub: Comment ${commentId} on ${channel}#${validIssueNumber}`);
    } catch (e) {
      log.logWarning("GitHub: Failed to upsert comment", String(e));
    }
  }

  // Create response context
  const responseCtx: ChatResponseContext = {
    async respond(text: string): Promise<void> {
      commentBody = text;
      await upsertComment(commentBody);
    },

    async replaceResponse(text: string): Promise<void> {
      commentBody = text;
      await upsertComment(commentBody);
    },

    async respondInThread(text: string, _options?: { style?: "muted" }): Promise<void> {
      // Append to the same comment
      commentBody += (commentBody ? "\n\n---\n\n" : "") + text;
      await upsertComment(commentBody);
    },

    async setTyping(_isTyping: boolean): Promise<void> {
      // GitHub doesn't support typing indicator
    },

    async setWorking(_working: boolean): Promise<void> {
      // Could add a reaction to show working status
    },

    async uploadFile(_filePath: string, _title?: string): Promise<void> {
      log.logWarning("GitHub: File upload not yet implemented");
    },

    async deleteResponse(): Promise<void> {
      log.logWarning("GitHub: Delete message not yet implemented");
    },
  };

  // Create message object
  const message: ChatMessage = {
    id: Date.now().toString(),
    sessionKey: channel,
    userId: "",
    text: "",
  };

  // Create platform info
  const platform: PlatformInfo = {
    name: "github",
    formattingGuide: "GitHub uses Markdown formatting",
    channels: [{ id: channel, name: channel }],
    users: [],
  };

  return {
    message,
    responseCtx,
    platform,
  };
}
