import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { LANGUAGES } from "../i18n/language.js";
import { isUploadUrl } from "./diagnostics-upload.js";

const workspaceGrant = z.object({
  grantId: z.string().min(1),
  path: z.string().min(1),
  label: z.string(),
  access: z.enum(["read_write", "read_only"]),
  createdAt: z.string(),
});
export type WorkspaceGrant = z.infer<typeof workspaceGrant>;

const savedEnrollment = z.object({
  computerId: z.string().min(1),
  tenantId: z.string().min(1).optional(),
  ownerActorId: z.string().min(1).optional(),
});
export type SavedEnrollment = z.infer<typeof savedEnrollment>;

export const IMESSAGE_HANDLES_MAX = 10;

export class IMessageHandlesError extends Error {
  constructor(
    readonly code: "invalid_handle" | "too_many_handles",
    message: string,
  ) {
    super(message);
    this.name = "IMessageHandlesError";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PUNCTUATION = /[\s\-().]/g;
const E164 = /^\+\d{6,15}$/;

// One iMessage handle in the form senders are compared in: an email
// lowercased, a phone number as `+` and digits. Undefined when it is neither.
export function normalizeIMessageHandle(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.includes("@"))
    return EMAIL.test(trimmed) ? trimmed.toLowerCase() : undefined;
  const phone = trimmed.replace(PHONE_PUNCTUATION, "");
  return E164.test(phone) ? phone : undefined;
}

// Normalized and deduplicated in order; throws on the first invalid handle
// or when more than IMESSAGE_HANDLES_MAX remain.
export function normalizeIMessageHandles(values: readonly string[]): string[] {
  const handles: string[] = [];
  for (const value of values) {
    const handle = normalizeIMessageHandle(value);
    if (!handle)
      throw new IMessageHandlesError(
        "invalid_handle",
        `"${value.trim()}" is not a phone number with country code (+...) or an email address.`,
      );
    if (!handles.includes(handle)) handles.push(handle);
  }
  if (handles.length > IMESSAGE_HANDLES_MAX)
    throw new IMessageHandlesError(
      "too_many_handles",
      `Add at most ${IMESSAGE_HANDLES_MAX} phone numbers or emails.`,
    );
  return handles;
}

// A damaged iMessage block resets only itself: a failure anywhere else in
// the config falls back to every default, which would drop the enrollment.
const imessageSettings = z
  .object({
    enabled: z.boolean().default(false),
    // The person's own phone numbers and Apple ID emails, normalized.
    handles: z.array(z.string()).max(IMESSAGE_HANDLES_MAX).default([]),
    // Whether the person pressed Allow once, so checking Messages may prompt.
    automationAsked: z.boolean().default(false),
  })
  .catch({ enabled: false, handles: [], automationAsked: false });

// Non-secret desktop settings. The Gateway credential is kept apart
// (computer-credential.ts). Keys of older versions, such as sandboxMode,
// are dropped on read.
const desktopConfig = z.object({
  serverUrl: z.string().url().optional(),
  displayName: z.string().optional(),
  computerId: z.string().optional(),
  tenantId: z.string().optional(),
  ownerActorId: z.string().optional(),
  // The Daemon ID the active enrollment named; an enrollment that named none
  // or another one is renewed once at start.
  daemonId: z.string().optional(),
  // Previous enrollments by server origin so re-enrolling after a local reset
  // or server switch renews the same Computer ID for the same account.
  savedEnrollments: z.record(z.string(), savedEnrollment).optional(),
  workspaceGrants: z.array(workspaceGrant).default([]),
  // The language the Web client last chose, which the shell's own text
  // follows; unset until the person chooses one (language.ts). A value
  // this version does not offer is dropped, not the whole file.
  language: z.enum(LANGUAGES).optional().catch(undefined),
  // Always-on mode: keep the system awake even when idle.
  preventSleep: z.boolean().default(false),
  // macOS permissions whose system prompt was shown once.
  permissionsAsked: z.array(z.enum(["folders", "automation"])).default([]),
  imessage: imessageSettings.default({
    enabled: false,
    handles: [],
    automationAsked: false,
  }),
  // The AI runtime the local server's installer set up: its executables
  // (LINGER_<RUNTIME>_PATH) and profiles (CODEX_HOME, CLAUDE_CONFIG_DIR,
  // PI_CODING_AGENT_DIR). The Computer daemon runs with them.
  runtimeEnvironment: z.record(z.string(), z.string()).optional(),
  // The runtime the person chose in that installation; the daemon marks it
  // so TeamHub places Another Me on it.
  preferredRuntime: z.enum(["codex", "claude", "pi"]).optional(),
  // The backup of the earlier Simplex app's data that the local server
  // already told about and enrolled this computer again for.
  legacyBackup: z.string().optional(),
  // Releases URL of the update feed, for a deployment that publishes its own
  // releases (update-manifest.ts); GitHub's simplexai-labs/linger when unset.
  // A value that is not a URL is dropped rather than resetting the file.
  updateFeedUrl: z.string().url().optional().catch(undefined),
  // Where Send Diagnostics uploads to (docs/diagnostics-upload.md); set by
  // hand for a self-hosted receiver. An invalid value is dropped, not the
  // whole file.
  diagnosticsUploadUrl: z
    .string()
    .refine(isUploadUrl)
    .optional()
    .catch(undefined),
  window: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
});
export type DesktopConfig = z.infer<typeof desktopConfig>;

export class ConfigStore {
  readonly #file: string;
  #value: DesktopConfig;

  constructor(file: string, defaults: Partial<DesktopConfig> = {}) {
    this.#file = file;
    // A damaged file falls back to defaults; the user enrolls again.
    const stored = desktopConfig.safeParse({ ...defaults, ...readJson(file) });
    this.#value = stored.success
      ? stored.data
      : desktopConfig.parse({ ...defaults });
  }

  get(): DesktopConfig {
    return this.#value;
  }

  update(patch: Partial<DesktopConfig>): DesktopConfig {
    this.#value = desktopConfig.parse({ ...this.#value, ...patch });
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const staged = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(staged, `${JSON.stringify(this.#value, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(staged, this.#file);
    return this.#value;
  }
}

const readJson = (file: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
};
