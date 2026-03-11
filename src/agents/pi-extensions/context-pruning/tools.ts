import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../glob-pattern.js";
import type { ContextPruningToolMatch } from "./settings.js";

function normalizeGlob(value: string) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function makeToolPrunablePredicate(
  match: ContextPruningToolMatch,
): (toolName: string) => boolean {
  const deny = compileGlobPatterns({ raw: match.deny, normalize: normalizeGlob });
  const allow = compileGlobPatterns({ raw: match.allow, normalize: normalizeGlob });

  return (toolName: string) => {
    const normalized = normalizeGlob(toolName);
    if (matchesAnyGlobPattern(normalized, deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return matchesAnyGlobPattern(normalized, allow);
  };
}

/**
 * Find the tool call arguments for a given toolCallId by looking through messages.
 */
function findToolCallArguments(
  messages: AgentMessage[],
  toolCallId: string,
): Record<string, unknown> | null {
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "toolCall" && block.id === toolCallId) {
        return (block.arguments as Record<string, unknown>) ?? null;
      }
    }
  }
  return null;
}

/**
 * Check if a tool result message is from a browser snapshot action.
 * Looks up the original tool call to check if action === "snapshot".
 */
export function isBrowserSnapshotToolResult(
  message: AgentMessage,
  messages: AgentMessage[],
): boolean {
  if (message.role !== "toolResult") {
    return false;
  }

  const toolName = message.toolName?.toLowerCase().trim();
  if (toolName !== "browser") {
    return false;
  }

  const toolCallId = message.toolCallId;
  if (!toolCallId) {
    return false;
  }

  // Look up the original tool call to check the action parameter
  const args = findToolCallArguments(messages, toolCallId);
  if (!args) {
    return false;
  }

  const action = typeof args.action === "string" ? args.action.toLowerCase() : "";
  return action === "snapshot";
}
