import { describe, expect, it } from "vitest";
import { ProviderOverrideSchema, ProviderPricingSchema } from "./provider-config.js";

const rule = {
  model: "gpt-6.1-sol",
  serviceTier: "default",
  minInputTokens: 0,
  maxInputTokens: 272000,
  input: 2,
  cachedInput: 0.1,
  output: 10,
};

describe("provider pricing configuration", () => {
  it("accepts explicit zero rates while preserving the whole rate unit", () => {
    const pricing = [{ ...rule, input: 0, cachedInput: 0, output: 0 }];
    expect(ProviderOverrideSchema.parse({ pricing })).toEqual({ pricing });
  });

  it.each([-1, Infinity, NaN])("rejects invalid rates: %s", (value) => {
    expect(ProviderPricingSchema.safeParse([{ ...rule, input: value }]).success).toBe(false);
  });

  it("requires all three rates instead of treating missing values as free", () => {
    expect(
      ProviderPricingSchema.safeParse([
        { model: rule.model, serviceTier: "default", minInputTokens: 0, input: 0 },
      ]).success,
    ).toBe(false);
  });

  it("rejects overlapping ranges, including the shared inclusive boundary", () => {
    expect(
      ProviderPricingSchema.safeParse([rule, { ...rule, minInputTokens: 272000 }]).success,
    ).toBe(false);
    expect(
      ProviderPricingSchema.safeParse([
        rule,
        { ...rule, minInputTokens: 272001, maxInputTokens: 500000 },
      ]).success,
    ).toBe(true);
    expect(
      ProviderPricingSchema.safeParse([{ ...rule, minInputTokens: 1, maxInputTokens: 0 }]).success,
    ).toBe(false);
  });

  it("detects Fast/priority aliases as conflicting rules", () => {
    expect(
      ProviderPricingSchema.safeParse([
        { ...rule, serviceTier: "fast" },
        { ...rule, serviceTier: "priority" },
      ]).success,
    ).toBe(false);
  });
});
