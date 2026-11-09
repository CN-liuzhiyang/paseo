import { describe, expect, it } from "vitest";
import { buildLastUsage, formatCost } from "./inspect.js";

describe("inspect usage", () => {
  it("keeps unknown costs distinct from free usage and includes the metadata", () => {
    const snapshot = {
      lastUsage: {
        inputTokens: 42,
        costSource: "local-estimate",
        hasUnknownModelCost: true,
        tokenUsageScope: "session",
      },
    };
    expect(buildLastUsage(snapshot)).toEqual({
      InputTokens: 42,
      OutputTokens: 0,
      CachedTokens: 0,
      CostUsd: null,
      CostSource: "local-estimate",
      HasUnknownModelCost: true,
      TokenUsageScope: "session",
    });
    expect(formatCost(null)).toBe("Unknown");
    expect(formatCost(0)).toBe("$0.00");
  });
});
