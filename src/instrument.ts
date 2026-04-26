import * as Sentry from "@sentry/node";
import {
  resolveSentryDsn,
  resolveStateDirFromArgv,
  resolveWorkspaceDirFromArgv,
} from "./config.js";
import { createSentryInitOptions } from "./sentry.js";

process.env.MAMA_STATE_DIR ??= resolveStateDirFromArgv();
const workingDir = resolveWorkspaceDirFromArgv();
const sentryDsn = resolveSentryDsn(workingDir);

Sentry.init(createSentryInitOptions(sentryDsn));
