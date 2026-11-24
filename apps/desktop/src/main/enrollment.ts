import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import type { components } from "@linger/wire-contracts/teamhub-public/types";

import type { CredentialStore } from "./computer-credential.js";
import type { SavedEnrollment } from "./config.js";
import type { Module, ModuleContext } from "./modules.js";
import type { WorkspaceGrantsModule } from "./workspace-grants.js";

type Schemas = components["schemas"];
type CreateRequest = Schemas["LocalComputerEnrollmentCreateRequest"];
type Authorization = Schemas["LocalComputerEnrollmentAuthorization"];
type ExchangeRequest = Schemas["LocalComputerEnrollmentExchangeRequest"];
type CredentialBundle = Schemas["LocalComputerCredentialBundle"];
type ServerCapability = NonNullable<
  Schemas["CurrentIdentity"]["server_capabilities"]
>[number];
const DAEMON_ID_CAPABILITY: ServerCapability =
  "local_computer_enrollment_daemon_id";

// The main process both creates and exchanges the enrollment, so nothing is
// ever redirected here. TeamHub still requires a loopback redirect URI.
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const REQUEST_TIMEOUT_MS = 30_000;

export class EnrollmentError extends Error {
  constructor(
    readonly code:
      | "NOT_SIGNED_IN"
      | "NO_TENANT"
      | "REJECTED"
      | "ENROLLMENT_REMOVED"
      | "DAEMON_IDENTITY_IN_USE"
      | "DAEMON_IDENTITY_MISMATCH"
      | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
  }
}

export interface EnrollInput {
  readonly serverUrl: string;
  // Session cookie header of the signed-in web session. Used for the create
  // call only and never stored or logged.
  readonly cookie: string;
  readonly displayName: string;
  // Keeps the same Computer identity when enrolling again.
  readonly computerId?: string;
  // SHA-256 of the local Daemon public key in base64url. Sent only to a
  // server whose /v0/me lists the capability, since an older one rejects it.
  readonly daemonId?: string;
  // When re-enrolling after a reset, omit computerId if another account signed in.
  readonly expectedOwnerActorId?: string;
  // Persists the authorized Computer ID before exchange completes.
  readonly onAuthorized?: (authorized: {
    readonly computerId: string;
    readonly tenantId: string;
    readonly ownerActorId?: string;
  }) => void;
  readonly fetch?: typeof fetch;
}

export interface Enrolled {
  readonly computerId: string;
  readonly tenantId: string;
  // The account the credential acts for; runtime registrations are its.
  readonly ownerActorId: string;
  // The Runner Gateway the daemon connects to (ws or wss).
  readonly gatewayUrl: string;
  readonly credential: string;
  // The Daemon ID the enrollment named, when the server accepted one.
  readonly daemonId?: string;
}

