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
  // Persisted when a Windows NVIDIA driver update requires a reboot, so the
  // next launch after reboot can auto-recheck local models and surface a ready
  // notice for the model the person tried to unlock.
  pendingDriverUpdate: z
    .object({
      targetVersion: z.string().min(1),
      resumeModelId: z.string().optional(),
      updatedAt: z.string().min(1),
    })
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
