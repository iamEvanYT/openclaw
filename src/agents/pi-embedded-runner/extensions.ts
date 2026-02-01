import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory, SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-extensions/compaction-safeguard.js";
import contextPruningExtension from "../pi-extensions/context-pruning.js";
import {
  setBrowserSnapshotExpiryRuntime,
  setContextPruningRuntime,
} from "../pi-extensions/context-pruning/runtime.js";
import {
  computeBrowserSnapshotExpirySettings,
  computeEffectiveSettings,
} from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { readBrowserSnapshotExpiredIds } from "./browser-snapshot-persistence.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";
import { log } from "./logger.js";

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningFactory(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): ExtensionFactory | undefined {
  const raw = params.cfg?.agents?.defaults?.contextPruning;

  // Browser snapshot expiration works independently of context pruning mode.
  // Initialize it unless explicitly disabled via config.
  const browserSnapshotSettings = computeBrowserSnapshotExpirySettings(raw);

  if (browserSnapshotSettings.enabled) {
    // Load persisted expired IDs from session to survive restarts
    const persistedExpiredIds = readBrowserSnapshotExpiredIds(params.sessionManager);
    if (persistedExpiredIds.size > 0) {
      log.info("loaded persisted browser snapshot state", {
        expiredCount: persistedExpiredIds.size,
      });
    }
    setBrowserSnapshotExpiryRuntime(params.sessionManager, {
      settings: browserSnapshotSettings,
      tracker: new Map(),
      expiredIds: persistedExpiredIds,
      lastToolResultCount: 0,
      lastUserMessageCount: 0,
    });
  }

  // Context pruning requires mode to be "cache-ttl" and an eligible provider
  if (raw?.mode !== "cache-ttl") {
    // Still need the extension for browser snapshot expiration if enabled
    if (browserSnapshotSettings.enabled) {
      return contextPruningExtension;
    }
    return undefined;
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) {
    // Still need the extension for browser snapshot expiration if enabled
    if (browserSnapshotSettings.enabled) {
      return contextPruningExtension;
    }
    return undefined;
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    // Still need the extension for browser snapshot expiration if enabled
    if (browserSnapshotSettings.enabled) {
      return contextPruningExtension;
    }
    return undefined;
  }

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
  });

  return contextPruningExtension;
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" {
  return cfg?.agents?.defaults?.compaction?.mode === "safeguard" ? "safeguard" : "default";
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      modelContextWindow: params.model?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: contextWindowInfo.tokens,
    });
    factories.push(compactionSafeguardExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  return factories;
}

export { ensurePiCompactionReserveTokens };
