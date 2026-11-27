import { windowsPrivatePath } from "./windows-private.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { readLocalIdentityKey, type Instance } from "./instance.js";
import { atomicPrivate, readPrivate } from "./private-files.js";

export function validateLocalCredentials(options: {
  email?: string;
  password?: string;
}): void {
  if (
    options.email !== undefined &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email)
  )
    throw new Error("Enter a valid login email.");
  if (
    options.password !== undefined &&
    (options.password.length < 8 ||
      options.password.length > 256 ||
      /\p{Cc}/u.test(options.password))
  )
    throw new Error(
      "Login passwords must contain 8–256 characters without control characters.",
    );
}
export async function readLocalLogin(
  instance: Pick<Instance, "root">,
): Promise<{ email: string; password: string; file: string }> {
  const file = path.join(instance.root, "local-account.json");
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) ||
    info.size > 16384
  )
    throw new Error(
      "The local account file must be private and owned by the current user (chmod 600).",
    );
  if (process.platform === "win32") await windowsPrivatePath(file, "file");
  try {
    const account = JSON.parse(await readFile(file, "utf8")) as LocalAccount;
    validateLocalCredentials(account);
    if (
      account.provisioned !== true ||
      typeof account.email !== "string" ||
      typeof account.password !== "string"
    )
      throw new Error();
    return { email: account.email, password: account.password, file };
  } catch {
    throw new Error(
      "The local account file is invalid or the account has not been created.",
    );
  }
}
// How the desktop app checks that the server it sends the owner password to
// is this instance's TeamHub: TeamHub's own loopback address and the key
// only TeamHub's process and this file's owner hold (see TeamHub's /v0/local/identity).
export interface LocalIdentity {
  teamhub: string;
  key: Buffer;
}
export async function readLocalIdentity(
  instance: Pick<Instance, "root">,
): Promise<LocalIdentity> {
  const unavailable = () =>
    new Error("Linger on this computer has no server identity yet.");
  const [settings, encoded] = await Promise.all([
    readPrivate(path.join(instance.root, "instance.json")),
    readLocalIdentityKey(instance.root),
  ]);
  if (settings === undefined || encoded === undefined) throw unavailable();
  let port: unknown;
  try {
    port = (JSON.parse(settings) as Partial<Instance>).source?.ports?.teamhub;
  } catch {
    throw unavailable();
  }
  if (
    !Number.isSafeInteger(port) ||
    (port as number) < 1024 ||
    (port as number) > 65535
  )
    throw unavailable();
  const key = Buffer.from(encoded, "base64");
  return { teamhub: `http://127.0.0.1:${port as number}`, key };
}
interface LocalAccount {
  email: string;
  password: string;
  provisioned: boolean;
}

// Whether the owner account exists. Until it does, nothing outside the
// installer keeps the product origin. An unreadable file counts as existing.
export async function localAccountProvisioned(root: string): Promise<boolean> {
  const text = await readPrivate(path.join(root, "local-account.json"));
  if (text === undefined) return false;
  try {
    return (JSON.parse(text) as Partial<LocalAccount>).provisioned !== false;
  } catch {
    return true;
  }
}

// Blocks private login reads during database replacement until the account
// step has established the owner in the new database.
export async function unprovisionLocalAccount(root: string): Promise<void> {
  const file = path.join(root, "local-account.json");
  const text = await readPrivate(file);
  if (text === undefined) return;
  let account: LocalAccount;
  try {
    account = JSON.parse(text) as LocalAccount;
  } catch {
    // Never expose parser errors containing the private password.
    throw new Error(
      "The local account file is invalid; existing credentials will not be overwritten.",
    );
  }
  if (account.provisioned !== true) return;
  await atomicPrivate(
    file,
    JSON.stringify({ ...account, provisioned: false }, null, 2) + "\n",
  );
}

// What TeamHub answers a challenge with (internal/localidentity).
export const localIdentityProof = (
  key: Uint8Array,
  nonce: string,
  origin: string,
): Buffer =>
  createHmac("sha256", key)
    .update(`linger-local-identity\n${nonce}\n${origin}`)
    .digest();

// The server did not prove it holds the key; says what failed, never with what.
export class LocalIdentityError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(`The local server did not prove its identity (${reason}).`, options);
    this.name = "LocalIdentityError";
    this.reason = reason;
  }
}

