// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  installCommand,
  loginCommands,
  signInCommand,
  updateCommand,
} from "./local-runtime-commands";

const desktop = {
  status: {
    bridge: "ok",
    runtime: "ok",
    computerId: "desktop",
    activeOperations: 0,
  },
};

it.each([
  ["codex", "0.59.0"],
  ["claude", "0.60.1"],
  ["pi", "0.59.0+build.3"],
  ["antigravity", "1.0.0"],
] as const)(
  "signs in to %s through the Computer CLI on Windows %s",
  (runtimeType, version) => {
    expect(
      signInCommand(
        runtimeType,
        { computer_id: "c1", platform: "win32", daemon_version: version },
        desktop,
      ),
    ).toBe(`linger-computer-local-3000 runtime login ${runtimeType}`);
  },
);

it.each([
  ["codex", { platform: "win32", daemon_version: "0.58.0" }],
  ["claude", { platform: "win32", daemon_version: "0.59.0-rc.1" }],
  ["pi", { platform: "win32" }],
  ["antigravity", { platform: "win32", daemon_version: "dev" }],
  ["codex", { platform: "darwin", daemon_version: "0.59.0" }],
  ["claude", { platform: "linux", daemon_version: "0.59.0" }],
  ["pi", { daemon_version: "0.59.0" }],
  [
    "antigravity",
    { computer_id: "desktop", platform: "win32", daemon_version: "0.59.0" },
  ],
] as const)("keeps the native %s command for %o", (runtimeType, computer) => {
  expect(signInCommand(runtimeType, computer, desktop)).toBe(
    loginCommands[runtimeType],
  );
});

it("keeps the native command without a Computer", () => {
  expect(signInCommand("codex", undefined)).toBe("codex login");
});

it("signs in through the CLI from a browser, where there is no Desktop", () => {
  expect(
    signInCommand("pi", {
      computer_id: "c1",
      platform: "win32",
      daemon_version: "0.59.0",
    }),
  ).toBe("linger-computer-local-3000 runtime login pi");
});

it("keeps the native command inside Desktop until it reports its Computer", () => {
  const computer = {
    computer_id: "desktop",
    platform: "win32",
    daemon_version: "0.59.0",
  };
  expect(signInCommand("pi", computer, { status: undefined })).toBe("pi");
  expect(signInCommand("pi", computer, desktop)).toBe("pi");
});

it("updates Antigravity through agy update while other runtimes reuse their install command", () => {
  expect(installCommand("antigravity", "darwin")).toBe(
    "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  );
  expect(installCommand("antigravity", "win32")).toBe(
    "irm https://antigravity.google/cli/install.ps1 | iex",
  );
  expect(updateCommand("antigravity", "darwin")).toBe("agy update");
  expect(updateCommand("antigravity", "win32")).toBe("agy update");
  expect(updateCommand("claude", "darwin")).toBe(
    installCommand("claude", "darwin"),
  );
  expect(updateCommand("codex", "linux")).toBe(
    installCommand("codex", "linux"),
  );
  expect(updateCommand("pi", "win32")).toBe(installCommand("pi", "win32"));
});
