import { describe, expect, it } from "vitest";
import {
  accumulateCodexUsage,
  createCodexUsageState,
  type CodexUsageState,
} from "./usage-accumulator.js";
import { findUsagePrice } from "./usage-pricing.js";

const context = { model: "gpt-6.1-sol", serviceTier: "default" };
const last = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 };

function update(
  state: CodexUsageState,
  multiplier = 1,
  model = context.model,
  serviceTier = "default",
) {
  return accumulateCodexUsage({
    state,
    context: { model, serviceTier },
    tokenUsage: {
      total: {
        inputTokens: 100 * multiplier,
        cachedInputTokens: 80 * multiplier,
        outputTokens: 10 * multiplier,
      },
      last: { ...last, totalTokens: 110 },
      modelContextWindow: 200000,
    },
  });
}

describe("Codex cumulative pricing", () => {
  it("prices only new usage and keeps context independent from session totals", () => {
    const first = update(createCodexUsageState({ resumed: false }));
    const second = update(first.state, 2);
    const duplicate = update(second.state, 2, "unknown", "unknown");
    expect(second.usage).toEqual({
      inputTokens: 200,
      cachedInputTokens: 160,
      outputTokens: 20,
      tokenUsageScope: "session",
      contextWindowUsedTokens: 110,
      contextWindowMaxTokens: 200000,
      costSource: "local-estimate",
      hasUnknownModelCost: false,
      totalCostUsd: 0.000296,
    });
    expect(duplicate).toEqual(second);
  });

  it("prices model and service tier switches at their original rates", () => {
    const first = update(createCodexUsageState({ resumed: false }));
    const second = update(first.state, 2, "gpt-6.1-terra", "fast");
    const third = update(second.state, 3, "gpt-6.1-sol", "flex");
    expect(third.usage.totalCostUsd).toBeCloseTo(0.00037, 12);
    expect(findUsagePrice({ ...context, serviceTier: "priority" }, 100)).toEqual(
      findUsagePrice({ ...context, serviceTier: "fast" }, 100),
    );
  });

  it("uses the single response input for the long context boundary", () => {
    expect(findUsagePrice(context, 272000)?.input).toBe(2);
    expect(findUsagePrice(context, 272001)?.input).toBe(4);
    const response = { inputTokens: 300000, cachedInputTokens: 200000, outputTokens: 1000 };
    const result = accumulateCodexUsage({
      state: createCodexUsageState({ resumed: false }),
      context,
      tokenUsage: { total: response, last: response },
    });
    expect(result.usage.totalCostUsd).toBe(0.455);
  });

  it.each([
    ["unknown-model", "default"],
    ["gpt-6.1-sol-preview", "default"],
    ["gpt-6.1-sol", "unknown-tier"],
  ])("never guesses a price for %s / %s", (model, serviceTier) => {
    const result = update(createCodexUsageState({ resumed: false }), 1, model, serviceTier);
    expect(result.usage.hasUnknownModelCost).toBe(true);
    expect(result.usage).not.toHaveProperty("totalCostUsd");
    expect(update(result.state, 2).usage).not.toHaveProperty("totalCostUsd");
  });

  it("supports explicit free prices", () => {
    const result = accumulateCodexUsage({
      state: createCodexUsageState({ resumed: false }),
      context,
      prices: [{ ...context, minInputTokens: 0, input: 0, cachedInput: 0, output: 0 }],
      tokenUsage: { total: last, last },
    });
    expect(result.usage.totalCostUsd).toBe(0);
    expect(result.usage.hasUnknownModelCost).toBe(false);
  });

  it("restores a priced baseline without charging the replay twice", () => {
    const first = update(createCodexUsageState({ resumed: false }));
    const restored = createCodexUsageState({ resumed: true, lastUsage: first.usage });
    expect(update(restored)).toEqual(first);
    expect(update(restored, 2)).toEqual(update(first.state, 2));
  });

  it("leaves resumed history unknown without a priced baseline", () => {
    const old = update(createCodexUsageState({ resumed: true }));
    expect(old.usage).not.toHaveProperty("totalCostUsd");
    const restored = createCodexUsageState({ resumed: true, lastUsage: old.usage });
    expect(update(restored, 2).usage.hasUnknownModelCost).toBe(true);
  });

  it("invalidates incomplete, coalesced, or regressing usage without stale cost", () => {
    const first = update(createCodexUsageState({ resumed: false }));
    for (const tokenUsage of [
      { last },
      { total: { ...last, inputTokens: 300 }, last },
      { total: { ...last, inputTokens: 90 }, last },
      { total: { ...last, cachedInputTokens: 101 }, last },
    ]) {
      const result = accumulateCodexUsage({ state: first.state, context, tokenUsage });
      expect(result.usage.hasUnknownModelCost).toBe(true);
      expect(result.usage).not.toHaveProperty("totalCostUsd");
    }
  });
});

