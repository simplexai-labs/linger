import { describe, expect, it } from "vitest";

import { planDevLiveKit } from "./dev-livekit";

const liveKit = {
  LIVEKIT_URL: "ws://127.0.0.1:17880",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "devsecret-livekit-voice-local-only-32-bytes",
};

describe("planDevLiveKit", () => {
  it("runs LiveKit on the LIVEKIT_URL port without a voice key", () => {
    const plan = planDevLiveKit({ ...liveKit });
    expect(plan).toMatchObject({
      action: "run",
      httpPort: 17880,
      keys: "devkey: devsecret-livekit-voice-local-only-32-bytes",
    });
    if (plan.action !== "run") throw new Error("expected a run plan");
    expect(JSON.parse(plan.config)).toMatchObject({
      port: 17880,
      bind_addresses: ["127.0.0.1"],
      rtc: { tcp_port: 0, udp_port: 7882, node_ip: "127.0.0.1" },
    });
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
