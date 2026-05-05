import * as Sentry from "@sentry/node";
import { resolveSentryDsn, resolveStateDirFromArgv } from "./config.js";
import { createSentryInitOptions } from "./sentry.js";

process.env.MAMA_STATE_DIR ??= resolveStateDirFromArgv();
const sentryDsn = resolveSentryDsn();

Sentry.init(createSentryInitOptions(sentryDsn));
