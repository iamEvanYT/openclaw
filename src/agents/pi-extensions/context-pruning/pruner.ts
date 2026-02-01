import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { log } from "./logger.js";
import type { BrowserSnapshotExpiryRuntimeValue } from "./runtime.js";
import {
  BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER,
  type EffectiveContextPruningSettings,
} from "./settings.js";
import { isBrowserSnapshotToolResult, makeToolPrunablePredicate } from "./tools.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
// We currently skip pruning tool results that contain images. Still, we count them (approx.) so
// we start trimming prunable tool results earlier when image-heavy context is consuming the window.
const IMAGE_CHAR_ESTIMATE = 8_000;

function asText(text: string): TextContent {
  return { type: "text", text };
}

function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  // Joined with "\n" separators between blocks.
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
  for (const block of content) {
    if (block.type === "image") {
      return true;
    }
  }
  return false;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return content.length;
    }
    let chars = 0;
    for (const b of content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "thinking") {
        chars += b.thinking.length;
      }
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    let chars = 0;
    for (const b of message.content) {
      if (b.type === "text") {
        chars += b.text.length;
      }
      if (b.type === "image") {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

function findAssistantCutoffIndex(
  messages: AgentMessage[],
  keepLastAssistants: number,
): number | null {
  // keepLastAssistants <= 0 => everything is potentially prunable.
  if (keepLastAssistants <= 0) {
    return messages.length;
  }

  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") {
      continue;
    }
    remaining--;
    if (remaining === 0) {
      return i;
    }
  }

  // Not enough assistant messages to establish a protected tail.
  return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  // Ignore image tool results for now: these are often directly relevant and hard to partially prune safely.
  if (hasImageBlocks(msg.content)) {
    return null;
  }

  const parts = collectTextSegments(msg.content);
  const rawLen = estimateJoinedTextLength(parts);
  if (rawLen <= settings.softTrim.maxChars) {
    return null;
  }

  const headChars = Math.max(0, settings.softTrim.headChars);
  const tailChars = Math.max(0, settings.softTrim.tailChars);
  if (headChars + tailChars >= rawLen) {
    return null;
  }

  const head = takeHeadFromJoinedText(parts, headChars);
  const tail = takeTailFromJoinedText(parts, tailChars);
  const trimmed = `${head}
...
${tail}`;

  const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  isToolPrunable?: (toolName: string) => boolean;
  contextWindowTokensOverride?: number;
}): AgentMessage[] {
  const { messages, settings, ctx } = params;
  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return messages;
  }

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) {
    return messages;
  }

  const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return messages;
  }

  // Bootstrap safety: never prune anything before the first user message. This protects initial
  // "identity" reads (SOUL.md, USER.md, etc.) which typically happen before the first inbound user
  // message exists in the session transcript.
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

  const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);

  const totalCharsBefore = estimateContextChars(messages);
  let totalChars = totalCharsBefore;
  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) {
    return messages;
  }

  const prunableToolIndexes: number[] = [];
  let next: AgentMessage[] | null = null;

  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (!isToolPrunable(msg.toolName)) {
      continue;
    }
    if (hasImageBlocks(msg.content)) {
      continue;
    }
    prunableToolIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!updated) {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated as unknown as AgentMessage;
  }

  const outputAfterSoftTrim = next ?? messages;
  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    return outputAfterSoftTrim;
  }

  let prunableToolChars = 0;
  for (const i of prunableToolIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return outputAfterSoftTrim;
  }

  for (const i of prunableToolIndexes) {
    if (ratio < settings.hardClearRatio) {
      break;
    }
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const cleared: ToolResultMessage = {
      ...msg,
      content: [asText(settings.hardClear.placeholder)],
    };
    if (!next) {
      next = messages.slice();
    }
    next[i] = cleared as unknown as AgentMessage;
    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }

  return next ?? messages;
}

/**
 * Expire browser snapshots that have exceeded the tool call threshold,
 * or when a new browser snapshot is taken (which immediately expires all older ones).
 *
 * This function:
 * 1. Scans messages for new browser snapshots
 * 2. If a new snapshot is found, expires all existing tracked snapshots immediately
 * 3. If multiple new snapshots are found, only keeps the last one
 * 4. Detects new tool calls and user messages to increment counters
 * 5. Replaces expired snapshot content with a static placeholder
 *
 * @returns The modified messages array (or original if no changes)
 */
