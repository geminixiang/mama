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
import { PRODUCT_NAME } from "./ui-copy.js";
import { defaultVaultTargetPath, type VaultManager } from "./vault.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/** Called after a binding is written, to notify the user in chat */
export type NotifyFn = (platform: string, conversationId: string, message: string) => Promise<void>;

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
        ? `Authorize ${oauthServiceHint.label} and store tokens in your vault.`
        : "Set any environment variable key/value pair in your vault.";
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

const sharedPageStyles = `
  :root {
    color-scheme: light;
    --bg: #f5f1e8;
    --panel: rgba(255, 255, 255, 0.9);
    --panel-border: rgba(28, 30, 33, 0.08);
    --text: #1c1e21;
    --muted: #5d5f64;
    --button: #1c1e21;
    --button-hover: #2c3035;
    --button-disabled: #8f949b;
    --field-border: #c9cfd6;
    --field-focus: #1c1e21;
    --ok-bg: #dff4e4;
    --ok-text: #1f5b34;
    --err-bg: #fde2e2;
    --err-text: #8a2f2f;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    padding: 32px 20px;
    display: grid;
    place-items: center;
    background:
      radial-gradient(circle at top, rgba(255, 255, 255, 0.7), transparent 45%),
      linear-gradient(180deg, #faf7f0 0%, var(--bg) 100%);
    color: var(--text);
    font-family:
      "SF Pro Text",
      "Segoe UI",
      system-ui,
      sans-serif;
  }

  .shell {
    width: min(100%, 560px);
  }

  .card {
    padding: 28px;
    border: 1px solid var(--panel-border);
    border-radius: 20px;
    background: var(--panel);
    box-shadow: 0 18px 48px rgba(28, 30, 33, 0.08);
    backdrop-filter: blur(8px);
  }

  .eyebrow {
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0 0 10px;
    font-size: clamp(1.5rem, 2vw, 1.8rem);
    line-height: 1.15;
    text-wrap: balance;
  }

  p {
    margin: 0;
    color: var(--muted);
    font-size: 0.98rem;
    line-height: 1.5;
  }

  .stack > * + * {
    margin-top: 14px;
  }

  .form {
    margin-top: 24px;
  }

  .form > * + * {
    margin-top: 18px;
  }

  label {
    display: block;
    margin-bottom: 6px;
    font-size: 0.92rem;
    font-weight: 650;
  }

  input,
  select,
  button {
    font: inherit;
  }

  input,
  select {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--field-border);
    border-radius: 12px;
    background: #fff;
    color: var(--text);
  }

  input:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--field-focus);
    outline-offset: 2px;
  }

  button {
    width: 100%;
    margin-top: 24px;
    padding: 13px 18px;
    border: none;
    border-radius: 12px;
    background: var(--button);
    color: #fff;
    cursor: pointer;
    transition: background-color 160ms ease;
  }

  button:hover {
    background: var(--button-hover);
  }

  button:disabled {
    background: var(--button-disabled);
    cursor: default;
  }

  .mode {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 22px;
  }

  .mode label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--field-border);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.85);
    font-weight: 500;
  }

  .mode input {
    width: auto;
    margin: 0;
  }

  .panel {
    display: none;
  }

  .panel.active {
    display: block;
  }

  .panel-note {
    margin-top: 10px;
    font-size: 0.92rem;
  }

  .result,
  .status {
    margin-top: 20px;
    padding: 14px 16px;
    border-radius: 14px;
    font-size: 0.95rem;
  }

  .result {
    display: none;
  }

  .result.ok,
  .status.ok {
    background: var(--ok-bg);
    color: var(--ok-text);
  }

  .result.err,
  .status.err {
    background: var(--err-bg);
    color: var(--err-text);
  }

  .close-note {
    margin-top: 14px;
    font-size: 0.92rem;
  }

  @media (max-width: 640px) {
    body {
      padding: 20px 14px;
    }

    .card {
      padding: 22px;
      border-radius: 16px;
    }
  }
`;

