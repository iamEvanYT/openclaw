import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  setBrowserSnapshotExpiryRuntime,
  type BrowserSnapshotExpiryRuntimeValue,
} from "./context-pruning/runtime.js";
import {
  BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER,
  DEFAULT_BROWSER_SNAPSHOT_EXPIRY_SETTINGS,
  computeBrowserSnapshotExpirySettings,
} from "./context-pruning/settings.js";
import { isBrowserSnapshotToolResult } from "./context-pruning/tools.js";
import { expireBrowserSnapshots } from "./context-pruning/pruner.js";
import contextPruningExtension from "./context-pruning/extension.js";
import {
  appendBrowserSnapshotState,
  BROWSER_SNAPSHOT_STATE_CUSTOM_TYPE,
  readBrowserSnapshotExpiredIds,
} from "../pi-embedded-runner/browser-snapshot-persistence.js";

function toolText(msg: AgentMessage): string {
  if (msg.role !== "toolResult") {
    throw new Error("expected toolResult");
  }
  const first = msg.content.find((b) => b.type === "text");
  if (!first || first.type !== "text") {
    return "";
  }
  return first.text;
}

function findToolResult(messages: AgentMessage[], toolCallId: string): AgentMessage {
  const msg = messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
  if (!msg) {
    throw new Error(`missing toolResult: ${toolCallId}`);
  }
  return msg;
}

/**
 * Create an assistant message with a tool call.
 */
function makeToolCall(params: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: params.toolCallId,
        name: params.toolName,
        arguments: params.args,
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function _makeToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: params.text }],
    isError: false,
    timestamp: Date.now(),
  };
}

/**
 * Create a browser snapshot tool call + result pair.
 * Returns [assistantWithToolCall, toolResult].
 */
function makeBrowserSnapshot(toolCallId: string): [AgentMessage, AgentMessage] {
  const toolCall = makeToolCall({
    toolCallId,
    toolName: "browser",
    args: { action: "snapshot" },
  });

  const snapshotContent = `- navigation [ref=e1]:
  - link "Home" [ref=e5]
  - link "About" [ref=e6]
- main:
  - heading "Welcome" [level=1]
  - button "Submit" [ref=e12]`;

  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId,
    toolName: "browser",
    content: [{ type: "text", text: snapshotContent }],
    isError: false,
    timestamp: Date.now(),
  };

  return [toolCall, toolResult];
}

/**
 * Create a browser status tool call + result pair.
 */
function makeBrowserStatus(toolCallId: string): [AgentMessage, AgentMessage] {
  const toolCall = makeToolCall({
    toolCallId,
    toolName: "browser",
    args: { action: "status" },
  });

  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId,
    toolName: "browser",
    content: [{ type: "text", text: '{"running": true, "profiles": ["default"]}' }],
    isError: false,
    timestamp: Date.now(),
  };

  return [toolCall, toolResult];
}

/**
 * Create a non-browser tool call + result pair.
 */
function makeExecTool(toolCallId: string, output: string): [AgentMessage, AgentMessage] {
  const toolCall = makeToolCall({
    toolCallId,
    toolName: "exec",
    args: { command: "echo test" },
  });

  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId,
    toolName: "exec",
    content: [{ type: "text", text: output }],
    isError: false,
    timestamp: Date.now(),
  };

  return [toolCall, toolResult];
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function createRuntime(
  overrides: Partial<BrowserSnapshotExpiryRuntimeValue> = {},
): BrowserSnapshotExpiryRuntimeValue {
  return {
    settings: { ...DEFAULT_BROWSER_SNAPSHOT_EXPIRY_SETTINGS },
    tracker: new Map(),
    expiredIds: new Set(),
    lastToolResultCount: 0,
    lastUserMessageCount: 0,
    ...overrides,
  };
}

