import { describe, expect, it } from "vitest";

import { parseSetupCommand } from "./setup-command.js";

describe("parseSetupCommand", () => {
  it("accepts scoped installation stop without arbitrary job IDs", () => {
    expect(parseSetupCommand({ op: "local.cancel" })).toEqual({
      op: "local.cancel",
    });
    expect(() =>
      parseSetupCommand({ op: "local.cancel", job: "other" }),
    ).toThrow();
  });

  it("accepts known commands", () => {
    expect(parseSetupCommand({ op: "prevent-sleep.set", on: true })).toEqual({
      op: "prevent-sleep.set",
      on: true,
    });
    expect(
      parseSetupCommand({ op: "server.set", serverUrl: "https://x.test" }),
    ).toEqual({ op: "server.set", serverUrl: "https://x.test" });
    expect(
      parseSetupCommand({ op: "permission.settings", id: "full-disk" }),
    ).toEqual({ op: "permission.settings", id: "full-disk" });
    expect(parseSetupCommand({ op: "local.start" })).toEqual({
      op: "local.start",
    });
    expect(
      parseSetupCommand({
        op: "local.start",
        runtime: "local",
      }),
    ).toEqual({ op: "local.start", runtime: "local" });
    expect(parseSetupCommand({ op: "local.location.pick" })).toEqual({
      op: "local.location.pick",
    });
    expect(parseSetupCommand({ op: "local.location.reset" })).toEqual({
      op: "local.location.reset",
    });
    expect(parseSetupCommand({ op: "local.signin.start" })).toEqual({
      op: "local.signin.start",
    });
    expect(
      parseSetupCommand({ op: "local.signin.start", code: " abc#def " }),
    ).toEqual({ op: "local.signin.start", code: "abc#def" });
    expect(parseSetupCommand({ op: "local.signin.cancel" })).toEqual({
      op: "local.signin.cancel",
    });
    expect(parseSetupCommand({ op: "local.account.show", on: true })).toEqual({
      op: "local.account.show",
      on: true,
    });
    expect(parseSetupCommand({ op: "local.account.copy" })).toEqual({
      op: "local.account.copy",
    });
    expect(parseSetupCommand({ op: "local.account.reveal" })).toEqual({
      op: "local.account.reveal",
    });
    expect(
      parseSetupCommand({ op: "local.signin.switch", runtime: "claude" }),
    ).toEqual({ op: "local.signin.switch", runtime: "claude" });
  });

  it("takes provider keys with local.start, trimmed, and nothing else", () => {
    expect(
      parseSetupCommand({
        op: "local.start",
        keys: { composio: " key-0 " },
      }),
    ).toEqual({ op: "local.start", keys: { composio: "key-0" } });
    expect(
      parseSetupCommand({ op: "local.start", keys: { composio: "" } }),
    ).toEqual({ op: "local.start", keys: { composio: "" } });
    // Voice keys are saved in the app, not on the setup page.
    for (const provider of ["soniox", "xai"])
      expect(() =>
        parseSetupCommand({ op: "local.start", keys: { [provider]: "x" } }),
      ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", keys: { livekit: "x" } }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", keys: { composio: "a b" } }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({
        op: "local.start",
        keys: { composio: "x".repeat(513) },
      }),
    ).toThrow();
    // A rejected key is not repeated in the error.
    let message = "";
    try {
      parseSetupCommand({
        op: "local.start",
        keys: { composio: "secret value" },
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain("secret value");
  });

  it("takes Pi provider credentials without requiring a terminal", () => {
    for (const provider of ["openai", "anthropic"]) {
      expect(
        parseSetupCommand({
          op: "local.signin.configure",
          credentials: { provider, apiKey: " test-api-key " },
        }),
      ).toEqual({
        op: "local.signin.configure",
        credentials: { provider, apiKey: "test-api-key" },
      });
    }
    expect(
      parseSetupCommand({
        op: "local.signin.configure",
        credentials: {
          provider: "openai-compatible",
          apiKey: "local-test-key",
          baseUrl: " http://127.0.0.1:18100/v1 ",
          model: " local/model-1 ",
        },
      }),
    ).toEqual({
      op: "local.signin.configure",
      credentials: {
        provider: "openai-compatible",
        apiKey: "local-test-key",
        baseUrl: "http://127.0.0.1:18100/v1",
        model: "local/model-1",
      },
    });
  });

  it("rejects unsafe Pi settings without repeating credentials", () => {
    const base = {
      provider: "openai-compatible",
      apiKey: "private-test-value",
      baseUrl: "https://api.example.test/v1",
      model: "local-model",
    };
    for (const changes of [
      { apiKey: "" },
      { apiKey: "private-test-value with-spaces" },
      { apiKey: "x".repeat(4097) },
      { provider: "unknown" },
      { baseUrl: "http://192.168.1.2/v1" },
      { baseUrl: "https://user:private-test-value@api.example.test/v1" },
      { baseUrl: "https://api.example.test/v1?key=private-test-value" },
      { model: "bad model" },
      { provider: "openai", baseUrl: "https://api.example.test/v1" },
      { unexpected: "private-test-value" },
    ]) {
      let message = "";
      try {
        parseSetupCommand({
          op: "local.signin.configure",
          credentials: { ...base, ...changes },
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("private-test-value");
    }
  });

  it("rejects unknown commands and extra fields", () => {
    expect(() => parseSetupCommand({ op: "shell.exec" })).toThrow();
    expect(() => parseSetupCommand({ op: "finish", path: "/" })).toThrow();
    expect(() => parseSetupCommand({ op: "prevent-sleep.set" })).toThrow();
    expect(() => parseSetupCommand({ op: "docker.open" })).toThrow();
    // The page never names a folder or a source; the main process asks the
    // user, and the source is the app's own.
    expect(() =>
      parseSetupCommand({ op: "local.location.pick", path: "/" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", location: "/" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", source: "checkout" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", runtime: "local-models" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", models: ["decision"] }),
    ).toThrow();
    // The sign-in page is the runtime's own; the page never names a URL,
    // and switching names one of the runtimes that sign in.
    expect(() =>
      parseSetupCommand({ op: "local.signin.open", url: "https://x.test" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.signin.start", code: "  " }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.signin.switch", runtime: "local" }),
    ).toThrow();
    // The account file is the installation's own; the page never names one.
    expect(() =>
      parseSetupCommand({ op: "local.account.reveal", file: "/etc/passwd" }),
    ).toThrow();
    expect(() => parseSetupCommand({ op: "local.account.show" })).toThrow();
    // Task access modes were removed with the runtime host.
    expect(() =>
      parseSetupCommand({ op: "sandbox.set", mode: "ask" }),
    ).toThrow();
    // Full Disk Access has no prompt; only System Settings grants it.
    expect(() =>
      parseSetupCommand({ op: "permission.request", id: "full-disk" }),
    ).toThrow();
  });
});
