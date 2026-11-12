import { describe, expect, it } from "vitest";

import { appWindow, quitRequested } from "./app-window.js";

describe("appWindow", () => {
  it("brings back setup that was closed before this computer connected", () => {
    expect(appWindow({ enrolled: false, setupOpen: false })).toBe("setup");
  });

  it("keeps setup in front while it is open", () => {
    expect(appWindow({ enrolled: true, setupOpen: true })).toBe("setup");
  });

  it("opens the main window once this computer is connected", () => {
    expect(appWindow({ enrolled: true, setupOpen: false })).toBe("main");
  });
});

describe("quitRequested", () => {
  it("quits for the uninstaller, as the second instance or the only one", () => {
    expect(quitRequested(["Linger.exe", "--quit"])).toBe(true);
    expect(quitRequested(["Linger.exe", "--background"])).toBe(false);
  });
});
