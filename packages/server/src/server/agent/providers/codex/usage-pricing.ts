import {
  normalizePricingServiceTier,
  type ProviderPricingRule,
} from "@getpaseo/protocol/provider-config";

export type UsagePrice = ProviderPricingRule;

interface PublishedUsagePrice extends UsagePrice {
  source: string;
  verifiedAt: string;
}

const SOURCE = "https://developers.openai.com/api/docs/pricing";
const VERIFIED_AT = "2026-11-09";

function modelPrices(model: string, scale: number): PublishedUsagePrice[] {
  const rows = [
    {
      serviceTier: "default",
      minInputTokens: 0,
      maxInputTokens: 272000,
      input: 2,
      cachedInput: 0.1,
      output: 10,
    },
    { serviceTier: "default", minInputTokens: 272001, input: 4, cachedInput: 0.2, output: 15 },
    {
      serviceTier: "fast",
      minInputTokens: 0,
      maxInputTokens: 272000,
      input: 4,
      cachedInput: 0.2,
      output: 20,
    },
    { serviceTier: "fast", minInputTokens: 272001, input: 8, cachedInput: 0.4, output: 30 },
    {
      serviceTier: "flex",
      minInputTokens: 0,
      maxInputTokens: 272000,
      input: 1,
      cachedInput: 0.05,
      output: 5,
    },
    { serviceTier: "flex", minInputTokens: 272001, input: 2, cachedInput: 0.1, output: 7.5 },
  ];
  return rows.map((row) =>
    Object.assign({}, row, {
      model,
      input: row.input * scale,
      cachedInput: row.cachedInput * scale,
      output: row.output * scale,
      source: SOURCE,
      verifiedAt: VERIFIED_AT,
    }),
  );
}

export const CODEX_USAGE_PRICES: readonly PublishedUsagePrice[] = [
  ...modelPrices("gpt-6.1-sol", 1),
  ...modelPrices("gpt-6.1-terra", 0.5),
];

export interface UsagePricingContext {
  model: string | null;
  serviceTier: string | null;
}

export function findUsagePrice(
  context: UsagePricingContext,
  inputTokens: number,
  overrides: readonly UsagePrice[] = [],
): UsagePrice | undefined {
  // Codex's older service-tier id for Fast is priority; no other tier falls back.
  const serviceTier = normalizePricingServiceTier(context.serviceTier);
  return [...overrides, ...CODEX_USAGE_PRICES].find((rule) => {
    const matchesIdentity =
      rule.model === context.model && normalizePricingServiceTier(rule.serviceTier) === serviceTier;
    const matchesRange =
      inputTokens >= rule.minInputTokens &&
      (rule.maxInputTokens === undefined || inputTokens <= rule.maxInputTokens);
    return matchesIdentity && matchesRange;
  });
}
