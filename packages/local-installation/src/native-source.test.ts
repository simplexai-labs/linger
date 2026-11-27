import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createSocket } from "node:dgram";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { afterEach, expect, test } from "vitest";
import { loadInstance } from "./instance.js";
import { updateUserKeys } from "./user-environment.js";
import { readLiveKitSettings } from "./native-livekit.js";
import { saveSourceBinding } from "./source-checkout.js";
import { freePort } from "./ports.js";
import {
  checkNativeSourceEnvironment,
  nativeSourceInstanceName,
  prepareNativeConfiguration,
  stopNativeReleaseServices,
  upgradeWriteFencePath,
} from "./native-source.js";

const roots: string[] = [];
const listeners: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((close) => close()));
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
// Another program takes `port`, on ::1 alone when the computer has it.
async function occupy(port: number, protocol: "tcp" | "udp" = "tcp") {
  for (const host of ["::1", "127.0.0.1"])
    try {
      if (protocol === "udp") {
        const socket = createSocket(host === "::1" ? "udp6" : "udp4");
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.bind(port, host, resolve);
        });
        listeners.push(() => new Promise((done) => socket.close(() => done())));
      } else {
        const server = net.createServer((socket) => socket.end());
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ port, host }, resolve);
        });
        listeners.push(() => new Promise((done) => server.close(() => done())));
      }
      return;
    } catch {
      // No ::1 here; take IPv4 loopback instead.
    }
  throw new Error(`Cannot occupy port ${port}`);
}
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "native-source-"));
  roots.push(home);
  const repo = path.join(home, "repo");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "linger" }),
  );
  await writeFile(path.join(repo, "scripts/source-native.mjs"), "export {};\n");
  return { home, repo };
}
test("native checkout identities are stable", async () => {
  const f = await fixture();
  expect(await nativeSourceInstanceName(f.repo)).toMatch(
    /^native-[a-f0-9]{12}$/,
  );
  const first = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-test",
  });
  expect(first.instance.mode).toBe("source-native");
  expect(
    (await loadInstance({ home: f.home, name: "native-test" }))?.mode,
  ).toBe("source-native");
  expect(first.env.TEAMHUB_HTTP_ADDRESS).toBe(
    `127.0.0.1:${first.instance.source!.ports.teamhub}`,
  );
  expect(first.env.TEAMHUB_DATABASE_URL).toContain(
    `:${first.instance.source!.ports.postgres}/simplexai`,
  );
  const nativeFile = path.join(first.instance.root, "native.env");
  const previous = parseEnv(await readFile(nativeFile, "utf8"));
  const second = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-test",
  });
  expect(second.instance).toEqual(first.instance);

  // LiveKit is stopped in this fixture. Its unbound port can be taken between
  // preparations without changing the instance's identity or credentials.
  const liveKit = (await readLiveKitSettings(second.instance.root))!;
  const expected: Record<string, string> = {
    ...previous,
    LIVEKIT_URL: `ws://127.0.0.1:${liveKit.httpPort}`,
    LIVEKIT_API_URL: `http://127.0.0.1:${liveKit.httpPort}`,
  };
  if (expected.LIVEKIT_URL !== previous.LIVEKIT_URL)
    expect(second.warnings).toContain(
      `Port ${new URL(previous.LIVEKIT_URL!).port} is in use by another program; Linger's livekit uses port ${liveKit.httpPort} instead.\n`,
    );
  const current = parseEnv(await readFile(nativeFile, "utf8"));
  const keys = new Set([...Object.keys(expected), ...Object.keys(current)]);
  // Only name changed fields on failure; native.env also contains secrets.
  expect([...keys].filter((key) => current[key] !== expected[key])).toEqual([]);
});

test.each(["O'Neil", "O'Neil`files"])(
  "native environments preserve paths below %s",
  async (directory) => {
    const f = await fixture();
    const native = await prepareNativeConfiguration(f.repo, {
      home: path.join(f.home, directory),
      name: "quoted-home",
    });
    const persisted = parseEnv(
      await readFile(path.join(native.instance.root, "native.env"), "utf8"),
    );
    for (const key of [
      "TEAMHUB_ARTIFACT_STORAGE_ROOT",
      "AGENT_HOME",
      "COMPUTER_RELEASE_DIR",
    ]) {
      expect(native.env[key]).toContain(directory);
      expect(persisted[key]).toBe(native.env[key]);
    }
  },
);

