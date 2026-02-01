import { parseDurationMs } from "../../../cli/parse-duration.js";

export type ContextPruningToolMatch = {
  allow?: string[];
  deny?: string[];
};
export type ContextPruningMode = "off" | "cache-ttl";

/**
 * Configuration for browser snapshot expiration.
 * Browser snapshots are large DOM tree outputs that can accumulate in the context window.
 * This feature automatically expires them after N tool calls to save tokens.
 */
export type BrowserSnapshotExpiryConfig = {
  /** Whether browser snapshot expiration is enabled. Default: true */
  enabled?: boolean;
  /** Number of tool calls (or user messages) after which a snapshot expires. Default: 3 */
  toolCalls?: number;
};

export type ContextPruningConfig = {
  mode?: ContextPruningMode;
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: ContextPruningToolMatch;
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
  /** Browser snapshot expiration settings. Works independently of pruning mode. */
  browserSnapshot?: {
    expiry?: BrowserSnapshotExpiryConfig;
  };
};

export type EffectiveContextPruningSettings = {
  mode: Exclude<ContextPruningMode, "off">;
  ttlMs: number;
  keepLastAssistants: number;
  softTrimRatio: number;
  hardClearRatio: number;
  minPrunableToolChars: number;
  tools: ContextPruningToolMatch;
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
};

/**
 * Effective settings for browser snapshot expiration.
 * This is separate from EffectiveContextPruningSettings because it works independently.
 */
export type EffectiveBrowserSnapshotExpirySettings = {
  enabled: boolean;
  toolCalls: number;
};

/** Static placeholder for expired browser snapshots. Must remain constant for prompt caching. */
export const BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER = "[Browser snapshot expired - content cleared]";

export const DEFAULT_BROWSER_SNAPSHOT_EXPIRY_SETTINGS: EffectiveBrowserSnapshotExpirySettings = {
  enabled: true,
  toolCalls: 3,
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: EffectiveContextPruningSettings = {
  mode: "cache-ttl",
  ttlMs: 5 * 60 * 1000,
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  tools: {},
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
};

export function computeEffectiveSettings(raw: unknown): EffectiveContextPruningSettings | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cfg = raw as ContextPruningConfig;
  if (cfg.mode !== "cache-ttl") {
    return null;
  }

  const s: EffectiveContextPruningSettings = structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS);
  s.mode = cfg.mode;

  if (typeof cfg.ttl === "string") {
    try {
      s.ttlMs = parseDurationMs(cfg.ttl, { defaultUnit: "m" });
    } catch {
      // keep default ttl
    }
  }

  if (typeof cfg.keepLastAssistants === "number" && Number.isFinite(cfg.keepLastAssistants)) {
    s.keepLastAssistants = Math.max(0, Math.floor(cfg.keepLastAssistants));
  }
  if (typeof cfg.softTrimRatio === "number" && Number.isFinite(cfg.softTrimRatio)) {
    s.softTrimRatio = Math.min(1, Math.max(0, cfg.softTrimRatio));
  }
  if (typeof cfg.hardClearRatio === "number" && Number.isFinite(cfg.hardClearRatio)) {
    s.hardClearRatio = Math.min(1, Math.max(0, cfg.hardClearRatio));
  }
  if (typeof cfg.minPrunableToolChars === "number" && Number.isFinite(cfg.minPrunableToolChars)) {
    s.minPrunableToolChars = Math.max(0, Math.floor(cfg.minPrunableToolChars));
  }
  if (cfg.tools) {
    s.tools = cfg.tools;
  }
  if (cfg.softTrim) {
    if (typeof cfg.softTrim.maxChars === "number" && Number.isFinite(cfg.softTrim.maxChars)) {
      s.softTrim.maxChars = Math.max(0, Math.floor(cfg.softTrim.maxChars));
    }
    if (typeof cfg.softTrim.headChars === "number" && Number.isFinite(cfg.softTrim.headChars)) {
      s.softTrim.headChars = Math.max(0, Math.floor(cfg.softTrim.headChars));
    }
    if (typeof cfg.softTrim.tailChars === "number" && Number.isFinite(cfg.softTrim.tailChars)) {
      s.softTrim.tailChars = Math.max(0, Math.floor(cfg.softTrim.tailChars));
    }
  }
  if (cfg.hardClear) {
    if (typeof cfg.hardClear.enabled === "boolean") {
      s.hardClear.enabled = cfg.hardClear.enabled;
    }
    if (typeof cfg.hardClear.placeholder === "string" && cfg.hardClear.placeholder.trim()) {
      s.hardClear.placeholder = cfg.hardClear.placeholder.trim();
    }
  }

  return s;
}

/**
 * Compute effective browser snapshot expiry settings from raw config.
 * Returns settings even if contextPruning mode is "off" since this feature works independently.
 */
export function computeBrowserSnapshotExpirySettings(
  raw: unknown,
): EffectiveBrowserSnapshotExpirySettings {
  const defaults = structuredClone(DEFAULT_BROWSER_SNAPSHOT_EXPIRY_SETTINGS);

  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const cfg = raw as ContextPruningConfig;
  const expiryCfg = cfg.browserSnapshot?.expiry;

  if (!expiryCfg || typeof expiryCfg !== "object") {
    return defaults;
  }

  if (typeof expiryCfg.enabled === "boolean") {
    defaults.enabled = expiryCfg.enabled;
  }

  if (typeof expiryCfg.toolCalls === "number" && Number.isFinite(expiryCfg.toolCalls)) {
    defaults.toolCalls = Math.max(1, Math.floor(expiryCfg.toolCalls));
  }

  return defaults;
}
