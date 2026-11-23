import { expect, it } from "vitest";

import { systemProxyEnvironment } from "./service-proxy.js";

it("adds the system proxy with loopback in NO_PROXY", () => {
  expect(
    systemProxyEnvironment({
      LINGER_SYSTEM_HTTPS_PROXY: " http://127.0.0.1:7890 ",
    }),
  ).toEqual({
    HTTPS_PROXY: "http://127.0.0.1:7890",
    NO_PROXY: "localhost,127.0.0.1,::1",
  });
});

it("keeps the person's NO_PROXY entries under the name they used", () => {
  expect(
    systemProxyEnvironment({
      LINGER_SYSTEM_HTTPS_PROXY: "http://p:1",
      no_proxy: "corp.example, localhost",
    }),
  ).toEqual({
    HTTPS_PROXY: "http://p:1",
    no_proxy: "corp.example,localhost,127.0.0.1,::1",
  });
  expect(
    systemProxyEnvironment({
      LINGER_SYSTEM_HTTPS_PROXY: "http://p:1",
      NO_PROXY: "a.example",
      no_proxy: "b.example",
    }),
  ).toEqual({
    HTTPS_PROXY: "http://p:1",
    NO_PROXY: "a.example,localhost,127.0.0.1,::1",
  });
});

it("adds nothing without a system proxy or when the person set HTTPS_PROXY", () => {
  expect(systemProxyEnvironment({})).toEqual({});
  expect(systemProxyEnvironment({ LINGER_SYSTEM_HTTPS_PROXY: " " })).toEqual(
    {},
  );
  expect(
    systemProxyEnvironment({
      LINGER_SYSTEM_HTTPS_PROXY: "http://system:1",
      HTTPS_PROXY: "http://mine:2",
    }),
  ).toEqual({});
  expect(
    systemProxyEnvironment({
      LINGER_SYSTEM_HTTPS_PROXY: "http://system:1",
      https_proxy: "http://mine:2",
    }),
  ).toEqual({});
});
