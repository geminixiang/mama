export function resolveSlackSessionKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

export function resolveSlackRootTs(messageTs: string, threadTs?: string): string {
  return threadTs || messageTs;
}