// PKCE enrollment for this computer with the current web session:
// create (as the signed-in human) -> exchange (as the computer).
export const enrollComputer = async (input: EnrollInput): Promise<Enrolled> => {
  const request = input.fetch ?? fetch;
  const call = (
    pathname: string,
    init: { method?: string; body?: unknown; cookie?: string },
  ): Promise<Response> =>
    request(new URL(pathname, input.serverUrl), {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  const me = await call("/v0/me", { cookie: input.cookie });
  if (me.status === 401)
    throw new EnrollmentError("NOT_SIGNED_IN", "Sign in before enrolling");
  if (!me.ok) throw rejected("Reading the signed-in account", me.status);
  const identity: unknown = await me.json();
  const actor = humanActor(identity);
  if (!actor)
    throw new EnrollmentError("NO_TENANT", "The account has no workspace");
  const { tenantId, actorId } = actor;
  const daemonId =
    input.daemonId && acceptsDaemonId(identity) ? input.daemonId : undefined;

  const candidateComputerId =
    input.expectedOwnerActorId &&
    actorId &&
    actorId !== input.expectedOwnerActorId
      ? undefined
      : input.computerId;

  const createEnrollment = async (
    computerId?: string,
  ): Promise<{ verifier: string; response: Response }> => {
    const verifier = randomBytes(32).toString("base64url");
    const createBody: CreateRequest = {
      display_name: input.displayName,
      redirect_uri: REDIRECT_URI,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(computerId ? { computer_id: computerId } : {}),
      ...(daemonId ? { daemon_id: daemonId } : {}),
    };
    const response = await call(
      `/v0/tenants/${encodeURIComponent(tenantId)}/local-computer-enrollments`,
      { method: "POST", body: createBody, cookie: input.cookie },
    );
    return { verifier, response };
  };

  let { verifier, response: created } =
    await createEnrollment(candidateComputerId);
  if (
    (created.status === 404 || created.status === 410) &&
    candidateComputerId
  ) {
    ({ verifier, response: created } = await createEnrollment(undefined));
  }
  if (created.status === 401)
    throw new EnrollmentError("NOT_SIGNED_IN", "Sign in before enrolling");
  if (created.status === 409) {
    const code = await readErrorCode(created);
    if (code === "DAEMON_IDENTITY_IN_USE")
      throw new EnrollmentError(
        "DAEMON_IDENTITY_IN_USE",
        "This computer is already connected to another Linger account. Sign in to that account to reconnect it, or remove this Computer from that account first.",
      );
    if (code === "LOCAL_COMPUTER_IDENTITY_MISMATCH")
      throw new EnrollmentError(
        "DAEMON_IDENTITY_MISMATCH",
        "This Computer registration belongs to another local identity. Remove the old Computer in Linger first, then reconnect.",
      );
    throw rejected("Creating the enrollment", created.status);
  }
  if (!created.ok) throw rejected("Creating the enrollment", created.status);
  const authorization = (await created.json()) as Authorization;
  if (
    !authorization.enrollment_id ||
    !authorization.authorization_code ||
    !authorization.computer_id
  )
    throw invalid();
  input.onAuthorized?.({
    computerId: authorization.computer_id,
    tenantId,
    ...(actorId ? { ownerActorId: actorId } : {}),
  });

  const exchangeBody: ExchangeRequest = {
    authorization_code: authorization.authorization_code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  };
  const exchanged = await call(
    `/v0/local-computer-enrollments/${encodeURIComponent(authorization.enrollment_id)}/exchange`,
    { method: "POST", body: exchangeBody },
  );
  if (exchanged.status === 410)
    throw new EnrollmentError(
      "ENROLLMENT_REMOVED",
      "This Computer was removed; enroll it again",
    );
  if (!exchanged.ok)
    throw rejected("Exchanging the enrollment", exchanged.status);
  const bundle = (await exchanged.json()) as CredentialBundle;
  if (
    !bundle.computer_id ||
    bundle.computer_id !== authorization.computer_id ||
    bundle.tenant_id !== tenantId ||
    typeof bundle.gateway_token !== "string" ||
    bundle.gateway_token.length < 32 ||
    !isGatewayUrl(bundle.gateway_url)
  )
    throw invalid();
  const ownerActorId = credentialOwner(
    bundle.gateway_token,
    bundle.computer_id,
    bundle.tenant_id,
  );
  if (!ownerActorId) throw invalid();
  return {
    computerId: bundle.computer_id,
    tenantId: bundle.tenant_id,
    ownerActorId,
    gatewayUrl: bundle.gateway_url,
    credential: bundle.gateway_token,
    ...(daemonId ? { daemonId } : {}),
  };
};

// Whether the server's /v0/me lists that its enrollment accepts daemon_id.
// A TeamHub older than the desktop omits the list and rejects the field.
function acceptsDaemonId(identity: unknown): boolean {
  const capabilities = (identity as { server_capabilities?: unknown } | null)
    ?.server_capabilities;
  return (
    Array.isArray(capabilities) && capabilities.includes(DAEMON_ID_CAPABILITY)
  );
}

const isGatewayUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "wss:" || url.protocol === "ws:") && !!url.host;
  } catch {
    return false;
  }
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const isLoopbackGatewayUrl = (value: unknown): value is string => {
  if (!isGatewayUrl(value)) return false;
  const url = new URL(value);
  return (
    LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) &&
    url.pathname === "/v1/runner-gateway" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
};

