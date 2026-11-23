import { describe, expect, it } from "vitest";

import {
  connectableAppsRule,
  mailCanvasRule,
} from "../../../src/agent/prompt/connected-apps.js";

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

describe("mail canvas rule", () => {
  it("sends a new Gmail or Feishu Mail email through a canvas", () => {
    const rule = mailCanvasRule(["gmail", "feishu_mail", "slack"]);
    expect(rule).toContain(
      "A new email the Human asks you to write, prepare, draft or send from gmail or feishu-mail goes on a canvas",
    );
    expect(rule).toContain(
      "Do not create it with the send or draft command of teamhub gmail or teamhub feishu-mail",
    );
  });

  it("routes Outlook through the canvas too", () => {
    expect(mailCanvasRule(["outlook"])).toContain(
      "send from outlook goes on a canvas",
    );
    expect(mailCanvasRule(["outlook"])).toContain("teamhub outlook");
  });

  it("says nothing without a mail app that has a canvas", () => {
    expect(mailCanvasRule(["slack"])).toBe("");
  });
});
