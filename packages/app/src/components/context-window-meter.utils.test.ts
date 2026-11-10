import { beforeAll, describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { en } from "../i18n/resources/en";
import { zhCN } from "../i18n/resources/zh-CN";
import { formatContextPercentage, formatSessionCostLabel } from "./context-window-meter.utils";

describe("context window meter formatting", () => {
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({
      lng: "en",
      resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
    });
  });

  it("localizes percentages without hiding context overflow", () => {
    expect(formatContextPercentage(125, "en")).toBe("125%");
    expect(formatContextPercentage(42, "fr")).toBe("42\u00a0%");
  });

  it("marks local cost estimates in English and Chinese", () => {
    const usage = { totalCostUsd: 0.8697412, costSource: "local-estimate" };
    expect(formatSessionCostLabel({ usage, t: i18n.getFixedT("en") })).toBe("Session cost ~$0.87");
    expect(formatSessionCostLabel({ usage, t: i18n.getFixedT("zh-CN") })).toBe("会话费用约 $0.87");
  });

  it("preserves SDK and legacy amounts without a local estimate marker", () => {
    const t = i18n.getFixedT("en");
    expect(formatSessionCostLabel({ usage: { totalCostUsd: 1.23, costSource: "sdk" }, t })).toBe(
      "Session cost $1.23",
    );
    expect(formatSessionCostLabel({ usage: { totalCostUsd: 0.0001 }, t })).toBe(
      "Session cost $0.0001",
    );
  });

  it("distinguishes unknown cost from missing usage and explicit zero", () => {
    const t = i18n.getFixedT("en");
    expect(formatSessionCostLabel({ usage: { hasUnknownModelCost: true }, t })).toBe(
      "Session cost unknown",
    );
    expect(
      formatSessionCostLabel({ usage: { hasUnknownModelCost: true }, t: i18n.getFixedT("zh-CN") }),
    ).toBe("费用未知");
    expect(formatSessionCostLabel({ usage: {}, t })).toBeNull();
    expect(formatSessionCostLabel({ usage: { totalCostUsd: 0 }, t })).toBe("Session cost $0.00");
    expect(
      formatSessionCostLabel({ usage: { totalCostUsd: 0, costSource: "local-estimate" }, t }),
    ).toBe("Session cost ~$0.00");
  });
});
