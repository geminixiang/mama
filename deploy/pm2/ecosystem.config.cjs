// PM2 ecosystem file for mama.
//
// Quick start:
//
//   # 1. Install mama + pm2
//   npm i -g @geminixiang/mama pm2
//
//   # 2. Pull and start the sandbox container (long-lived, mama execs into it)
//   docker pull ghcr.io/geminixiang/mama-sandbox:latest
//   docker run -d --name rd-sandbox --restart unless-stopped \
//     ghcr.io/geminixiang/mama-sandbox:latest
//
//   # 3. Grab this ecosystem file, edit `args` + `env`, then start
//   curl -O https://raw.githubusercontent.com/geminixiang/mama/main/deploy/pm2/ecosystem.config.cjs
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup    # run the printed command to enable boot autostart
//
// Reload after upgrading mama:
//   npm i -g @geminixiang/mama && pm2 reload mama
//
// Logs:
//   pm2 logs mama         # tail combined logs
//   pm2 logs mama --lines 200
//
// Args reference (see `mama --help` equivalent in src/main.ts):
//   <working-directory>           required positional, the git repo mama operates on
//   --state-dir=<dir>             defaults to ~/.mama (where settings.json + vaults live)
//   --sandbox=<spec>              one of:
//                                   container:<existing-container-name>   (recommended)
//                                   image:<image-name>                    (mama-managed per-user)
//                                   host
//                                   firecracker:<vm-id>:<host-path>
//                                   cloudflare:<sandbox-id>
//
// Notes:
// - kill_timeout is 60s to give mama's internal graceful shutdown
//   (handler.shutdown defaults to 30s) room to drain in-flight LLM
//   turns before pm2 sends SIGKILL.
// - The sandbox container should be started with `--restart unless-stopped`
//   so it comes back on reboot before mama (which pm2 startup also brings
//   up) tries to exec into it. Docker's daemon starts before pm2's unit.

module.exports = {
  apps: [
    {
      name: "mama",
      script: "mama",

      // EDIT ME: working dir + sandbox to match your setup.
      args: "--sandbox=container:rd-sandbox /root/.mom/data",

      // EDIT ME: uncomment what you need. Prefer loading secrets from
      // a sourced env file or pm2's --env-file rather than committing
      // them here.
      env: {
        // --- Platforms (at least one required) ---
        // MAMA_SLACK_APP_TOKEN: "xapp-...",
        // MAMA_SLACK_BOT_TOKEN: "xoxb-...",
        // MAMA_TELEGRAM_BOT_TOKEN: "123456:ABC-...",
        // MAMA_DISCORD_BOT_TOKEN: "MTI...",
        // --- LLM providers (set whichever you use) ---
        // ANTHROPIC_API_KEY: "sk-ant-...",
        // OPENAI_API_KEY: "sk-...",
        // --- Login portal / set-secret links ---
        // MAMA_LINK_URL: "https://mama.example.com",
        // MAMA_LINK_PORT: "8181",
        // --- GitHub OAuth login ---
        // GITHUB_OAUTH_CLIENT_ID: "...",
        // GITHUB_OAUTH_CLIENT_SECRET: "...",
        // --- Google Workspace OAuth login ---
        // GOOGLE_WORKSPACE_CLI_CLIENT_ID: "...",
        // GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "...",
        // --- Cloudflare sandbox (required when --sandbox=cloudflare:*) ---
        // MAMA_CLOUDFLARE_SANDBOX_URL: "https://...",
        // MAMA_CLOUDFLARE_SANDBOX_TOKEN: "...",
      },

      // Graceful shutdown: SIGTERM, then wait up to 60s before SIGKILL.
      kill_timeout: 60000,

      // Auto-restart policy.
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,

      // Log formatting (~/.pm2/logs/mama-out.log + mama-error.log).
      time: true,
      merge_logs: true,
    },
  ],
};