it("replays a numeric session fixture against the independently calculated API estimate", () => {
  const rows = [
    [19230, 10240, 125, 19230, 10240, 125],
    [44801, 29440, 340, 25571, 19200, 215],
    [80323, 55040, 615, 35522, 25600, 275],
    [127406, 90624, 747, 47083, 35584, 132],
    [184601, 137600, 874, 57195, 46976, 127],
    [248677, 194688, 1160, 64076, 57088, 286],
    [320058, 258816, 1390, 71381, 64128, 230],
    [398439, 330240, 2014, 78381, 71424, 624],
    [477767, 409088, 2489, 79328, 78848, 475],
    [557783, 488704, 2839, 80016, 79616, 350],
    [644755, 568832, 3314, 86972, 80128, 475],
    [743791, 656128, 3886, 99036, 87296, 572],
    [844319, 755584, 4196, 100528, 99456, 310],
    [949456, 856192, 4475, 105137, 100608, 279],
    [1060615, 961408, 4907, 111159, 105216, 432],
    [1177922, 1072768, 5486, 117307, 111360, 579],
    [1301945, 1190528, 5857, 124023, 117760, 371],
    [1430003, 1314688, 6802, 128058, 124160, 945],
    [1563727, 1443456, 7078, 133724, 128768, 276],
    [1701993, 1577216, 7576, 138266, 133760, 498],
    [1847071, 1715840, 7938, 145078, 138624, 362],
    [1996047, 1861120, 8211, 148976, 145280, 273],
    [2145445, 2010240, 8396, 149398, 149120, 185],
    [2296140, 2159616, 8857, 150695, 149376, 461],
    [2450159, 2310656, 20850, 154019, 151040, 11993],
    [2616195, 2476544, 21822, 166036, 165888, 972],
    [2784537, 2643328, 22080, 168342, 166784, 258],
    [2955073, 2811776, 22692, 170536, 168448, 612],
    [3127578, 2982784, 23384, 172505, 171008, 692],
    [3301426, 3155840, 24272, 173848, 173056, 888],
    [3476401, 3330432, 24476, 174975, 174592, 204],
  ];
  let state = createCodexUsageState({ resumed: false });
  for (const [
    inputTokens,
    cachedInputTokens,
    outputTokens,
    lastInput,
    lastCached,
    lastOutput,
  ] of rows) {
    const result = accumulateCodexUsage({
      state,
      context,
      tokenUsage: {
        total: { inputTokens, cachedInputTokens, outputTokens },
        last: { inputTokens: lastInput, cachedInputTokens: lastCached, outputTokens: lastOutput },
      },
    });
    expect(result.usage.hasUnknownModelCost).toBe(false);
    state = result.state;
  }
  expect(state.previous).toEqual({
    inputTokens: 3476401,
    cachedInputTokens: 3330432,
    outputTokens: 24476,
  });
  expect(state.cost).toBeCloseTo(0.8697412, 12);
});
