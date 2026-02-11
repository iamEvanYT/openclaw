import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";

describe("memory flush settings", () => {
  it("defaults to enabled with fallback prompt and system prompt", () => {
    const settings = resolveMemoryFlushSettings();
    expect(settings).not.toBeNull();
    expect(settings?.enabled).toBe(true);
    expect(settings?.prompt.length).toBeGreaterThan(0);
    expect(settings?.systemPrompt.length).toBeGreaterThan(0);
  });

  it("respects disable flag", () => {
    expect(
      resolveMemoryFlushSettings({
        agents: {
          defaults: { compaction: { memoryFlush: { enabled: false } } },
        },
      }),
    ).toBeNull();
  });

  it("appends NO_REPLY hint when missing", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              prompt: "Write memories now.",
              systemPrompt: "Flush memory.",
            },
          },
        },
      },
    });
    expect(settings?.prompt).toContain("NO_REPLY");
    expect(settings?.systemPrompt).toContain("NO_REPLY");
  });

  it("defaults alwaysExecute to false", () => {
    const settings = resolveMemoryFlushSettings();
    expect(settings?.alwaysExecute).toBe(false);
  });

  it("respects alwaysExecute when set to true", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: { alwaysExecute: true },
          },
        },
      },
    });
    expect(settings?.alwaysExecute).toBe(true);
  });
});

describe("shouldRunMemoryFlush", () => {
  it("requires totalTokens and threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 0 },
        contextWindowTokens: 16_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when entry is missing", () => {
    expect(
      shouldRunMemoryFlush({
        entry: undefined,
        contextWindowTokens: 16_000,
        reserveTokensFloor: 1_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when under threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 10_000 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 10_000,
      }),
    ).toBe(false);
  });

  it("triggers at the threshold boundary", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 85 },
        contextWindowTokens: 100,
        reserveTokensFloor: 10,
        softThresholdTokens: 5,
      }),
    ).toBe(true);
  });

  it("skips when already flushed for current compaction count", () => {
    expect(
      shouldRunMemoryFlush({
        entry: {
          totalTokens: 90_000,
          compactionCount: 2,
          memoryFlushCompactionCount: 2,
        },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });

  it("runs when above threshold and not flushed", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 96_000, compactionCount: 1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(true);
  });

  it("ignores stale cached totals", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 96_000, totalTokensFresh: false, compactionCount: 1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });
});

describe("resolveMemoryFlushContextWindowTokens", () => {
  it("falls back to default when nothing is set", () => {
    expect(resolveMemoryFlushContextWindowTokens({})).toBe(200_000);
  });

  it("uses agentCfgContextTokens when set", () => {
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 42_000 })).toBe(42_000);
  });

  it("uses agentCfgContextTokens even when larger than model default", () => {
    // No model in cache, so model lookup returns undefined.
    // agentCfgContextTokens is the user's explicit setting and should win.
    expect(
      resolveMemoryFlushContextWindowTokens({
        modelId: "unknown-model",
        agentCfgContextTokens: 300_000,
      }),
    ).toBe(300_000);
  });

  it("ignores non-positive agentCfgContextTokens", () => {
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 0 })).toBe(200_000);
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: -1 })).toBe(200_000);
  });
});
