import { afterEach, describe, expect, it } from "vitest";

import { resetLanguageForTest, setLanguage, translate } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";

import { localRuntimeMessage } from "./local-runtime-message";

afterEach(() => resetLanguageForTest());

describe("localRuntimeMessage", () => {
  it("words a known code in the interface language", async () => {
    await setLanguage("zh-CN");
    expect(
      localRuntimeMessage(
        {
          error_code: "RUNTIME_NOT_INSTALLED",
          message: "Runtime executable not found",
        },
        "codex",
        "Studio Mac",
        translate,
      ),
    ).toBe(
      zhCN.localRuntimeMessage.notInstalled
        .replace("{computer}", "Studio Mac")
        .replace("{app}", "Codex"),
    );
  });

  it("words a known code in English", () => {
    expect(
      localRuntimeMessage(
        {
          error_code: "LOCAL_COMPUTER_OFFLINE",
          message: "Local Computer is offline",
        },
        "claude",
        "Studio Mac",
        translate,
      ),
    ).toBe("Studio Mac is offline.");
  });

  it("distinguishes an outdated AI app from a Computer that needs a Linger update", async () => {
    expect(
      localRuntimeMessage(
        {
          error_code: "RUNTIME_INCOMPATIBLE",
          message: "antigravity version 1.5.9 is below minimum 1.5.12",
        },
        "antigravity",
        "Studio Mac",
        translate,
      ),
    ).toBe("Antigravity on Studio Mac needs an update.");
    expect(
      localRuntimeMessage(
        {
          error_code: "LOCAL_COMPUTER_UPGRADE_REQUIRED",
          message: "Local Computer needs an upgrade",
        },
        "antigravity",
        "Studio Mac",
        translate,
      ),
    ).toBe("Studio Mac needs a Linger update.");

    await setLanguage("zh-CN");
    expect(
      localRuntimeMessage(
        {
          error_code: "RUNTIME_INCOMPATIBLE",
          message: "antigravity version 1.5.9 is below minimum 1.5.12",
        },
        "antigravity",
        "Studio Mac",
        translate,
      ),
    ).toBe(
      zhCN.localRuntimeMessage.needsUpdate
        .replace("{computer}", "Studio Mac")
        .replace("{app}", "Antigravity"),
    );
    expect(
      localRuntimeMessage(
        {
          error_code: "LOCAL_COMPUTER_UPGRADE_REQUIRED",
          message: "Local Computer needs an upgrade",
        },
        "antigravity",
        "Studio Mac",
        translate,
      ),
    ).toBe(
      zhCN.localRuntimeMessage.computerNeedsUpdate.replace(
        "{computer}",
        "Studio Mac",
      ),
    );
  });

  it("keeps the Runtime's diagnostic as TeamHub sent it", async () => {
    await setLanguage("zh-CN");
    expect(
      localRuntimeMessage(
        {
          error_code: "RUNTIME_DIAGNOSTIC_FAILED",
          message: "Claude authentication status probe failed",
        },
        "claude",
        "Studio Mac",
        translate,
      ),
    ).toBe("Claude authentication status probe failed");
  });

  it("falls back to TeamHub's English for an unknown or missing code", async () => {
    await setLanguage("zh-CN");
    expect(
      localRuntimeMessage(
        { error_code: "RUNTIME_QUOTA_EXCEEDED", message: "Quota exceeded" },
        "pi",
        "Studio Mac",
        translate,
      ),
    ).toBe("Quota exceeded");
    expect(
      localRuntimeMessage({}, "pi", "Studio Mac", translate),
    ).toBeUndefined();
  });
});
