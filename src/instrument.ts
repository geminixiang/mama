import * as os from "os";
import * as Sentry from "@sentry/node";
import { resolveSentryDsnFromConfig, resolveWorkspaceDirFromArgv } from "./config.js";
import { createSentryInitOptions } from "./sentry.js";

// Lazy initialization: resolve Sentry DSN only when Sentry is actually initialized
// This avoids parsing CLI args and reading files on every import
const getSentryDsn = () => {
  const workingDir = resolveWorkspaceDirFromArgv();
  // stateDir defaults to ~/.mama (same as main.ts)
  const stateDir = process.env.MAMA_STATE_DIR || os.homedir() + "/.mama";
  return resolveSentryDsnFromConfig(stateDir, workingDir);
};

Sentry.init(createSentryInitOptions(getSentryDsn()));