// The owner the credential is scoped to for the tenant, read from its claims
// the way the Go daemon reads them (config.go tokenOwners). Not verified
// here: the gateway checks the signature.
export const credentialOwner = (
  credential: string,
  computerId: string,
  tenantId: string,
): string | undefined => {
  const [format, payload] = credential.split(".");
  if (format !== "sr1" || !payload) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as {
      runner_id?: unknown;
      tenant_owners?: { tenant_id?: unknown; owner_actor_id?: unknown }[];
    };
    if (claims.runner_id !== computerId) return undefined;
    const owner = claims.tenant_owners?.find(
      (item) => item.tenant_id === tenantId,
    )?.owner_actor_id;
    return typeof owner === "string" && owner ? owner : undefined;
  } catch {
    return undefined;
  }
};

function humanActor(
  value: unknown,
): { readonly tenantId: string; readonly actorId?: string } | undefined {
  const actors = (value as { actors?: unknown }).actors;
  if (!Array.isArray(actors)) return undefined;
  const human = actors.find(
    (a): a is { tenant_id: string; id?: unknown } =>
      !!a &&
      typeof a === "object" &&
      (a as { kind?: unknown }).kind === "human" &&
      typeof (a as { tenant_id?: unknown }).tenant_id === "string",
  );
  if (!human) return undefined;
  const actorId =
    typeof human.id === "string" && human.id ? human.id : undefined;
  return { tenantId: human.tenant_id, ...(actorId ? { actorId } : {}) };
}

export function humanTenant(value: unknown): string | undefined {
  return humanActor(value)?.tenantId;
}

// Reads the Daemon public key file and computes the same base64url SHA-256
// Daemon ID the Go daemon computes; never reads or retains the private key.
export function readDaemonId(file: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const encoded = (parsed as { public_key?: unknown }).public_key;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=?$/.test(encoded))
    return undefined;
  const publicKey = Buffer.from(encoded, "base64");
  if (publicKey.length !== 32) return undefined;
  return createHash("sha256").update(publicKey).digest("base64url");
}

export function enrollmentOrigin(serverUrl: string): string | undefined {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return undefined;
  }
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body?.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

const rejected = (step: string, status: number): EnrollmentError =>
  new EnrollmentError("REJECTED", `${step} failed (${String(status)})`);
const invalid = (): EnrollmentError =>
  new EnrollmentError(
    "INVALID_RESPONSE",
    "The server returned an invalid enrollment",
  );

export interface EnrollmentOptions {
  // Reads the web session cookie from the renderer session.
  readonly sessionCookie: (serverUrl: string) => Promise<string | undefined>;
  readonly defaultDisplayName: string;
  // Where the Gateway credential is kept for the daemon.
  readonly credentials: CredentialStore;
  // Path to the Go daemon's daemon-identity.json file.
  readonly daemonIdentityFile?: string;
  readonly fetch?: typeof fetch;
}

// Stores the credential for the daemon; the app config keeps only the
// non-secret Computer id.
export class EnrollmentModule implements Module {
  readonly name = "Enrollment";
  readonly dependsOn = ["Config"];
  readonly #options: EnrollmentOptions;
  #ctx: ModuleContext | undefined;
  #pending: Promise<{ computerId: string }> | undefined;
  #offServerChanged: (() => void) | undefined;
  #offServerMoved: (() => void) | undefined;
  #activeServerUrl: string | undefined;

