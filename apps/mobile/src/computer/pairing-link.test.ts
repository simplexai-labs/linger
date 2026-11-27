import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "../lib/bytes";
import { generateKeyPair, hostIdOf } from "../session/noise";
import {
  normalizeOrigin,
  parsePairingLink,
  PairingLinkError,
} from "./pairing-link";
import { ComputerStore } from "./store";
import { MemoryFiles, MemorySecrets } from "../testing/memory";

const now = new Date("2026-11-22T10:00:00Z");
const hostKey = generateKeyPair().publicKey;

function link(payload: Record<string, unknown>): string {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return `linger://pair?d=${toBase64Url(json)}`;
}

const valid = {
  v: 1,
  name: "Studio Mac",
  host_key: toBase64Url(hostKey),
  invite: toBase64Url(new Uint8Array(32).fill(7)),
  expires_at: "2026-11-22T10:10:00Z",
  relay: "wss://relay.heylinger.com",
  lan: [
    "ws://192.168.1.20:7443",
    "ws://192.168.1.20:7443/",
    "http://evil.example",
  ],
};

function problem(input: string): string | undefined {
  try {
    parsePairingLink(input, now);
    return undefined;
  } catch (error) {
    return error instanceof PairingLinkError ? error.problem : "OTHER";
  }
}

describe("parsePairingLink", () => {
  it("reads every field of a valid code and derives the Host ID", () => {
    const parsed = parsePairingLink(link(valid), now);
    expect(parsed.computerName).toBe("Studio Mac");
    expect(parsed.hostKey).toEqual(hostKey);
    expect(parsed.hostId).toBe(hostIdOf(hostKey));
    expect(parsed.invite).toBe(valid.invite);
    expect(parsed.relay).toBe("wss://relay.heylinger.com");
    expect(parsed.lan).toEqual(["ws://192.168.1.20:7443"]);
  });

  it("accepts the bare payload a deep link route receives", () => {
    const d = link(valid).split("d=")[1] ?? "";
    expect(parsePairingLink(d, now).computerName).toBe("Studio Mac");
  });

  it("accepts a code without a Relay when it has LAN origins", () => {
    expect(
      parsePairingLink(link({ ...valid, relay: null }), now).relay,
    ).toBeNull();
  });

  it("refuses codes that cannot be used", () => {
    expect(problem("https://example.com")).toBe("NOT_A_PAIRING_CODE");
    expect(problem("linger://pair?d=not*base64")).toBe("NOT_A_PAIRING_CODE");
    expect(problem(link({ ...valid, v: 2 }))).toBe("UNSUPPORTED_VERSION");
    expect(
      problem(link({ ...valid, expires_at: "2026-11-22T09:59:59Z" })),
    ).toBe("EXPIRED");
    expect(
      problem(link({ ...valid, host_key: toBase64Url(new Uint8Array(31)) })),
    ).toBe("NOT_A_PAIRING_CODE");
    expect(problem(link({ ...valid, relay: "https://relay.example" }))).toBe(
      "NOT_A_PAIRING_CODE",
    );
    expect(problem(link({ ...valid, relay: null, lan: [] }))).toBe(
      "NOT_A_PAIRING_CODE",
    );
    expect(problem(link({ ...valid, invite: 5 }))).toBe("NOT_A_PAIRING_CODE");
  });
});

describe("normalizeOrigin", () => {
  it("keeps WebSocket origins and refuses paths and credentials", () => {
    expect(normalizeOrigin("ws://10.0.0.2:7443/")).toBe("ws://10.0.0.2:7443");
    expect(normalizeOrigin("wss://relay.example")).toBe("wss://relay.example");
    expect(normalizeOrigin("ws://[fe80::1]:7443")).toBe("ws://[fe80::1]:7443");
    expect(normalizeOrigin("ws://10.0.0.2:7443/v1/connect/x")).toBeUndefined();
    expect(normalizeOrigin("ws://user@10.0.0.2")).toBeUndefined();
  });
});

describe("base64url", () => {
  it("round-trips every length", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = Uint8Array.from(
        { length },
        (_, index) => (index * 37) & 0xff,
      );
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });
});

describe("ComputerStore", () => {
  it("keeps each computer's key and files apart and deletes all of one", async () => {
    const files = new MemoryFiles();
    const secrets = new MemorySecrets();
    const store = new ComputerStore(files, secrets);
    const first = generateKeyPair();
    const computer = (hostId: string) => ({
      hostId,
      name: hostId,
      hostKey: toBase64Url(hostKey),
      relay: null,
      lan: ["ws://10.0.0.2:7443"],
      phoneId: `phone-${hostId}`,
      pairedAt: new Date().toISOString(),
    });
    await store.add(computer("a".repeat(32)), first);
    await store.add(computer("b".repeat(32)), generateKeyPair());
    await files.write(`computers/${"a".repeat(32)}/outbox.json`, "{}");
    await store.setActive("a".repeat(32));

    expect((await store.key("a".repeat(32)))?.publicKey).toEqual(
      first.publicKey,
    );
    expect((await store.list()).map((item) => item.hostId)).toHaveLength(2);

    await store.remove("a".repeat(32));
    expect(await store.key("a".repeat(32))).toBeUndefined();
    expect(
      await files.read(`computers/${"a".repeat(32)}/outbox.json`),
    ).toBeUndefined();
    expect(await store.activeId()).toBeUndefined();
    expect((await store.list()).map((item) => item.hostId)).toEqual([
      "b".repeat(32),
    ]);
  });
});
