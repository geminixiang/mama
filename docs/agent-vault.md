# Agent Vault credential mode

`image:*` sandboxes can use Infisical Agent Vault as a transparent HTTP credential proxy.

```json
{
  "sandbox": {
    "credentials": {
      "mode": "agent-vault",
      "address": "http://127.0.0.1:14321",
      "vault": "default",
      "ttlSeconds": 3600,
      "caPath": "~/.mama/agent-vault-ca.pem",
      "proxyHost": "host.docker.internal",
      "proxyPort": 14322
    }
  }
}
```

Only `mode: "agent-vault"` is supported by this integration. It currently requires `--sandbox=image:<image>`.

When enabled, mama:

1. runs `agent-vault ca fetch` and mounts the CA certificate into the sandbox at `/etc/ssl/agent-vault-ca.pem`;
2. runs `agent-vault vault token` to mint a vault-scoped proxy session;
3. injects `HTTPS_PROXY`, `HTTP_PROXY`, CA trust env vars, and `NODE_USE_ENV_PROXY=1`;
4. adds `host.docker.internal:host-gateway` to managed Docker containers;
5. stops injecting mama vault env vars and vault file mounts into the sandbox.

For GitHub CLI compatibility, mama sets a non-secret placeholder `GH_TOKEN`. The real GitHub token should live only in Agent Vault and be attached by the proxy for `api.github.com`.

Example Agent Vault setup:

```bash
agent-vault server -d
agent-vault vault credential set GH_TOKEN=ghp_xxx
agent-vault vault service add \
  --host api.github.com \
  --description "GitHub API" \
  --auth-type bearer \
  --token-key GH_TOKEN
```

Expected sandbox behavior:

```bash
env | grep GH_TOKEN      # shows only the placeholder
gh api user --jq .login  # succeeds through Agent Vault proxy
```

The sandbox receives an Agent Vault session token in its proxy URL. Treat it as sensitive and keep TTLs short.