  constructor(options: EnrollmentOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const initial = ctx.config.get();
    if (initial.serverUrl && initial.computerId) {
      this.#activeServerUrl = initial.serverUrl;
      this.#remember(initial.serverUrl, {
        computerId: initial.computerId,
        ...(initial.tenantId ? { tenantId: initial.tenantId } : {}),
        ...(initial.ownerActorId ? { ownerActorId: initial.ownerActorId } : {}),
      });
    }
    // An enrollment belongs to one server; switching servers drops it.
    this.#offServerChanged = ctx.bus.on("server.changed", () => {
      if (!ctx.config.get().computerId) {
        this.#activeServerUrl = undefined;
        return;
      }
      void this.#unenrollForServerChange().catch((error: unknown) =>
        ctx.log.warn("enrollment.clear_failed", { error: String(error) }),
      );
    });
    // The same server at another origin keeps its enrollments: the Computer
    // reaches it through the gateway TeamHub named, not through the origin.
    this.#offServerMoved = ctx.bus.on("server.moved", (from, to) => {
      this.#moveEnrollment(from, to);
    });
    // Enrollments made before the owner was kept, or whose credential did
    // not carry over from the bridge, are renewed for the same Computer.
    const config = ctx.config.get();
    if (!config.computerId) return;
    const renewFailed = (error: unknown): void =>
      ctx.log.warn("enrollment.renew_failed", { error: String(error) });
    if (
      !config.ownerActorId ||
      this.#options.credentials.read()?.computerId !== config.computerId
    ) {
      void this.enroll().catch(renewFailed);
      return;
    }
    // So, once, is an enrollment that did not name the daemon's identity:
    // Set Up Again in an earlier release paired a new Computer while the
    // identity stayed bound to the old one, and naming it renews the old one.
    const daemonId = this.#readDaemonId();
    if (daemonId !== undefined && config.daemonId !== daemonId)
      void this.#nameDaemon().catch(renewFailed);
  }

  async stop(): Promise<void> {
    this.#offServerChanged?.();
    this.#offServerMoved?.();
  }

  #moveEnrollment(from: string, to: string): void {
    const fromOrigin = enrollmentOrigin(from);
    const toOrigin = enrollmentOrigin(to);
    if (!fromOrigin || !toOrigin) return;
    if (
      this.#activeServerUrl &&
      enrollmentOrigin(this.#activeServerUrl) === fromOrigin
    )
      this.#activeServerUrl = to;
    const saved = this.#ctx!.config.get().savedEnrollments;
    const entry = saved?.[fromOrigin];
    if (!saved || !entry) return;
    this.#ctx!.config.update({
      savedEnrollments: Object.fromEntries([
        ...Object.entries(saved).filter(([origin]) => origin !== fromOrigin),
        [toOrigin, entry],
      ]),
    });
  }

  // Updates the saved loopback gateway URL when the local server's
  // node-services listener moved to a different port, keeping the existing
  // Computer identity and token, and restarts the daemon to connect there.
  syncLocalGatewayUrl(gatewayUrl: string): boolean {
    const ctx = this.#ctx;
    if (!ctx || !isLoopbackGatewayUrl(gatewayUrl)) return false;
    const config = ctx.config.get();
    if (!config.computerId) return false;
    const credential = this.#options.credentials.read();
    if (
      !credential ||
      credential.computerId !== config.computerId ||
      !isLoopbackGatewayUrl(credential.gatewayUrl) ||
      credential.gatewayUrl === gatewayUrl
    )
      return false;
    this.#options.credentials.write({ ...credential, gatewayUrl });
    ctx.bus.emit("computer.changed", credential.computerId);
    ctx.log.info("enrollment.gateway_moved", {
      computer_id: credential.computerId,
      from: credential.gatewayUrl,
      to: gatewayUrl,
    });
    return true;
  }

  // Whether the window holds a valid session for the configured server.
  async signedIn(): Promise<boolean> {
    return (await this.#identity()) !== undefined;
  }

  // The signed-in identity (/v0/me) on the configured server, or undefined
  // when signed out or unreachable.
  async #identity(): Promise<unknown> {
    const serverUrl = this.#ctx!.config.get().serverUrl;
    if (!serverUrl) return undefined;
    const cookie = await this.#options.sessionCookie(serverUrl);
    if (!cookie) return undefined;
    try {
      const response = await (this.#options.fetch ?? fetch)(
        new URL("/v0/me", serverUrl),
        {
          headers: { accept: "application/json", cookie },
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      return response.ok ? ((await response.json()) as unknown) : undefined;
    } catch {
      return undefined;
    }
  }

  // Renews the enrollment so it names the daemon's identity, only on a
  // server that accepts it, so an older one sees no credential rotation.
  async #nameDaemon(): Promise<void> {
    if (acceptsDaemonId(await this.#identity())) await this.enroll();
  }

  #readDaemonId(): string | undefined {
    return this.#options.daemonIdentityFile
      ? readDaemonId(this.#options.daemonIdentityFile)
      : undefined;
  }

  enroll(): Promise<{ computerId: string }> {
    // Concurrent clicks share one enrollment instead of creating two.
    this.#pending ??= this.#enroll().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async unenroll(): Promise<void> {
    await this.#clearEnrollment(
      this.#activeServerUrl ?? this.#ctx!.config.get().serverUrl,
    );
  }

  async #unenrollForServerChange(): Promise<void> {
    await this.#clearEnrollment(this.#activeServerUrl);
  }

  async #clearEnrollment(serverUrl: string | undefined): Promise<void> {
    const ctx = this.#ctx!;
    const config = ctx.config.get();
    const saved =
      serverUrl && config.computerId
        ? this.#withSaved(serverUrl, {
            computerId: config.computerId,
            ...(config.tenantId ? { tenantId: config.tenantId } : {}),
            ...(config.ownerActorId
              ? { ownerActorId: config.ownerActorId }
              : {}),
          })
        : undefined;
    this.#activeServerUrl = undefined;
    this.#options.credentials.clear();
    ctx.config.update({
      computerId: undefined,
      tenantId: undefined,
      ownerActorId: undefined,
      daemonId: undefined,
      ...(saved ? { savedEnrollments: saved } : {}),
    });
    ctx.bus.emit("computer.changed", undefined);
    ctx.log.info("enrollment.cleared");
  }

  async #enroll(): Promise<{ computerId: string }> {
    const ctx = this.#ctx!;
    const config = ctx.config.get();
    if (!config.serverUrl) throw new Error("Server address is not set");
    const cookie = await this.#options.sessionCookie(config.serverUrl);
    if (!cookie)
      throw new EnrollmentError("NOT_SIGNED_IN", "Sign in before enrolling");
    const origin = enrollmentOrigin(config.serverUrl);
    const saved = origin ? config.savedEnrollments?.[origin] : undefined;
    const computerId = config.computerId ?? saved?.computerId;
    const expectedOwnerActorId = config.computerId
      ? undefined
      : saved?.ownerActorId;
    const daemonId = this.#readDaemonId();
    const serverUrl = config.serverUrl;
    const enrolled = await enrollComputer({
      serverUrl,
      cookie,
      displayName: config.displayName ?? this.#options.defaultDisplayName,
      ...(computerId ? { computerId } : {}),
      ...(expectedOwnerActorId ? { expectedOwnerActorId } : {}),
      ...(daemonId ? { daemonId } : {}),
      onAuthorized: (authorized) => {
        this.#remember(serverUrl, authorized);
      },
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
    });
    this.#options.credentials.write({
      computerId: enrolled.computerId,
      gatewayUrl: enrolled.gatewayUrl,
      token: enrolled.credential,
    });
    const nextSaved = this.#withSaved(serverUrl, {
      computerId: enrolled.computerId,
      tenantId: enrolled.tenantId,
      ownerActorId: enrolled.ownerActorId,
    });
    this.#activeServerUrl = serverUrl;
    ctx.config.update({
      computerId: enrolled.computerId,
      tenantId: enrolled.tenantId,
      ownerActorId: enrolled.ownerActorId,
      daemonId: enrolled.daemonId,
      ...(nextSaved ? { savedEnrollments: nextSaved } : {}),
    });
    // Populate the default workspace grant before emitting computer.changed
    // so the daemon starts with workspace_grants ready for first-online setup.
    await ctx.get<WorkspaceGrantsModule>("WorkspaceGrants").ensureDefault();
    ctx.bus.emit("computer.changed", enrolled.computerId);
    ctx.log.info("enrollment.completed", { computer_id: enrolled.computerId });
    return { computerId: enrolled.computerId };
  }

  #remember(serverUrl: string, entry: SavedEnrollment): void {
    const next = this.#withSaved(serverUrl, entry);
    if (next) this.#ctx?.config.update({ savedEnrollments: next });
  }

  #withSaved(
    serverUrl: string,
    entry: SavedEnrollment,
  ): Record<string, SavedEnrollment> | undefined {
    const origin = enrollmentOrigin(serverUrl);
    if (!origin) return undefined;
    return {
      ...this.#ctx?.config.get().savedEnrollments,
      [origin]: entry,
    };
  }
}
