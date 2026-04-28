import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import { loadSessionViewModel, type SessionViewItem } from "./service.js";
import type { InMemorySessionViewTokenStore } from "./store.js";

export async function handleSessionViewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionViewTokenStore?: InMemorySessionViewTokenStore,
): Promise<boolean> {
  if (req.method !== "GET" || url.pathname !== "/session") {
    return false;
  }

  const token = url.searchParams.get("token")?.trim();
  if (!token || !sessionViewTokenStore) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderStatusPage("Session unavailable", "This session link is invalid or has expired."),
    );
    return true;
  }

  const entry = sessionViewTokenStore.peek(token);
  if (!entry) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderStatusPage("Session unavailable", "This session link is invalid or has expired."),
    );
    return true;
  }

  try {
    const model = loadSessionViewModel(entry.sessionFile);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderSessionPage(model, entry.expiresAt));
  } catch (error) {
    log.logWarning(
      `[${entry.conversationId}] Failed to render session ${entry.sessionFile}`,
      error instanceof Error ? error.message : String(error),
    );
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderStatusPage("Session unavailable", "The session could not be loaded right now."));
  }

  return true;
}

function renderSessionPage(
  model: {
    title: string;
    sessionId: string;
    createdAt: string;
    updatedAt: string;
    entryCount: number;
    items: SessionViewItem[];
  },
  expiresAt: number,
): string {
  const items =
    model.items.length > 0
      ? model.items.map((item) => renderItem(item)).join("\n")
      : `<div class="system-event"><span class="event-dot"></span><span class="event-text">No messages yet — send one to the bot, then refresh.</span></div>`;

  return renderHtmlDocument(
    `${model.title} · Session Viewer`,
    `<header class="hero-card">
      <div class="hero-top">
        <div class="hero-title-group">
          <span class="hero-wordmark">mama</span>
          <h1 class="hero-title">${esc(model.title)}</h1>
        </div>
        <button class="refresh-btn" onclick="window.location.reload()">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12.5 2.5A6 6 0 1 0 13 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M10 2.5h2.5V5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Refresh
        </button>
      </div>
      <div class="stat-row">
        ${renderSummaryItem("ID", model.sessionId.slice(0, 8))}
        ${renderSummaryItem("Created", formatDate(model.createdAt))}
        ${renderSummaryItem("Updated", formatDate(model.updatedAt))}
        ${renderSummaryItem("Entries", String(model.entryCount))}
        ${renderSummaryItem("Expires", formatDate(new Date(expiresAt).toISOString()))}
      </div>
    </header>

    <main class="timeline-shell">
      <div class="timeline-list">
        ${items}
      </div>
    </main>`,
  );
}

function renderSummaryItem(label: string, value: string): string {
  return `<span class="stat-chip"><span class="stat-label">${esc(label)}</span><strong class="stat-value">${esc(value)}</strong></span>`;
}

