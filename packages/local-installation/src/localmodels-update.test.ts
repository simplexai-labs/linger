import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { c as createTar } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeToolRecordPath,
  compareSemver,
  evaluateLocalmodelsManifest,
  inferToolVersions,
  LOCALMODELS_UPDATE_PUBLIC_KEY,
  LocalmodelsManifestError,
  readVerifiedActiveTool,
  verifyLocalmodelsManifest,
  writeActiveToolRecord,
  type LocalmodelsToolSource,
} from "./localmodels-manifest.js";
import { resolveEffectiveToolSource } from "./localmodels-tool.js";
import {
  activateLocalmodelsUpdate,
  checkLocalmodelsUpdate,
  LocalmodelsUpdateError,
  rollbackLocalmodelsUpdate,
  stageLocalmodelsUpdate,
} from "./localmodels-update.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linger-lm-update-"));
  dirs.push(dir);
  return dir;
}

async function reopenTree(root: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(root, 0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = path.join(root, entry.name);
      if (entry.isDirectory()) await reopenTree(child);
      else if (entry.isFile()) await chmod(child, 0o600);
    }
  } catch {
    // Ignore already removed entries.
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map(async (dir) => {
      await reopenTree(dir);
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function signManifest(
  manifest: Record<string, unknown>,
  privateKey: ReturnType<typeof makeKeyPair>["privateKey"],
) {
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = `${cryptoSign(null, Buffer.from(raw, "utf8"), privateKey).toString("base64")}\n`;
  return { raw, signature };
}

const target = `${process.platform}-${process.arch}`;
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

async function makeKitTarball(
  dir: string,
  commit: string,
  version: string,
  npmVersion: string,
): Promise<{
  tarballBytes: Buffer;
  source: LocalmodelsToolSource;
}> {
  const work = path.join(dir, `kit-${version}`);
  const pkg = path.join(work, "package");
  const pythonDir = path.join(pkg, "python", "bin");
  const moduleDir = path.join(pkg, "modules", "localmodels");
  await mkdir(pythonDir, { recursive: true });
  await mkdir(moduleDir, { recursive: true });
  const pythonFile = path.join(pythonDir, "python3");
  const mainFile = path.join(moduleDir, "__main__.py");
  await writeFile(pythonFile, "#!/bin/sh\necho ok\n", { mode: 0o700 });
  await writeFile(mainFile, 'print("ok")\n', { mode: 0o600 });
  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
  const assets: Record<string, string> = {
    "python/bin/python3": sha(Buffer.from("#!/bin/sh\necho ok\n")),
    "modules/localmodels/__main__.py": sha(Buffer.from('print("ok")\n')),
  };
  const toolJson = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      sourceCommit: commit,
      python: "python/bin/python3",
      moduleDir: "modules",
      assets,
    }),
  );
  await writeFile(path.join(pkg, "tool.json"), toolJson);
  const archive = path.join(work, "kit.tgz");
  await createTar({ gzip: true, cwd: work, file: archive }, ["package"]);
  const { readFile } = await import("node:fs/promises");
  const tarballBytes = await readFile(archive);
  const kitSha = sha(tarballBytes);
  return {
    tarballBytes,
    source: {
      version,
      npmVersion,
      url: `https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/${version}/${target}.tgz`,
      mirrors: [
        `https://registry.npmjs.org/@simplexai/localmodels-${target}/-/localmodels-${target}-${npmVersion}.tgz`,
        `https://cdn.npmmirror.com/packages/@simplexai/localmodels-${target}/${npmVersion}/localmodels-${target}-${npmVersion}.tgz`,
      ],
      sha256: kitSha,
      bytes: tarballBytes.length,
      sourceCommit: commit,
      manifestSha256: sha(toolJson),
    },
  };
}

async function makeScriptsTarball(
  dir: string,
  files: Record<string, string>,
): Promise<Buffer> {
  const work = path.join(dir, `scripts-${Math.random().toString(16).slice(2)}`);
  const pkg = path.join(work, "package");
  await mkdir(pkg, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(pkg, name), content, "utf8");
  const archive = path.join(work, "localmodels.tgz");
  await createTar({ gzip: true, cwd: work, file: archive }, ["package"]);
  const { readFile } = await import("node:fs/promises");
  return readFile(archive);
}

