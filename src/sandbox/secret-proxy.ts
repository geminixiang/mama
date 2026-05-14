import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Proxy server script ────────────────────────────────────────────────────────
// Embedded so it's self-contained after npm pack/publish (no runtime file lookup).
// Runs inside a node:20-alpine container; requires Node.js ≥ 18 (fetch + streams).

const PROXY_SERVER_SCRIPT = `
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

const PORT = parseInt(process.env.PROXY_PORT ?? '8080', 10);
const routes = JSON.parse(process.env.PROXY_ROUTES ?? '[]');

// Strip these from inbound requests so the sandbox can't leak its dummy key
// to the upstream and so injected keys are the only auth present.
const STRIP_REQ = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'host', 'content-length', 'transfer-encoding', 'connection']);
// Hop-by-hop headers to drop from upstream responses before forwarding
const STRIP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);

function findRoute(url) {
  return routes.find(r => url === r.prefix || url.startsWith(r.prefix + '/') || url.startsWith(r.prefix + '?'));
}

const server = createServer((req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routes: routes.length }));
    return;
  }

  const route = findRoute(url);
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No proxy route for: ' + url }));
    return;
  }

  const targetPath = url.slice(route.prefix.length) || '/';
  const base = route.target.replace(/\\/$/, '');
  const targetUrl = new URL(base + targetPath);

  // Build outbound headers
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQ.has(k.toLowerCase())) headers[k] = v;
  }
  if (route.headers) {
    for (const [k, v] of Object.entries(route.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }

  // Collect request body then forward
  const bodyChunks = [];
  req.on('data', c => bodyChunks.push(c));
  req.on('end', () => {
    const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;
    if (body) headers['content-length'] = String(body.length);

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 443,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers,
    };

    const upstreamReq = httpsRequest(options, upstream => {
      const resHeaders = {};
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (!STRIP_RES.has(k.toLowerCase())) resHeaders[k] = v;
      }
      res.writeHead(upstream.statusCode, resHeaders);
      upstream.pipe(res);
    });

    upstreamReq.on('error', err => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: String(err) }));
    });

    if (body) upstreamReq.write(body);
    upstreamReq.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('mama-secret-proxy ready on :' + PORT + ' (' + routes.length + ' route(s))');
});
`.trim();

// ── Service definitions ────────────────────────────────────────────────────────

/** Auth header injection strategy for a well-known API service. */
interface ServiceDef {
  /** Env var in the vault that holds the API key. */
  envKey: string;
  /** URL path prefix served by the proxy, e.g. "/anthropic". */
  proxyPrefix: string;
  /** Upstream base URL, e.g. "https://api.anthropic.com". */
  targetUrl: string;
  /** Auth header name to inject, lower-cased. */
  authHeaderName: string;
  /** Optional prefix for the header value, e.g. "Bearer ". */
  authHeaderValuePrefix?: string;
  /** Env var the sandbox client SDK reads for the base URL, if supported. */
  sandboxBaseUrlEnvKey?: string;
  /**
   * Additional sandbox env vars to set alongside the base URL.
   * Key is the env var name; value is the literal string to use (e.g., "proxy"
   * as a dummy API key that satisfies SDK initialisation checks).
   */
  sandboxExtraEnv?: Record<string, string>;
}

const SERVICE_DEFS: ServiceDef[] = [
  {
    envKey: "ANTHROPIC_API_KEY",
    proxyPrefix: "/anthropic",
    targetUrl: "https://api.anthropic.com",
    authHeaderName: "x-api-key",
    sandboxBaseUrlEnvKey: "ANTHROPIC_BASE_URL",
    sandboxExtraEnv: { ANTHROPIC_API_KEY: "proxy" },
  },
  {
    envKey: "OPENAI_API_KEY",
    proxyPrefix: "/openai",
    targetUrl: "https://api.openai.com",
    authHeaderName: "authorization",
    authHeaderValuePrefix: "Bearer ",
    sandboxBaseUrlEnvKey: "OPENAI_BASE_URL",
    sandboxExtraEnv: { OPENAI_API_KEY: "proxy" },
  },
  {
    envKey: "OPENROUTER_API_KEY",
    proxyPrefix: "/openrouter",
    targetUrl: "https://openrouter.ai/api",
    authHeaderName: "authorization",
    authHeaderValuePrefix: "Bearer ",
    // OpenRouter is OpenAI-compatible; callers typically set OPENAI_BASE_URL.
    // We use a dedicated prefix so OPENAI and OPENROUTER can coexist.
    sandboxExtraEnv: { OPENROUTER_API_KEY: "proxy" },
  },
];

// ── ProxyRoute (serialised into PROXY_ROUTES env var) ─────────────────────────

export interface ProxyRoute {
  prefix: string;
  target: string;
  headers: Record<string, string>;
}

// ── SecretProxyManager ─────────────────────────────────────────────────────────

