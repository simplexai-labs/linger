import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ensureLocalAccount,
  localIdentityProof,
  preProvisionLocalAccount,
} from "./account.js";
import type { Instance } from "./instance.js";
import {
  expectPrivateFixtureFile,
  shareFixtureFile,
} from "./test-support/private-files.js";

const provisionOwner =
  vi.fn<(email: string, password: string) => Promise<void>>();
const owner = { provisionOwner };
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const identityKey = Buffer.alloc(32, 9);
async function fixture({ identity = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "linger-account-"));
  roots.push(root);
  const instance = { root, origin: "http://localhost:3000" } as Instance;
  if (identity)
    await writeFile(
      path.join(root, "local-identity.key"),
      `${identityKey.toString("base64")}\n`,
      { mode: 0o600 },
    );
  return {
    instance,
    file: path.join(root, "local-account.json"),
    signal: new AbortController().signal,
  };
}
// This instance's server: it proves the origin before `handler` sees requests.
function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/v0/local/identity")) return handler(url, init);
      const { nonce } = JSON.parse(init?.body as string) as { nonce: string };
      return Response.json({
        proof: localIdentityProof(
          identityKey,
          nonce,
          "http://localhost:3000",
        ).toString("base64url"),
      });
    }),
  );
}
it("creates the owner through stdin, confirms login and logs out before reusing private credentials", async () => {
  const f = await fixture();
  const requests: string[] = [];
  let created = false;
  stubFetch(
    vi.fn(async (url: string) => {
      requests.push(new URL(url).pathname);
      return new Response(null, {
        status: url.endsWith("/logout") ? 204 : created ? 200 : 401,
        headers: created ? { "set-cookie": "session=test; HttpOnly" } : {},
      });
    }),
  );
  provisionOwner.mockImplementation(async (email, password) => {
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    expect(saved.provisioned).toBe(false);
    expect(email).toBe(saved.email);
    expect(password === saved.password).toBe(true);
    created = true;
  });
  const result = await ensureLocalAccount(f.instance, f.signal, owner);
  expect(result.email).toBe("owner@linger.local");
  expect(result.file).toBe(f.file);
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  expect(saved.password.length).toBeGreaterThanOrEqual(24);
  expect(saved.provisioned).toBe(true);
  await expectPrivateFixtureFile(f.file);
  expect(requests).toEqual([
    "/v0/auth/login",
    "/v0/auth/login",
    "/v0/auth/logout",
  ]);
  vi.mocked(fetch).mockClear();
  provisionOwner.mockClear();
  await ensureLocalAccount(f.instance, f.signal, owner);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map(
        ([url]) => new URL(url instanceof Request ? url.url : url).pathname,
      ),
  ).toEqual(["/v0/local/identity", "/v0/auth/login", "/v0/auth/logout"]);
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(
    JSON.parse(await readFile(f.file, "utf8")).password === saved.password,
  ).toBe(true);
});
it("recovers owner creation interrupted after commit using the saved password without resetting it", async () => {
  const f = await fixture();
  const password = "a".repeat(32);
  await writeFile(
    f.file,
    JSON.stringify({
      email: "owner@linger.local",
      password,
      provisioned: false,
    }),
    { mode: 0o600 },
  );
  stubFetch(
    vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "set-cookie": "session=test; HttpOnly" },
        }),
    ),
  );
  await ensureLocalAccount(f.instance, f.signal, owner);
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(true);
  expect(JSON.parse(await readFile(f.file, "utf8")).password).toBe(password);
});
it("does not mark an existing owner provisioned when its saved password cannot log in", async () => {
  const f = await fixture();
  stubFetch(vi.fn(async () => new Response(null, { status: 401 })));
  provisionOwner.mockResolvedValue(undefined);
  await expect(
    ensureLocalAccount(f.instance, f.signal, owner).then(() => "success"),
  ).rejects.toThrow(/existing accounts will not be reset/);
  expect(provisionOwner).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(false);
});
it("confirms a committed owner after a command failure without exposing command diagnostics", async () => {
  const f = await fixture();
  let attempts = 0;
  stubFetch(
    vi.fn(
      async () => new Response(null, { status: ++attempts === 1 ? 401 : 200 }),
    ),
  );
  provisionOwner.mockRejectedValue(new Error("private-server-secret"));
  await ensureLocalAccount(f.instance, f.signal, owner);
  expect(attempts).toBe(2);
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(true);
});
it("keeps credentials private when command creation and login both fail", async () => {
  const f = await fixture();
  stubFetch(vi.fn(async () => new Response(null, { status: 401 })));
  provisionOwner.mockRejectedValue(new Error("private-server-secret"));
  const message = await ensureLocalAccount(f.instance, f.signal, owner).then(
    () => "success",
    (error: Error) => error.message,
  );
  expect(message).toMatch(/existing accounts will not be reset/);
  expect(message).not.toContain("private-server-secret");
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(false);
});
it("does not create an owner on an unexpected login error or leak server response secrets", async () => {
  const f = await fixture();
  stubFetch(
    vi.fn(async () => new Response("private-server-secret", { status: 503 })),
  );
  await expect(
    ensureLocalAccount(f.instance, f.signal, owner).then(() => "success"),
  ).rejects.toThrow("Local account login check failed (HTTP 503)");
  expect(provisionOwner).not.toHaveBeenCalled();
});
it("rejects nonprivate or linked credential files before network activity", async () => {
  const f = await fixture();
  const target = path.join(f.instance.root, "target");
  const instance = { ...f.instance };
  if (process.platform === "win32") {
    // A junction exercises reparse-point rejection without needing permission
    // to create a Windows file symlink.
    await mkdir(target);
    await writeFile(path.join(target, path.basename(f.file)), "{}");
    instance.root = path.join(f.instance.root, "junction");
    await symlink(target, instance.root, "junction");
  } else {
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, f.file);
  }
  vi.stubGlobal("fetch", vi.fn());
  await expect(ensureLocalAccount(instance, f.signal, owner)).rejects.toThrow(
    /private/,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("does not expose credential text from malformed JSON or continue after cancellation", async () => {
  const f = await fixture();
  await writeFile(f.file, '{"password":"private-password" malformed}', {
    mode: 0o600,
  });
  vi.stubGlobal("fetch", vi.fn());
  await expect(ensureLocalAccount(f.instance, f.signal, owner)).rejects.toThrow(
    "The local account file is invalid; existing credentials will not be overwritten.",
  );
  await rm(f.file);
  await expect(
    ensureLocalAccount(f.instance, AbortSignal.abort(), owner),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("accepts first-time custom credentials and reuses them without resetting", async () => {
  const f = await fixture();
  stubFetch(vi.fn(async () => new Response(null, { status: 200 })));
  const expected = {
    email: "custom@example.com",
    password: "custom-password-123",
  };
  const result = await ensureLocalAccount(f.instance, f.signal, {
    ...expected,
    provisionOwner,
  });
  expect(result).toMatchObject(expected);
  const again = await ensureLocalAccount(f.instance, f.signal, {
    email: "other@example.com",
    password: "other-password-123",
    provisionOwner,
  });
  expect(again).toMatchObject(expected);
});
it("provides credentials only through a validated private login read", async () => {
  const { readLocalLogin } = await import("./account.js");
  const f = await fixture();
  await writeFile(
    f.file,
    JSON.stringify({
      email: "person@example.com",
      password: "a-private-password",
      provisioned: true,
    }),
    { mode: 0o600 },
  );
  expect(await readLocalLogin(f.instance)).toMatchObject({
    email: "person@example.com",
    password: "a-private-password",
  });
  await shareFixtureFile(f.file);
  await expect(readLocalLogin(f.instance)).rejects.toThrow(/private/);
});
it("rejects invalid custom credentials before writing or calling the account service", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn());
  await expect(
    ensureLocalAccount(f.instance, f.signal, {
      email: "bad",
      password: "x",
      provisionOwner,
    }),
  ).rejects.toThrow(/email/);
  await expect(readFile(f.file, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("uses a source owner provisioner with saved credentials and confirms login", async () => {
  const f = await fixture();
  let attempts = 0;
  stubFetch(
    vi.fn(
      async () => new Response(null, { status: ++attempts === 1 ? 401 : 200 }),
    ),
  );
  provisionOwner.mockResolvedValue(undefined);
  let provisioned = false;
  await ensureLocalAccount(f.instance, f.signal, {
    provisionOwner: async (email, password) => {
      const saved = JSON.parse(await readFile(f.file, "utf8"));
      expect(email === saved.email && password === saved.password).toBe(true);
      provisioned = true;
    },
  });
  expect(provisioned).toBe(true);
  expect(attempts).toBe(2);
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(true);
});
it("reads the server identity from the private instance files", async () => {
  const { readLocalIdentity } = await import("./account.js");
  const f = await fixture({ identity: false });
  const key = Buffer.alloc(32, 7);
  await expect(readLocalIdentity(f.instance)).rejects.toThrow(
    "Linger on this computer has no server identity yet.",
  );
  await writeFile(
    path.join(f.instance.root, "instance.json"),
    JSON.stringify({ source: { ports: { teamhub: 4100, web: 3000 } } }),
    { mode: 0o600 },
  );
  // An instance without a key file yet, or with an invalid one, has none.
  await expect(readLocalIdentity(f.instance)).rejects.toThrow(/identity/);
  const keyFile = path.join(f.instance.root, "local-identity.key");
  await writeFile(keyFile, "not a key\n", { mode: 0o600 });
  await expect(readLocalIdentity(f.instance)).rejects.toThrow(/identity/);
  await writeFile(keyFile, `${key.toString("base64")}\n`, { mode: 0o600 });
  expect(await readLocalIdentity(f.instance)).toEqual({
    teamhub: "http://127.0.0.1:4100",
    key,
  });
  await shareFixtureFile(keyFile);
  await expect(readLocalIdentity(f.instance)).rejects.toThrow(/private/);
});

it("recreates a missing owner when the private file is already marked provisioned", async () => {
  const f = await fixture();
  const saved =
    JSON.stringify(
      {
        email: "owner@linger.local",
        password: "saved-private-password",
        provisioned: true,
      },
      null,
      2,
    ) + "\n";
  await writeFile(f.file, saved, { mode: 0o600 });
  let created = false;
  stubFetch(
    vi.fn(
      async (url: string) =>
        new Response(null, {
          status: url.endsWith("/logout") ? 204 : created ? 200 : 401,
          headers: created ? { "set-cookie": "session=test; HttpOnly" } : {},
        }),
    ),
  );
  provisionOwner.mockImplementation(async (email, password) => {
    expect(email).toBe("owner@linger.local");
    expect(password).toBe("saved-private-password");
    created = true;
  });
  const result = await ensureLocalAccount(f.instance, f.signal, owner);
  expect(created).toBe(true);
  expect(provisionOwner).toHaveBeenCalledOnce();
  expect(result.email).toBe("owner@linger.local");
  expect(await readFile(f.file, "utf8")).toBe(saved);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map(
        ([url]) => new URL(url instanceof Request ? url.url : url).pathname,
      ),
  ).toEqual([
    "/v0/local/identity",
    "/v0/auth/login",
    "/v0/auth/login",
    "/v0/auth/logout",
  ]);
});
it("keeps an existing provisioned owner ready after the user changes their password", async () => {
  const f = await fixture();
  const saved = JSON.stringify({
    email: "owner@linger.local",
    password: "saved-private-password",
    provisioned: true,
  });
  await writeFile(f.file, saved, { mode: 0o600 });
  stubFetch(
    vi.fn(async () => new Response("server-private-secret", { status: 401 })),
  );
  provisionOwner.mockResolvedValue(undefined);
  await expect(
    ensureLocalAccount(f.instance, f.signal, owner),
  ).resolves.toEqual({
    email: "owner@linger.local",
    password: "saved-private-password",
    file: f.file,
  });
  expect(provisionOwner).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await readFile(f.file, "utf8")).toBe(saved);
});
it("does not provision an already marked account when its login service fails", async () => {
  const f = await fixture();
  const saved = JSON.stringify({
    email: "owner@linger.local",
    password: "saved-private-password",
    provisioned: true,
  });
  await writeFile(f.file, saved, { mode: 0o600 });
  stubFetch(
    vi.fn(async () => new Response("server-private-secret", { status: 503 })),
  );
  await expect(ensureLocalAccount(f.instance, f.signal, owner)).rejects.toThrow(
    "Local account login check failed (HTTP 503)",
  );
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(await readFile(f.file, "utf8")).toBe(saved);
});
it("preserves a provisioned account and hides details on a network failure", async () => {
  const f = await fixture();
  const saved = JSON.stringify({
    email: "owner@linger.local",
    password: "saved-private-password",
    provisioned: true,
  });
  await writeFile(f.file, saved, { mode: 0o600 });
  stubFetch(
    vi.fn(async () => {
      throw new Error("server-private-secret");
    }),
  );
  await expect(ensureLocalAccount(f.instance, f.signal, owner)).rejects.toThrow(
    "The local account service is unavailable. Reopen Linger to retry; account credentials are preserved.",
  );
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(await readFile(f.file, "utf8")).toBe(saved);
});

it("does not trust a provisioned marker when owner confirmation and login both fail", async () => {
  const f = await fixture();
  const saved = JSON.stringify({
    email: "owner@linger.local",
    password: "saved-private-password",
    provisioned: true,
  });
  await writeFile(f.file, saved, { mode: 0o600 });
  stubFetch(
    vi.fn(async () => new Response("server-private-secret", { status: 401 })),
  );
  provisionOwner.mockRejectedValue(new Error("private-owner-command-failure"));
  await expect(ensureLocalAccount(f.instance, f.signal, owner)).rejects.toThrow(
    "Local account sign-in failed after creation (HTTP 401). Credentials are preserved; existing accounts will not be reset.",
  );
  expect(await readFile(f.file, "utf8")).toBe(saved);
});
it.each([429, 503])(
  "does not accept a provisioned owner when the confirmation login fails with %s",
  async (status) => {
    const f = await fixture();
    const saved = JSON.stringify({
      email: "owner@linger.local",
      password: "saved-private-password",
      provisioned: true,
    });
    await writeFile(f.file, saved, { mode: 0o600 });
    let calls = 0;
    stubFetch(
      vi.fn(
        async () =>
          new Response(null, { status: ++calls === 1 ? 401 : status }),
      ),
    );
    provisionOwner.mockResolvedValue(undefined);
    await expect(
      ensureLocalAccount(f.instance, f.signal, owner),
    ).rejects.toThrow(
      `Local account sign-in failed after creation (HTTP ${status}). Credentials are preserved; existing accounts will not be reset.`,
    );
    expect(await readFile(f.file, "utf8")).toBe(saved);
  },
);
it("does not report an existing provisioned owner ready after cancellation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const saved = JSON.stringify({
    email: "owner@linger.local",
    password: "saved-private-password",
    provisioned: true,
  });
  await writeFile(f.file, saved, { mode: 0o600 });
  stubFetch(vi.fn(async () => new Response(null, { status: 401 })));
  provisionOwner.mockImplementation(async () => controller.abort());
  await expect(
    ensureLocalAccount(f.instance, controller.signal, owner),
  ).rejects.toThrow();
  expect(await readFile(f.file, "utf8")).toBe(saved);
});

it("sends no password to another program answering at the origin", async () => {
  const f = await fixture();
  const requests: string[] = [];
  for (const answer of [
    () => Response.json({ proof: "forged" }),
    () => new Response("Not Found", { status: 404 }),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requests.push(new URL(url).pathname);
        return answer();
      }),
    );
    await expect(
      ensureLocalAccount(f.instance, f.signal, owner),
    ).rejects.toThrow(
      "Another program is answering at http://localhost:3000, so Linger cannot use port 3000.",
    );
  }
  expect(requests).toEqual(["/v0/local/identity", "/v0/local/identity"]);
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(false);
});

