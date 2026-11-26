import { afterEach, describe, expect, it } from "vitest";

import { resetLanguageForTest, setLanguage, translate } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";

import { reasoningEffortLabel } from "./use-agent-model-selection";

afterEach(() => resetLanguageForTest());

describe("reasoningEffortLabel", () => {
  it("translates known reasoning efforts including minimal and off", async () => {
    expect(reasoningEffortLabel("off")).toBe("Off");
    expect(reasoningEffortLabel("minimal")).toBe("Minimal");
    expect(reasoningEffortLabel("xhigh")).toBe("Extra high");

    await setLanguage("zh-CN");
    expect(reasoningEffortLabel("off", translate)).toBe(
      zhCN.composer.effortOff,
    );
    expect(reasoningEffortLabel("minimal", translate)).toBe(
      zhCN.composer.effortMinimal,
    );
  });

  it("formats unknown future effort tokens cleanly without throwing", () => {
    expect(reasoningEffortLabel("super_high")).toBe("Super high");
    expect(reasoningEffortLabel("tier-2")).toBe("Tier 2");
    expect(reasoningEffortLabel("toString")).toBe("ToString");
  });
});
