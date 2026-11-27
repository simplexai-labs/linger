// Noise_XK_25519_ChaChaPoly_SHA256, initiator side only. This is the phone's
// half of the session described in docs/mobile.md; the computer runs
// flynn/noise. contracts/mobile-session/vectors.json pins both to the same
// bytes, and noise.test.ts checks this file against it.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import nacl from "tweetnacl";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

const PROTOCOL_NAME = "Noise_XK_25519_ChaChaPoly_SHA256";
const PROLOGUE_LABEL = "linger-mobile/1";
const HASH_LENGTH = 32;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
const MAX_NONCE = 2n ** 64n - 1n;

const encoder = new TextEncoder();

export interface KeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

// X25519 runs through tweetnacl: its Float64 field math is several times
// faster in Hermes than noble's BigInt ladder, which cost about 20 ms per
// operation on the phone and three of them per handshake.
function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return nacl.scalarMult.base(privateKey);
}

/** X25519, refusing the all-zero result of a low-order point. */
function sharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  const shared = nacl.scalarMult(privateKey, publicKey);
  if (shared.every((byte) => byte === 0))
    throw new Error("X25519 produced a low-order result");
  return shared;
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  if (privateKey.length !== KEY_LENGTH)
    throw new Error("private key must be 32 bytes");
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The prologue binds a handshake to the protocol version and one computer. */
export function sessionPrologue(computerPublicKey: Uint8Array): Uint8Array {
  return concat(encoder.encode(PROLOGUE_LABEL), computerPublicKey);
}

/** Lowercase hex of the first 16 bytes of SHA-256 over the computer's key. */
export function hostIdOf(computerPublicKey: Uint8Array): string {
  return toHex(sha256(computerPublicKey).subarray(0, 16));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hkdf(
  chainingKey: Uint8Array,
  input: Uint8Array,
): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, input);
  const first = hmac(sha256, tempKey, Uint8Array.of(1));
  const second = hmac(sha256, tempKey, concat(first, Uint8Array.of(2)));
  return [first, second];
}

function nonceBytes(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  let value = counter;
  for (let i = 4; i < 12; i++) {
    nonce[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}

/**
 * One direction of the transport. Nonces count up from zero and are never
 * reused; a failed decryption is fatal for the session.
 */
export class CipherState {
  #key: Uint8Array | undefined;
  #nonce = 0n;

  constructor(key?: Uint8Array) {
    this.#key = key;
  }

  get hasKey(): boolean {
    return this.#key !== undefined;
  }

  encrypt(associated: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.#key) return plaintext;
    const out = chacha20poly1305(this.#key, this.#next(), associated).encrypt(
      plaintext,
    );
    return out;
  }

  decrypt(associated: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.#key) return ciphertext;
    if (ciphertext.length < TAG_LENGTH)
      throw new Error("ciphertext is shorter than its tag");
    return chacha20poly1305(this.#key, this.#next(), associated).decrypt(
      ciphertext,
    );
  }

  #next(): Uint8Array {
    if (this.#nonce >= MAX_NONCE) throw new Error("nonce exhausted");
    const nonce = nonceBytes(this.#nonce);
    this.#nonce += 1n;
    return nonce;
  }
}

class SymmetricState {
  #chainingKey: Uint8Array;
  #hash: Uint8Array;
  #cipher = new CipherState();

  constructor() {
    const name = encoder.encode(PROTOCOL_NAME);
    // The protocol name is exactly HASHLEN bytes, so it is used as is.
    if (name.length !== HASH_LENGTH) throw new Error("protocol name length");
    this.#hash = name;
    this.#chainingKey = name;
  }

  mixHash(data: Uint8Array): void {
    this.#hash = sha256(concat(this.#hash, data));
  }

  mixKey(input: Uint8Array): void {
    const [chainingKey, key] = hkdf(this.#chainingKey, input);
    this.#chainingKey = chainingKey;
    this.#cipher = new CipherState(key);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.#cipher.encrypt(this.#hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.#cipher.decrypt(this.#hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.#chainingKey, new Uint8Array(0));
    return [new CipherState(first), new CipherState(second)];
  }
}

export interface Transport {
  /** Encrypts what the phone sends. */
  readonly send: CipherState;
  /** Decrypts what the computer sends. */
  readonly receive: CipherState;
}

/**
 * The phone's XK handshake. The phone already knows the computer's static
 * key from the pairing code; it reveals its own key and sends its first data
 * only in the third message, after two forward-secret messages.
 */
export class Initiator {
  readonly #symmetric = new SymmetricState();
  readonly #static: KeyPair;
  readonly #remoteStatic: Uint8Array;
  #ephemeral: KeyPair | undefined;
  #remoteEphemeral: Uint8Array | undefined;
  #stage: "first" | "second" | "third" | "done" = "first";

  constructor(input: {
    staticKey: KeyPair;
    computerPublicKey: Uint8Array;
    /** Tests pin the ephemeral key; real handshakes generate it. */
    ephemeralKey?: KeyPair;
  }) {
    if (input.computerPublicKey.length !== KEY_LENGTH)
      throw new Error("computer key must be 32 bytes");
    this.#static = input.staticKey;
    this.#remoteStatic = input.computerPublicKey;
    this.#ephemeral = input.ephemeralKey;
    this.#symmetric.mixHash(sessionPrologue(input.computerPublicKey));
    this.#symmetric.mixHash(input.computerPublicKey);
  }

  /** -> e, es (empty payload) */
  writeFirst(): Uint8Array {
    if (this.#stage !== "first") throw new Error("handshake out of order");
    this.#stage = "second";
    const ephemeral = (this.#ephemeral ??= generateKeyPair());
    this.#symmetric.mixHash(ephemeral.publicKey);
    this.#symmetric.mixKey(
      sharedSecret(ephemeral.privateKey, this.#remoteStatic),
    );
    return concat(
      ephemeral.publicKey,
      this.#symmetric.encryptAndHash(new Uint8Array(0)),
    );
  }

  /** <- e, ee (empty payload) */
  readSecond(message: Uint8Array): void {
    if (this.#stage !== "second" || !this.#ephemeral)
      throw new Error("handshake out of order");
    this.#stage = "third";
    if (message.length !== KEY_LENGTH + TAG_LENGTH)
      throw new Error("handshake reply has the wrong length");
    const remoteEphemeral = message.slice(0, KEY_LENGTH);
    this.#remoteEphemeral = remoteEphemeral;
    this.#symmetric.mixHash(remoteEphemeral);
    this.#symmetric.mixKey(
      sharedSecret(this.#ephemeral.privateKey, remoteEphemeral),
    );
    const payload = this.#symmetric.decryptAndHash(
      message.subarray(KEY_LENGTH),
    );
    if (payload.length !== 0) throw new Error("handshake reply carried data");
  }

  /** -> s, se, payload */
  writeThird(payload: Uint8Array): {
    message: Uint8Array;
    transport: Transport;
  } {
    if (this.#stage !== "third" || !this.#remoteEphemeral)
      throw new Error("handshake out of order");
    this.#stage = "done";
    const encryptedStatic = this.#symmetric.encryptAndHash(
      this.#static.publicKey,
    );
    this.#symmetric.mixKey(
      sharedSecret(this.#static.privateKey, this.#remoteEphemeral),
    );
    const encryptedPayload = this.#symmetric.encryptAndHash(payload);
    const [send, receive] = this.#symmetric.split();
    return {
      message: concat(encryptedStatic, encryptedPayload),
      transport: { send, receive },
    };
  }
}
