// Builds deterministic .tar.zst App Bundles and assembles + Ed25519-signs the
// Schema 3 app-manifest.json for high-frequency Linger V2 incremental releases.
//
// Usage:
//   node apps/desktop/scripts/build-app-bundles.mjs \
//     --version 0.2.15 --channel stable --out <dir> \
//     --base-url https://cdn.example.com/linger \
//     [--prev-manifest <path>] [--sign-key <ed25519.pem>] \
//     [--min-shell 0.1.10] [--rollout-percent 100] [--bundles web,backend]
import { spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import zlib, { createZstdCompress } from "node:zlib";

import {
  BUNDLE_IDS,
  PLATFORM_TARGETS,
  planBundleBuilds,
} from "./compute-bundle-inputs.mjs";

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultRepoRoot = path.resolve(desktopDir, "../..");

const runCmd = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Packs a directory deterministically into a `.tar.zst` archive using Node 26's
 * built-in zstd compressor and returns `{ file, artifactId, sha256, size }`.
 */
export async function packDeterministicTarZst(
  sourceDir,
  outDir,
  bundleId,
  suffix = "",
) {
  await mkdir(outDir, { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), `linger-pack-${bundleId}-`));
  try {
    const tarFile = path.join(work, `${bundleId}.tar`);
    // macOS BSD tar lacks --sort=name/--mtime=@0; probe GNU flags quietly first.
    try {
      await runCmd(
        "tar",
        [
          "--sort=name",
          "--format=posix",
          "--owner=0",
          "--group=0",
          "--numeric-owner",
          "--mtime=@0",
          "-cf",
          tarFile,
          "-C",
          sourceDir,
          ".",
        ],
        { stdio: "ignore" },
      );
    } catch {
      await runCmd("tar", ["-cf", tarFile, "-C", sourceDir, "."]);
    }
    const stagedZst = path.join(work, `${bundleId}.tar.zst`);
    await pipeline(
      createReadStream(tarFile),
      createZstdCompress({
        params: {
          [zlib.constants.ZSTD_c_compressionLevel]: 12,
          [zlib.constants.ZSTD_c_windowLog]: 24,
          [zlib.constants.ZSTD_c_nbWorkers]: Math.min(
            availableParallelism(),
            4,
          ),
        },
      }),
      createWriteStream(stagedZst),
    );
    const sha256 = await sha256File(stagedZst);
    const size = (await stat(stagedZst)).size;
    const artifactId = `${bundleId}${suffix ? `-${suffix}` : ""}-${sha256.slice(0, 12)}`;
    const fileName = `${artifactId}.tar.zst`;
    const dest = path.join(outDir, fileName);
    await cp(stagedZst, dest);
    return { fileName, filePath: dest, artifactId, sha256, size };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Packages the unified atomic `backend` bundle for a single target:
 *   - teamhub/         (signed teamhub, migrate, account)
 *   - node-services/   (esbuild entries + voice-runtime + prompts)
 *   - skills/          (skills/builtin)
 *   - computer-daemon/ (signed linger-computer-daemon + teamhub-cli)
 *   - installer/       (linger-installer dist)
 */
export async function packageBackendBundle({
  target,
  outDir,
  teamhubDir = null,
  nodeServicesDir = null,
  skillsDir = null,
  computerDaemonDir = null,
  installerDir = null,
}) {
  if (!target) throw new Error("packageBackendBundle requires target");
  const work = await mkdtemp(path.join(tmpdir(), `linger-backend-${target}-`));
  try {
    const sections = [
      ["teamhub", teamhubDir],
      ["node-services", nodeServicesDir],
      ["skills", skillsDir],
      ["computer-daemon", computerDaemonDir],
      ["installer", installerDir],
    ];
    for (const [sub, src] of sections) {
      const dest = path.join(work, sub);
      await mkdir(dest, { recursive: true });
      if (src && existsSync(src)) {
        await cp(src, dest, { recursive: true });
      }
    }
    return await packDeterministicTarZst(work, outDir, "backend", target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Compares newly packed deterministic `.tar.zst` artifacts against a previous
 * Schema 3 manifest by content SHA-256 (P2). When a newly built bundle's
 * archive digest is byte-for-byte identical to the previous release, its URL,
 * mirrors, artifactId, and originAppVersion are inherited automatically so CI
 * never misses shared-package edits while still skipping redundant uploads.
 */
export function reconcileBuiltArtifactsWithPrevManifest(
  builtArtifacts,
  prevManifest,
) {
  const reconciled = structuredClone(builtArtifacts);
  const inheritedBundles = [];
  const changedBundles = [];

  for (const [bundleId, built] of Object.entries(reconciled)) {
    const prevBundle = prevManifest?.bundles?.[bundleId];
    if (!prevBundle || !built) {
      changedBundles.push(bundleId);
      continue;
    }
    if (prevBundle.arch === "noarch") {
      if (built.sha256 && built.sha256 === prevBundle.artifact?.sha256) {
        reconciled[bundleId] = {
          ...built,
          __inheritedEntry: structuredClone(prevBundle),
        };
        inheritedBundles.push(bundleId);
      } else {
        changedBundles.push(bundleId);
      }
      continue;
    }

    // per-target bundle: deduplicate each target independently by sha256.
    let allTargetsMatched = true;
    const targets = Object.keys(built);
    if (targets.length === 0) {
      changedBundles.push(bundleId);
      continue;
    }
    for (const target of targets) {
      const art = built[target];
      const prevArt = prevBundle.targets?.[target];
      if (art?.sha256 && prevArt?.sha256 === art.sha256) {
        built[target] = {
          ...art,
          __inheritedArtifact: structuredClone(prevArt),
        };
      } else {
        allTargetsMatched = false;
      }
    }
    if (allTargetsMatched) {
      reconciled[bundleId] = {
        ...built,
        __inheritedEntry: structuredClone(prevBundle),
      };
      inheritedBundles.push(bundleId);
    } else {
      changedBundles.push(bundleId);
    }
  }

  return { reconciled, inheritedBundles, changedBundles };
}

/**
 * Assembles a Schema 3 `app-manifest.json` from newly built artifacts and
 * inherited entries from `plan` (and optionally deduplicates newly built
 * artifacts against `prevManifest` by deterministic `.tar.zst` SHA-256).
 */
export function assembleManifestV3({
  appVersion,
  channel = "stable",
  releaseId = `${appVersion}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`,
  publishedAt = new Date().toISOString(),
  rollout = { percent: 100 },
  compat,
  compatIndex,
  shell,
  plan,
  builtArtifacts = {},
  prevManifest = null,
  baseUrl,
  mirrorBaseUrls = [],
}) {
  const effectiveBuilt = prevManifest
    ? reconcileBuiltArtifactsWithPrevManifest(builtArtifacts, prevManifest)
        .reconciled
    : builtArtifacts;
  const makeUrls = (bundleId, fileName) => {
    const relPath = `bundles/${bundleId}/${fileName}`;
    const isRelative = !baseUrl || baseUrl === "relative";
    const url = isRelative
      ? relPath
      : `${baseUrl.replace(/\/+$/, "")}/${relPath}`;
    const mirrors = mirrorBaseUrls
      .filter(Boolean)
      .map((m) => `${m.replace(/\/+$/, "")}/${relPath}`);
    return mirrors.length > 0 ? { url, mirrors } : { url };
  };

  const bundles = {};
  for (const bundleId of BUNDLE_IDS) {
    const entry = plan.bundles[bundleId];
    if (!entry) throw new Error(`Plan missing bundle ${bundleId}`);

    if (entry.action === "REUSED" && entry.inherited) {
      bundles[bundleId] = structuredClone(entry.inherited);
      continue;
    }

    const built = effectiveBuilt[bundleId];
    if (!built) {
      throw new Error(
        `Bundle ${bundleId} marked BUILD but no artifact was provided`,
      );
    }

    if (built.__inheritedEntry) {
      bundles[bundleId] = {
        ...structuredClone(built.__inheritedEntry),
        inputHash: entry.inputHash,
      };
      continue;
    }

    if (entry.arch === "noarch") {
      bundles[bundleId] = {
        arch: "noarch",
        originAppVersion: appVersion,
        inputHash: entry.inputHash,
        ...(entry.nativeDepsHash
          ? { nativeDepsHash: entry.nativeDepsHash }
          : {}),
        artifact: {
          artifactId: built.artifactId,
          format: built.format ?? "tar.zst",
          ...makeUrls(bundleId, built.fileName),
          sha256: built.sha256,
          size: built.size,
        },
      };
    } else {
      const targets = {};
      for (const [target, art] of Object.entries(built)) {
        if (target.startsWith("__")) continue;
        targets[target] = art.__inheritedArtifact
          ? structuredClone(art.__inheritedArtifact)
          : {
              artifactId: art.artifactId,
              format: art.format ?? "tar.zst",
              ...makeUrls(bundleId, art.fileName),
              sha256: art.sha256,
              size: art.size,
              ...(art.signed ? { signed: art.signed } : {}),
              ...(art.deltas?.length ? { deltas: art.deltas } : {}),
            };
      }
      bundles[bundleId] = {
        arch: "per-target",
        originAppVersion: appVersion,
        inputHash: entry.inputHash,
        ...(entry.nativeDepsHash
          ? { nativeDepsHash: entry.nativeDepsHash }
          : {}),
        targets,
      };
    }
  }

  return {
    schema: 3,
    channel,
    releaseId,
    appVersion,
    publishedAt,
    rollout,
    compat: {
      minShellVersion: compat?.minShellVersion ?? "0.2.0",
      ...(compat?.maxShellVersion
        ? { maxShellVersion: compat.maxShellVersion }
        : {}),
      minNativeDepsHash: compat?.minNativeDepsHash ?? plan.nativeDepsHash,
      runnerGatewayProtocol: compat?.runnerGatewayProtocol ?? 1,
      dbSchemaEpoch: compat?.dbSchemaEpoch ?? 892,
      rollbackSafe: compat?.rollbackSafe ?? true,
    },
    ...(compatIndex?.length ? { compatIndex } : {}),
    ...(shell ? { shell } : {}),
    bundles,
  };
}

/**
 * Signs an AppManifestV3 JSON buffer with an Ed25519 private key PEM and
 * verifies it against the expected public key PEM (e.g. UPDATE_PUBLIC_KEY).
 */
export function signManifestV3(manifest, privateKeyPem, expectedPublicKeyPem) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const privKey = createPrivateKey(privateKeyPem);
  const sig = sign(null, bytes, privKey);
  if (expectedPublicKeyPem) {
    const ok = verify(null, bytes, createPublicKey(expectedPublicKeyPem), sig);
    if (!ok) {
      throw new Error(
        "Private signing key does not match UPDATE_PUBLIC_KEY; clients would reject this manifest",
      );
    }
  }
  return {
    bytes,
    signatureBase64: `${sig.toString("base64")}\n`,
  };
}

export async function writeSignedManifestV3(
  outDir,
  manifest,
  { privateKeyPem = null, expectedPublicKeyPem = null } = {},
) {
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "app-manifest.json");
  if (!privateKeyPem) {
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    return { manifestPath, signaturePath: null };
  }
  const { bytes, signatureBase64 } = signManifestV3(
    manifest,
    privateKeyPem,
    expectedPublicKeyPem,
  );
  const signaturePath = path.join(outDir, "app-manifest.json.sig");
  await writeFile(manifestPath, bytes);
  await writeFile(signaturePath, signatureBase64, "utf8");
  return { manifestPath, signaturePath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const mode = flag("--mode") ?? "plan";
  const repoRoot = path.resolve(flag("--repo") ?? defaultRepoRoot);
  const outDir = path.resolve(
    flag("--out") ?? path.join(repoRoot, ".linger-runtime/app-bundles"),
  );
  const prevPath = flag("--prev-manifest");
  const prevManifest = prevPath
    ? JSON.parse(await readFile(path.resolve(prevPath), "utf8"))
    : null;
  const targets = (flag("--targets") ?? PLATFORM_TARGETS.join(","))
    .split(",")
    .filter(Boolean);

  if (mode === "plan") {
    const plan = planBundleBuilds(repoRoot, {
      ref: flag("--ref") ?? "HEAD",
      useFs: args.includes("--fs"),
      targets,
      prevManifest,
    });
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, "plan.json"),
      `${JSON.stringify(plan, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else if (mode === "backend") {
    const target = flag("--target");
    if (!target) throw new Error("--mode backend requires --target");
    const res = await packageBackendBundle({
      target,
      outDir: path.join(outDir, "bundles/backend"),
      teamhubDir: flag("--teamhub-dir")
        ? path.resolve(flag("--teamhub-dir"))
        : null,
      nodeServicesDir: flag("--node-services-dir")
        ? path.resolve(flag("--node-services-dir"))
        : null,
      skillsDir: flag("--skills-dir")
        ? path.resolve(flag("--skills-dir"))
        : path.join(repoRoot, "skills/builtin"),
      computerDaemonDir: flag("--daemon-dir")
        ? path.resolve(flag("--daemon-dir"))
        : null,
      installerDir: flag("--installer-dir")
        ? path.resolve(flag("--installer-dir"))
        : path.join(repoRoot, "apps/linger-installer/dist"),
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else if (mode === "assemble-manifest") {
    const version = flag("--version");
    const baseUrl = flag("--base-url");
    const planFile = flag("--plan");
    const builtFile = flag("--built");
    if (!version || !baseUrl || !planFile) {
      throw new Error(
        "assemble-manifest requires --version, --base-url, and --plan",
      );
    }
    const plan = JSON.parse(await readFile(path.resolve(planFile), "utf8"));
    const builtArtifacts = builtFile
      ? JSON.parse(await readFile(path.resolve(builtFile), "utf8"))
      : {};
    const manifest = assembleManifestV3({
      appVersion: version,
      channel: flag("--channel") ?? "stable",
      rollout: { percent: Number(flag("--rollout-percent") ?? "100") },
      compat: {
        minShellVersion: flag("--min-shell") ?? "0.2.0",
        minNativeDepsHash: plan.nativeDepsHash,
        runnerGatewayProtocol: Number(flag("--gateway-protocol") ?? "1"),
        dbSchemaEpoch: Number(flag("--db-epoch") ?? "892"),
        rollbackSafe: flag("--rollback-safe") !== "false",
      },
      plan,
      builtArtifacts,
      prevManifest,
      baseUrl,
      mirrorBaseUrls: (flag("--mirrors") ?? "").split(",").filter(Boolean),
    });
    const signKeyPath = flag("--sign-key");
    const privateKeyPem = signKeyPath
      ? await readFile(path.resolve(signKeyPath), "utf8")
      : null;
    let expectedPublicKeyPem = null;
    if (privateKeyPem && !args.includes("--skip-pubkey-check")) {
      const src = await readFile(
        path.join(desktopDir, "src/main/update-manifest.ts"),
        "utf8",
      );
      expectedPublicKeyPem =
        /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(
          src,
        )?.[0] ?? null;
    }
    const written = await writeSignedManifestV3(outDir, manifest, {
      privateKeyPem,
      expectedPublicKeyPem,
    });
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}
