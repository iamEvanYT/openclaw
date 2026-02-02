import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { appendBrowserSnapshotState } from "../../pi-embedded-runner/browser-snapshot-persistence.js";
import { log } from "./logger.js";
import { pruneContextMessages } from "./pruner.js";
import { expireBrowserSnapshots } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";
import { getBrowserSnapshotExpiryRuntime } from "./runtime.js";

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    try {
      let messages = event.messages;
      let modified = false;

      log.debug("context event received", { messageCount: messages.length });

      // Browser snapshot expiration runs independently of context pruning mode
      const browserSnapshotRuntime = getBrowserSnapshotExpiryRuntime(ctx.sessionManager);
      log.debug("browser snapshot runtime", {
        exists: !!browserSnapshotRuntime,
        enabled: browserSnapshotRuntime?.settings.enabled,
        trackedSnapshots: browserSnapshotRuntime?.tracker.size,
        expiredIds: browserSnapshotRuntime?.expiredIds.size,
      });

      if (browserSnapshotRuntime && browserSnapshotRuntime.settings.enabled) {
        const expiredIdsBefore = browserSnapshotRuntime.expiredIds.size;
        log.debug("running browser snapshot expiration", {
          threshold: browserSnapshotRuntime.settings.toolCalls,
          trackedCount: browserSnapshotRuntime.tracker.size,
        });

        const afterExpiry = expireBrowserSnapshots({
          messages,
          runtime: browserSnapshotRuntime,
        });

        if (afterExpiry !== messages) {
          log.debug("browser snapshot expiration modified messages");
          messages = afterExpiry;
          modified = true;
        } else {
          log.debug("browser snapshot expiration did not modify messages");
        }

        // Persist expired IDs if any new ones were added
        const newlyExpiredCount = browserSnapshotRuntime.expiredIds.size - expiredIdsBefore;
        if (newlyExpiredCount > 0) {
          log.debug("persisting expired snapshot IDs", { count: newlyExpiredCount });
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
