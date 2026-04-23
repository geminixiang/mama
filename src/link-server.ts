import { createHash, randomBytes } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { resolveLinkBaseUrl } from "./config.js";
import type { InMemoryLinkTokenStore } from "./link-token.js";
import {
  getOAuthServices,
  resolveOAuthService,
  type LoginCredentialKind,
  type OAuthService,
} from "./login.js";
import * as log from "./log.js";
import { defaultVaultTargetPath, type VaultManager } from "./vault.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Called after a binding is written, to notify the user in chat */
export type NotifyFn = (platform: string, channelId: string, message: string) => Promise<void>;

interface LinkCompleteBody {
  token: string;
  mode?: LoginCredentialKind;
  envKey?: string;
  credential?: string;
}

interface OAuthStartBody {
  token: string;
  serviceId: string;
}

interface PendingOAuthState {
  linkToken: string;
  serviceId: string;
  codeVerifier: string;
  expiresAt: number;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// ── startLinkServer ────────────────────────────────────────────────────────────

/**
 * Start a small HTTP server that receives credential onboarding callbacks from the web portal.
 *
 * Routes:
 *   GET  /health              — health check
 *   GET  /link?token=xxx      — credential onboarding page
 *   POST /api/link/complete   — API key completion endpoint
 *   POST /api/oauth/start     — creates provider OAuth redirect URL
 *   GET  /oauth/callback      — OAuth callback endpoint
 */
export function startLinkServer(
  port: number,
  linkTokenStore: InMemoryLinkTokenStore,
  vaultManager: VaultManager,
  notify: NotifyFn,
): void {
  const oauthStates = new Map<string, PendingOAuthState>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", requestBaseUrl(req));

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

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

      const oauthServiceHint = linkToken.providerId
        ? resolveOAuthService(linkToken.providerId)
        : undefined;
      const oauthServices = getOAuthServices();
      const defaultMode: LoginCredentialKind = oauthServiceHint ? "oauth" : "api_key";

      const title = oauthServiceHint ? `${oauthServiceHint.label} OAuth` : "Store Secret";
      const helpText = oauthServiceHint
        ? `Authorize ${oauthServiceHint.label} and store tokens in your personal vault.`
        : "Set any environment variable key/value pair in your personal vault.";
      const secretLabel = "Secret value";
      const placeholder = "sk-...";
      const initialEnvKey = "";

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderCredentialPage(
          rawToken,
          title,
          defaultMode,
          initialEnvKey,
          secretLabel,
          placeholder,
          helpText,
          oauthServices,
          oauthServiceHint?.id,
        ),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/link/complete") {
      void readJsonBody(req, res, async (body) => {
        await handleLinkComplete(body, linkTokenStore, vaultManager, notify, res);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/oauth/start") {
      void readJsonBody(req, res, async (body) => {
        await handleOAuthStart(body, req, linkTokenStore, oauthStates, res);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      void handleOAuthCallback(
        url,
        req,
        linkTokenStore,
        vaultManager,
        notify,
        oauthStates,
        res,
      ).catch((err: Error) => {
        log.logWarning("OAuth callback failed", err.message);
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderErrorPage("OAuth callback failed. Please retry /login."));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    log.logInfo(`Link callback server listening on port ${port}`);
    if (!resolveLinkBaseUrl()) {
      log.logWarning(
        "MOM_LINK_URL is not set. OAuth redirect_uri will be derived from " +
          "request headers (Host / X-Forwarded-*), which is insecure in production. " +
          "Set MOM_LINK_URL=https://your-host.example.com",
      );
    }
  });

  server.on("error", (err) => {
    log.logWarning("Link server error", err.message);
  });
}

/**
 * Resolve the externally-visible base URL of this server.
 *
 * Prefers MOM_LINK_URL (see config.ts) so the OAuth `redirect_uri` is
 * deterministic and not influenced by attacker-controlled request headers.
 * Falls back to Host / X-Forwarded-* only when no base URL is configured
 * — intended for local development.
 */
function requestBaseUrl(req: IncomingMessage): string {
  const configured = resolveLinkBaseUrl();
  if (configured) return configured;

  const protoRaw = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const proto = protoRaw || "http";
  const host =
    ((req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ??
      req.headers.host ??
      `localhost`) ||
    `localhost`;
  return `${proto}://${host}`;
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  onBody: (body: string) => Promise<void>,
): Promise<void> {
  let body = "";
  let bodyTooLarge = false;

  req.on("data", (chunk: Buffer) => {
    if (bodyTooLarge) return;
    body += chunk.toString();
    if (body.length > 16 * 1024) {
      bodyTooLarge = true;
      res.writeHead(413);
      res.end();
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (bodyTooLarge) return;
    await onBody(body);
  });
}

// ── HTML helpers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function renderCredentialPage(
  token: string,
  title: string,
  defaultMode: LoginCredentialKind,
  initialEnvKey: string,
  secretLabel: string,
  placeholder: string,
  helpText: string,
  oauthServices: OAuthService[],
  oauthServiceIdHint?: string,
): string {
  const oauthOptions = oauthServices
    .map((service) => {
      const selected = service.id === oauthServiceIdHint ? ' selected="selected"' : "";
      return `<option value="${esc(service.id)}"${selected}>${esc(service.label)}</option>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login — mama</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; text-align: center; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    p { color: #555; font-size: 0.95rem; }
    label { display: block; margin-top: 20px; margin-bottom: 6px; text-align: left; font-weight: 600; font-size: 0.9rem; }
    input, select { width: 100%; box-sizing: border-box; padding: 12px; font-size: 1rem; border: 1px solid #ccc; border-radius: 8px; }
    button { margin-top: 24px; padding: 12px 32px; font-size: 1rem; background: #1a1a1a; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
    button:hover { background: #333; }
    button:disabled { background: #999; cursor: default; }
    #result { margin-top: 20px; padding: 12px; border-radius: 6px; display: none; }
    #result.ok { background: #d3f9d8; color: #1a4d2e; }
    #result.err { background: #ffc9c9; color: #5c1a1a; }
    .mode { margin-top: 20px; text-align: left; }
    .mode label { display: inline-flex; align-items: center; margin-right: 18px; font-weight: 500; }
    .mode input { width: auto; margin-right: 6px; }
    .panel { display: none; }
    .panel.active { display: block; }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p>Your personal sandbox is already provisioned automatically.</p>
  <p>${esc(helpText)}</p>
  <div class="mode">
    <label><input type="radio" name="mode" value="api_key" ${defaultMode === "api_key" ? "checked" : ""}> API key</label>
    <label><input type="radio" name="mode" value="oauth" ${defaultMode === "oauth" ? "checked" : ""}> OAuth login</label>
  </div>

  <div id="api-panel" class="panel">
    <label for="envKey">Environment key</label>
    <input id="envKey" type="text" placeholder="OPENAI_API_KEY" value="${esc(initialEnvKey)}" autocomplete="off">
    <label for="credential">${esc(secretLabel)}</label>
    <input id="credential" type="password" placeholder="${esc(placeholder)}" autocomplete="off">
  </div>

  <div id="oauth-panel" class="panel">
    <label for="oauthService">OAuth service</label>
    <select id="oauthService">${oauthOptions}</select>
    <p style="text-align:left;margin-top:10px">You'll be redirected to the selected service's authorization page.</p>
  </div>

  <button id="btn" onclick="connect()">Continue</button>
  <div id="result"></div>
  <script>
    const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

    function selectedMode() {
      return document.querySelector('input[name="mode"]:checked').value;
    }

    function showResult(message, ok) {
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.className = ok ? 'ok' : 'err';
      result.textContent = message;
    }

    function syncPanels() {
      const api = document.getElementById('api-panel');
      const oauth = document.getElementById('oauth-panel');
      const mode = selectedMode();
      api.className = mode === 'api_key' ? 'panel active' : 'panel';
      oauth.className = mode === 'oauth' ? 'panel active' : 'panel';
    }

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener('change', syncPanels);
    }

    syncPanels();

    async function connect() {
      const btn = document.getElementById('btn');
      const mode = selectedMode();
      btn.disabled = true;
      btn.textContent = mode === 'oauth' ? 'Redirecting…' : 'Saving…';

      try {
        if (mode === 'oauth') {
          const serviceId = document.getElementById('oauthService').value;
          const r = await fetch('/api/oauth/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: '${esc(token)}', serviceId }),
          });
          const data = await r.json();
          if (!r.ok) {
            showResult('Error: ' + (data.error ?? r.status), false);
            btn.disabled = false;
            btn.textContent = 'Continue';
            return;
          }
          window.location.href = data.redirectUrl;
          return;
        }

        const envKey = document.getElementById('envKey').value.trim();
        const credential = document.getElementById('credential').value.trim();
        if (!envKeyPattern.test(envKey)) {
          showResult('Please enter a valid environment key.', false);
          btn.disabled = false;
          btn.textContent = 'Continue';
          return;
        }
        if (!credential) {
          showResult('Please enter a value.', false);
          btn.disabled = false;
          btn.textContent = 'Continue';
          return;
        }

        const r = await fetch('/api/link/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${esc(token)}', mode: 'api_key', envKey, credential }),
        });
        const data = await r.json();
        if (r.ok) {
          showResult(data.message ?? 'Credential stored. You can close this tab.', true);
          btn.style.display = 'none';
          for (const input of document.querySelectorAll('input,select')) input.disabled = true;
        } else {
          showResult('Error: ' + (data.error ?? r.status), false);
          btn.disabled = false;
          btn.textContent = 'Continue';
        }
      } catch (err) {
        showResult('Network error: ' + err.message, false);
        btn.disabled = false;
        btn.textContent = 'Continue';
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

function renderSuccessPage(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Linked — mama</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1a1a1a}
.box{background:#d3f9d8;color:#1a4d2e;padding:16px;border-radius:8px}</style>
</head><body><div class="box">${esc(message)} You can close this tab.</div></body></html>`;
}

// ── API-key completion ────────────────────────────────────────────────────────

async function handleLinkComplete(
  body: string,
  linkTokenStore: InMemoryLinkTokenStore,
  vaultManager: VaultManager,
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

  const envKey = data.envKey?.trim() ?? "";
  const credential = data.credential?.trim() ?? "";

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid envKey format" }));
    return;
  }

  if (!credential) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required field: credential" }));
    return;
  }

  // Atomic consume prevents two concurrent requests from both passing the
  // validity check before either deletes the token.
  const linkToken = linkTokenStore.consume(data.token);
  if (!linkToken) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid or expired token" }));
    return;
  }

  vaultManager.upsertEnv(linkToken.vaultId, { [envKey]: credential });

  log.logInfo(
    `Stored ${envKey} for ${linkToken.platform}/${linkToken.platformUserId} in vault:${linkToken.vaultId}`,
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: `${envKey} stored successfully in your vault.` }));

  notify(
    linkToken.platform,
    linkToken.channelId,
    `${envKey} stored successfully in vault \`${linkToken.vaultId}\`.`,
  ).catch((err: Error) => {
    log.logWarning("Failed to notify user after credential login", err.message);
  });
}

// ── OAuth flow ────────────────────────────────────────────────────────────────

async function handleOAuthStart(
  body: string,
  req: IncomingMessage,
  linkTokenStore: InMemoryLinkTokenStore,
  oauthStates: Map<string, PendingOAuthState>,
  res: ServerResponse,
): Promise<void> {
  let data: Partial<OAuthStartBody>;
  try {
    data = JSON.parse(body) as Partial<OAuthStartBody>;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (!data.token || !data.serviceId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required fields: token/serviceId" }));
    return;
  }

  const linkToken = linkTokenStore.peek(data.token);
  if (!linkToken) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid or expired token" }));
    return;
  }

  const service = resolveOAuthService(data.serviceId);
  if (!service) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Unsupported OAuth service: ${data.serviceId}` }));
    return;
  }

  const clientId = process.env[service.clientIdEnvKey];
  const clientSecret = process.env[service.clientSecretEnvKey];
  if (!clientId || !clientSecret) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          `OAuth service ${service.label} is not configured. ` +
          `Missing ${service.clientIdEnvKey}/${service.clientSecretEnvKey}.`,
      }),
    );
    return;
  }

  const state = randomBytes(16).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  oauthStates.set(state, {
    linkToken: data.token,
    serviceId: service.id,
    codeVerifier,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  });

  for (const [k, v] of oauthStates) {
    if (Date.now() > v.expiresAt) oauthStates.delete(k);
  }

  const redirectUri = `${requestBaseUrl(req)}/oauth/callback`;
  const authorizeUrl = new URL(service.authorizationUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  if (service.scopes.length > 0) {
    authorizeUrl.searchParams.set("scope", service.scopes.join(" "));
  }
  for (const [key, value] of Object.entries(service.authorizationParams ?? {})) {
    authorizeUrl.searchParams.set(key, value);
  }

  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, redirectUrl: authorizeUrl.toString() }));
}

async function handleOAuthCallback(
  url: URL,
  req: IncomingMessage,
  linkTokenStore: InMemoryLinkTokenStore,
  vaultManager: VaultManager,
  notify: NotifyFn,
  oauthStates: Map<string, PendingOAuthState>,
  res: ServerResponse,
): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const error = url.searchParams.get("error");

  // Atomic pop: whatever path we take from here, this state is spent.
  // Done before any `await` to close the TOCTOU window between the state
  // lookup and the final delete.
  const pending = oauthStates.get(state);
  if (pending) oauthStates.delete(state);

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage(`OAuth authorization failed: ${error}`));
    return;
  }

  if (!pending || Date.now() > pending.expiresAt) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("OAuth state is invalid or expired. Please run /login again."));
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("Missing OAuth authorization code."));
    return;
  }

  const service = resolveOAuthService(pending.serviceId);
  if (!service) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("Unsupported OAuth service."));
    return;
  }

  const clientId = process.env[service.clientIdEnvKey];
  const clientSecret = process.env[service.clientSecretEnvKey];
  if (!clientId || !clientSecret) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("OAuth service is not configured on server."));
    return;
  }

  // Atomic consume: pairs with the callback being one-shot. Two concurrent
  // callbacks for the same state would previously both pass `peek` and both
  // run `exchangeOAuthCode` across the await; only one reaches `consume`.
  const linkToken = linkTokenStore.consume(pending.linkToken);
  if (!linkToken) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("Login link is invalid or expired. Please run /login again."));
    return;
  }

  const redirectUri = `${requestBaseUrl(req)}/oauth/callback`;
  const tokenResp = await exchangeOAuthCode(
    service,
    code,
    clientId,
    clientSecret,
    redirectUri,
    pending.codeVerifier,
  );

  const accessToken = tokenResp.access_token?.trim();
  const refreshToken = tokenResp.refresh_token?.trim();

  if (!accessToken) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderErrorPage("OAuth token exchange did not return an access_token."));
    return;
  }

  const updates: Record<string, string> = {};
  if (service.accessTokenEnvKey) {
    updates[service.accessTokenEnvKey] = accessToken;
  }
  for (const key of service.additionalAccessTokenEnvKeys ?? []) {
    updates[key] = accessToken;
  }
  if (refreshToken && service.refreshTokenEnvKey) {
    updates[service.refreshTokenEnvKey] = refreshToken;
  }

  const fileOutput = service.fileOutput;
  let mountedPath: string | undefined;
  if (fileOutput?.type === "authorized_user") {
    if (!refreshToken) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderErrorPage(
          "OAuth token exchange did not return a refresh_token. " +
            "Retry after revoking prior consent or ensure prompt=consent is applied.",
        ),
      );
      return;
    }

    mountedPath = fileOutput.targetPath ?? defaultVaultTargetPath(fileOutput.relativePath);
    if (fileOutput.envKey) {
      updates[fileOutput.envKey] = mountedPath;
    }
  }

  const storedTargets: string[] = [];
  if (Object.keys(updates).length > 0) {
    vaultManager.upsertEnv(linkToken.vaultId, updates);
    storedTargets.push(...Object.keys(updates).sort());
  }
  if (fileOutput?.type === "authorized_user" && refreshToken) {
    vaultManager.upsertFile(
      linkToken.vaultId,
      fileOutput.relativePath,
      renderAuthorizedUserCredential(clientId, clientSecret, refreshToken),
      fileOutput.targetPath,
    );
    if (mountedPath) storedTargets.push(mountedPath);
  }

  log.logInfo(
    `Stored [${storedTargets.join(", ")}] for ${linkToken.platform}/${linkToken.platformUserId} in vault:${linkToken.vaultId}`,
  );

  notify(
    linkToken.platform,
    linkToken.channelId,
    `${service.label} OAuth stored (${storedTargets.join(", ")}) in vault \`${linkToken.vaultId}\`.`,
  ).catch((err: Error) => {
    log.logWarning("Failed to notify user after OAuth login", err.message);
  });

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderSuccessPage(`${service.label} OAuth connected successfully.`));
}

async function exchangeOAuthCode(
  service: OAuthService,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<Record<string, string>> {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", code);
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);
  params.set("redirect_uri", redirectUri);
  params.set("code_verifier", codeVerifier);

  const response = await fetch(service.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let parsed: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    parsed = JSON.parse(text) as Record<string, string>;
  } else {
    const form = new URLSearchParams(text);
    parsed = Object.fromEntries(form.entries());
  }

  if (!response.ok) {
    const message = parsed.error_description ?? parsed.error ?? `${response.status}`;
    throw new Error(`OAuth token exchange failed for ${service.id}: ${message}`);
  }

  return parsed;
}

function renderAuthorizedUserCredential(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): string {
  return (
    JSON.stringify(
      {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        type: "authorized_user",
      },
      null,
      2,
    ) + "\n"
  );
}