it("preProvisionLocalAccount creates the account file and owner without HTTP or marking provisioned", async () => {
  const f = await fixture();
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  let created = false;
  provisionOwner.mockImplementation(async (email, password) => {
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    expect(saved.provisioned).toBe(false);
    expect(email).toBe(saved.email);
    expect(password).toBe(saved.password);
    created = true;
  });

  await preProvisionLocalAccount(f.instance, f.signal, owner);

  expect(created).toBe(true);
  expect(provisionOwner).toHaveBeenCalledOnce();
  expect(fetchSpy).not.toHaveBeenCalled();
  const savedAfterPre = JSON.parse(await readFile(f.file, "utf8"));
  expect(savedAfterPre.provisioned).toBe(false);
  await expectPrivateFixtureFile(f.file);

  // ensureLocalAccount still verifies origin, succeeds on first login, and
  // marks provisioned without running provisionOwner again.
  provisionOwner.mockClear();
  const requests: string[] = [];
  stubFetch(
    vi.fn(async (url: string) => {
      requests.push(new URL(url).pathname);
      return new Response(null, {
        status: url.endsWith("/logout") ? 204 : created ? 200 : 401,
        headers: created ? { "set-cookie": "session=test; HttpOnly" } : {},
      });
    }),
  );
  const ensured = await ensureLocalAccount(f.instance, f.signal, owner);
  expect(ensured.email).toBe(savedAfterPre.email);
  expect(ensured.password).toBe(savedAfterPre.password);
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(requests).toEqual(["/v0/auth/login", "/v0/auth/logout"]);
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(true);
});