test("native environment quoting preserves literal Windows backslashes", async () => {
  const f = await fixture();
  const value = String.raw`C:\new\O'Neil\linger`;
  await writeFile(path.join(f.repo, ".env"), `FIXTURE_PATH=\`${value}\`\n`);
  const native = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "quoted-value",
  });
  const persisted = parseEnv(
    await readFile(path.join(native.instance.root, "native.env"), "utf8"),
  );
  expect(native.env.FIXTURE_PATH).toBe(value);
  expect(persisted.FIXTURE_PATH).toBe(value);
});

test("native environments reject a value that would consume the next key", async () => {
  const f = await fixture();
  const options = { home: f.home, name: "cross-entry-value" };
  const native = await prepareNativeConfiguration(f.repo, options);
  const envFile = path.join(native.instance.root, "native.env");
  const before = await readFile(envFile, "utf8");
  const value = "'`=a\\n#\\";
  // As the last entry this is readable, but writing another quoted entry
  // after it can close its leading quote and absorb the following key.
  const supplied = `CONTROL=kept\nFIXTURE_VALUE=${value}\n`;
  expect(parseEnv(supplied)).toEqual({ CONTROL: "kept", FIXTURE_VALUE: value });
  await writeFile(path.join(f.repo, ".env"), supplied);

  await expect(prepareNativeConfiguration(f.repo, options)).rejects.toThrow(
    "Source environment contains unsupported characters.",
  );
  expect(await readFile(envFile, "utf8")).toBe(before);
});

test.each(["'quoted", '"quoted', "`quoted"])(
  "native environments preserve a representable leading quote in %s",
  async (value) => {
    const f = await fixture();
    const delimiter = value.startsWith("'") ? '"' : "'";
    await writeFile(
      path.join(f.repo, ".env"),
      `FIXTURE_VALUE=${delimiter}${value}${delimiter}\nFOLLOWING=kept\n`,
    );
    const native = await prepareNativeConfiguration(f.repo, {
      home: f.home,
      name: "leading-quote",
    });
    const persisted = parseEnv(
      await readFile(path.join(native.instance.root, "native.env"), "utf8"),
    );
    expect(persisted.FIXTURE_VALUE).toBe(value);
    expect(persisted.FOLLOWING).toBe("kept");
  },
);

