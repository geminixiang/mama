import * as Sentry from "@sentry/node";
import { resolveSentryDsn, resolveWorkspaceDirFromArgv } from "./config.js";
import { createSentryInitOptions } from "./sentry.js";

const workingDir = resolveWorkspaceDirFromArgv();
const sentryDsn = resolveSentryDsn(workingDir);

Sentry.init(createSentryInitOptions(sentryDsn));
