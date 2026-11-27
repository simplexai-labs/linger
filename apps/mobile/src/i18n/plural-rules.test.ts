import { describe, expect, it } from "vitest";

import { installPluralRules } from "./plural-rules";

describe("installPluralRules", () => {
  it("keeps an engine's own rules", () => {
    expect(installPluralRules({ Intl })).toBe(false);
  });

  it("gives English one and other, and Chinese only other", () => {
    const target = { Intl: {} as { PluralRules?: typeof Intl.PluralRules } };
    expect(installPluralRules(target)).toBe(true);
    const Rules = target.Intl.PluralRules!;
    expect(new Rules("en").select(1)).toBe("one");
    expect(new Rules("en").select(2)).toBe("other");
    expect(new Rules("zh-CN").select(1)).toBe("other");
    expect(new Rules("zh-CN").resolvedOptions().pluralCategories).toEqual([
      "other",
    ]);
  });
});
