import { createServer } from "node:http";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionInfo {
  sessionKey: string;
  running: boolean;
  stopRequested: boolean;
  lastAccessedAt: number;
  startedAt?: number;
  lastActivityAt?: number;
  currentTool?: string;
}

export interface AdminServerOptions {
  port: number;
  getSessions: () => SessionInfo[];
  forceStop: (sessionKey: string) => void;
}

// ============================================================================
// Dashboard HTML
// ============================================================================

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mama admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --surface2: #22263a;
      --border: #2e3348;
      --text: #e2e8f0;
      --text2: #8892a4;
      --green: #22c55e;
      --orange: #f97316;
      --gray: #64748b;
      --red: #ef4444;
      --blue: #3b82f6;
      --radius: 8px;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace;
      font-size: 13px;
      line-height: 1.5;
      padding: 24px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    header h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: 0.05em;
      color: var(--text);
    }
    header h1 span { color: var(--blue); }
    .meta {
      display: flex;
      align-items: center;
      gap: 16px;
      color: var(--text2);
      font-size: 12px;
    }
    .pulse {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
    }
    .stat-card .label { color: var(--text2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .stat-card.running .value { color: var(--green); }
    .stat-card.idle .value { color: var(--gray); }
    .stat-card.stopping .value { color: var(--orange); }
    .stat-card.total .value { color: var(--text); }
    .table-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .table-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--text2);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      padding: 10px 16px;
      background: var(--surface2);
      color: var(--text2);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 500;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
      max-width: 280px;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--surface2); }
    .session-key {
      font-family: inherit;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .badge::before {
      content: '';
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .badge.running { background: rgba(34,197,94,0.12); color: var(--green); }
    .badge.running::before { background: var(--green); animation: pulse 1.2s infinite; }
    .badge.stopping { background: rgba(249,115,22,0.12); color: var(--orange); }
    .badge.stopping::before { background: var(--orange); }
    .badge.idle { background: rgba(100,116,139,0.12); color: var(--gray); }
    .badge.idle::before { background: var(--gray); }
    .tool-tag {
      background: rgba(59,130,246,0.1);
      color: var(--blue);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
    }
    .muted { color: var(--text2); }
    button.stop-btn {
      background: rgba(239,68,68,0.1);
      color: var(--red);
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s;
    }
    button.stop-btn:hover { background: rgba(239,68,68,0.2); }
    button.stop-btn:disabled { opacity: 0.4; cursor: default; }
    .empty {
      text-align: center;
      padding: 48px 16px;
      color: var(--text2);
    }
    .error-banner {
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      color: var(--red);
      border-radius: var(--radius);
      padding: 10px 16px;
      margin-bottom: 16px;
      display: none;
    }
  </style>
</head>
<body>
  <header>
    <h1><span>mama</span> / admin</h1>
    <div class="meta">
      <div class="pulse" id="pulse"></div>
      <span id="last-updated">—</span>
    </div>
  </header>

  <div class="error-banner" id="error-banner">Connection lost — retrying…</div>

  <div class="stats">
    <div class="stat-card total">
      <div class="label">Total Sessions</div>
      <div class="value" id="stat-total">—</div>
    </div>
    <div class="stat-card running">
      <div class="label">Running</div>
      <div class="value" id="stat-running">—</div>
    </div>
    <div class="stat-card stopping">
      <div class="label">Stopping</div>
      <div class="value" id="stat-stopping">—</div>
    </div>
    <div class="stat-card idle">
      <div class="label">Idle</div>
      <div class="value" id="stat-idle">—</div>
    </div>
  </div>

  <div class="table-wrap">
    <div class="table-header">Sessions</div>
    <table>
      <thead>
        <tr>
          <th>Session Key</th>
          <th>Status</th>
          <th>Current Tool</th>
          <th>Duration</th>
          <th>Last Activity</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="sessions-body">
        <tr><td colspan="6" class="empty">Loading…</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    const NOW_INTERVAL = 500; // render "now" updates
    let sessions = [];
    let renderTimer = null;

    function fmtDuration(ms) {
      if (ms < 0) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60) + 's';
      const h = Math.floor(m / 60);
      return h + 'h ' + (m % 60) + 'm';
    }

    function fmtAgo(ts) {
      if (!ts) return '—';
      return fmtDuration(Date.now() - ts) + ' ago';
    }

    function statusBadge(s) {
      if (s.stopRequested) return '<span class="badge stopping">stopping</span>';
      if (s.running) return '<span class="badge running">running</span>';
      return '<span class="badge idle">idle</span>';
    }

    function esc(str) {
      return String(str)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
    }

    function render() {
      const now = Date.now();
      const running = sessions.filter(s => s.running && !s.stopRequested).length;
      const stopping = sessions.filter(s => s.stopRequested).length;
      const idle = sessions.filter(s => !s.running).length;

      document.getElementById('stat-total').textContent = sessions.length;
      document.getElementById('stat-running').textContent = running;
      document.getElementById('stat-stopping').textContent = stopping;
      document.getElementById('stat-idle').textContent = idle;

      const tbody = document.getElementById('sessions-body');
      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">No sessions cached</td></tr>';
        return;
      }

      // Sort: running first, then by lastAccessedAt desc
      const sorted = [...sessions].sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        return b.lastAccessedAt - a.lastAccessedAt;
      });

      tbody.innerHTML = sorted.map(s => {
        const duration = s.startedAt ? fmtDuration(now - s.startedAt) : '—';
        const lastAct = fmtAgo(s.lastActivityAt || (s.running ? s.startedAt : s.lastAccessedAt));
        const tool = s.currentTool
          ? '<span class="tool-tag">' + esc(s.currentTool) + '</span>'
          : '<span class="muted">—</span>';
        const stopBtn = s.running
          ? '<button class="stop-btn" onclick="forceStop(' + JSON.stringify(s.sessionKey) + ', this)" ' +
            (s.stopRequested ? 'disabled' : '') + '>Stop</button>'
          : '<span class="muted">—</span>';
        return '<tr>' +
          '<td><span class="session-key" title="' + esc(s.sessionKey) + '">' + esc(s.sessionKey) + '</span></td>' +
          '<td>' + statusBadge(s) + '</td>' +
          '<td>' + tool + '</td>' +
          '<td class="muted">' + duration + '</td>' +
          '<td class="muted">' + lastAct + '</td>' +
          '<td>' + stopBtn + '</td>' +
          '</tr>';
      }).join('');
    }

    async function forceStop(sessionKey, btn) {
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await fetch('/api/sessions/' + encodeURIComponent(sessionKey) + '/stop', { method: 'POST' });
      } catch(e) {
        btn.disabled = false;
        btn.textContent = 'Stop';
      }
    }

    async function fetchSessions() {
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        sessions = await res.json();
        document.getElementById('error-banner').style.display = 'none';
        document.getElementById('pulse').style.background = 'var(--green)';
        document.getElementById('last-updated').textContent =
          'Updated ' + new Date().toLocaleTimeString();
        render();
      } catch(e) {
        document.getElementById('error-banner').style.display = 'block';
        document.getElementById('pulse').style.background = 'var(--red)';
      }
    }

    // Fetch data every 2s, re-render every 0.5s for live durations
    fetchSessions();
    setInterval(fetchSessions, 2000);
    setInterval(render, NOW_INTERVAL);
  </script>
</body>
</html>`;

// ============================================================================
// Server
// ============================================================================

export function startAdminServer(opts: AdminServerOptions): void {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (method === "GET" && url === "/api/sessions") {
      const sessions = opts.getSessions();
      const body = JSON.stringify(sessions);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // POST /api/sessions/:key/stop
    const stopMatch = url.match(/^\/api\/sessions\/(.+)\/stop$/);
    if (method === "POST" && stopMatch) {
      const sessionKey = decodeURIComponent(stopMatch[1]);
      opts.forceStop(sessionKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.on("error", (err) => {
    log.logWarning("Admin server error", err.message);
  });

  server.listen(opts.port, "127.0.0.1", () => {
    log.logInfo(`Admin dashboard: http://localhost:${opts.port}`);
  });
}
