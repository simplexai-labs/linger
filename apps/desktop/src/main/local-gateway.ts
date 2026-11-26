import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  parseLoopbackBifrostAddress,
  resolveLocalmodelsBifrostLocation,
} from "@linger/local-installation/localmodels-tool";

import type { DesktopLocalGatewayInfo } from "../shared/api.js";
import {
  SecretClipboard,
  type SecretClipboardTarget,
} from "./secret-clipboard.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 4096;
const DEFAULT_ADMIN_USER = "localmodels";

export type LocalGatewayClipboard = SecretClipboardTarget;

export interface LocalGatewayOptions {
  /** Returns the current installation's Linger home directory. */
  readonly home: () => string;
  readonly clipboard: LocalGatewayClipboard;
  readonly openExternal: (url: string) => Promise<void>;
  readonly showFile: (file: string) => void;
  readonly clearAfterMs?: number;
}

interface ResolvedGateway {
  readonly appDir: string;
  readonly adminUrl?: string;
  readonly passwordPath: string;
  readonly configPath: string;
}

/** Parses a loopback `127.0.0.1:<port>` address into `http://127.0.0.1:<port>`. */
export function parseLoopbackAdminUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw
    .trim()
    .replace(/^http:\/\//, "")
    .replace(/\/+$/, "");
  const parsed = parseLoopbackBifrostAddress(trimmed);
  return parsed ? `http://${parsed.addr}` : undefined;
}

async function readOwnedRegularFile(
  file: string,
  maxBytes: number,
  options: { requirePrivateMode?: boolean } = {},
): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
      return undefined;
    }
    if (process.platform !== "win32") {
      if (info.uid !== process.getuid?.()) return undefined;
      if (options.requirePrivateMode && (info.mode & 0o077) !== 0) {
        return undefined;
      }
    }
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function isRegularOwnedFile(
  file: string,
  maxBytes: number,
): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
      return false;
    }
    if (process.platform !== "win32" && info.uid !== process.getuid?.()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

async function readJsonObject(
  file: string,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const raw = await readOwnedRegularFile(file, maxBytes);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Local-only reader and helper for this computer's managed Bifrost gateway.
 * Passwords are never cached and never cross TeamHub APIs; they are read on
 * demand from the owner-only `admin-password` file in the Electron main process.
 */
export class LocalGatewayService {
  readonly #options: LocalGatewayOptions;
  readonly #clipboard: SecretClipboard;

  constructor(options: LocalGatewayOptions) {
    this.#options = options;
    this.#clipboard = new SecretClipboard(
      options.clipboard,
      options.clearAfterMs,
    );
  }

  async getInfo(): Promise<DesktopLocalGatewayInfo> {
    const resolved = await this.#resolve();
    if (!resolved) return { available: false };

    const config = await readJsonObject(resolved.configPath, MAX_CONFIG_BYTES);
    const authConfig = field(field(config, "governance"), "auth_config");
    const rawUsername = field(authConfig, "admin_username");
    const username =
      typeof rawUsername === "string" && rawUsername.trim()
        ? rawUsername.trim()
        : DEFAULT_ADMIN_USER;
    const rawDisableInferenceAuth = field(
      authConfig,
      "disable_auth_on_inference",
    );
    const inferenceAuthDisabled =
      typeof rawDisableInferenceAuth === "boolean"
        ? rawDisableInferenceAuth
        : true;
    const hasPassword =
      (await this.#readPassword(resolved.passwordPath)) !== undefined;

    return {
      available: true,
      ...(resolved.adminUrl ? { adminUrl: resolved.adminUrl } : {}),
      username,
      hasPassword,
      inferenceAuthDisabled,
    };
  }

  async revealPassword(): Promise<{ readonly password: string }> {
    const resolved = await this.#resolve();
    if (!resolved) {
      throw new Error(
        "Local Bifrost gateway is not configured on this computer.",
      );
    }
    const password = await this.#readPassword(resolved.passwordPath);
    if (!password) {
      throw new Error(
        "The local Bifrost admin password file is missing or not private.",
      );
    }
    return { password };
  }

  async copyPassword(): Promise<{
    readonly copied: boolean;
    readonly clearAfterMs: number;
  }> {
    const { password } = await this.revealPassword();
    const clearAfterMs = await this.#clipboard.copy(password);
    return { copied: true, clearAfterMs };
  }

  async openAdmin(): Promise<void> {
    const resolved = await this.#resolve();
    if (!resolved?.adminUrl) {
      throw new Error("Local Bifrost gateway address is not available.");
    }
    await this.#options.openExternal(resolved.adminUrl);
  }

  async openFolder(): Promise<void> {
    const resolved = await this.#resolve();
    if (!resolved) {
      throw new Error("Local Bifrost gateway folder is not available.");
    }
    const target = (await isRegularOwnedFile(
      resolved.passwordPath,
      MAX_PASSWORD_BYTES,
    ))
      ? resolved.passwordPath
      : (await isRegularOwnedFile(resolved.configPath, MAX_CONFIG_BYTES))
        ? resolved.configPath
        : resolved.appDir;
    this.#options.showFile(target);
  }

  dispose(): void {
    this.#clipboard.dispose();
  }

  async #readPassword(passwordPath: string): Promise<string | undefined> {
    const raw = await readOwnedRegularFile(passwordPath, MAX_PASSWORD_BYTES, {
      requirePrivateMode: true,
    });
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  }

  async #resolve(): Promise<ResolvedGateway | undefined> {
    const { bifrostDir, addr } = await resolveLocalmodelsBifrostLocation(
      this.#options.home(),
    );
    const passwordPath = path.join(bifrostDir, "admin-password");
    const configPath = path.join(bifrostDir, "config.json");
    const hasPasswordFile = await isRegularOwnedFile(
      passwordPath,
      MAX_PASSWORD_BYTES,
    );
    const hasConfigFile = await isRegularOwnedFile(
      configPath,
      MAX_CONFIG_BYTES,
    );
    if (!hasPasswordFile && !hasConfigFile) return undefined;

    const adminUrl = parseLoopbackAdminUrl(addr);
    return {
      appDir: bifrostDir,
      ...(adminUrl ? { adminUrl } : {}),
      passwordPath,
      configPath,
    };
  }
}
