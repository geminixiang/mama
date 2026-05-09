import { execFile } from "child_process";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { promisify } from "util";
import type { ContainerMount } from "./provisioner.js";

const execFileAsync = promisify(execFile);
const DEFAULT_ADDRESS = "http://127.0.0.1:14321";
const DEFAULT_VAULT = "default";
const DEFAULT_PROXY_HOST = "host.docker.internal";
const DEFAULT_PROXY_PORT = 14322;
const DEFAULT_TTL_SECONDS = 3600;
const CONTAINER_CA_PATH = "/etc/ssl/agent-vault-ca.pem";

export interface AgentVaultConfig {
  mode: "off" | "agent-vault";
  address: string;
  vault: string;
  ttlSeconds: number;
  caPath: string;
  proxyHost: string;
  proxyPort: number;
  ghTokenPlaceholder: string;
}

export interface SandboxCredentialRuntime {
  env: Record<string, string>;
  mounts: ContainerMount[];
  disableVaultInjection: boolean;
}

export function defaultAgentVaultConfig(stateDir?: string): AgentVaultConfig {
  const baseDir = stateDir ? resolve(stateDir) : join(homedir(), ".mama");
  return {
    mode: "off",
    address: DEFAULT_ADDRESS,
    vault: DEFAULT_VAULT,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    caPath: join(baseDir, "agent-vault-ca.pem"),
    proxyHost: DEFAULT_PROXY_HOST,
    proxyPort: DEFAULT_PROXY_PORT,
    ghTokenPlaceholder: "mama-agent-vault-placeholder",
  };
}

export async function createAgentVaultRuntime(
  config: AgentVaultConfig,
): Promise<SandboxCredentialRuntime | undefined> {
  if (config.mode === "off") return undefined;

  mkdirSync(dirname(config.caPath), { recursive: true });
  const ca = await runAgentVault(["ca", "fetch", "--address", config.address], config);
  writeFileSync(config.caPath, ca.stdout, { mode: 0o600 });
  chmodSync(config.caPath, 0o600);

  const tokenArgs = ["vault", "token", "--ttl", String(config.ttlSeconds)];
  const token = (await runAgentVault(tokenArgs, config)).stdout.trim();
  if (!token) throw new Error("agent-vault returned an empty session token");

  const proxyUrl = `https://${encodeURIComponent(token)}:${encodeURIComponent(
    config.vault,
  )}@${config.proxyHost}:${config.proxyPort}`;

  return {
    disableVaultInjection: true,
    mounts: [{ source: config.caPath, target: CONTAINER_CA_PATH }],
    env: {
      AGENT_VAULT_ADDR: config.address,
      AGENT_VAULT_VAULT: config.vault,
      AGENT_VAULT_SESSION_TOKEN: token,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,host.docker.internal",
      NODE_USE_ENV_PROXY: "1",
      SSL_CERT_FILE: CONTAINER_CA_PATH,
      NODE_EXTRA_CA_CERTS: CONTAINER_CA_PATH,
      REQUESTS_CA_BUNDLE: CONTAINER_CA_PATH,
      CURL_CA_BUNDLE: CONTAINER_CA_PATH,
      GIT_SSL_CAINFO: CONTAINER_CA_PATH,
      DENO_CERT: CONTAINER_CA_PATH,
      GH_TOKEN: config.ghTokenPlaceholder,
    },
  };
}

async function runAgentVault(
  args: string[],
  config: AgentVaultConfig,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("agent-vault", args, {
      env: { ...process.env, AGENT_VAULT_ADDR: config.address, AGENT_VAULT_VAULT: config.vault },
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`agent-vault ${args.join(" ")} failed: ${detail}`);
  }
}
