import { describe, expect, it } from "vitest";

import { generateKeyPair } from "../session/noise";
import { SessionClosed, SessionRefused, type Hello } from "../session/session";
import type { ManagedSession, OpenInput } from "./connection";
import { pairWithComputer, PairingError } from "./pairing";
import type { PairingLink } from "./pairing-link";

const link: PairingLink = {
  computerName: "Studio Mac",
  hostKey: generateKeyPair().publicKey,
  hostId: "d".repeat(32),
  invite: "invite-token",
  expiresAt: new Date(Date.now() + 600_000),
  relay: "wss://relay.example",
  lan: ["ws://10.0.0.2:7443"],
};

function session(): ManagedSession {
  return {
    welcome: { type: "pending", phone_id: "phone_1", code: "654321", lan: [] },
    pending: true,
    closed: false,
    closeFrame: undefined,
    onApproved: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined,
  };
}

function run(
  answers: ((hello: Hello, url: string) => ManagedSession | Error)[],
) {
  const calls: { url: string; hello: Hello }[] = [];
  const result = pairWithComputer({
    link,
    staticKey: generateKeyPair(),
    deviceName: "Pixel",
    platform: "android",
    socketFactory: () => {
      throw new Error("not used");
    },
    open: async (input: OpenInput) => {
      calls.push({ url: input.url, hello: input.hello });
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error("unexpected dial");
      const outcome = answer(input.hello, input.url);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  return { result, calls };
}

describe("pairWithComputer", () => {
  it("tries the LAN first and sends the pair hello with the device name", async () => {
    const { result, calls } = run([() => session()]);
    const paired = await result;
    expect(paired.route).toBe("lan");
    expect(calls).toEqual([
      {
        url: `ws://10.0.0.2:7443/v1/connect/${link.hostId}`,
        hello: {
          type: "pair",
          invite: "invite-token",
          name: "Pixel",
          platform: "android",
        },
      },
    ]);
  });

  it("falls back to the Relay and resumes when the lost reply spent the invite", async () => {
    const { result, calls } = run([
      () => new SessionClosed("socket closed (1006)", 1006),
      () => new SessionRefused("INVITE_INVALID"),
      () => session(),
    ]);
    const paired = await result;
    expect(paired.route).toBe("relay");
    expect(calls.map((call) => call.hello.type)).toEqual([
      "pair",
      "pair",
      "resume",
    ]);
    expect(calls[2]?.url).toBe(`wss://relay.example/v1/connect/${link.hostId}`);
  });

  it("reports an invalid invite without resuming when no hello was lost", async () => {
    const { result, calls } = run([() => new SessionRefused("INVITE_INVALID")]);
    await expect(result).rejects.toEqual(new PairingError("INVITE_INVALID"));
    expect(calls).toHaveLength(1);
  });

  it("reports an invalid invite when the resume does not know the phone", async () => {
    const { result } = run([
      () => new SessionClosed("socket closed (1006)", 1006),
      () => new SessionRefused("INVITE_INVALID"),
      () => new SessionRefused("PHONE_UNKNOWN"),
    ]);
    await expect(result).rejects.toEqual(new PairingError("INVITE_INVALID"));
  });

  it("names each refusal and an unreachable computer", async () => {
    await expect(
      run([() => new SessionRefused("RATE_LIMITED")]).result,
    ).rejects.toEqual(new PairingError("RATE_LIMITED"));
    await expect(
      run([
        () => new SessionClosed("unreachable"),
        () => new SessionClosed("unreachable"),
      ]).result,
    ).rejects.toEqual(new PairingError("UNREACHABLE"));
  });
});