export function expireBrowserSnapshots(params: {
  messages: AgentMessage[];
  runtime: BrowserSnapshotExpiryRuntimeValue;
}): AgentMessage[] {
  const { messages, runtime } = params;

  if (!runtime.settings.enabled) {
    return messages;
  }

  // Count current tool results and user messages
  let currentToolResultCount = 0;
  let currentUserMessageCount = 0;
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      currentToolResultCount++;
    } else if (msg.role === "user") {
      currentUserMessageCount++;
    }
  }

  // Detect new tool calls or user messages since last check
  const newToolCalls = Math.max(0, currentToolResultCount - runtime.lastToolResultCount);
  const newUserMessages = Math.max(0, currentUserMessageCount - runtime.lastUserMessageCount);
  const incrementCount = newToolCalls + newUserMessages;

  // Update counts for next time
  runtime.lastToolResultCount = currentToolResultCount;
  runtime.lastUserMessageCount = currentUserMessageCount;

  // Increment counters for all tracked snapshots
  if (incrementCount > 0) {
    for (const entry of runtime.tracker.values()) {
      entry.callsSince += incrementCount;
    }
  }

  // Scan for new browser snapshots in order
  // If we find a new snapshot, expire all existing tracked snapshots immediately
  // If multiple new snapshots exist, only the last one survives
  const newSnapshotIds: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "toolResult") {
      continue;
    }
    const toolCallId = msg.toolCallId;
    if (!toolCallId) {
      continue;
    }
    // Skip if already tracking or already expired
    if (runtime.tracker.has(toolCallId) || runtime.expiredIds.has(toolCallId)) {
      continue;
    }
    // Check if this is a browser snapshot
    if (isBrowserSnapshotToolResult(msg, messages)) {
      newSnapshotIds.push(toolCallId);
    }
  }

  // If new snapshots were found, expire all existing tracked snapshots
  if (newSnapshotIds.length > 0 && runtime.tracker.size > 0) {
    for (const entry of runtime.tracker.values()) {
      // Force expire by setting callsSince to threshold
      entry.callsSince = runtime.settings.toolCalls;
    }
  }

  // If multiple new snapshots found, only keep the last one (expire the rest)
  // Register only the last snapshot; mark all earlier ones as needing expiration
  const snapshotsToExpire: string[] = [];
  if (newSnapshotIds.length > 1) {
    // All but the last are immediately expired
    for (let i = 0; i < newSnapshotIds.length - 1; i++) {
      snapshotsToExpire.push(newSnapshotIds[i]);
    }
  }

  // Register only the last new snapshot (if any)
  if (newSnapshotIds.length > 0) {
    const lastSnapshotId = newSnapshotIds[newSnapshotIds.length - 1];
    runtime.tracker.set(lastSnapshotId, {
      toolCallId: lastSnapshotId,
      callsSince: 0,
    });
  }

  // Find expired snapshots (by threshold OR forced by new snapshot)
  const expiredIds: string[] = [...snapshotsToExpire];
  const threshold = runtime.settings.toolCalls;

  for (const entry of runtime.tracker.values()) {
    if (entry.callsSince >= threshold) {
      expiredIds.push(entry.toolCallId);
    }
  }

  if (expiredIds.length === 0) {
    return messages;
  }

  // Log once when snapshots expire
  log.info("browser snapshot expired", { count: expiredIds.length });

  // Create a set for O(1) lookup
  const expiredSet = new Set(expiredIds);

  // Replace expired snapshot content with placeholder
  let next: AgentMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "toolResult") {
      continue;
    }
    const toolCallId = msg.toolCallId;
    if (!toolCallId || !expiredSet.has(toolCallId)) {
      continue;
    }

    // Replace content with static placeholder
    const expired: ToolResultMessage = {
      ...msg,
      content: [asText(BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER)],
    };

    if (!next) {
      next = messages.slice();
    }
    next[i] = expired as unknown as AgentMessage;

    // Mark as expired and remove from active tracking
    runtime.tracker.delete(toolCallId);
    runtime.expiredIds.add(toolCallId);
  }

  return next ?? messages;
}
