import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { pruneContextMessages, expireBrowserSnapshots } from "./pruner.js";
import { getContextPruningRuntime, getBrowserSnapshotExpiryRuntime } from "./runtime.js";
import { appendBrowserSnapshotState } from "../../pi-embedded-runner/browser-snapshot-persistence.js";
import { log } from "./logger.js";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    try {
      let messages = event.messages;
      let modified = false;

      // Browser snapshot expiration runs independently of context pruning mode
      const browserSnapshotRuntime = getBrowserSnapshotExpiryRuntime(ctx.sessionManager);
      if (browserSnapshotRuntime && browserSnapshotRuntime.settings.enabled) {
        const expiredIdsBefore = browserSnapshotRuntime.expiredIds.size;
        const afterExpiry = expireBrowserSnapshots({
          messages,
          runtime: browserSnapshotRuntime,
        });
        if (afterExpiry !== messages) {
          messages = afterExpiry;
          modified = true;
        }
        // Persist expired IDs if any new ones were added
        if (browserSnapshotRuntime.expiredIds.size > expiredIdsBefore) {
          appendBrowserSnapshotState(ctx.sessionManager, browserSnapshotRuntime.expiredIds);
        }
      }

      // Context pruning (requires mode to be enabled)
      const runtime = getContextPruningRuntime(ctx.sessionManager);
      if (runtime) {
        if (runtime.settings.mode === "cache-ttl") {
          const ttlMs = runtime.settings.ttlMs;
          const lastTouch = runtime.lastCacheTouchAt ?? null;
          const shouldPrune = lastTouch && ttlMs > 0 && Date.now() - lastTouch >= ttlMs;

          if (shouldPrune) {
            const afterPruning = pruneContextMessages({
              messages,
              settings: runtime.settings,
              ctx,
              isToolPrunable: runtime.isToolPrunable,
              contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
            });

            if (afterPruning !== messages) {
              messages = afterPruning;
              modified = true;
              runtime.lastCacheTouchAt = Date.now();
            }
          }
        }
      }

      if (!modified) {
        return undefined;
      }

      return { messages };
    } catch (err) {
      log.error("context-pruning extension error", { error: String(err) });
      return undefined;
    }
  });
}
