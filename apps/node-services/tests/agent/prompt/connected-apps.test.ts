import { describe, expect, it } from "vitest";

import { connectableAppsRule } from "../../../src/agent/prompt/connected-apps.js";

describe("connectable apps rule", () => {
  it("keeps Feishu Mail behind the Human's ask and the confirmation card", () => {
    const rule = connectableAppsRule(["gmail", "feishu_mail"]);
    expect(rule).toContain(
      "Connect feishu_mail only when the Human asks you to share their Feishu Mail with you",
    );
    expect(rule).toContain("never with lark-cli mail commands");
  });

  it("says nothing of Feishu Mail when it cannot be connected", () => {
    expect(connectableAppsRule(["gmail"])).not.toContain("feishu");
    expect(connectableAppsRule([])).toBe("");
  });
});