function renderPageDocument(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — ${PRODUCT_NAME}</title>
  <style>${sharedPageStyles}</style>
</head>
<body>
  <main class="shell">
    <section class="card">
      ${body}
    </section>
  </main>
</body>
</html>`;
}

function renderStatusPage(
  title: string,
  message: string,
  tone: "ok" | "err",
  options?: { closeNote?: boolean },
): string {
  const closeNote = options?.closeNote ? '<p class="close-note">You can close this tab.</p>' : "";
  return renderPageDocument(
    title,
    `<div class="stack">
      <p class="eyebrow">${PRODUCT_NAME}</p>
      <h1>${esc(title)}</h1>
      <div class="status ${tone}">${esc(message)}</div>
      ${closeNote}
    </div>`,
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

  return renderPageDocument(
    "Login",
    `<div class="stack">
  <p class="eyebrow">${PRODUCT_NAME}</p>
  <h1>${esc(title)}</h1>
  <p>Your personal sandbox is already provisioned automatically.</p>
  <p>${esc(helpText)}</p>
  <div class="mode">
    <label><input type="radio" name="mode" value="api_key" ${defaultMode === "api_key" ? "checked" : ""}> API key</label>
    <label><input type="radio" name="mode" value="oauth" ${defaultMode === "oauth" ? "checked" : ""}> OAuth login</label>
  </div>

  <div class="form">
  <div id="api-panel" class="panel">
    <label for="envKey">Environment key</label>
    <input id="envKey" type="text" name="envKey" placeholder="OPENAI_API_KEY" value="${esc(initialEnvKey)}" autocomplete="off">
    <label for="credential">${esc(secretLabel)}</label>
    <input id="credential" type="password" name="credential" placeholder="${esc(placeholder)}" autocomplete="off">
  </div>

  <div id="oauth-panel" class="panel">
    <label for="oauthService">OAuth service</label>
    <select id="oauthService" name="oauthService">${oauthOptions}</select>
    <p class="panel-note">You'll be redirected to the selected service's authorization page.</p>
  </div>

  <button id="btn" onclick="connect()">Continue</button>
  <div id="result" class="result" aria-live="polite"></div>
  </div>
  <script>
    const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

    function selectedMode() {
      return document.querySelector('input[name="mode"]:checked').value;
    }

    function showResult(message, ok) {
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.className = ok ? 'result ok' : 'result err';
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
</div>`,
  );
}

function renderErrorPage(message: string): string {
  return renderStatusPage("Login Error", message, "err");
}

function renderSuccessPage(message: string): string {
  return renderStatusPage("Connected", message, "ok", { closeNote: true });
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

  try {
    vaultManager.upsertEnv(linkToken.vaultId, { [envKey]: credential });
  } catch (error) {
    log.logWarning(
      `Failed to persist ${envKey} for ${linkToken.platform}/${linkToken.platformUserId}`,
      error instanceof Error ? error.message : String(error),
    );
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "Failed to store credential on server. Please fix the server issue and run /login again.",
      }),
    );
    return;
  }

  log.logInfo(
    `Stored ${envKey} for ${linkToken.platform}/${linkToken.platformUserId} in vault:${linkToken.vaultId}`,
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, message: `${envKey} stored successfully in vault.` }));

  notify(
    linkToken.platform,
    linkToken.conversationId,
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
  try {
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
  } catch (error) {
    log.logWarning(
      `Failed to persist OAuth credentials for ${linkToken.platform}/${linkToken.platformUserId}`,
      error instanceof Error ? error.message : String(error),
    );
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      renderErrorPage(
        "OAuth tokens were received but could not be stored on the server. Fix the server issue and run /login again.",
      ),
    );
    return;
  }

  log.logInfo(
    `Stored [${storedTargets.join(", ")}] for ${linkToken.platform}/${linkToken.platformUserId} in vault:${linkToken.vaultId}`,
  );

  notify(
    linkToken.platform,
    linkToken.conversationId,
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
