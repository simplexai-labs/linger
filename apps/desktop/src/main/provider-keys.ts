import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// The personal provider keys the setup page takes, by the names the services
// read. The installer keeps them in the instance's user.env, which a person
// can also edit by hand; voice keys are saved in the app instead.
export const PROVIDER_KEYS = {
  composio: "COMPOSIO_API_KEY",
} as const;
export type KeyProvider = keyof typeof PROVIDER_KEYS;

// Edits from the setup page: a key replaces the saved one, "" removes it
// and an absent provider keeps it.
export type ProviderKeyChanges = Partial<Record<KeyProvider, string>>;

export const userEnvironmentFile = (home: string, instance: string): string =>
  path.join(home, "instances", instance, "user.env");

// Voice keys a person may still write into user.env by hand; the page does
// not take them, but diagnostics must redact them.
const HAND_EDITED_KEYS = ["SONIOX_API_KEY", "XAI_API_KEY"];

// user.env in `home`; unreadable counts as empty.
function readUserEnvironment(
  home: string,
  instance: string,
): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(userEnvironmentFile(home, instance), "utf8"));
  } catch {
    return {};
  }
}

// The keys saved in `home`, by provider.
export function savedProviderKeys(
  home: string,
  instance: string,
): Partial<Record<KeyProvider, string>> {
  const saved = readUserEnvironment(home, instance);
  const keys: Partial<Record<KeyProvider, string>> = {};
  for (const [provider, name] of Object.entries(PROVIDER_KEYS))
    if (saved[name]?.trim()) keys[provider as KeyProvider] = saved[name].trim();
  return keys;
}

// Every key value user.env in `home` holds, for redaction.
export function savedSecretValues(home: string, instance: string): string[] {
  const saved = readUserEnvironment(home, instance);
  return [...Object.values(PROVIDER_KEYS), ...HAND_EDITED_KEYS]
    .map((name) => saved[name]?.trim())
    .filter((value): value is string => !!value);
}

// The installer's own input for the same edits.
export const installerKeyChanges = (
  changes: ProviderKeyChanges,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(changes).map(([provider, key]) => [
      PROVIDER_KEYS[provider as KeyProvider],
      key,
    ]),
  );
