import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import type { TFunction } from "i18next";

interface SessionCostLabelOptions {
  usage: Pick<AgentUsage, "totalCostUsd" | "costSource" | "hasUnknownModelCost">;
  t: TFunction;
}

export function formatSessionCostLabel({ usage, t }: SessionCostLabelOptions): string | null {
  const value = usage.totalCostUsd;
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return usage.hasUnknownModelCost ? t("contextWindow.unknownSessionCost") : null;
  }
  const fractionDigits = value > 0 && value < 0.01 ? 4 : 2;
  const cost = `$${value.toFixed(fractionDigits)}`;
  if (usage.costSource === "local-estimate") {
    return t("contextWindow.estimatedSessionCost", { cost });
  }
  return t("contextWindow.sessionCost", { cost });
}

export function formatContextPercentage(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value / 100);
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}
