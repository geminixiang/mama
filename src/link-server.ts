import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { UserBindingStore } from "./bindings.js";
import type { InMemoryLinkTokenStore } from "./link-token.js";
import * as log from "./log.js";
import { DockerProvisioner } from "./provisioner.js";
import type { VaultManager } from "./vault.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Called after a binding is written, to notify the user in chat */
export type NotifyFn = (platform: string, channelId: string, message: string) => Promise<void>;

interface LinkCompleteBody {
  token: string;
}

// ── startLinkServer ────────────────────────────────────────────────────────────

/**
 * Start a small HTTP server that receives credential onboarding callbacks from the web portal.
 *
 * Routes:
 *   GET  /health              — health check
 *   GET  /link?token=xxx      — placeholder credential onboarding page
 *   POST /api/link/complete   — placeholder completion endpoint
 */
export function startLinkServer(
  port: number,
  linkTokenStore: InMemoryLinkTokenStore,
  _bindingStore: UserBindingStore,
  _vaultManager: VaultManager,
  notify: NotifyFn,
  _provisioner?: DockerProvisioner,
): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Placeholder credential onboarding page.
    if (req.method === "GET" && url.pathname === "/link") {
      const rawToken = url.searchParams.get("token") ?? "";
      const linkToken = linkTokenStore.peek(rawToken);

      if (!linkToken) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderErrorPage(
            "This link is invalid or has expired. Ask the bot for a new /login link.",
          ),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderCredentialPlaceholderPage(rawToken));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/link/complete") {
      let body = "";
      let bodyTooLarge = false;
      req.on("data", (chunk: Buffer) => {
        if (bodyTooLarge) return;
        body += chunk.toString();
        if (body.length > 4096) {
          bodyTooLarge = true;
          res.writeHead(413);
          res.end();
          req.destroy();
        }
      });
      req.on("end", () => {
        if (bodyTooLarge) return;
        handleLinkComplete(body, linkTokenStore, notify, res);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    log.logInfo(`Link callback server listening on port ${port}`);
  });

  server.on("error", (err) => {
    log.logWarning("Link server error", err.message);
  });
}

// ── HTML helpers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function renderCredentialPlaceholderPage(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — mama</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; text-align: center; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    p { color: #555; font-size: 0.95rem; }
    button { margin-top: 24px; padding: 12px 32px; font-size: 1rem; background: #1a1a1a; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
    button:hover { background: #333; }
    button:disabled { background: #999; cursor: default; }
    #result { margin-top: 20px; padding: 12px; border-radius: 6px; display: none; }
    #result.ok { background: #d3f9d8; color: #1a4d2e; }
    #result.err { background: #ffc9c9; color: #5c1a1a; }
  </style>
</head>
<body>
  <h1>Credential Login</h1>
  <p>Your personal sandbox is already provisioned automatically.</p>
  <p>This portal is reserved for storing API keys and OAuth tokens in your vault, but that flow is not implemented in this build yet.</p>
  <button id="btn" onclick="connect()">Acknowledge</button>
  <div id="result"></div>
  <script>
    async function connect() {
      const btn = document.getElementById('btn');
      btn.disabled = true;
      btn.textContent = 'Finishing…';
      const result = document.getElementById('result');
      try {
        const r = await fetch('/api/link/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${esc(token)}' }),
        });
        const data = await r.json();
        result.style.display = 'block';
        if (r.ok) {
          result.className = 'ok';
          result.textContent = data.message ?? 'No credentials were stored. You can close this tab.';
          btn.style.display = 'none';
        } else {
          result.className = 'err';
          result.textContent = 'Error: ' + (data.error ?? r.status);
          btn.disabled = false;
          btn.textContent = 'Acknowledge';
        }
      } catch (err) {
        result.style.display = 'block';
        result.className = 'err';
        result.textContent = 'Network error: ' + err.message;
        btn.disabled = false;
        btn.textContent = 'Acknowledge';
      }
    }
  </script>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Link Error — mama</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1a1a1a}
.box{background:#ffc9c9;color:#5c1a1a;padding:16px;border-radius:8px}</style>
</head><body><div class="box">${esc(message)}</div></body></html>`;
}

// ── handleLinkComplete ─────────────────────────────────────────────────────────

async function handleLinkComplete(
  body: string,
  linkTokenStore: InMemoryLinkTokenStore,
  notify: NotifyFn,
  res: ServerResponse,
): Promise<void> {
  let data: Partial<LinkCompleteBody>;
  try {
    data = JSON.parse(body) as Partial<LinkCompleteBody>;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (!data.token) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required field: token" }));
    return;
  }

  const linkToken = linkTokenStore.consume(data.token);
  if (!linkToken) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid or expired token" }));
    return;
  }

  log.logInfo(
    `Credential login placeholder acknowledged for ${linkToken.platform}/${linkToken.platformUserId}`,
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      message:
        "Credential onboarding is not implemented yet. Your sandbox is already provisioned automatically.",
    }),
  );

  notify(
    linkToken.platform,
    linkToken.channelId,
    "Credential onboarding is not implemented yet. Your personal sandbox is already provisioned automatically.",
  ).catch((err: Error) => {
    log.logWarning("Failed to notify user after login placeholder", err.message);
  });
}
