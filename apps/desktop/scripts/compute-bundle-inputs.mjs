// Computes deterministic content-addressed input hashes for every V2 App Bundle
// and resolves which modules need to be rebuilt versus inherited from a previous
// Schema 3 app-manifest.json.
//
// Usage:
//   node apps/desktop/scripts/compute-bundle-inputs.mjs \
//     [--repo <path>] [--ref HEAD] [--prev-manifest <path>] \
//     [--target darwin-arm64] [--format json]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NODE_SERVICES_EXTERNALS } from "./bundle-node-services.mjs";
import { RUNTIME_PACKAGES } from "./build-native-runtime.mjs";

const defaultRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const BUNDLE_IDS = Object.freeze(["web", "backend", "node-native-deps"]);

export const PLATFORM_TARGETS = Object.freeze([
  "darwin-arm64",
  "win32-x64",
  "linux-x64",
]);

// Source ownership table for the 2+1 bundle architecture:
//   - web (noarch): frontend SPA + static-host
//   - backend (per-target): unified atomic backend (teamhub + node-services/voice-runtime + skills/prompts + computer-daemon/teamhub-cli + installer)
//   - node-native-deps (per-target): cached external native node_modules
// Changes outside a bundle's owned paths never invalidate its inputHash.
export const BUNDLE_INPUT_SPECS = Object.freeze({
  web: {
    arch: "noarch",
    paths: [
      "apps/web",
      "packages/document-files",
      "packages/document-model",
      "packages/knowledge-format",
      "packages/service-kit",
      "contracts/generated/typescript",
      "apps/desktop/scripts/build-native-runtime.mjs",
    ],
    exclude: [
      /^apps\/web\/e2e\//,
      /(?:^|\/)__tests__\//,
      /\.(?:test|spec)\.[cm]?[jt]sx?$/,
    ],
  },
  backend: {
    arch: "per-target",
    paths: [
      "apps/teamhub/cmd/teamhub",
      "apps/teamhub/cmd/migrate",
      "apps/teamhub/cmd/account",
      "apps/teamhub/internal",
      "apps/teamhub/migrations",
      "apps/teamhub/go.mod",
      "apps/teamhub/go.sum",
      "apps/node-services/src",
      "apps/node-services/prompts",
      "apps/node-services/scripts/dev-supervisor.ts",
      "apps/node-services/package.json",
      "apps/voice-runtime/src",
      "apps/voice-runtime/package.json",
      "apps/computer/local-daemon",
      "apps/computer/package.json",
      "apps/computer/tools",
      "apps/computer/scripts",
      "apps/teamhub-cli/src",
      "apps/teamhub-cli/scripts",
      "apps/teamhub-cli/bin",
      "apps/teamhub-cli/package.json",
      "apps/linger-installer/src",
      "apps/linger-installer/scripts",
      "apps/linger-installer/package.json",
      "packages/local-installation/src",
      "packages/local-installation/package.json",
      "packages/document-files",
      "packages/document-model",
      "packages/knowledge-format",
      "packages/service-kit",
      "contracts/generated/go",
      "contracts/generated/typescript",
      "skills/embed.go",
      "skills/go.mod",
      "skills/builtin",
      "apps/desktop/scripts/build-teamhub.mjs",
      "apps/desktop/scripts/build-daemon.mjs",
      "apps/desktop/scripts/bundle-node-services.mjs",
      "patches/@hocuspocus__server@4.3.0.patch",
      "patches/deepagents@1.12.0.patch",
      "patches/playwright-core@1.64.0-alpha-1790635538000.patch",
    ],
    exclude: [
      /_test\.go$/,
      /(?:^|\/)__tests__\//,
      /\.(?:test|spec)\.[cm]?[jt]sx?$/,
    ],
  },
  "node-native-deps": {
    arch: "per-target",
    paths: [
      "apps/desktop/scripts/bundle-node-services.mjs",
      "apps/desktop/scripts/build-native-runtime.mjs",
      "patches/@livekit__agents@1.7.1.patch",
      ".node-version",
    ],
    exclude: [],
    usesNativeDepsLock: true,
  },
});

const matchesExternalPattern = (pkgName, pattern) => {
  if (pattern.endsWith("/*")) {
    return pkgName.startsWith(pattern.slice(0, -1));
  }
  if (pattern.endsWith("-*")) {
    return pkgName.startsWith(pattern.slice(0, -1));
  }
  return pkgName === pattern;
};

/**
 * Extracts normalized `{ name, version, integrity }` records for native/external
 * runtime dependencies from pnpm-lock.yaml and computes a deterministic hash.
 * Pure JS/TS business edits do not alter this hash.
 */
