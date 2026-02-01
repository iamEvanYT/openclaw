/**
 * Persistence utilities for browser snapshot expiration state.
 * Uses SessionManager custom entries to persist expiredIds across session restarts.
 */

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

export const BROWSER_SNAPSHOT_STATE_CUSTOM_TYPE = "openclaw.browser-snapshot-expiry";

export type BrowserSnapshotStateEntryData = {
  /** Timestamp when this state was persisted */
  timestamp: number;
  /** Set of toolCallIds that have been expired (serialized as array) */
  expiredIds: string[];
};

/**
 * Read the last persisted browser snapshot expiry state from the session.
 * Returns the set of expired toolCallIds, or an empty set if not found.
 */
export function readBrowserSnapshotExpiredIds(sessionManager: unknown): Set<string> {
  const sm = sessionManager as { getEntries?: () => CustomEntryLike[] };
  if (!sm?.getEntries) {
    return new Set();
  }
  try {
    const entries = sm.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== BROWSER_SNAPSHOT_STATE_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as Partial<BrowserSnapshotStateEntryData> | undefined;
      if (data && Array.isArray(data.expiredIds)) {
        return new Set(data.expiredIds.filter((id) => typeof id === "string"));
      }
    }
  } catch {
    return new Set();
  }
  return new Set();
}

/**
 * Persist the browser snapshot expiry state to the session.
 * Only writes if there are expired IDs to persist.
 */
export function appendBrowserSnapshotState(sessionManager: unknown, expiredIds: Set<string>): void {
  if (expiredIds.size === 0) {
    return;
  }
  const sm = sessionManager as {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  if (!sm?.appendCustomEntry) {
    return;
  }
  try {
    const data: BrowserSnapshotStateEntryData = {
      timestamp: Date.now(),
      expiredIds: Array.from(expiredIds),
    };
    sm.appendCustomEntry(BROWSER_SNAPSHOT_STATE_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}
