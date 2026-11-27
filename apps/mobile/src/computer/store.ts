// Everything the phone keeps belongs to one paired computer and lives under
// computers/<hostId>/ (metadata, outbox, push grant) plus one keychain entry
// for the phone's private key. Removing a computer deletes all of it.
import { fromBase64Url, toBase64Url } from "../lib/bytes";
import { keyPairFromPrivate, type KeyPair } from "../session/noise";
import type { RelaySettings } from "./relay-nodes";

export interface PairedComputer extends RelaySettings {
  readonly hostId: string;
  readonly name: string;
  /** The computer's static public key, base64url; the phone pins it. */
  readonly hostKey: string;
  readonly lan: readonly string[];
  readonly phoneId: string;
  readonly pairedAt: string;
}

/** Small text files under the app's private document directory. */
export interface TextFiles {
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  /** Deletes a directory and everything in it; missing is fine. */
  removeDirectory(path: string): Promise<void>;
  /** Names of the directories directly under path; missing is empty. */
  listDirectories(path: string): Promise<string[]>;
}

/** The platform keychain. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const HOST_ID = /^[0-9a-f]{32}$/;

export function computerDirectory(hostId: string): string {
  if (!HOST_ID.test(hostId)) throw new Error("invalid host id");
  return `computers/${hostId}`;
}

function keyName(hostId: string): string {
  return `linger.phone-key.${hostId}`;
}

async function readJson<T>(
  files: TextFiles,
  path: string,
): Promise<T | undefined> {
  const text = await files.read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function hostKeyBytes(computer: PairedComputer): Uint8Array {
  return fromBase64Url(computer.hostKey);
}

export class ComputerStore {
  constructor(
    readonly files: TextFiles,
    private readonly secrets: SecretStore,
  ) {}

  async list(): Promise<PairedComputer[]> {
    const ids = (await this.files.listDirectories("computers")).filter((id) =>
      HOST_ID.test(id),
    );
    const computers: PairedComputer[] = [];
    for (const id of ids) {
      const computer = await readJson<PairedComputer>(
        this.files,
        `${computerDirectory(id)}/computer.json`,
      );
      if (computer?.hostId === id) computers.push(computer);
    }
    return computers.sort((a, b) => a.pairedAt.localeCompare(b.pairedAt));
  }

  async get(hostId: string): Promise<PairedComputer | undefined> {
    const computer = await readJson<PairedComputer>(
      this.files,
      `${computerDirectory(hostId)}/computer.json`,
    );
    return computer?.hostId === hostId ? computer : undefined;
  }

  /** Stores the key first so metadata never names a computer without one. */
  async add(computer: PairedComputer, key: KeyPair): Promise<void> {
    await this.secrets.set(
      keyName(computer.hostId),
      toBase64Url(key.privateKey),
    );
    await this.save(computer);
  }

  async save(computer: PairedComputer): Promise<void> {
    await this.files.write(
      `${computerDirectory(computer.hostId)}/computer.json`,
      JSON.stringify(computer),
    );
  }

  async key(hostId: string): Promise<KeyPair | undefined> {
    const stored = await this.secrets.get(keyName(hostId));
    if (!stored) return undefined;
    try {
      return keyPairFromPrivate(fromBase64Url(stored));
    } catch {
      return undefined;
    }
  }

  /** Deletes the key and every file kept for this computer. */
  async remove(hostId: string): Promise<void> {
    await this.secrets.delete(keyName(hostId));
    await this.files.removeDirectory(computerDirectory(hostId));
    if ((await this.activeId()) === hostId)
      await this.files.write("active.json", "{}");
  }

  async activeId(): Promise<string | undefined> {
    const active = await readJson<{ hostId?: string }>(
      this.files,
      "active.json",
    );
    return active?.hostId;
  }

  async setActive(hostId: string): Promise<void> {
    await this.files.write("active.json", JSON.stringify({ hostId }));
  }
}