it("preProvisionLocalAccount skips already-provisioned accounts without calling provisionOwner", async () => {
  const f = await fixture();
  const saved = JSON.stringify({
    email: "owner@linger.local",
    password: "saved-private-password",
    provisioned: true,
  });
  await writeFile(f.file, saved, { mode: 0o600 });
  vi.stubGlobal("fetch", vi.fn());

  await preProvisionLocalAccount(f.instance, f.signal, owner);

  expect(provisionOwner).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(await readFile(f.file, "utf8")).toBe(saved);
});

it("preProvisionLocalAccount ignores invalid or unsafe files so ensureLocalAccount reports the error", async () => {
  const f = await fixture();
  const malformed = '{"password":"private-password" malformed}';
  await writeFile(f.file, malformed, { mode: 0o600 });
  vi.stubGlobal("fetch", vi.fn());

  await expect(
    preProvisionLocalAccount(f.instance, f.signal, owner),
  ).resolves.toBeUndefined();
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(await readFile(f.file, "utf8")).toBe(malformed);

  // Also returns silently for a symlink/non-private file without modifying it.
  await rm(f.file);
  const target = path.join(f.instance.root, "target");
  const instance = { ...f.instance };
  if (process.platform === "win32") {
    await mkdir(target);
    await writeFile(path.join(target, path.basename(f.file)), "{}");
    instance.root = path.join(f.instance.root, "junction");
    await symlink(target, instance.root, "junction");
  } else {
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, f.file);
  }
  await expect(
    preProvisionLocalAccount(instance, f.signal, owner),
  ).resolves.toBeUndefined();
  expect(provisionOwner).not.toHaveBeenCalled();
});

it("preProvisionLocalAccount swallows non-abort owner failures and propagates aborts", async () => {
  const f = await fixture();
  provisionOwner.mockRejectedValueOnce(new Error("db busy"));
  await expect(
    preProvisionLocalAccount(f.instance, f.signal, owner),
  ).resolves.toBeUndefined();
  expect(provisionOwner).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(false);

  // Already aborted before start throws without calling provisionOwner.
  provisionOwner.mockClear();
  const reason = new Error("aborted before preProvision");
  await expect(
    preProvisionLocalAccount(f.instance, AbortSignal.abort(reason), owner),
  ).rejects.toBe(reason);
  expect(provisionOwner).not.toHaveBeenCalled();

  // Aborted while provisionOwner is running rethrows.
  const controller = new AbortController();
  const abortError = new Error("aborted mid-provision");
  provisionOwner.mockImplementationOnce(async () => {
    controller.abort(abortError);
    throw abortError;
  });
  await expect(
    preProvisionLocalAccount(f.instance, controller.signal, owner),
  ).rejects.toBe(abortError);
});
