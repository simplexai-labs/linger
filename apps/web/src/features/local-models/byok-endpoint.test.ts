import { describe, expect, it } from "vitest";

import {
  formatByokFullUrl,
  normalizeByokFullUrl,
  parseByokFullUrl,
} from "./byok-endpoint";

describe("byok-endpoint full URL parsing", () => {
  it("normalizes whitespace and trailing slashes", () => {
    expect(normalizeByokFullUrl("  https://api.openai.com/v1///  ")).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("formats saved base URL, path, and endpoint into one full URL", () => {
    expect(
      formatByokFullUrl({
        base_url: "https://api.example.com/",
        endpoint: "/chat/completions",
        path: "/v1",
      }),
    ).toBe("https://api.example.com/v1/chat/completions");

    expect(
      formatByokFullUrl({
        base_url: "https://open.bigmodel.cn",
        endpoint: "",
        path: "/api/paas/v4",
      }),
    ).toBe("https://open.bigmodel.cn/api/paas/v4");

    expect(formatByokFullUrl({ base_url: "", endpoint: "", path: "" })).toBe(
      "",
    );
  });

  it("parses explicit OpenAI Chat, OpenAI Responses, and Anthropic Messages URLs", () => {
    expect(
      parseByokFullUrl("https://api.openai.com/v1/chat/completions"),
    ).toEqual({
      baseUrl: "https://api.openai.com",
      endpoint: "/chat/completions",
      explicitEndpoint: true,
      origin: "https://api.openai.com",
      path: "/v1",
      protocol: "openai-chat",
      runtime: "pi",
    });

    expect(parseByokFullUrl("https://api.openai.com/v1/responses")).toEqual({
      baseUrl: "https://api.openai.com",
      endpoint: "/responses",
      explicitEndpoint: true,
      origin: "https://api.openai.com",
      path: "/v1",
      protocol: "openai-responses",
      runtime: "codex",
    });

    expect(parseByokFullUrl("https://api.anthropic.com/v1/messages")).toEqual({
      baseUrl: "https://api.anthropic.com",
      endpoint: "/messages",
      explicitEndpoint: true,
      origin: "https://api.anthropic.com",
      path: "/v1",
      protocol: "anthropic",
      runtime: "claude",
    });

    expect(
      parseByokFullUrl("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
    ).toEqual({
      baseUrl: "https://open.bigmodel.cn",
      endpoint: "/chat/completions",
      explicitEndpoint: true,
      origin: "https://open.bigmodel.cn",
      path: "/api/paas/v4",
      protocol: "openai-chat",
      runtime: "pi",
    });
  });

  it("fills sensible default path and endpoint when given a base or versioned URL", () => {
    expect(parseByokFullUrl("https://openrouter.ai/api/v1")).toEqual({
      baseUrl: "https://openrouter.ai",
      endpoint: "/chat/completions",
      explicitEndpoint: false,
      origin: "https://openrouter.ai",
      path: "/api/v1",
      protocol: "openai-chat",
      runtime: "pi",
    });

    expect(parseByokFullUrl("https://api.anthropic.com")).toEqual({
      baseUrl: "https://api.anthropic.com",
      endpoint: "/messages",
      explicitEndpoint: false,
      origin: "https://api.anthropic.com",
      path: "/v1",
      protocol: "anthropic",
      runtime: "claude",
    });

    expect(parseByokFullUrl("http://localhost:11434")).toEqual({
      baseUrl: "http://localhost:11434",
      endpoint: "/chat/completions",
      explicitEndpoint: false,
      origin: "http://localhost:11434",
      path: "/v1",
      protocol: "openai-chat",
      runtime: "pi",
    });
  });

  it("preserves an existing BYOK runtime or empty endpoint when the saved URL is unchanged", () => {
    expect(
      parseByokFullUrl("https://api.example.com/v1/chat/completions", {
        preserveRuntime: "claude",
        preserveRuntimeForUrl: "https://api.example.com/v1/chat/completions",
      }),
    ).toMatchObject({
      protocol: "openai-chat",
      runtime: "claude",
    });

    expect(
      parseByokFullUrl("https://gateway.example.com/custom", {
        preserveEmptyEndpointForUrl: "https://gateway.example.com/custom",
        preserveRuntime: "pi",
        preserveRuntimeForUrl: "https://gateway.example.com/custom",
      }),
    ).toEqual({
      baseUrl: "https://gateway.example.com",
      endpoint: "",
      explicitEndpoint: true,
      origin: "https://gateway.example.com",
      path: "/custom",
      protocol: "openai-chat",
      runtime: "pi",
    });
  });

  it("rejects malformed URLs, non-http schemes, credentials, queries, and hashes", () => {
    expect(parseByokFullUrl("")).toBeNull();
    expect(parseByokFullUrl("not-a-url")).toBeNull();
    expect(parseByokFullUrl("ftp://api.example.com/v1")).toBeNull();
    expect(parseByokFullUrl("https://user:pass@api.example.com/v1")).toBeNull();
    expect(parseByokFullUrl("https://api.example.com/v1?beta=1")).toBeNull();
    expect(parseByokFullUrl("https://api.example.com/v1#section")).toBeNull();
    expect(
      parseByokFullUrl("https://api.example.com/v1/chat completions"),
    ).toBeNull();
  });
});
