/**
 * Helpers shared across platform adapters.
 *
 * The agent runner is platform-agnostic: it hands strings and structured tool
 * results to each adapter, which decides how to split, format, and route them.
 * The split/normalize logic itself doesn't differ across platforms — only the
 * markup wrappers — so it lives here once.
 */

/**
 * Split `text` into chunks no larger than `limit`, appending a continuation
 * marker (e.g. `_(continued 1)_`) at the end of every part except the last.
 *
 * Each adapter passes its own `formatContinuation` so the marker uses the
 * platform's italic / emphasis convention.
 */
export function splitText(
  text: string,
  limit: number,
  formatContinuation: (partNum: number) => string,
): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  let partNum = 1;
  while (remaining.length > 0) {
    const suffixReserve = formatContinuation(partNum).length + 8;
    const chunkLimit = Math.max(1, limit - suffixReserve);
    const chunk = remaining.slice(0, chunkLimit);
    remaining = remaining.slice(chunkLimit);
    const suffix = remaining.length > 0 ? `\n${formatContinuation(partNum)}` : "";
    parts.push(chunk + suffix);
    partNum++;
  }
  return parts;
}

/**
 * Render tool-call args for human display. Drops `label` (already in the
 * heading) and folds `path` + `offset`/`limit` into a single `path:start-end`
 * line. Pure data normalization with no platform-specific markup.
 */
export function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const lines: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (key === "label" || key === "offset" || key === "limit") continue;

    if (key === "path" && typeof value === "string") {
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      lines.push(
        offset !== undefined && limit !== undefined
          ? `${value}:${offset}-${offset + limit}`
          : value,
      );
      continue;
    }

    lines.push(typeof value === "string" ? value : JSON.stringify(value));
  }

  return lines.join("\n");
}