test("native environments still reject multiline values without publishing them", async () => {
  const f = await fixture();
  await writeFile(path.join(f.repo, ".env"), "FIXTURE_VALUE='line\nbreak'\n");
  await expect(
    prepareNativeConfiguration(f.repo, {
      home: f.home,
      name: "multiline-value",
    }),
  ).rejects.toThrow("Source environment contains unsupported characters.");
  await expect(
    readFile(path.join(f.home, "instances/multiline-value/native.env")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("native environment checks do not require or report Docker", async () => {
  const f = await fixture();
  const report = await checkNativeSourceEnvironment({
    ...f,
    signal: new AbortController().signal,
  });
  expect(report.releaseAvailable).toBe(true);
  expect(report.checks.some((row) => row.id === "source-native")).toBe(true);
  expect(report.checks.some((row) => /docker|compose/i.test(row.id))).toBe(
    false,
  );
});
test("native env files omit launcher-only keys while child env retains its file", async () => {
  const f = await fixture();
  const native = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-env",
  });
  const nativeFile = path.join(native.instance.root, "native.env");
  const persisted = parseEnv(await readFile(nativeFile, "utf8"));
  const omitted = [
    "WEB_HTTP_PORT",
    "TEAMHUB_HTTP_PORT",
    "DOCUMENT_RUNTIME_HTTP_PORT",
    "POSTGRES_PORT",
    "HOST",
    "LOCAL_ENV_FILE",
  ];
  for (const key of omitted) expect(persisted).not.toHaveProperty(key);
  expect(native.env.LOCAL_ENV_FILE).toBe(nativeFile);
  expect(persisted.TEAMHUB_HTTP_ADDRESS).toBe(native.env.TEAMHUB_HTTP_ADDRESS);
  expect(persisted.NODE_SERVICES_HTTP_PORT).toBe(
    native.env.NODE_SERVICES_HTTP_PORT,
  );
  // Every process listens on its own allocated port, never the defaults.
  const { ports } = native.instance.source!;
  expect(persisted).toMatchObject({
    NODE_SERVICES_HTTP_ADDRESS: `127.0.0.1:${ports.nodeServices}`,
    DOCUMENT_RUNTIME_HTTP_ADDRESS: `127.0.0.1:${ports.document}`,
    TEAMHUB_NODE_SERVICES_URL: `http://127.0.0.1:${ports.nodeServices}`,
    TEAMHUB_DOCUMENT_RUNTIME_URL: `http://127.0.0.1:${ports.document}`,
  });
});

test("keys saved from the setup page and LiveKit reach the Native services", async () => {
  const f = await fixture();
  const keys = { SONIOX_API_KEY: "soniox-1", XAI_API_KEY: "xai-1" };
  const root = (name: string) => path.join(f.home, "instances", name);
  await updateUserKeys(root("native-keys"), keys);
  const native = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-keys",
  });
  expect(native.env).toMatchObject(keys);
  // Native runs its own LiveKit on loopback with keys made for the instance.
  const liveKit = await readLiveKitSettings(native.instance.root);
  expect(liveKit).toBeDefined();
  expect(native.env).toMatchObject({
    LIVEKIT_URL: `ws://127.0.0.1:${liveKit!.httpPort}`,
    LIVEKIT_API_URL: `http://127.0.0.1:${liveKit!.httpPort}`,
    LIVEKIT_API_KEY: liveKit!.apiKey,
    LIVEKIT_API_SECRET: liveKit!.apiSecret,
  });
  expect(liveKit!.apiSecret.length).toBeGreaterThanOrEqual(32);
  const ports = Object.values(native.instance.source!.ports);
  expect(ports).not.toContain(liveKit!.httpPort);
  // The ports and keys stay across starts.
  const repeated = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-keys",
  });
  expect(await readLiveKitSettings(repeated.instance.root)).toEqual(liveKit);
  // A cleared key is gone from the next start's environment.
  await updateUserKeys(root("native-keys"), { SONIOX_API_KEY: "" });
  const again = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-keys",
  });
  expect(again.env).not.toHaveProperty("SONIOX_API_KEY");
  expect(again.env.XAI_API_KEY).toBe("xai-1");
});
test("an owned native instance follows a new checkout and keeps its data", async () => {
  const f = await fixture();
  const first = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "desktop",
  });
  await writeFile(path.join(first.instance.root, "kept"), "data");
  const next = path.join(f.home, "next");
  await mkdir(path.join(next, "scripts"), { recursive: true });
  for (const file of ["package.json", "scripts/source-native.mjs"])
    await writeFile(
      path.join(next, file),
      await readFile(path.join(f.repo, file)),
    );
  await expect(
    prepareNativeConfiguration(next, { home: f.home, name: "desktop" }),
  ).rejects.toThrow(/bound/);
  const moved = await prepareNativeConfiguration(next, {
    home: f.home,
    name: "desktop",
    rebindSource: true,
  });
  expect(moved.instance.releaseDir).toBe(next);
  expect(moved.instance.source!.repo).toBe(next);
  expect(moved.instance.source!.ports).toEqual(first.instance.source!.ports);
  expect(moved.instance.port).toBe(first.instance.port);
  expect(await readFile(path.join(first.instance.root, "kept"), "utf8")).toBe(
    "data",
  );
  // The services still run from the first checkout until they restart.
  expect(
    (await loadInstance({ home: f.home, name: "desktop" }))?.releaseDir,
  ).toBe(f.repo);
  await saveSourceBinding(moved.instance);
  const saved = await loadInstance({ home: f.home, name: "desktop" });
  expect(saved?.releaseDir).toBe(next);
  expect(saved?.source).toEqual(moved.instance.source);
});
// Four real configurations run Windows ACL and process checks, which can
// exceed the ordinary Windows test timeout.
test(
  "a resumed instance moves off ports another program took",
  async () => {
    const f = await fixture();
    const options = { home: f.home, name: "native-test" };
    const first = await prepareNativeConfiguration(f.repo, {
      ...options,
      port: await freePort(new Set()),
    });
    const before = first.instance.source!.ports;
    const livekit = (await readLiveKitSettings(first.instance.root))!;
    await occupy(before.web);
    await occupy(before.teamhub);
    await occupy(before.postgres);
    await occupy(livekit.httpPort);
    await occupy(livekit.rtcPort, "udp");

    const second = await prepareNativeConfiguration(f.repo, options);
    const after = second.instance.source!.ports;
    for (const name of ["web", "teamhub", "postgres"] as const)
      expect(after[name]).not.toBe(before[name]);
    expect(after.nodeServices).toBe(before.nodeServices);
    expect(after.document).toBe(before.document);
    // Without an owner account nothing keeps the origin yet, so it moves too.
    expect(second.instance.port).toBe(after.web);
    expect(second.instance.origin).toBe(`http://localhost:${after.web}`);
    expect(await loadInstance(options)).toEqual(second.instance);
    expect(second.env.WEB_PUBLIC_ORIGIN).toBe(second.instance.origin);
    expect(second.env.TEAMHUB_HTTP_ADDRESS).toBe(`127.0.0.1:${after.teamhub}`);
    expect(second.env.TEAMHUB_DATABASE_URL).toContain(
      `:${after.postgres}/simplexai`,
    );
    const moved = (await readLiveKitSettings(first.instance.root))!;
    expect(moved.httpPort).not.toBe(livekit.httpPort);
    expect(moved.rtcPort).not.toBe(livekit.rtcPort);
    expect(moved.apiSecret).toBe(livekit.apiSecret);
    expect(second.env.LIVEKIT_URL).toBe(`ws://127.0.0.1:${moved.httpPort}`);
    expect(second.warnings.join("")).toContain(
      `Port ${before.teamhub} is in use by another program; Linger's teamhub uses port ${after.teamhub} instead.`,
    );
    expect(second.warnings).toHaveLength(5);

    // Once the owner account exists, a Computer this installer enrolled keeps
    // the origin: the web port stays and its service reports the program.
    await writeFile(
      path.join(first.instance.root, "local-account.json"),
      JSON.stringify({ provisioned: true }),
      { mode: 0o600 },
    );
    await occupy(after.web);
    const third = await prepareNativeConfiguration(f.repo, options);
    expect(third.instance.port).toBe(after.web);
    expect(third.instance.source!.ports).toEqual(after);
    expect(third.warnings).toEqual([]);

    // A database set aside from an older install marks the account to be made
    // again, but that install's Computer still keeps the origin.
    await writeFile(
      path.join(first.instance.root, "local-account.json"),
      JSON.stringify({ provisioned: false }),
      { mode: 0o600 },
    );
    await mkdir(path.join(first.instance.root, "simplex-backup-earlier"));
    const fourth = await prepareNativeConfiguration(f.repo, options);
    expect(fourth.instance.port).toBe(after.web);
    expect(fourth.warnings).toEqual([]);
  },
  process.platform === "win32" ? 150_000 : undefined,
);
test("the desktop's web origin moves off a taken port after the account exists", async () => {
  const f = await fixture();
  const options = { home: f.home, name: "desktop", externalComputer: true };
  const first = await prepareNativeConfiguration(f.repo, options);
  const before = first.instance.source!.ports;
  await writeFile(
    path.join(first.instance.root, "local-account.json"),
    JSON.stringify({ provisioned: true }),
    { mode: 0o600 },
  );
  // A database set aside from an older install does not hold it either.
  await mkdir(path.join(first.instance.root, "simplex-backup-earlier"));
  await occupy(before.web);
  // The desktop update that finds the port taken also brings a new checkout.
  const next = path.join(f.home, "next");
  await mkdir(path.join(next, "scripts"), { recursive: true });
  for (const file of ["package.json", "scripts/source-native.mjs"])
    await writeFile(
      path.join(next, file),
      await readFile(path.join(f.repo, file)),
    );

  const second = await prepareNativeConfiguration(next, {
    ...options,
    rebindSource: true,
  });
  const after = second.instance.source!.ports;
  expect(after.web).not.toBe(before.web);
  expect(second.instance.port).toBe(after.web);
  expect(second.instance.origin).toBe(`http://localhost:${after.web}`);
  expect(second.env.WEB_PUBLIC_ORIGIN).toBe(second.instance.origin);
  expect(second.env.WEB_HTTP_PORT).toBe(String(after.web));
  expect(second.warnings.join("")).toContain(
    `Port ${before.web} is in use by another program; Linger's web uses port ${after.web} instead.`,
  );
  // The moved origin is saved at once; the checkout only once the services
  // serve from it.
  const stored = await loadInstance(options);
  expect(stored?.origin).toBe(second.instance.origin);
  expect(stored?.source?.ports).toEqual(after);
  expect(stored?.releaseDir).toBe(f.repo);
  expect(stored?.source?.repo).toBe(f.repo);
});

test("stopNativeReleaseServices stops only requested switchable services in safe order and upgradeWriteFencePath is deterministic", async () => {
  const f = await fixture();
  const native = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "stop-services-test",
  });
  expect(upgradeWriteFencePath(f.home)).toBe(
    path.join(path.resolve(f.home), "state", "upgrade-write-fence"),
  );
  const logs: string[] = [];
  const result = await stopNativeReleaseServices(native.instance, {
    services: ["teamhub", "node-services"],
    log: (msg) => logs.push(msg),
  });
  expect(result.stopped).toEqual(["node-services", "teamhub"]);
  expect(logs).toEqual([
    "Stopping native node-services for release transition.",
    "Stopping native teamhub for release transition.",
  ]);
});
