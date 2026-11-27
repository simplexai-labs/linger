// In-memory stand-ins for the device storage, for unit tests.
import type { SecretStore, TextFiles } from "../computer/store";

export class MemoryFiles implements TextFiles {
  readonly files = new Map<string, string>();

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async write(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }

  async removeDirectory(path: string): Promise<void> {
    for (const key of [...this.files.keys()])
      if (key.startsWith(`${path}/`)) this.files.delete(key);
  }

  async listDirectories(path: string): Promise<string[]> {
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(`${path}/`)) continue;
      const rest = key.slice(path.length + 1).split("/");
      if (rest.length > 1 && rest[0]) names.add(rest[0]);
    }
    return [...names];
  }
}

export class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
