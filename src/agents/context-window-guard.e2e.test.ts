import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyContextWindowCap,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  it("blocks below 16k (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 8000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.source).toBe("model");
    expect(guard.tokens).toBe(8000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("warns below 32k but does not block at 16k+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "small",
      modelContextWindow: 24_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.tokens).toBe(24_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not warn at 32k+ (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "openai",
      modelId: "ok",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("uses models.providers.*.models[].contextWindow when present", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "http://localhost",
            apiKey: "x",
            models: [
              {
                id: "tiny",
                name: "tiny",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 12_000,
                maxTokens: 256,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      provider: "openrouter",
      modelId: "tiny",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("modelsConfig");
    expect(guard.shouldBlock).toBe(true);
  });

  it("caps with agents.defaults.contextTokens", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 20_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 200_000,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("agentContextTokens");
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not override when cap exceeds base window", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 128_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      provider: "anthropic",
      modelId: "whatever",
      modelContextWindow: 64_000,
      defaultTokens: 200_000,
    });
    expect(info.source).toBe("model");
    expect(info.tokens).toBe(64_000);
  });

  it("uses default when nothing else is available", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      provider: "anthropic",
      modelId: "unknown",
      modelContextWindow: undefined,
      defaultTokens: 200_000,
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("default");
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("allows overriding thresholds", () => {
    const info = { tokens: 10_000, source: "model" as const };
    const guard = evaluateContextWindowGuard({
      info,
      warnBelowTokens: 12_000,
      hardMinTokens: 9_000,
    });
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("exports thresholds as expected", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(32_000);
  });
});

describe("applyContextWindowCap", () => {
  it("caps model contextWindow when info.tokens is smaller", () => {
    const model = { id: "test", contextWindow: 200_000, provider: "anthropic" };
    const info = { tokens: 32_000, source: "agentContextTokens" as const };
    const result = applyContextWindowCap(model, info);
    expect(result.contextWindow).toBe(32_000);
    expect(result.id).toBe("test");
    expect(result.provider).toBe("anthropic");
    // Should be a new object, not mutating original
    expect(result).not.toBe(model);
    expect(model.contextWindow).toBe(200_000);
  });

  it("returns model unchanged when info.tokens >= model.contextWindow", () => {
    const model = { id: "test", contextWindow: 64_000, provider: "openai" };
    const info = { tokens: 128_000, source: "default" as const };
    const result = applyContextWindowCap(model, info);
    expect(result).toBe(model); // Same reference
    expect(result.contextWindow).toBe(64_000);
  });

  it("returns model unchanged when info.tokens equals model.contextWindow", () => {
    const model = { id: "test", contextWindow: 64_000, provider: "openai" };
    const info = { tokens: 64_000, source: "model" as const };
    const result = applyContextWindowCap(model, info);
    expect(result).toBe(model);
  });

  it("handles model with undefined contextWindow", () => {
    const model = { id: "test", provider: "custom", contextWindow: undefined };
    const info = { tokens: 32_000, source: "agentContextTokens" as const };
    const result = applyContextWindowCap(model, info);
    expect(result.contextWindow).toBe(32_000);
    expect(result).not.toBe(model);
  });

  it("preserves all model properties when capping", () => {
    const model = {
      id: "claude-4",
      contextWindow: 200_000,
      provider: "anthropic",
      api: "anthropic" as const,
      maxTokens: 8192,
      reasoning: true,
    };
    const info = { tokens: 50_000, source: "agentContextTokens" as const };
    const result = applyContextWindowCap(model, info);
    expect(result).toEqual({
      ...model,
      contextWindow: 50_000,
    });
  });
});
