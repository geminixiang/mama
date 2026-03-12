/**
 * Extension loader for mama.
 *
 * Scans two directories for extension files and loads them via the
 * pi-coding-agent `loadExtensions()` runtime (uses jiti for TS support):
 *
 *   {workspace}/extensions/   — global, shared across all channels
 *   {channel}/extensions/     — per-channel overrides
 *
 * Each extension file must export a default function:
 *
 *   import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
 *   export default function (pi: ExtensionAPI) {
 *     pi.registerTool({ name: "my-tool", ... });
 *     pi.on("agent_start", () => { ... });
 *   }
 *
 * Supported file extensions: .js  .mjs  .cjs  .ts
 *
 * Results are cached in `globalResourceCache` for the TTL configured in
 * settings.json (resourceCacheTtlMs, default 30 s).  The cache entry is
 * explicitly invalidated after every agent run so that extensions created or
 * edited by the agent during a session are picked up on the very next request.
 */

import {
  createExtensionRuntime,
  discoverAndLoadExtensions,
  type LoadExtensionsResult,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { extname, join } from "path";
import { globalResourceCache } from "./cache.js";
import * as log from "./log.js";

const EXTENSION_EXTS = new Set([".js", ".mjs", ".cjs", ".ts"]);

/** Return absolute paths of all extension files inside a directory. */
async function scanExtensionDir(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && EXTENSION_EXTS.has(extname(e.name)))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Load (or return cached) extensions for a given channel.
 *
 * @param channelDir  Absolute host path to the channel directory.
 * @param cwd         Working directory passed to the extension loader.
 */
export async function loadMamaExtensions(
  channelDir: string,
  cwd: string,
): Promise<LoadExtensionsResult> {
  const cacheKey = `extensions:${channelDir}`;
  const cached = globalResourceCache.get<LoadExtensionsResult>(cacheKey);
  if (cached !== undefined) return cached;

  const workspaceDir = join(channelDir, "..");

  const [workspacePaths, channelPaths] = await Promise.all([
    scanExtensionDir(join(workspaceDir, "extensions")),
    scanExtensionDir(join(channelDir, "extensions")),
  ]);

  const allPaths = [...workspacePaths, ...channelPaths];

  let result: LoadExtensionsResult;
  if (allPaths.length === 0) {
    result = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  } else {
    log.logInfo(
      `[extensions] Loading ${allPaths.length} file(s): ${allPaths.map((p) => p.split("/").pop()).join(", ")}`,
    );
    // Pass our pre-scanned absolute paths as configuredPaths.
    // No agentDir is given, so standard system/project locations are skipped —
    // only the explicit workspace/channel extension files are loaded.
    result = await discoverAndLoadExtensions(allPaths, cwd);
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        log.logWarning(`[extensions] Failed to load ${err.path}`, err.error);
      }
    }
    if (result.extensions.length > 0) {
      log.logInfo(`[extensions] Loaded ${result.extensions.length} extension(s)`);
    }
  }

  globalResourceCache.set(cacheKey, result);
  return result;
}
