import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  Initiator,
  hostIdOf,
  keyPairFromPrivate,
  sessionPrologue,
  toHex,
} from "./noise";

interface Vectors {
  protocol: string;
  prologue_hex: string;
  computer_static_public_hex: string;
  phone_static_private_hex: string;
  phone_ephemeral_private_hex: string;
  host_id: string;
  first_message_hex: string;
  second_message_hex: string;
  hello_payload_hex: string;
  third_message_hex: string;
  welcome_payload_hex: string;
  welcome_message_hex: string;
  phone_to_computer: { plaintext_hex: string; ciphertext_hex: string }[];
  computer_to_phone: { plaintext_hex: string; ciphertext_hex: string }[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/mobile-session/vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Vectors;

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function initiator(): Initiator {
  return new Initiator({
    staticKey: keyPairFromPrivate(bytes(vectors.phone_static_private_hex)),
    computerPublicKey: bytes(vectors.computer_static_public_hex),
    ephemeralKey: keyPairFromPrivate(
      bytes(vectors.phone_ephemeral_private_hex),
    ),
  });
}

describe("Noise XK initiator", () => {
  it("reproduces the computer's handshake and transport bytes", () => {
    expect(vectors.protocol).toBe("Noise_XK_25519_ChaChaPoly_SHA256");
    const computerKey = bytes(vectors.computer_static_public_hex);
    expect(toHex(sessionPrologue(computerKey))).toBe(vectors.prologue_hex);
    expect(hostIdOf(computerKey)).toBe(vectors.host_id);

    const phone = initiator();
    expect(toHex(phone.writeFirst())).toBe(vectors.first_message_hex);
    phone.readSecond(bytes(vectors.second_message_hex));
    const { message, transport } = phone.writeThird(
      bytes(vectors.hello_payload_hex),
    );
    expect(toHex(message)).toBe(vectors.third_message_hex);
    expect(
      toHex(
        transport.receive.decrypt(
          new Uint8Array(0),
          bytes(vectors.welcome_message_hex),
        ),
      ),
    ).toBe(vectors.welcome_payload_hex);
    for (const vector of vectors.phone_to_computer) {
      expect(
        toHex(
          transport.send.encrypt(
            new Uint8Array(0),
            bytes(vector.plaintext_hex),
          ),
        ),
      ).toBe(vector.ciphertext_hex);
    }
    for (const vector of vectors.computer_to_phone) {
      expect(
        toHex(
          transport.receive.decrypt(
            new Uint8Array(0),
            bytes(vector.ciphertext_hex),
          ),
        ),
      ).toBe(vector.plaintext_hex);
    }
  });

  it("rejects a second message that was tampered with", () => {
    const phone = initiator();
    phone.writeFirst();
    const reply = bytes(vectors.second_message_hex);
    reply[reply.length - 1] = (reply.at(-1) ?? 0) ^ 1;
    expect(() => phone.readSecond(reply)).toThrow();
  });

  it("refuses to send its key before hearing the computer", () => {
    const phone = initiator();
    expect(() => phone.writeThird(new Uint8Array(0))).toThrow();
  });
});