const PROXY_CONTAINER_PREFIX = "mama-proxy-";
const PROXY_PORT = 8080;
const PROXY_IMAGE = "node:20-alpine";
const PROXY_SCRIPT_PATH = join(tmpdir(), "mama-proxy-server.mjs");

export class SecretProxyManager {
  // ── public API ───────────────────────────────────────────────────────────────

  /**
   * Build the proxy route list from a vault env map.
   * Returns an empty array when no known service keys are present.
   */
  buildProxyRoutes(vaultEnv: Record<string, string>): ProxyRoute[] {
    const routes: ProxyRoute[] = [];
    for (const def of SERVICE_DEFS) {
      const apiKey = vaultEnv[def.envKey];
      if (!apiKey) continue;
      const authValue = (def.authHeaderValuePrefix ?? "") + apiKey;
      routes.push({
        prefix: def.proxyPrefix,
        target: def.targetUrl,
        headers: { [def.authHeaderName]: authValue },
      });
    }
    return routes;
  }

  /**
   * Build the env map to pass to the sandbox container.
   * Known API key env vars are replaced with dummy values + proxy base URLs.
   * All other vault env vars are forwarded unchanged.
   */
  buildSandboxEnv(vaultEnv: Record<string, string>, proxyHostname: string): Record<string, string> {
    const sandboxEnv: Record<string, string> = {};
    const proxiedKeys = new Set(SERVICE_DEFS.map((d) => d.envKey));

    // Forward non-secret env vars as-is
    for (const [key, value] of Object.entries(vaultEnv)) {
      if (!proxiedKeys.has(key)) sandboxEnv[key] = value;
    }

    // Replace each known API key with proxy URL + dummy key
    for (const def of SERVICE_DEFS) {
      if (!vaultEnv[def.envKey]) continue;
      if (def.sandboxBaseUrlEnvKey) {
        sandboxEnv[def.sandboxBaseUrlEnvKey] =
          `http://${proxyHostname}:${PROXY_PORT}${def.proxyPrefix}`;
      }
      if (def.sandboxExtraEnv) {
        Object.assign(sandboxEnv, def.sandboxExtraEnv);
      }
    }

    return sandboxEnv;
  }

  /**
   * Returns true when at least one vault env var maps to a known proxy service.
   */
  hasProxiableSecrets(vaultEnv: Record<string, string>): boolean {
    return SERVICE_DEFS.some((def) => !!vaultEnv[def.envKey]);
  }

  /**
   * Provision a proxy container attached to the given Docker network.
   * Idempotent: if the container is already running, this is a no-op.
   */
  async provision(
    containerKey: string,
    vaultEnv: Record<string, string>,
    networkName: string,
  ): Promise<void> {
    const name = this.containerName(containerKey);
    const routes = this.buildProxyRoutes(vaultEnv);
    if (routes.length === 0) return;

    // Skip if already running
    if (await this.isRunning(name)) return;

    // Remove any stopped container with the same name before recreating
    await this.forceRemove(name).catch(() => {});

    const scriptPath = this.ensureScriptOnDisk();
    const routesJson = JSON.stringify(routes);

    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      name,
      "--network",
      networkName,
      "--label",
      "mama.managed=true",
      "--label",
      "mama.sandbox=secret-proxy",
      "--label",
      `mama.proxy-for=${containerKey}`,
      "-e",
      `PROXY_ROUTES=${routesJson}`,
      "-e",
      `PROXY_PORT=${PROXY_PORT}`,
      "-v",
      `${scriptPath}:/proxy.mjs:ro`,
      PROXY_IMAGE,
      "node",
      "/proxy.mjs",
    ]);
  }

  /** Stop a proxy container (leaves it removable later). */
  async stop(containerKey: string): Promise<void> {
    const name = this.containerName(containerKey);
    try {
      await execFileAsync("docker", ["stop", name]);
    } catch {
      // Ignore: container may already be stopped or missing
    }
  }

  /** Remove a proxy container. */
  async remove(containerKey: string): Promise<void> {
    await this.forceRemove(this.containerName(containerKey));
  }

  /** Hostname reachable from within the Docker network. */
  proxyHostname(containerKey: string): string {
    return this.containerName(containerKey);
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private containerName(containerKey: string): string {
    return `${PROXY_CONTAINER_PREFIX}${containerKey}`;
  }

  private async isRunning(containerName: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        containerName,
      ]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async forceRemove(containerName: string): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "-f", containerName]);
    } catch {
      // Ignore: container may not exist
    }
  }

  /**
   * Write PROXY_SERVER_SCRIPT to a fixed temp path and return it.
   * Using a stable path means multiple SecretProxyManager instances share
   * the same script file without conflict (content is always identical).
   */
  private ensureScriptOnDisk(): string {
    writeFileSync(PROXY_SCRIPT_PATH, PROXY_SERVER_SCRIPT, { mode: 0o600 });
    return PROXY_SCRIPT_PATH;
  }
}