function manifestFor(
  kit: LocalmodelsToolSource,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 1,
    version: kit.version ?? "0.1.0.dev48",
    npmVersion: kit.npmVersion ?? "0.1.0-dev.48",
    sourceCommit: kit.sourceCommit,
    compatibility: {
      cliContract: "v2",
      archiveLayout: "npm-package-v1",
      minLingerVersion: "0.16.0",
    },
    summary: "Adds support for newer local models.",
    notesUrl: "https://docs.linger.com/models/changelog",
    kits: {
      [target]: {
        url: kit.url,
        mirrors: kit.mirrors,
        sha256: kit.sha256,
        bytes: kit.bytes,
        sourceCommit: kit.sourceCommit,
        manifestSha256: kit.manifestSha256,
      },
    },
    ...overrides,
  };
}

describe("localmodels manifest verification and policy", () => {
  it("pins a valid Ed25519 production public key", () => {
    expect(LOCALMODELS_UPDATE_PUBLIC_KEY).toContain("BEGIN PUBLIC KEY");
    expect(
      createPublicKey(LOCALMODELS_UPDATE_PUBLIC_KEY).asymmetricKeyType,
    ).toBe("ed25519");
  });

  it("verifies signed manifests and rejects tampering, wrong key, or empty key", async () => {
    const dir = await tempDir();
    const { privateKey, publicPem } = makeKeyPair();
    const other = makeKeyPair();
    const { source } = await makeKitTarball(
      dir,
      commitB,
      "0.1.0.dev48",
      "0.1.0-dev.48",
    );
    const { raw, signature } = signManifest(manifestFor(source), privateKey);

    const parsed = verifyLocalmodelsManifest(
      Buffer.from(raw, "utf8"),
      signature,
      publicPem,
    );
    expect(parsed.version).toBe("0.1.0.dev48");
    expect(parsed.npmVersion).toBe("0.1.0-dev.48");
    expect(parsed.kits[target]?.sha256).toBe(source.sha256);

    expect(() =>
      verifyLocalmodelsManifest(
        Buffer.from(`${raw} `, "utf8"),
        signature,
        publicPem,
      ),
    ).toThrow(LocalmodelsManifestError);
    expect(() =>
      verifyLocalmodelsManifest(
        Buffer.from(raw, "utf8"),
        signature,
        other.publicPem,
      ),
    ).toThrow(LocalmodelsManifestError);
    expect(() =>
      verifyLocalmodelsManifest(Buffer.from(raw, "utf8"), signature, ""),
    ).toThrow(LocalmodelsManifestError);
  });

  it("enforces adaptive prerelease channel policy and minLingerVersion gates", async () => {
    const dir = await tempDir();
    const { privateKey, publicPem } = makeKeyPair();
    const { source: devKit } = await makeKitTarball(
      dir,
      commitB,
      "0.1.0.dev48",
      "0.1.0-dev.48",
    );
    const devSigned = signManifest(
      manifestFor(devKit, {
        compatibility: {
          cliContract: "v2",
          archiveLayout: "npm-package-v1",
          minLingerVersion: "0.20.0",
        },
      }),
      privateKey,
    );
    const devManifest = verifyLocalmodelsManifest(
      Buffer.from(devSigned.raw, "utf8"),
      devSigned.signature,
      publicPem,
    );

    // Stable baseline refuses prerelease manifests.
    expect(
      evaluateLocalmodelsManifest({
        manifest: devManifest,
        target,
        currentNpmVersion: "0.1.0",
        baselineNpmVersion: "0.1.0",
        desktopVersion: "0.21.0",
      }),
    ).toEqual({ kind: "up_to_date" });

    // Dev baseline evaluates minLingerVersion and reports requires_app_update.
    expect(
      evaluateLocalmodelsManifest({
        manifest: devManifest,
        target,
        currentNpmVersion: "0.1.0-dev.47",
        baselineNpmVersion: "0.1.0-dev.47",
        desktopVersion: "0.16.36",
      }),
    ).toEqual({
      kind: "requires_app_update",
      version: "0.1.0.dev48",
      npmVersion: "0.1.0-dev.48",
      minLingerVersion: "0.20.0",
    });

    // Compatible once desktopVersion meets minLingerVersion.
    const ok = evaluateLocalmodelsManifest({
      manifest: devManifest,
      target,
      currentNpmVersion: "0.1.0-dev.47",
      baselineNpmVersion: "0.1.0-dev.47",
      desktopVersion: "0.20.0",
    });
    expect(ok.kind).toBe("compatible");

    expect(compareSemver("0.1.0", "0.1.0-dev.48")).toBeGreaterThan(0);
    expect(
      inferToolVersions({ url: devKit.url, mirrors: devKit.mirrors }),
    ).toEqual({
      version: "0.1.0.dev48",
      npmVersion: "0.1.0-dev.48",
    });
  });
});

