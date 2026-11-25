import { describe, expect, it } from "vitest";

import { planDevLiveKit } from "./dev-livekit";

const liveKit = {
  LIVEKIT_URL: "ws://127.0.0.1:17880",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "devsecret-livekit-voice-local-only-32-bytes",
};

describe("planDevLiveKit", () => {
  it("runs LiveKit on the LIVEKIT_URL port without a voice key on POSIX", () => {
    const plan = planDevLiveKit({ ...liveKit }, "darwin");
    expect(plan).toMatchObject({
      action: "run",
      httpPort: 17880,
      keys: "devkey: devsecret-livekit-voice-local-only-32-bytes",
    });
    if (plan.action !== "run") throw new Error("expected a run plan");
    expect(JSON.parse(plan.config)).toEqual({
      port: 17880,
      bind_addresses: ["127.0.0.1"],
      rtc: {
        tcp_port: 0,
        udp_port: 7882,
        use_external_ip: false,
        node_ip: "127.0.0.1",
        enable_loopback_candidate: true,
        ips: { includes: ["127.0.0.1/32"] },
      },
      logging: { level: "info" },
    });
    expect(plan.config).not.toContain("devsecret");
  });

  it("advertises local interfaces for UDP media on Windows while keeping signalling on loopback", () => {
    const plan = planDevLiveKit({ ...liveKit }, "win32");
    if (plan.action !== "run") throw new Error("expected a run plan");
    const parsed = JSON.parse(plan.config);
    expect(parsed).toEqual({
      port: 17880,
      bind_addresses: ["127.0.0.1"],
      rtc: {
        tcp_port: 0,
        udp_port: 7882,
        use_external_ip: false,
        enable_loopback_candidate: true,
      },
      logging: { level: "info" },
    });
    expect(parsed.rtc.node_ip).toBeUndefined();
    expect(parsed.rtc.ips).toBeUndefined();
    expect(plan.config).not.toContain("devsecret");
  });

  it("uses a LiveKit server on another host instead of starting one", () => {
    expect(
      planDevLiveKit({
        ...liveKit,
        LIVEKIT_URL: "wss://livekit.example.com",
      }).action,
    ).toBe("skip");
  });

  it("names the missing LiveKit settings", () => {
    expect(() =>
      planDevLiveKit({
        LIVEKIT_URL: liveKit.LIVEKIT_URL,
      }),
    ).toThrow(/LIVEKIT_API_KEY/);
  });
});
