// The device implementations of TextFiles and SecretStore.
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import type { SecretStore, TextFiles } from "./store";

function fileAt(path: string): File {
  return new File(Paths.document, ...path.split("/"));
}

function directoryAt(path: string): Directory {
  return new Directory(Paths.document, ...path.split("/"));
}

// Writes to one path run one at a time, so two never share a temporary file.
const writing = new Map<string, Promise<void>>();

async function replace(path: string, text: string): Promise<void> {
  const file = fileAt(path);
  file.parentDirectory.create({ intermediates: true, idempotent: true });
  // Write beside the target, keep the old file as a backup while the new one
  // moves in, then drop it: a crash at any step leaves either the old or
  // the new contents readable, never neither.
  const temporary = new File(file.parentDirectory, `${file.name}.tmp`);
  const backup = new File(file.parentDirectory, `${file.name}.bak`);
  if (temporary.exists) temporary.delete();
  temporary.create();
  await temporary.write(text);
  if (backup.exists) backup.delete();
  if (file.exists) await file.move(backup);
  await temporary.move(fileAt(path));
  if (backup.exists) backup.delete();
}

export const documentFiles: TextFiles = {
  async read(path) {
    const file = fileAt(path);
    if (file.exists) return file.text();
    // A crash between keeping the backup and moving the new file in.
    const backup = new File(file.parentDirectory, `${file.name}.bak`);
    return backup.exists ? backup.text() : undefined;
  },
  write(path, text) {
    const next = (writing.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => replace(path, text));
    writing.set(path, next);
    return next;
  },
  async removeDirectory(path) {
    const directory = directoryAt(path);
    if (directory.exists) directory.delete();
  },
  async listDirectories(path) {
    const directory = directoryAt(path);
    if (!directory.exists) return [];
    return directory
      .list()
      .filter((entry) => entry instanceof Directory)
      .map((entry) => entry.name);
  },
};

// AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY lets a locked phone reconnect while it
// records, and keeps the key out of backups and device transfers.
const keychainOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const keychain: SecretStore = {
  async get(key) {
    return (await SecureStore.getItemAsync(key, keychainOptions)) ?? undefined;
  },
  async set(key, value) {
    await SecureStore.setItemAsync(key, value, keychainOptions);
  },
  async delete(key) {
    await SecureStore.deleteItemAsync(key, keychainOptions);
  },
};
