import type { AgentUsage } from "../../agent-sdk-types.js";
import { findUsagePrice, type UsagePrice, type UsagePricingContext } from "./usage-pricing.js";

interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface CodexUsageState {
  previous: TokenCounts | null;
  cost: number;
  unknown: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tokenCounts(value: unknown): TokenCounts | null {
  const data = record(value);
  if (!data) return null;
  const inputTokens = count(data.inputTokens ?? data.input_tokens);
  const cachedInputTokens = count(data.cachedInputTokens ?? data.cached_input_tokens);
  const outputTokens = count(data.outputTokens ?? data.output_tokens);
  if (inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined)
    return null;
  if (cachedInputTokens > inputTokens) return null;
  return { inputTokens, cachedInputTokens, outputTokens };
}

const ZERO: TokenCounts = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

export function createCodexUsageState(options: {
  resumed: boolean;
  lastUsage?: AgentUsage;
}): CodexUsageState {
  const baseline = options.lastUsage;
  if (!options.resumed) return { previous: ZERO, cost: 0, unknown: false };
  const previous = baseline?.tokenUsageScope === "session" ? tokenCounts(baseline) : null;
  const completeEstimate =
    baseline?.costSource === "local-estimate" &&
    baseline.hasUnknownModelCost === false &&
    typeof baseline.totalCostUsd === "number" &&
    Number.isFinite(baseline.totalCostUsd) &&
    baseline.totalCostUsd >= 0;
  return {
    previous,
    cost:
      completeEstimate && typeof baseline?.totalCostUsd === "number" ? baseline.totalCostUsd : 0,
    unknown: previous !== null && !completeEstimate,
  };
}

export function codexTokenUsage(tokenUsage: unknown): AgentUsage | undefined {
  const data = record(tokenUsage);
  if (!data) return undefined;
  const total = tokenCounts(data.total);
  const last = record(data.last);
  const max = count(data.modelContextWindow ?? data.model_context_window);
  const used = count(last?.totalTokens ?? last?.total_tokens);
  return {
    ...total,
    tokenUsageScope: "session",
    ...(max !== undefined && max > 0 ? { contextWindowMaxTokens: max } : {}),
    ...(used !== undefined && used > 0 ? { contextWindowUsedTokens: used } : {}),
  };
}

export function accumulateCodexUsage(options: {
  state: CodexUsageState;
  tokenUsage: unknown;
  context: UsagePricingContext;
  prices?: readonly UsagePrice[];
}): { state: CodexUsageState; usage: AgentUsage } {
  const { state, context, prices } = options;
  const data = record(options.tokenUsage);
  const total = tokenCounts(data?.total);
  const last = tokenCounts(data?.last);
  let unknown = state.unknown;
  let cost = state.cost;
  const previous = state.previous;
  if (!total) {
    unknown = true;
  } else if (!previous) {
    // Resumed legacy sessions have no priced history. Even last === total cannot prove it.
    unknown ||= total.inputTokens !== 0 || total.outputTokens !== 0;
  } else {
    const delta = {
      inputTokens: total.inputTokens - previous.inputTokens,
      cachedInputTokens: total.cachedInputTokens - previous.cachedInputTokens,
      outputTokens: total.outputTokens - previous.outputTokens,
    };
    const changed = Object.values(delta).some((value) => value !== 0);
    if (changed) {
      const matchesResponse =
        last !== null &&
        delta.inputTokens >= 0 &&
        delta.cachedInputTokens >= 0 &&
        delta.outputTokens >= 0 &&
        delta.inputTokens === last.inputTokens &&
        delta.cachedInputTokens === last.cachedInputTokens &&
        delta.outputTokens === last.outputTokens;
      const price = last ? findUsagePrice(context, last.inputTokens, prices) : undefined;
      if (!matchesResponse || !price) {
        unknown = true;
      } else {
        cost +=
          ((delta.inputTokens - delta.cachedInputTokens) * price.input +
            delta.cachedInputTokens * price.cachedInput +
            delta.outputTokens * price.output) /
          1e6;
      }
    }
  }
  const usage: AgentUsage = {
    ...codexTokenUsage(options.tokenUsage),
    costSource: "local-estimate",
    hasUnknownModelCost: unknown,
    ...(!unknown ? { totalCostUsd: cost } : {}),
  };
  return { state: { previous: total ?? previous, cost, unknown }, usage };
}