describe("browser-snapshot-expiry", () => {
  describe("isBrowserSnapshotToolResult", () => {
    it("detects browser snapshot tool results by checking action parameter", () => {
      const [toolCall, toolResult] = makeBrowserSnapshot("t1");
      const messages = [toolCall, toolResult];
      expect(isBrowserSnapshotToolResult(toolResult, messages)).toBe(true);
    });

    it("returns false for browser status action", () => {
      const [toolCall, toolResult] = makeBrowserStatus("t1");
      const messages = [toolCall, toolResult];
      expect(isBrowserSnapshotToolResult(toolResult, messages)).toBe(false);
    });

    it("returns false for non-browser tool results", () => {
      const [toolCall, toolResult] = makeExecTool("t1", "output");
      const messages = [toolCall, toolResult];
      expect(isBrowserSnapshotToolResult(toolResult, messages)).toBe(false);
    });

    it("returns false when tool call is not found", () => {
      const [, toolResult] = makeBrowserSnapshot("t1");
      // No matching tool call in messages
      const messages = [toolResult];
      expect(isBrowserSnapshotToolResult(toolResult, messages)).toBe(false);
    });

    it("returns false for non-toolResult messages", () => {
      const messages: AgentMessage[] = [];
      expect(isBrowserSnapshotToolResult(makeUser("hello"), messages)).toBe(false);
      expect(isBrowserSnapshotToolResult(makeAssistant("hello"), messages)).toBe(false);
    });
  });

  describe("computeBrowserSnapshotExpirySettings", () => {
    it("returns defaults when config is empty", () => {
      const settings = computeBrowserSnapshotExpirySettings({});
      expect(settings.enabled).toBe(true);
      expect(settings.toolCalls).toBe(3);
    });

    it("returns defaults when config is null", () => {
      const settings = computeBrowserSnapshotExpirySettings(null);
      expect(settings.enabled).toBe(true);
      expect(settings.toolCalls).toBe(3);
    });

    it("respects enabled=false", () => {
      const settings = computeBrowserSnapshotExpirySettings({
        browserSnapshot: { expiry: { enabled: false } },
      });
      expect(settings.enabled).toBe(false);
    });

    it("respects custom toolCalls value", () => {
      const settings = computeBrowserSnapshotExpirySettings({
        browserSnapshot: { expiry: { toolCalls: 10 } },
      });
      expect(settings.toolCalls).toBe(10);
    });

    it("enforces minimum toolCalls of 1", () => {
      const settings = computeBrowserSnapshotExpirySettings({
        browserSnapshot: { expiry: { toolCalls: 0 } },
      });
      expect(settings.toolCalls).toBe(1);
    });
  });

  describe("expireBrowserSnapshots", () => {
    it("does not expire snapshots before threshold is reached", () => {
      const runtime = createRuntime();
      const [snapCall, snapResult] = makeBrowserSnapshot("snap1");
      const [exec1Call, exec1Result] = makeExecTool("t1", "out1");
      const [exec2Call, exec2Result] = makeExecTool("t2", "out2");

      const messages: AgentMessage[] = [
        makeUser("u1"),
        snapCall,
        snapResult,
        exec1Call,
        exec1Result,
        exec2Call,
        exec2Result,
        // Only 2 tool calls after snapshot, threshold is 3
      ];

      const result = expireBrowserSnapshots({ messages, runtime });

      // Snapshot should still be present
      expect(toolText(findToolResult(result, "snap1"))).toContain("navigation");
      expect(runtime.tracker.has("snap1")).toBe(true);
      expect(runtime.expiredIds.has("snap1")).toBe(false);
    });

    it("expires snapshots after exactly 3 tool calls (default threshold)", () => {
      const runtime = createRuntime();
      const [snapCall, snapResult] = makeBrowserSnapshot("snap1");

      // Stage 1: One user message + snapshot
      const stage1: AgentMessage[] = [makeUser("u1"), snapCall, snapResult];
      expireBrowserSnapshots({ messages: stage1, runtime });
      expect(runtime.tracker.has("snap1")).toBe(true);
      expect(runtime.tracker.get("snap1")?.callsSince).toBe(0);

      // Stage 2: Add 3 more tool results
      const [exec1Call, exec1Result] = makeExecTool("t1", "out1");
      const [exec2Call, exec2Result] = makeExecTool("t2", "out2");
      const [exec3Call, exec3Result] = makeExecTool("t3", "out3");

      const stage2: AgentMessage[] = [
        makeUser("u1"),
        snapCall,
        snapResult,
        exec1Call,
        exec1Result,
        exec2Call,
        exec2Result,
        exec3Call,
        exec3Result,
      ];
      const result = expireBrowserSnapshots({ messages: stage2, runtime });

      // Snapshot should be expired (3 new tool calls since registration)
      expect(toolText(findToolResult(result, "snap1"))).toBe(BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER);
      expect(runtime.tracker.has("snap1")).toBe(false);
      expect(runtime.expiredIds.has("snap1")).toBe(true);
    });

    it("expires old snapshots immediately when a new snapshot is taken", () => {
      const runtime = createRuntime();
      const [snap1Call, snap1Result] = makeBrowserSnapshot("snap1");

      // Stage 1: Register snap1
      const stage1: AgentMessage[] = [makeUser("u1"), snap1Call, snap1Result];
      expireBrowserSnapshots({ messages: stage1, runtime });
      expect(runtime.tracker.has("snap1")).toBe(true);
      expect(runtime.tracker.get("snap1")?.callsSince).toBe(0);

      // Stage 2: Take a new snapshot - snap1 should expire immediately
      const [snap2Call, snap2Result] = makeBrowserSnapshot("snap2");
      const stage2: AgentMessage[] = [
        makeUser("u1"),
        snap1Call,
        snap1Result,
        snap2Call,
        snap2Result,
      ];
      const result = expireBrowserSnapshots({ messages: stage2, runtime });

      // snap1 should be expired immediately due to new snapshot
      expect(toolText(findToolResult(result, "snap1"))).toBe(BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER);
      expect(runtime.expiredIds.has("snap1")).toBe(true);
      // snap2 should be registered and active
      expect(runtime.tracker.has("snap2")).toBe(true);
      expect(toolText(findToolResult(result, "snap2"))).toContain("navigation");
    });

    it("increments counter on user messages", () => {
      const runtime = createRuntime();
      const [snapCall, snapResult] = makeBrowserSnapshot("snap1");

      // Stage 1: Register snapshot
      const stage1: AgentMessage[] = [makeUser("u1"), snapCall, snapResult];
      expireBrowserSnapshots({ messages: stage1, runtime });
      expect(runtime.tracker.has("snap1")).toBe(true);

      // Stage 2: Add 3 user messages (default threshold is 3)
      const stage2: AgentMessage[] = [
        makeUser("u1"),
        snapCall,
        snapResult,
        makeUser("u2"),
        makeUser("u3"),
        makeUser("u4"), // 3 new user messages
      ];
      const result = expireBrowserSnapshots({ messages: stage2, runtime });

      // Snapshot should be expired
      expect(toolText(findToolResult(result, "snap1"))).toBe(BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER);
    });

    it("does not expire the newest snapshot when multiple snapshots are taken", () => {
      const runtime = createRuntime();
      const [snap1Call, snap1Result] = makeBrowserSnapshot("snap1");
      const [exec1Call, exec1Result] = makeExecTool("t1", "out1");
      const [snap2Call, snap2Result] = makeBrowserSnapshot("snap2");

      // All in one go - snap1 and snap2 registered, snap1 should expire, snap2 should survive
      const messages: AgentMessage[] = [
        makeUser("u1"),
        snap1Call,
        snap1Result,
        exec1Call,
        exec1Result,
        snap2Call,
        snap2Result,
      ];

      const result = expireBrowserSnapshots({ messages, runtime });

      // snap1 was registered first, then snap2 was detected, causing snap1 to expire
      expect(toolText(findToolResult(result, "snap1"))).toBe(BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER);
      // snap2 is the newest, should be kept
      expect(toolText(findToolResult(result, "snap2"))).toContain("navigation");
      expect(runtime.tracker.has("snap2")).toBe(true);
    });

    it("does nothing when disabled", () => {
      const runtime = createRuntime({
        settings: { enabled: false, toolCalls: 3 },
      });

      const [snapCall, snapResult] = makeBrowserSnapshot("snap1");
      const [exec1Call, exec1Result] = makeExecTool("t1", "out1");
      const [exec2Call, exec2Result] = makeExecTool("t2", "out2");
      const [exec3Call, exec3Result] = makeExecTool("t3", "out3");

      const messages: AgentMessage[] = [
        makeUser("u1"),
        snapCall,
        snapResult,
        exec1Call,
        exec1Result,
        exec2Call,
        exec2Result,
        exec3Call,
        exec3Result,
      ];

      const result = expireBrowserSnapshots({ messages, runtime });

      // Snapshot should still be present
      expect(toolText(findToolResult(result, "snap1"))).toContain("navigation");
    });

    it("uses static placeholder text for prompt caching", () => {
      // Verify the placeholder is a constant string
      expect(BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER).toBe(
        "[Browser snapshot expired - content cleared]",
      );

      // Run expiration and verify the exact placeholder is used
      const runtime = createRuntime({ settings: { enabled: true, toolCalls: 1 } });
      const [snapCall, snapResult] = makeBrowserSnapshot("snap1");

      // Stage 1: Just the user and snapshot
      const stage1: AgentMessage[] = [makeUser("u1"), snapCall, snapResult];

      // First call registers the snapshot with callsSince: 0
      expireBrowserSnapshots({ messages: stage1, runtime });
      expect(runtime.tracker.has("snap1")).toBe(true);
      expect(runtime.tracker.get("snap1")!.callsSince).toBe(0);

      // Stage 2: Add another tool result
      const [exec1Call, exec1Result] = makeExecTool("t1", "out1");
      const stage2: AgentMessage[] = [makeUser("u1"), snapCall, snapResult, exec1Call, exec1Result];

      // Second call: sees 1 new tool result, increments callsSince to 1, expires snapshot
      const result = expireBrowserSnapshots({ messages: stage2, runtime });

      expect(toolText(findToolResult(result, "snap1"))).toBe(
        "[Browser snapshot expired - content cleared]",
      );
    });

    it("does not re-expire already expired snapshots", () => {
      const runtime = createRuntime();
      runtime.expiredIds.add("snap1");

      const [snapCall, snapResult] = makeBrowserSnapshot("snap1");
      const messages: AgentMessage[] = [makeUser("u1"), snapCall, snapResult];

      expireBrowserSnapshots({ messages, runtime });

      // Should not be tracked again
      expect(runtime.tracker.has("snap1")).toBe(false);
    });
  });

  describe("extension integration", () => {
    it("browser snapshot expiration works without context pruning enabled", () => {
      const sessionManager = {};

      setBrowserSnapshotExpiryRuntime(sessionManager, {
        settings: { enabled: true, toolCalls: 2 },
        tracker: new Map(),
        expiredIds: new Set(),
        lastToolResultCount: 0,
        lastUserMessageCount: 0,
      });

      // No context pruning runtime set (mode is "off")

      const [snapCall, snapResult] = makeBrowserSnapshot("snap1");
      const [exec1Call, exec1Result] = makeExecTool("t1", "out1");
      const [exec2Call, exec2Result] = makeExecTool("t2", "out2");

      const messages: AgentMessage[] = [
        makeUser("u1"),
        snapCall,
        snapResult,
        exec1Call,
        exec1Result,
        exec2Call,
        exec2Result,
      ];

      let handler:
        | ((
            event: { messages: AgentMessage[] },
            ctx: ExtensionContext,
          ) => { messages: AgentMessage[] } | undefined)
        | undefined;

      const api = {
        on: (name: string, fn: unknown) => {
          if (name === "context") {
            handler = fn as typeof handler;
          }
        },
        appendEntry: (_type: string, _data?: unknown) => {},
      } as unknown as ExtensionAPI;

      contextPruningExtension(api);

      if (!handler) {
        throw new Error("missing context handler");
      }

      // First call registers the snapshot
      handler({ messages: messages.slice(0, 3) }, {
        model: undefined,
        sessionManager,
      } as unknown as ExtensionContext);

      // Second call should expire it
      const result = handler({ messages }, {
        model: undefined,
        sessionManager,
      } as unknown as ExtensionContext);

      if (!result) {
        throw new Error("expected handler to return messages");
      }

      expect(toolText(findToolResult(result.messages, "snap1"))).toBe(
        BROWSER_SNAPSHOT_EXPIRED_PLACEHOLDER,
      );
    });
  });

  describe("persistence", () => {
    it("reads expired IDs from session custom entries", () => {
      const mockEntries = [
        { type: "custom", customType: "other", data: {} },
        {
          type: "custom",
          customType: BROWSER_SNAPSHOT_STATE_CUSTOM_TYPE,
          data: { timestamp: Date.now(), expiredIds: ["snap1", "snap2"] },
        },
      ];

      const sessionManager = {
        getEntries: () => mockEntries,
      };

      const expiredIds = readBrowserSnapshotExpiredIds(sessionManager);
      expect(expiredIds.has("snap1")).toBe(true);
      expect(expiredIds.has("snap2")).toBe(true);
      expect(expiredIds.size).toBe(2);
    });

    it("returns empty set when no persisted state exists", () => {
      const sessionManager = {
        getEntries: () => [],
      };

      const expiredIds = readBrowserSnapshotExpiredIds(sessionManager);
      expect(expiredIds.size).toBe(0);
    });

    it("returns empty set when sessionManager has no getEntries", () => {
      const expiredIds = readBrowserSnapshotExpiredIds({});
      expect(expiredIds.size).toBe(0);
    });

    it("appends state to session custom entries", () => {
      const appendedEntries: Array<{ type: string; data: unknown }> = [];
      const sessionManager = {
        appendCustomEntry: (customType: string, data: unknown) => {
          appendedEntries.push({ type: customType, data });
        },
      };

      const expiredIds = new Set(["snap1", "snap2"]);
      appendBrowserSnapshotState(sessionManager, expiredIds);

      expect(appendedEntries.length).toBe(1);
      expect(appendedEntries[0].type).toBe(BROWSER_SNAPSHOT_STATE_CUSTOM_TYPE);
      const data = appendedEntries[0].data as { expiredIds: string[] };
      expect(data.expiredIds).toContain("snap1");
      expect(data.expiredIds).toContain("snap2");
    });

    it("does not append when expiredIds is empty", () => {
      const appendedEntries: Array<{ type: string; data: unknown }> = [];
      const sessionManager = {
        appendCustomEntry: (customType: string, data: unknown) => {
          appendedEntries.push({ type: customType, data });
        },
      };

      appendBrowserSnapshotState(sessionManager, new Set());

      expect(appendedEntries.length).toBe(0);
    });

    it("expired IDs survive across session restarts", () => {
      // Simulate persisted state from a previous session
      const mockEntries = [
        {
          type: "custom",
          customType: BROWSER_SNAPSHOT_STATE_CUSTOM_TYPE,
          data: { timestamp: Date.now(), expiredIds: ["snap1"] },
        },
      ];

      const sessionManager = {
        getEntries: () => mockEntries,
      };

      // Load persisted expired IDs (as would happen on startup)
      const persistedExpiredIds = readBrowserSnapshotExpiredIds(sessionManager);

      // Create runtime with persisted state
      const runtime = createRuntime({
        expiredIds: persistedExpiredIds,
      });

      // snap1 is already in expiredIds, so it shouldn't be tracked again
      const [snapCall, snapResult] = makeBrowserSnapshot("snap1");
      const messages: AgentMessage[] = [
        makeUser("u1"),
        snapCall,
        snapResult, // This was expired before restart
      ];

      expireBrowserSnapshots({ messages, runtime });

      // snap1 should NOT be tracked (it's already expired from previous session)
      expect(runtime.tracker.has("snap1")).toBe(false);
      expect(runtime.expiredIds.has("snap1")).toBe(true);
    });
  });
});
