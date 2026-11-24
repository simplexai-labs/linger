import { INKLING_2_MINI_HF_URL } from "@linger/service-kit/featured-models";
import { describe, expect, it } from "vitest";

import {
  INKLING_2_MINI_ANNOUNCEMENT_URL,
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
  SETUP_EXTERNAL_URLS,
} from "../shared/setup.js";
import { parseSetupCommand } from "./setup-command.js";

describe("parseSetupCommand", () => {
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
    expect(
      parseSetupCommand({ op: "diagnostics.send", action: "confirm" }),
    ).toEqual({ op: "diagnostics.send", action: "confirm" });
    expect(parseSetupCommand({ op: "local.location.pick" })).toEqual({
      op: "local.location.pick",
    });
    expect(parseSetupCommand({ op: "local.location.reset" })).toEqual({
      op: "local.location.reset",
    });
    expect(parseSetupCommand({ op: "local.recheck" })).toEqual({
      op: "local.recheck",
    });
    expect(parseSetupCommand({ op: "driver.open-nvidia-app" })).toEqual({
      op: "driver.open-nvidia-app",
    });
    expect(
      parseSetupCommand({
        op: "external.open",
        url: NVIDIA_DRIVER_DOWNLOAD_URL,
      }),
    ).toEqual({ op: "external.open", url: NVIDIA_DRIVER_DOWNLOAD_URL });
    expect(
      parseSetupCommand({
        op: "external.open",
        url: NVIDIA_DRIVER_GUIDE_URL,
      }),
    ).toEqual({ op: "external.open", url: NVIDIA_DRIVER_GUIDE_URL });
    expect(parseSetupCommand({ op: "local.signin.start" })).toEqual({
      op: "local.signin.start",
    });
    expect(
      parseSetupCommand({ op: "local.signin.start", code: " abc#def " }),
    ).toEqual({ op: "local.signin.start", code: "abc#def" });
    expect(
      parseSetupCommand({ op: "local.signin.start", device: true }),
    ).toEqual({ op: "local.signin.start", device: true });
    expect(
      parseSetupCommand({ op: "local.signin.copy", what: "code" }),
    ).toEqual({ op: "local.signin.copy", what: "code" });
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
    expect(
      parseSetupCommand({
        op: "local.byok.check",
        byok: {
          baseUrl: " https://api.example.com ",
          path: "/v1",
          endpoint: "/responses",
          protocol: "openai-responses",
          apiKey: "sk-test",
          modelId: " gpt-5.4 ",
          runtime: "codex",
        },
      }),
    ).toEqual({
      op: "local.byok.check",
      byok: {
        baseUrl: "https://api.example.com",
        path: "/v1",
        endpoint: "/responses",
        protocol: "openai-responses",
        apiKey: "sk-test",
        modelId: "gpt-5.4",
        runtime: "codex",
      },
    });
    // A pasted full address: no path or endpoint appended.
    expect(
      parseSetupCommand({
        op: "local.byok.models",
        byok: {
          baseUrl: "https://ark.example.com/api/v3/chat/completions",
          path: "",
          endpoint: "",
          protocol: "openai-chat",
        },
      }),
    ).toEqual({
      op: "local.byok.models",
      byok: {
        baseUrl: "https://ark.example.com/api/v3/chat/completions",
        path: "",
        endpoint: "",
        protocol: "openai-chat",
      },
    });
    expect(
      parseSetupCommand({
        op: "local.signin.byok",
        byok: {
          baseUrl: "https://api.anthropic.com",
          path: "/v1",
          endpoint: "/messages",
          protocol: "anthropic",
          modelId: "claude-sonnet-4-6",
          runtime: "pi",
        },
      }),
    ).toEqual({
      op: "local.signin.byok",
      byok: {
        baseUrl: "https://api.anthropic.com",
        path: "/v1",
        endpoint: "/messages",
        protocol: "anthropic",
        modelId: "claude-sonnet-4-6",
        runtime: "pi",
      },
    });
  });

  it("takes only a path or endpoint that extends the base URL's path", () => {
    const check = (fields: Record<string, unknown>) =>
      parseSetupCommand({
        op: "local.byok.models",
        byok: {
          baseUrl: "https://api.example.com",
          path: "/v1",
          endpoint: "/messages",
          protocol: "anthropic",
          ...fields,
        },
      });
    for (const path of [
      "v1",
      "/v1/",
      "//evil.example",
      "/v1?x=1",
      "/v1#x",
      "/a b",
      "/a\\b",
      "/" + "x".repeat(256),
    ]) {
      expect(() => check({ path })).toThrow();
      expect(() => check({ endpoint: path })).toThrow();
    }
    expect(() => check({ protocol: "gemini" })).toThrow();
    expect(() => check({ modelId: "gpt-5.4" })).toThrow();
    expect(() => check({ path: undefined })).toThrow();
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
    // Copying takes what the step shows, never text from the page.
    expect(() =>
      parseSetupCommand({ op: "local.signin.copy", what: "password" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.signin.copy", what: "url", text: "x" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.signin.start", device: false }),
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

  it("accepts only exact allowlisted HTTPS URLs for external.open", () => {
    for (const url of SETUP_EXTERNAL_URLS)
      expect(parseSetupCommand({ op: "external.open", url })).toEqual({
        op: "external.open",
        url,
      });

    for (const url of [
      INKLING_2_MINI_HF_URL,
      "https://evil.example.com/",
      "http://thinkingmachines.ai/news/inkling-2-mini/",
      `${INKLING_2_MINI_ANNOUNCEMENT_URL}?ref=test`,
      `${INKLING_2_MINI_ANNOUNCEMENT_URL}#top`,
      `${INKLING_2_MINI_ANNOUNCEMENT_URL}extra`,
      "javascript:alert(1)",
      "file:///etc/passwd",
      "",
    ])
      expect(() => parseSetupCommand({ op: "external.open", url })).toThrow();

    expect(() => parseSetupCommand({ op: "external.open" })).toThrow();
    expect(() =>
      parseSetupCommand({
        op: "external.open",
        url: INKLING_2_MINI_ANNOUNCEMENT_URL,
        extra: true,
      }),
    ).toThrow();
  });

  it("validates driver update setup commands strictly", () => {
    expect(
      parseSetupCommand({
        op: "driver.start-install",
        requiredCuda: "13.0",
      }),
    ).toEqual({
      op: "driver.start-install",
      requiredCuda: "13.0",
    });
    expect(parseSetupCommand({ op: "driver.clear-state" })).toEqual({
      op: "driver.clear-state",
    });
    expect(() =>
      parseSetupCommand({
        op: "driver.start-install",
        requiredCuda: "13.0; rm -rf /",
      }),
    ).toThrow();
  });
});