describe("localmodels update discovery, staging, activation and rollback", () => {
  it("discovers via npm dist-tags in region order, extracts signed manifest, stages, smoke-checks, activates and cleans up on baseline upgrade", async () => {
    const dir = await tempDir();
    const home = path.join(dir, "home");
    const { privateKey, publicPem } = makeKeyPair();
    const baseline = (
      await makeKitTarball(dir, commitA, "0.1.0.dev47", "0.1.0-dev.47")
    ).source;
    const nextKit = await makeKitTarball(
      dir,
      commitB,
      "0.1.0.dev48",
      "0.1.0-dev.48",
    );
    const { raw, signature } = signManifest(
      manifestFor(nextKit.source),
      privateKey,
    );
    const scriptsTarball = await makeScriptsTarball(dir, {
      "manifest.json": raw,
      "manifest.json.sig": signature,
    });

    const requestedUrls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      requestedUrls.push(url);
      if (url.endsWith("/dist-tags")) {
        return new Response(
          JSON.stringify({ next: "0.1.0-dev.48", latest: "0.0.9" }),
          { status: 200 },
        );
      }
      if (url.endsWith("localmodels-0.1.0-dev.48.tgz")) {
        return new Response(new Uint8Array(scriptsTarball), { status: 200 });
      }
      if (
        url.endsWith(`${target}.tgz`) ||
        url.includes(`localmodels-${target}-0.1.0-dev.48.tgz`)
      ) {
        return new Response(new Uint8Array(nextKit.tarballBytes), {
          status: 200,
          headers: { "content-length": String(nextKit.tarballBytes.length) },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const checked = await checkLocalmodelsUpdate({
      home,
      baseline,
      desktopVersion: "0.16.36",
      publicKey: publicPem,
      region: "cn",
      fetcher,
    });
    expect(checked.kind).toBe("available");
    expect(requestedUrls[0]).toContain("registry.npmmirror.com");
    expect(requestedUrls[1]).toContain("cdn.npmmirror.com");
    // Check must never download the platform kit tarball.
    expect(
      requestedUrls.some((url) => url.includes(`localmodels-${target}`)),
    ).toBe(false);
    if (checked.kind !== "available") return;

    const phases: string[] = [];
    const smokeCalls: string[][] = [];
    const smokeEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const staged = await stageLocalmodelsUpdate({
      home,
      verified: checked.verified,
      kit: checked.kit,
      fetcher,
      onPhase: (phase) => phases.push(phase),
      run: async (_file, args, options) => {
        smokeCalls.push(args);
        smokeEnvs.push(options?.env);
        if (args.includes("capabilities")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              schema: "localmodels.stack-capabilities/v1",
            }),
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ schema: "localmodels.library-status/v1" }),
          stderr: "",
        };
      },
    });
    expect(phases).toEqual(["downloading", "verifying"]);
    expect(smokeCalls).toHaveLength(2);
    expect(smokeEnvs[0]).toMatchObject({
      LOCALMODELS_TOOLS_DIR: path.join(home, "runtime", "localmodels", "tools"),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    });
    // Staging does not activate yet.
    expect(
      await readVerifiedActiveTool(home, baseline, { publicKey: publicPem }),
    ).toBeUndefined();

    const activeTool = await activateLocalmodelsUpdate(home, staged, {
      baseline,
    });
    expect(activeTool.python).toContain(nextKit.source.sha256);

    const resolved = await resolveEffectiveToolSource(home, baseline, {
      desktopVersion: "0.16.36",
      publicKey: publicPem,
    });
    expect(resolved?.origin).toBe("updated");
    expect(resolved?.version).toBe("0.1.0.dev48");
    expect(resolved?.source.sha256).toBe(nextKit.source.sha256);

    // When Desktop later ships a newer baseline, the stale active.json is superseded and cleaned up.
    const newerBaseline: LocalmodelsToolSource = {
      ...baseline,
      version: "0.1.0.dev49",
      npmVersion: "0.1.0-dev.49",
    };
    const afterDesktopUpgrade = await resolveEffectiveToolSource(
      home,
      newerBaseline,
      { desktopVersion: "0.17.0", publicKey: publicPem },
    );
    expect(afterDesktopUpgrade?.origin).toBe("bundled");
    expect(afterDesktopUpgrade?.version).toBe("0.1.0.dev49");
    await expect(stat(activeToolRecordPath(home))).rejects.toThrow();
  });

  it("refuses activation when smoke check fails and falls back when active.json is tampered", async () => {
    const dir = await tempDir();
    const home = path.join(dir, "home");
    const { privateKey, publicPem } = makeKeyPair();
    const baseline = (
      await makeKitTarball(dir, commitA, "0.1.0.dev47", "0.1.0-dev.47")
    ).source;
    const nextKit = await makeKitTarball(
      dir,
      commitB,
      "0.1.0.dev48",
      "0.1.0-dev.48",
    );
    const { raw, signature } = signManifest(
      manifestFor(nextKit.source),
      privateKey,
    );
    const manifest = verifyLocalmodelsManifest(
      Buffer.from(raw, "utf8"),
      signature,
      publicPem,
    );

    await expect(
      stageLocalmodelsUpdate({
        home,
        verified: { manifest, raw, signature },
        kit: nextKit.source,
        fetcher: async () =>
          new Response(new Uint8Array(nextKit.tarballBytes), {
            status: 200,
            headers: { "content-length": String(nextKit.tarballBytes.length) },
          }),
        run: async () => ({ code: 1, stdout: "", stderr: "boom" }),
      }),
    ).rejects.toThrow(LocalmodelsUpdateError);

    // Write a tampered active.json and confirm safe fallback to baseline.
    await writeActiveToolRecord(home, {
      manifest,
      raw: `${raw} `,
      signature,
    });
    const fallback = await resolveEffectiveToolSource(home, baseline, {
      desktopVersion: "0.16.36",
      publicKey: publicPem,
    });
    expect(fallback?.origin).toBe("bundled");
    expect(fallback?.source.sha256).toBe(baseline.sha256);

    await rollbackLocalmodelsUpdate(home);
    await expect(stat(activeToolRecordPath(home))).rejects.toThrow();
  });

  it("rejects version substitution where signed manifest version differs from dist-tag", async () => {
    const dir = await tempDir();
    const home = path.join(dir, "home");
    const { privateKey, publicPem } = makeKeyPair();
    const baseline = (
      await makeKitTarball(dir, commitA, "0.1.0.dev47", "0.1.0-dev.47")
    ).source;
    const olderKit = await makeKitTarball(
      dir,
      commitB,
      "0.1.0.dev48",
      "0.1.0-dev.48",
    );
    const { raw, signature } = signManifest(
      manifestFor(olderKit.source),
      privateKey,
    );
    const scriptsTarball = await makeScriptsTarball(dir, {
      "manifest.json": raw,
      "manifest.json.sig": signature,
    });

    await expect(
      checkLocalmodelsUpdate({
        home,
        baseline,
        desktopVersion: "0.16.36",
        publicKey: publicPem,
        region: "global",
        fetcher: async (input) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (url.endsWith("/dist-tags"))
            return new Response(JSON.stringify({ next: "0.1.0-dev.49" }), {
              status: 200,
            });
          if (url.endsWith("localmodels-0.1.0-dev.49.tgz"))
            return new Response(new Uint8Array(scriptsTarball), {
              status: 200,
            });
          return new Response("not found", { status: 404 });
        },
      }),
    ).rejects.toThrow(LocalmodelsManifestError);
  });
});