export function computeNativeDepsHash(
  lockfileText,
  {
    target = "all",
    nodeMajor = "26",
    externals = NODE_SERVICES_EXTERNALS,
    runtimePackages = RUNTIME_PACKAGES,
    extraSalts = [],
  } = {},
) {
  const packagesBlockStart = lockfileText.indexOf("\npackages:\n");
  const packagesBlock =
    packagesBlockStart >= 0
      ? lockfileText.slice(packagesBlockStart)
      : lockfileText;
  const entryRegex =
    /\n {2}'?([^'\n:]+?)@([^'\n:]+?)'?:\n(?: {4}[^\n]+\n)*? {4}resolution: \{integrity: (sha\d+-[A-Za-z0-9+/=]+)\}/g;

  const matched = [];
  for (const match of packagesBlock.matchAll(entryRegex)) {
    const [, rawName, rawVersion, integrity] = match;
    const pkgName = rawName;
    const isExternal =
      externals.some((p) => matchesExternalPattern(pkgName, p)) ||
      runtimePackages.includes(pkgName);
    if (isExternal) {
      matched.push({ name: pkgName, version: rawVersion, integrity });
    }
  }
  matched.sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name.localeCompare(b.name),
  );

  const hash = createHash("sha256");
  hash.update(`schema:1\nnodeMajor:${nodeMajor}\ntarget:${target}\n`);
  for (const salt of [...extraSalts].sort()) {
    hash.update(`salt:${salt}\n`);
  }
  for (const item of matched) {
    hash.update(`${item.name}@${item.version}=${item.integrity}\n`);
  }
  const digest = hash.digest("hex");
  return {
    hash: `sha256:${digest}`,
    shortId: `nd-${digest.slice(0, 16)}`,
    packageCount: matched.length,
    packages: matched,
  };
}

function readNodeMajor(repoRoot) {
  const file = path.join(repoRoot, ".node-version");
  if (!existsSync(file)) return "26";
  const raw = readFileSync(file, "utf8").trim();
  const match = /^v?(\d+)/.exec(raw);
  return match ? match[1] : "26";
}

/**
 * Derives the latest PostgreSQL schema epoch from the highest numbered SQL
 * migration prefix under `apps/teamhub/migrations/` (e.g. `00896_*.sql` -> 896).
 * Falls back cleanly to `fallback` (default 0) when the migrations directory is
 * absent or contains no numbered SQL migrations.
 */
export function resolveDbSchemaEpoch(repoRoot = defaultRepoRoot, fallback = 0) {
  const migrationsDir = path.join(repoRoot, "apps", "teamhub", "migrations");
  let entries;
  try {
    entries = readdirSync(migrationsDir);
  } catch {
    return fallback;
  }
  let highest = -1;
  for (const name of entries) {
    const match = /^(\d+)_.*\.sql$/i.exec(name);
    if (!match) continue;
    const epoch = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(epoch) && epoch > highest) {
      highest = epoch;
    }
  }
  return highest >= 0 ? highest : fallback;
}

