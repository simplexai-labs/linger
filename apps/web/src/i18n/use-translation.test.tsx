import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocalRuntimeAuthenticationGuidance } from "@/features/local-computer/local-runtime-authentication-guidance";
import { settingsMessages } from "@/features/settings/settings.messages";

import { setLanguage } from "./language";
import zhCN from "./locales/zh-CN.json";
import { useT } from "./use-translation";

function Title() {
  const t = useT();
  return <h1>{t(settingsMessages.title)}</h1>;
}

describe("translated components", () => {
  it("render again in the new language when it changes", async () => {
    render(<Title />);
    expect(screen.getByRole("heading")).toHaveTextContent("Settings");
    await act(() => setLanguage("zh-CN"));
    expect(screen.getByRole("heading")).toHaveTextContent(zhCN.settings.title);
    await act(() => setLanguage("en"));
    expect(screen.getByRole("heading")).toHaveTextContent("Settings");
  });

  it("keep the elements of a sentence where the translation puts them", async () => {
    render(
      <LocalRuntimeAuthenticationGuidance
        computerName="<code>Studio</code>"
        runtimeType="codex"
      />,
    );
    expect(screen.getByText(/^Run/)).toHaveTextContent(
      "Run codex login on <code>Studio</code>.",
    );
    const command = () =>
      [...document.querySelectorAll("code")].map((code) => code.textContent);
    // The Computer's name is text even when it looks like markup.
    expect(command()).toEqual(["codex login"]);

    await act(() => setLanguage("zh-CN"));
    expect(command()).toEqual(["codex login"]);
    const sentence = document.querySelector("code")!.parentElement!;
    const [before, after] = zhCN.computerSetup.signInGuidance
      .replace("{computer}", "<code>Studio</code>")
      .replace("{app}", "Codex")
      .split("<code>{command}</code>");
    expect(sentence.textContent).toBe(`${before}codex login${after}`);
  });
});