function parseUserBody(raw: string): { username: string | null; content: string } {
  // [timestamp] [username]: content
  let m = raw.match(/^\[[^\]]+\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (m) return { username: m[1], content: m[2] };
  // [username]: content
  m = raw.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (m) return { username: m[1], content: m[2] };
  return { username: null, content: raw };
}

function renderItem(item: SessionViewItem): string {
  if (item.kind === "system") {
    const parts = [item.title, item.body].filter((x): x is string => Boolean(x)).map(esc);
    const time = item.meta
      ? ` · <time class="event-time">${esc(formatDate(item.meta))}</time>`
      : "";
    return `<div class="system-event"><span class="event-dot"></span><span class="event-text">${parts.join(" — ")}</span>${time}</div>`;
  }

  if (item.kind === "tool") {
    const toneClass = item.tone === "err" ? " tone-err" : item.tone === "ok" ? " tone-ok" : "";
    const body = item.body ? `<pre class="tool-output${toneClass}">${esc(item.body)}</pre>` : "";
    const time = item.meta ? `<time class="tool-time">${esc(formatDate(item.meta))}</time>` : "";
    return `<div class="tool-block">
  <div class="tool-header">
    <span class="tool-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 2L5 5.5 1.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 9h2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
    <span class="tool-name">${esc(item.title)}</span>
    ${time}
  </div>
  ${body}
</div>`;
  }

  const time = item.meta ? `<time class="msg-time">${esc(formatDate(item.meta))}</time>` : "";

  if (item.kind === "user") {
    const { username, content } = item.body
      ? parseUserBody(item.body)
      : { username: null, content: "" };
    const initial = username ? esc(username.slice(0, 2).toUpperCase()) : "U";
    const body = content ? `<pre class="msg-body">${esc(content)}</pre>` : "";
    return `<div class="msg-row msg-user">
  <div class="user-bubble">
    ${body}
    ${time}
  </div>
  <div class="msg-avatar user-avatar" title="${username ? esc(username) : "User"}">${initial}</div>
</div>`;
  }

  // assistant
  const body = item.body ? `<pre class="msg-body">${esc(item.body)}</pre>` : "";
  return `<div class="msg-row msg-assistant">
  <div class="msg-avatar asst-avatar" aria-hidden="true">A</div>
  <div class="asst-card">
    ${body}
    ${time}
  </div>
</div>`;
}

function renderStatusPage(title: string, message: string): string {
  return renderHtmlDocument(
    title,
    `<section class="card stack">
      <p class="eyebrow">mama</p>
      <h1>${esc(title)}</h1>
      <div class="status err">${esc(message)}</div>
    </section>`,
  );
}

function renderHtmlDocument(title: string, shellContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${styles}</style>
</head>
<body>
  <main class="shell">
    ${shellContent}
  </main>
</body>
</html>`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;600&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

  :root {
    --bg: #f0ece3;
    --surface: #ffffff;
    --border: rgba(0, 0, 0, 0.08);
    --text: #18181b;
    --muted: #71717a;
    --subtle: #a1a1aa;

    --user-bg: #18181b;
    --user-text: #fafafa;
    --user-time: rgba(250, 250, 250, 0.5);

    --asst-border: #22c55e;
    --asst-avatar-bg: #f0fdf4;
    --asst-avatar-text: #16a34a;

    --tool-bg: #0d1117;
    --tool-header: #161b22;
    --tool-text: #c9d1d9;
    --tool-accent: #58a6ff;
    --tool-ok: #3fb950;
    --tool-err: #f85149;
    --tool-time: #484f58;

    --ok-bg: #f0fdf4;
    --ok-text: #15803d;
    --err-bg: #fef2f2;
    --err-text: #b91c1c;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    min-height: 100vh;
    padding: 40px 20px 80px;
    display: flex;
    flex-direction: column;
    align-items: center;
    background-color: var(--bg);
    background-image:
      radial-gradient(ellipse 80% 40% at 50% -10%, rgba(255,255,255,0.6) 0%, transparent 70%);
    color: var(--text);
    font-family: 'DM Sans', 'Segoe UI', system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  .shell {
    width: 100%;
    max-width: 780px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* ── Hero ─────────────────────────────────────────────────────────────── */

  .hero-card {
    padding: 28px 32px 24px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06);
  }

  .hero-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }

  .hero-wordmark {
    display: block;
    margin-bottom: 6px;
    color: var(--subtle);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .hero-title {
    font-family: 'Lora', Georgia, serif;
    font-size: clamp(1.4rem, 2.5vw, 1.75rem);
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
    color: var(--text);
    text-wrap: balance;
  }

  .refresh-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 7px 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    font: 500 0.8rem/1 'DM Sans', sans-serif;
    cursor: pointer;
    transition: color 120ms, border-color 120ms, background 120ms;
    white-space: nowrap;
  }

  .refresh-btn:hover {
    color: var(--text);
    border-color: rgba(0,0,0,0.2);
    background: rgba(0,0,0,0.03);
  }

  .refresh-btn:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 2px;
  }

  .stat-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .stat-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: #f4f4f5;
    font-size: 0.775rem;
    line-height: 1;
  }

  .stat-label {
    color: var(--muted);
    font-weight: 500;
  }

  .stat-value {
    color: var(--text);
    font-weight: 600;
  }

  /* ── Timeline shell ───────────────────────────────────────────────────── */

  .timeline-shell {
    padding: 20px 0;
  }

  .timeline-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* ── Message rows ─────────────────────────────────────────────────────── */

  .msg-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 2px 0;
  }

  /* ── User messages ────────────────────────────────────────────────────── */

  .msg-user {
    justify-content: flex-end;
  }

  .user-bubble {
    max-width: 85%;
    padding: 12px 16px;
    border-radius: 18px 18px 4px 18px;
    background: var(--user-bg);
    color: var(--user-text);
    box-shadow: 0 1px 2px rgba(0,0,0,0.12);
  }

  .msg-user .msg-body {
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 0.9rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--user-text);
  }

  .msg-user .msg-time {
    display: block;
    margin-top: 6px;
    font-size: 0.72rem;
    color: var(--user-time);
    text-align: right;
  }

  /* ── Avatars ──────────────────────────────────────────────────────────── */

  .msg-avatar {
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-size: 0.68rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0;
    flex-shrink: 0;
  }

  .user-avatar {
    background: #eff6ff;
    border: 1.5px solid #93c5fd;
    color: #1d4ed8;
  }

  .asst-avatar {
    background: var(--asst-avatar-bg);
    border: 1.5px solid var(--asst-border);
    color: var(--asst-avatar-text);
    margin-bottom: 2px;
  }

  /* ── Assistant messages ───────────────────────────────────────────────── */

  .msg-assistant {
    align-items: flex-end;
    gap: 8px;
    max-width: 85%;
  }

  .asst-card {
    min-width: 0;
    padding: 14px 18px;
    border: 1px solid var(--border);
    border-radius: 18px 18px 18px 4px;
    background: var(--surface);
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }

  .msg-assistant .msg-body {
    font-family: 'DM Sans', system-ui, sans-serif;
    font-size: 0.9rem;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
  }

  .msg-assistant .msg-time {
    display: block;
    margin-top: 8px;
    font-size: 0.72rem;
    color: var(--subtle);
  }

  /* ── Tool blocks ──────────────────────────────────────────────────────── */

  .tool-block {
    max-width: 92%;
    margin-left: 36px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.06);
    box-shadow: 0 2px 8px rgba(0,0,0,0.16);
    margin: 6px 0;
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--tool-header);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    overflow: hidden;
  }

  .tool-icon {
    color: var(--tool-accent);
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .tool-name {
    flex: 1;
    font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--tool-accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tool-time {
    flex-shrink: 0;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--tool-time);
  }

  .tool-output {
    display: block;
    padding: 12px 14px;
    background: var(--tool-bg);
    color: var(--tool-text);
    font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    font-size: 0.78rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
    max-height: 400px;
    overflow-y: auto;
  }

  .tool-output.tone-ok { color: var(--tool-ok); }
  .tool-output.tone-err { color: var(--tool-err); }

  /* ── System events ────────────────────────────────────────────────────── */

  .system-event {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 0;
    color: var(--subtle);
    font-size: 0.775rem;
  }

  .event-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--subtle);
    flex-shrink: 0;
    opacity: 0.6;
  }

  .event-text {
    color: var(--muted);
  }

  .event-time {
    color: var(--subtle);
    font-style: normal;
  }

  /* ── Status page ──────────────────────────────────────────────────────── */

  .card {
    padding: 28px 32px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.06);
  }

  .stack > * + * { margin-top: 14px; }

  .eyebrow {
    color: var(--subtle);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h1 {
    font-family: 'Lora', Georgia, serif;
    font-size: clamp(1.4rem, 2.5vw, 1.75rem);
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }

  p { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }

  .status {
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 0.9rem;
  }

  .status.err {
    background: var(--err-bg);
    color: var(--err-text);
    border: 1px solid rgba(185, 28, 28, 0.12);
  }

  /* ── Responsive ───────────────────────────────────────────────────────── */

  @media (max-width: 600px) {
    body { padding: 20px 12px 60px; }

    .hero-card, .card { padding: 20px; border-radius: 16px; }

    .hero-top { flex-direction: column; gap: 12px; }

    .refresh-btn { align-self: flex-start; }

    .user-bubble { max-width: 88%; }

    .asst-avatar { display: none; }

    .asst-card { border-radius: 4px 14px 14px 14px; }
  }
`;
