import type {
  EffectiveBrowserSnapshotExpirySettings,
  EffectiveContextPruningSettings,
} from "./settings.js";

export type ContextPruningRuntimeValue = {
  settings: EffectiveContextPruningSettings;
  contextWindowTokens?: number | null;
  isToolPrunable: (toolName: string) => boolean;
  lastCacheTouchAt?: number | null;
};

/**
 * Tracks a single browser snapshot tool result for expiration.
 */
export type BrowserSnapshotTrackerEntry = {
  /** The tool call ID that produced this snapshot */
  toolCallId: string;
  /** Number of tool calls + user messages since this snapshot was registered */
  callsSince: number;
};

/**
 * Runtime state for browser snapshot expiration.
 * Separate from context pruning runtime since it works independently.
 */
export type BrowserSnapshotExpiryRuntimeValue = {
  settings: EffectiveBrowserSnapshotExpirySettings;
  /**
   * Active snapshots being tracked for expiration.
   * Keyed by toolCallId for efficient lookup and deduplication.
   */
  tracker: Map<string, BrowserSnapshotTrackerEntry>;
  /**
   * Set of toolCallIds that have already been expired.
   * Used to avoid re-processing already expired snapshots.
   */
  expiredIds: Set<string>;
  /**
   * Number of tool results seen in the last context event.
   * Used to detect new tool calls.
   */
  lastToolResultCount: number;
  /**
   * Number of user messages seen in the last context event.
   * Used to detect new user messages.
   */
  lastUserMessageCount: number;
};

// Session-scoped runtime registry keyed by object identity.
// Important: this relies on Pi passing the same SessionManager object instance into
// ExtensionContext (ctx.sessionManager) that we used when calling setContextPruningRuntime.
const REGISTRY = new WeakMap<object, ContextPruningRuntimeValue>();

// Separate registry for browser snapshot expiry runtime (works independently)
const BROWSER_SNAPSHOT_REGISTRY = new WeakMap<object, BrowserSnapshotExpiryRuntimeValue>();

export function setContextPruningRuntime(
  sessionManager: unknown,
  value: ContextPruningRuntimeValue | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }

  const key = sessionManager;
  if (value === null) {
    REGISTRY.delete(key);
    return;
  }

  REGISTRY.set(key, value);
}

export function getContextPruningRuntime(
  sessionManager: unknown,
): ContextPruningRuntimeValue | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }

  return REGISTRY.get(sessionManager) ?? null;
}

export function setBrowserSnapshotExpiryRuntime(
  sessionManager: unknown,
  value: BrowserSnapshotExpiryRuntimeValue | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }

  const key = sessionManager;
  if (value === null) {
    BROWSER_SNAPSHOT_REGISTRY.delete(key);
    return;
  }

  BROWSER_SNAPSHOT_REGISTRY.set(key, value);
}

export function getBrowserSnapshotExpiryRuntime(
  sessionManager: unknown,
): BrowserSnapshotExpiryRuntimeValue | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }

  return BROWSER_SNAPSHOT_REGISTRY.get(sessionManager) ?? null;
}

/**
 * Register a new browser snapshot for tracking.
 */
export function registerBrowserSnapshot(
  runtime: BrowserSnapshotExpiryRuntimeValue,
  toolCallId: string,
): void {
  // Don't track if already expired or already tracking
  if (runtime.expiredIds.has(toolCallId) || runtime.tracker.has(toolCallId)) {
    return;
  }

  runtime.tracker.set(toolCallId, {
    toolCallId,
    callsSince: 0,
  });
}

/**
 * Increment the call counter for all tracked snapshots.
 * Call this when a new tool call completes or a user message is received.
 */
export function incrementBrowserSnapshotCounters(runtime: BrowserSnapshotExpiryRuntimeValue): void {
  for (const entry of runtime.tracker.values()) {
    entry.callsSince += 1;
  }
}

/**
 * Get all snapshot toolCallIds that have exceeded the expiration threshold.
 */
export function getExpiredSnapshotIds(runtime: BrowserSnapshotExpiryRuntimeValue): string[] {
  const expired: string[] = [];
  const threshold = runtime.settings.toolCalls;

  for (const entry of runtime.tracker.values()) {
    if (entry.callsSince >= threshold) {
      expired.push(entry.toolCallId);
    }
  }

  return expired;
}

/**
 * Mark snapshots as expired and remove from active tracking.
 */
export function markSnapshotsExpired(
  runtime: BrowserSnapshotExpiryRuntimeValue,
  toolCallIds: string[],
): void {
  for (const id of toolCallIds) {
    runtime.tracker.delete(id);
    runtime.expiredIds.add(id);
  }
}
