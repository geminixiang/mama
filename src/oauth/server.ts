import { createServer, type IncomingMessage, type ServerResponse } from "http";
import * as log from "../log.js";

export type OAuthCallbackHandler = (
  code: string,
  state: string,
) => Promise<{ success: boolean; email?: string }>;

export type TokenRequestHandler = (slackUserId: string) => Promise<string | null>;

/**
 * Combined HTTP server that handles:
 * - GET /oauth/callback  — Google OAuth redirect URI
 * - GET /api/token/:userId — Internal token endpoint (localhost only)
 */
export function startOAuthServer(
  port: number,
  onCallback: OAuthCallbackHandler,
  onTokenRequest: TokenRequestHandler,
): () => void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    const url = new URL(req.url, `http://localhost:${port}`);

    // ── OAuth callback ──────────────────────────────────────────────────────
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage("Authorization Failed", `<p style="color:#c62828">${error}</p>`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage("Bad Request", "<p>Missing code or state parameter.</p>"));
        return;
      }

      try {
        const result = await onCallback(code, state);
        if (result.success) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            htmlPage(
              "Authorization Successful",
              `<p style="color:#2e7d32;font-size:1.2em">✓ Authorized as <strong>${result.email ?? "unknown"}</strong></p>
               <p>You can close this tab and return to Slack.</p>`,
            ),
          );
        } else {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(htmlPage("Authorization Failed", "<p>An internal error occurred.</p>"));
        }
      } catch (err) {
        log.logWarning("OAuth callback error", String(err));
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(htmlPage("Internal Server Error", "<p>Please try again.</p>"));
      }
      return;
    }

    // ── Token API (localhost only) ───────────────────────────────────────────
    const tokenMatch = url.pathname.match(/^\/api\/token\/([^/]+)$/);
    if (tokenMatch) {
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const slackUserId = tokenMatch[1];
      const token = await onTokenRequest(slackUserId);
      if (token) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(token);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("no_token");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, "0.0.0.0", () => {
    log.logInfo(`OAuth server listening on port ${port}`);
  });

  return () => server.close();
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>body{font-family:sans-serif;max-width:600px;margin:60px auto;text-align:center}</style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;
}
