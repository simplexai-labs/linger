// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineMessages } from "@linger/service-kit/messages";
import { describe, expect, it } from "vitest";

import { offlineMessages } from "../shell/offline.messages.js";
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import { localizePage } from "./page.js";

const runtime = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../shell/messages.html",
  ),
  "utf8",
);

const messages = {
  ...offlineMessages,
  ...defineMessages("offline", {
    onlyInEnglish: "Only in English",
    files: { one: "{count} file", other: "{count} files" },
  }),
};

const PAGE = `<!doctype html>
<html lang="en">
  <head><title data-t="unreachableTitle"></title></head>
  <body>
    <button data-t="tryAgain" data-t-title="changeServer"></button>
    <input data-t-placeholder="serverAddress" />
    <p id="english" data-t="onlyInEnglish"></p>
    <p id="reason"></p>
    <script>
      document.getElementById("reason").replaceChildren(
        ...tSpans("unreachable", { host: "<b>linger.example.com</b>" }),
      );
      window.result = {
        retrying: t("retrying", { seconds: 1200 }),
        one: t("files", { count: 1 }),
        many: t("files", { count: 3 }),
      };
    </script>
  </body>
</html>`;

// Runs a localized page in this document the way a shell window would.
const load = (language: "en" | "zh-CN") => {
  const html = localizePage(PAGE, runtime, messages, language);
  document.documentElement.innerHTML = html;
  document.documentElement.lang = /<html lang="([^"]+)"/u.exec(html)![1]!;
  const scripts = [...document.querySelectorAll("script:not([type])")];
  for (const script of scripts) new Function(script.textContent!)();
  return (window as unknown as { result: Record<string, string> }).result;
};

describe("localizePage", () => {
  it("fills the page in English", () => {
    const result = load("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Can't reach the server");
    const button = document.querySelector("button")!;
    expect(button.textContent).toBe("Try Again");
    expect(button.title).toBe("Change Server");
    expect(document.querySelector("input")!.placeholder).toBe("Server address");
    expect(result).toEqual({
      retrying: "Retrying in 1,200s",
      one: "1 file",
      many: "3 files",
    });
  });

  it("fills the page in Chinese, English where the catalog has no message", () => {
    const result = load("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe(zhCN.offline.unreachableTitle);
    expect(document.querySelector("button")!.textContent).toBe(
      zhCN.offline.tryAgain,
    );
    expect(document.getElementById("english")!.textContent).toBe(
      "Only in English",
    );
    expect(result.retrying).toBe(
      zhCN.offline.retrying.replace("{seconds}", "1,200"),
    );
    // English plural rules for the English fallback.
    expect(result.one).toBe("1 file");
  });

  it("makes spans from the message only, never from a value", () => {
    load("en");
    const reason = document.getElementById("reason")!;
    const host = reason.querySelector("span.host")!;
    expect(host.textContent).toBe("<b>linger.example.com</b>");
    expect(reason.querySelector("b")).toBeNull();
  });

  it("keeps text from closing the message block", () => {
    const html = localizePage(
      PAGE,
      runtime,
      defineMessages("offline", { tryAgain: "</script><script>alert(1)" }),
      "en",
    );
    expect(html).not.toContain("</script><script>alert(1)");
  });

  it("renders the offline card logo without a corner status badge", () => {
    const offline = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../shell/offline.html",
      ),
      "utf8",
    );
    document.documentElement.innerHTML = offline;
    expect(document.querySelector(".mark img")).not.toBeNull();
    expect(document.querySelector(".mark .badge")).toBeNull();
  });
});
