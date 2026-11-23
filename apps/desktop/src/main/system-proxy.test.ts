import { describe, expect, it } from "vitest";

import { proxyUrlFromResolution, systemProxy } from "./system-proxy.js";

describe("system proxy", () => {
  it.each([
    ["PROXY 127.0.0.1:7890", "http://127.0.0.1:7890"],
    // A PAC answer: Chromium's first choice wins.
    [
      "PROXY proxy.corp:8080; PROXY backup:8080; DIRECT",
      "http://proxy.corp:8080",
    ],
    ["HTTPS secure.corp:443", "https://secure.corp:443"],
    ["PROXY [::1]:7890", "http://[::1]:7890"],
    ["DIRECT", undefined],
    ["DIRECT; PROXY 127.0.0.1:7890", undefined],
    ["SOCKS5 127.0.0.1:7891", undefined],
    ["SOCKS 127.0.0.1:7891; DIRECT", undefined],
    ["PROXY", undefined],
    ["", undefined],
  ])("reads %j as %s", (resolution, expected) => {
    expect(proxyUrlFromResolution(resolution)).toBe(expected);
  });

  it("passes the system proxy under its own name", async () => {
    await expect(
      systemProxy({}, async () => "PROXY 127.0.0.1:7890"),
    ).resolves.toEqual({
      env: { LINGER_SYSTEM_HTTPS_PROXY: "http://127.0.0.1:7890" },
      source: "system",
    });
    await expect(systemProxy({}, async () => "DIRECT")).resolves.toEqual({
      env: {},
      source: "none",
    });
    await expect(systemProxy({}, undefined)).resolves.toEqual({
      env: {},
      source: "none",
    });
  });

  it("leaves a proxy set in the environment to win, without resolving", async () => {
    let asked = false;
    const resolve = async () => {
      asked = true;
      return "PROXY system:1";
    };
    for (const env of [
      { HTTPS_PROXY: "http://mine:2" },
      { https_proxy: "http://mine:2" },
    ])
      await expect(systemProxy(env, resolve)).resolves.toEqual({
        env: {},
        source: "environment",
      });
    expect(asked).toBe(false);
  });

  it("gives up on a resolver that fails or hangs", async () => {
    await expect(
      systemProxy({}, () => Promise.reject(new Error("no session"))),
    ).resolves.toEqual({ env: {}, source: "unavailable" });
    await expect(
      systemProxy({}, () => new Promise<string>(() => undefined), 20),
    ).resolves.toEqual({ env: {}, source: "unavailable" });
  });
});
