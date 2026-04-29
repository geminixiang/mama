import type { ConversationKind } from "../../adapter.js";
import { resolveChatSessionKey } from "../../session-policy.js";

export function resolveSlackSessionKey(channelId: string, threadTs?: string): string {
  const conversationKind: ConversationKind = channelId.startsWith("D") ? "direct" : "shared";
  return resolveChatSessionKey({
    conversationId: channelId,
    conversationKind,
    messageId: channelId,
    threadTs,
    persistentTopLevel: true,
    scopeDirectThreads: true,
  });
}

export function resolveSlackRootTs(messageTs: string, threadTs?: string): string {
  return threadTs || messageTs;
}