function listTreeEntriesFromGit(repoRoot, ref, ownedPaths) {
  const existing = ownedPaths.filter((p) => {
    try {
      const out = execFileSync("git", ["ls-tree", "-r", ref, "--", p], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return [];
  const raw = execFileSync("git", ["ls-tree", "-r", ref, "--", ...existing], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const results = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [meta, relPath] = line.split("\t");
    if (!meta || !relPath) continue;
    const [mode, type, sha] = meta.split(" ");
    if (type !== "blob") continue;
    results.push({ path: relPath, blobId: `${mode}:${sha}` });
  }
  return results;
}

function listTreeEntriesFromFs(repoRoot, ownedPaths) {
  const results = [];
  const walk = (absPath, relPath) => {
    const info = statSync(absPath);
    if (info.isDirectory()) {
      for (const name of readdirSync(absPath).sort()) {
        if (name === "node_modules" || name === ".git" || name === "dist")
          continue;
        walk(path.join(absPath, name), `${relPath}/${name}`);
      }
      return;
    }
    if (info.isFile()) {
      const digest = createHash("sha256")
        .update(readFileSync(absPath))
        .digest("hex");
      results.push({
        path: relPath.split(path.sep).join("/"),
        blobId: `fs:${digest}`,
      });
    }
  };
  for (const owned of ownedPaths) {
    const abs = path.join(repoRoot, owned);
    if (!existsSync(abs)) continue;
    walk(abs, owned.split(path.sep).join("/"));
  }
  return results;
}

function hasGitRef(repoRoot, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{tree}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function computeBundleInputHash(
  repoRoot,
  bundleId,
  {
    ref = null,
    target = null,
    toolchain = {},
    lockfileText = null,
    useFs = false,
  } = {},
) {
  const spec = BUNDLE_INPUT_SPECS[bundleId];
  if (!spec) throw new Error(`Unknown bundle id: ${bundleId}`);

  const entries =
    !useFs && ref && hasGitRef(repoRoot, ref)
      ? listTreeEntriesFromGit(repoRoot, ref, spec.paths)
      : listTreeEntriesFromFs(repoRoot, spec.paths);

  const filtered = entries
    .filter((entry) => !spec.exclude.some((re) => re.test(entry.path)))
    .sort((a, b) => a.path.localeCompare(b.path));

  const hash = createHash("sha256");
  hash.update(`bundle:${bundleId}\narch:${spec.arch}\n`);
  if (spec.arch === "per-target" && target) {
    hash.update(`target:${target}\n`);
  }
  for (const [k, v] of Object.entries(toolchain).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update(`toolchain:${k}=${v}\n`);
  }
  for (const entry of filtered) {
    hash.update(`${entry.path}\0${entry.blobId}\n`);
  }

  let nativeDepsInfo = null;
  if (spec.usesNativeDepsLock || bundleId === "backend") {
    const lock =
      lockfileText ??
      (existsSync(path.join(repoRoot, "pnpm-lock.yaml"))
        ? readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8")
        : "");
    nativeDepsInfo = computeNativeDepsHash(lock, {
      target: spec.arch === "per-target" ? (target ?? "all") : "all",
      nodeMajor: toolchain.nodeMajor ?? readNodeMajor(repoRoot),
    });
    if (spec.usesNativeDepsLock) {
      hash.update(`nativeDeps:${nativeDepsInfo.hash}\n`);
    }
  }

  return {
    bundleId,
    arch: spec.arch,
    inputHash: hash.digest("hex"),
    fileCount: filtered.length,
    ...(nativeDepsInfo
      ? {
          nativeDepsHash: nativeDepsInfo.hash,
          nativeDepsShortId: nativeDepsInfo.shortId,
        }
      : {}),
  };
}

/**
 * Plans which bundles must be built vs reused from a previous Schema 3 manifest.
 * Unchanged bundles inherit their exact previous artifactId/url/sha256/originAppVersion.
 */
export function planBundleBuilds(
  repoRoot,
  {
    ref = "HEAD",
    useFs = false,
    targets = PLATFORM_TARGETS,
    prevManifest = null,
    toolchain = {},
    lockfileText = null,
  } = {},
) {
  const plan = {};
  const nodeMajor = toolchain.nodeMajor ?? readNodeMajor(repoRoot);
  const lock =
    lockfileText ??
    (existsSync(path.join(repoRoot, "pnpm-lock.yaml"))
      ? readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8")
      : "");

  const globalNativeDeps = computeNativeDepsHash(lock, {
    target: "all",
    nodeMajor,
  });

  for (const bundleId of BUNDLE_IDS) {
    const spec = BUNDLE_INPUT_SPECS[bundleId];
    const computed = computeBundleInputHash(repoRoot, bundleId, {
      ref,
      useFs,
      toolchain: { ...toolchain, nodeMajor },
      lockfileText: lock,
    });
    const prevEntry = prevManifest?.bundles?.[bundleId];
    const sameInput =
      prevEntry !== undefined &&
      prevEntry.inputHash === computed.inputHash &&
      (bundleId !== "backend" ||
        prevEntry.nativeDepsHash === globalNativeDeps.hash) &&
      (spec.arch === "noarch"
        ? Boolean(prevEntry.artifact?.sha256)
        : targets.every((t) => Boolean(prevEntry.targets?.[t]?.sha256)));

    plan[bundleId] = {
      bundleId,
      arch: spec.arch,
      action: sameInput ? "REUSED" : "BUILD",
      inputHash: computed.inputHash,
      fileCount: computed.fileCount,
      ...(bundleId === "backend" || bundleId === "node-native-deps"
        ? {
            nativeDepsHash: globalNativeDeps.hash,
            nativeDepsShortId: globalNativeDeps.shortId,
          }
        : {}),
      ...(sameInput ? { inherited: prevEntry } : {}),
    };
  }

  return {
    schema: 1,
    ref: useFs ? "worktree" : ref,
    nativeDepsHash: globalNativeDeps.hash,
    nativeDepsShortId: globalNativeDeps.shortId,
    bundles: plan,
    toBuild: Object.values(plan)
      .filter((b) => b.action === "BUILD")
      .map((b) => b.bundleId),
    reused: Object.values(plan)
      .filter((b) => b.action === "REUSED")
      .map((b) => b.bundleId),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repoRoot = path.resolve(flag("--repo") ?? defaultRepoRoot);
  const ref = flag("--ref") ?? "HEAD";
  const useFs = args.includes("--fs");
  const prevPath = flag("--prev-manifest");
  const prevManifest = prevPath
    ? JSON.parse(readFileSync(path.resolve(prevPath), "utf8"))
    : null;
  const targetsArg = flag("--targets");
  const targets = targetsArg
    ? targetsArg.split(",").filter(Boolean)
    : PLATFORM_TARGETS;

  const result = planBundleBuilds(repoRoot, {
    ref,
    useFs,
    targets,
    prevManifest,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
