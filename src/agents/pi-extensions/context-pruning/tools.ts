import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { ContextPruningToolMatch } from "./settings.js";

function normalizePatterns(patterns?: string[]): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return patterns
    .map((p) =>
      String(p ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function compilePattern(pattern: string): CompiledPattern {
  if (pattern === "*") {
    return { kind: "all" };
  }
  if (!pattern.includes("*")) {
    return { kind: "exact", value: pattern };
  }

  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`);
  return { kind: "regex", value: re };
}

function compilePatterns(patterns?: string[]): CompiledPattern[] {
  return normalizePatterns(patterns).map(compilePattern);
}

function matchesAny(toolName: string, patterns: CompiledPattern[]): boolean {
  for (const p of patterns) {
    if (p.kind === "all") {
      return true;
    }
    if (p.kind === "exact" && toolName === p.value) {
      return true;
    }
    if (p.kind === "regex" && p.value.test(toolName)) {
      return true;
    }
  }
  return false;
}

export function makeToolPrunablePredicate(
  match: ContextPruningToolMatch,
): (toolName: string) => boolean {
  const deny = compilePatterns(match.deny);
  const allow = compilePatterns(match.allow);

  return (toolName: string) => {
    const normalized = toolName.trim().toLowerCase();
    if (matchesAny(normalized, deny)) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return matchesAny(normalized, allow);
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