// Asks the server at `url` to prove it holds this installation's identity
// key for `origin`, with a fresh nonce each time, so an earlier answer
// proves nothing.
export async function proveLocalIdentity(options: {
  url: string | URL;
  origin: string;
  key: Uint8Array;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<void> {
  const nonce = randomBytes(32).toString("base64url");
  let proof: unknown;
  try {
    const response = await (options.fetch ?? fetch)(options.url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ nonce }),
      redirect: "error",
      signal: options.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new LocalIdentityError(`status ${response.status}`);
    }
    proof = ((await response.json()) as { proof?: unknown } | null)?.proof;
  } catch (error) {
    if (error instanceof LocalIdentityError) throw error;
    throw new LocalIdentityError(
      error instanceof SyntaxError ? "invalid answer" : "no answer",
      { cause: error },
    );
  }
  const expected = localIdentityProof(options.key, nonce, options.origin);
  const actual =
    typeof proof === "string" && /^[A-Za-z0-9_-]{43}$/.test(proof)
      ? Buffer.from(proof, "base64url")
      : undefined;
  if (
    !actual ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    throw new LocalIdentityError("wrong proof");
}

const serviceUnavailable = () =>
  new Error(
    "The local account service is unavailable. Reopen Linger to retry; account credentials are preserved.",
  );
// The password goes only to a server that proves, through the origin, that
// it is this instance's TeamHub: another program can answer on `localhost`,
// which macOS tries on ::1 first.
async function proveOrigin(instance: Instance, signal: AbortSignal) {
  const key = await readLocalIdentityKey(instance.root);
  if (!key) throw new Error("The instance has no server identity key.");
  try {
    await proveLocalIdentity({
      url: `${instance.origin}/v0/local/identity`,
      origin: instance.origin,
      key: Buffer.from(key, "base64"),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof LocalIdentityError) || error.reason === "no answer")
      throw serviceUnavailable();
    throw new Error(
      `Another program is answering at ${instance.origin}, so Linger cannot use port ${new URL(instance.origin).port}. Quit that program, then reopen Linger to retry; account credentials are preserved.`,
      { cause: error },
    );
  }
}

async function loadOrInitLocalAccount(
  instance: Pick<Instance, "root">,
  options: { email?: string; password?: string },
): Promise<{ file: string; account: LocalAccount }> {
  const file = path.join(instance.root, "local-account.json");
  let account: LocalAccount;
  try {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      throw new Error(
        "The local account file must be private and owned by the current user (chmod 600).",
      );
    if (process.platform === "win32") await windowsPrivatePath(file, "file");
    account = JSON.parse(await readFile(file, "utf8")) as LocalAccount;
    if (
      typeof account.email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) ||
      typeof account.password !== "string" ||
      account.password.length < 8 ||
      account.password.length > 256 ||
      /\p{Cc}/u.test(account.password) ||
      typeof account.provisioned !== "boolean"
    )
      throw new Error(
        "The local account file is invalid; existing credentials will not be overwritten.",
      );
  } catch (error) {
    if (error instanceof SyntaxError)
      // eslint-disable-next-line preserve-caught-error -- JSON parser errors may contain the private password.
      throw new Error(
        "The local account file is invalid; existing credentials will not be overwritten.",
      );
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    validateLocalCredentials(options);
    account = {
      email: options.email ?? "owner@linger.local",
      password: options.password ?? randomBytes(24).toString("base64url"),
      provisioned: false,
    };
    // Persist before creation, allowing a retry after a committed owner transaction.
    await atomicPrivate(file, JSON.stringify(account, null, 2) + "\n");
  }
  return { file, account };
}

/**
 * Best-effort local owner pre-provisioning before HTTP readiness completes.
 * Loads or creates `local-account.json` and runs the local owner command when
 * the account is not yet marked provisioned; never sends credentials over HTTP,
 * never skips origin verification, and never sets `provisioned: true`.
 */
export async function preProvisionLocalAccount(
  instance: Instance,
  signal: AbortSignal,
  options: {
    email?: string;
    password?: string;
    provisionOwner: (email: string, password: string) => Promise<void>;
  },
): Promise<void> {
  signal.throwIfAborted();
  let loaded: { file: string; account: LocalAccount };
  try {
    loaded = await loadOrInitLocalAccount(instance, options);
  } catch {
    signal.throwIfAborted();
    return;
  }
  signal.throwIfAborted();
  if (loaded.account.provisioned) return;
  try {
    await options.provisionOwner(loaded.account.email, loaded.account.password);
  } catch (error) {
    if (signal.aborted) throw error;
  }
  signal.throwIfAborted();
}

// Called under the instance lock. TeamHub owns deployment-owner creation;
// its idempotent command never resets an existing account password.
export async function ensureLocalAccount(
  instance: Instance,
  signal: AbortSignal,
  options: {
    email?: string;
    password?: string;
    // Resolves only when this email owns the deployment; never resets a password.
    provisionOwner: (email: string, password: string) => Promise<void>;
  },
): Promise<{ email: string; file: string; password: string }> {
  const { file, account } = await loadOrInitLocalAccount(instance, options);
  const email = account.email;
  signal.throwIfAborted();
  await proveOrigin(instance, signal);
  async function post(route: string, body: unknown, cookie?: string) {
    let response: Response;
    try {
      response = await fetch(`${instance.origin}/v0/auth/${route}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw serviceUnavailable();
    }
    await response.body?.cancel();
    return response;
  }
  async function complete(response: Response) {
    account.provisioned = true;
    await atomicPrivate(file, JSON.stringify(account, null, 2) + "\n");
    // This CLI session is not the browser session; discard it after provisioning.
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (cookie) await post("logout", {}, cookie).catch(() => {});
    signal.throwIfAborted();
    return { email, file, password: account.password };
  }
  const login = await post("login", {
    identifier: email,
    password: account.password,
  });
  if (login.ok) return complete(login);
  if (login.status !== 401)
    throw new Error(`Local account login check failed (HTTP ${login.status})`);
  let ownerConfirmed = false;
  try {
    await options.provisionOwner(email, account.password);
    ownerConfirmed = true;
  } catch {
    // The command can fail after commit. Never expose diagnostics containing
    // private input; confirm ownership using the persisted password instead.
    signal.throwIfAborted();
  }
  const confirmed = await post("login", {
    identifier: email,
    password: account.password,
  });
  if (confirmed.ok) return complete(confirmed);
  // An existing owner may have changed the password in Settings. The local
  // command confirms the owner exists, not that the saved password is current.
  if (account.provisioned && ownerConfirmed && confirmed.status === 401) {
    signal.throwIfAborted();
    return { email, file, password: account.password };
  }
  throw new Error(
    `Local account sign-in failed after creation (HTTP ${confirmed.status}). Credentials are preserved; existing accounts will not be reset.`,
  );
}
