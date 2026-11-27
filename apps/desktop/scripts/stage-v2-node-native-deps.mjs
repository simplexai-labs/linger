// Stages real per-target production node_modules for V2 `node-native-deps`
// bundles (`<out>/<target>/node_modules`, `node-native-deps-manifest.json`,
// `models.json`) and optionally writes `package.json` + `models.json` into the
// staged V2 `node-services/` directory.
//
// Reuses `copyExternals`, `RUNTIME_PACKAGES`, `modelPackageGroup`,
// `modelPackages`, `OPTIONAL_IMPORTS`, and `PLATFORMS` from
// `build-native-runtime.mjs` alongside `NODE_SERVICES_EXTERNALS` from
// `bundle-node-services.mjs` so V2 bundles ship the exact same external native
// and runtime dependencies as the Shell's offline runtime.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./build-daemon.mjs";
import {
  copyExternals,
  modelPackageGroup,
  modelPackages,
  OPTIONAL_IMPORTS,
  PLATFORMS,
  RUNTIME_PACKAGES,
  RUNTIME_TARGETS,
} from "./build-native-runtime.mjs";
import { NODE_SERVICES_EXTERNALS } from "./bundle-node-services.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptsDir, "../../..");
const BUILTIN_MODULES = new Set(builtinModules);

function packageName(specifier) {
  const clean = specifier.replace(/^node:/, "");
  return clean
    .split("/")
    .slice(0, clean.startsWith("@") ? 2 : 1)
    .join("/");
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Computes the sorted root package names to extract from a hoisted
 * `@linger/node-services` pnpm deploy directory. Combines:
 *  - `imports`: exact external bare specifiers emitted by `bundleNodeServices`
 *  - `runtimePackages`: dynamic runtime-loaded packages (`RUNTIME_PACKAGES`)
 *  - `externals`: explicit external patterns (`NODE_SERVICES_EXTERNALS`)
 *    matched against `deployedDependencies` so standalone invocations without
 *    a bundle metafile still capture every required external package.
 */
export function resolveExternalPackageRoots({
  imports = [],
  externals = NODE_SERVICES_EXTERNALS,
  deployedDependencies = [],
  runtimePackages = RUNTIME_PACKAGES,
  optionalImports = OPTIONAL_IMPORTS,
} = {}) {
  const roots = new Set();
  const isSkipped = (name) =>
    !name || BUILTIN_MODULES.has(name) || optionalImports.has(name);

  for (const name of runtimePackages) {
    if (!isSkipped(name)) roots.add(name);
  }

  for (const specifier of imports) {
    if (!specifier || specifier.startsWith("node:")) continue;
    const name = packageName(specifier);
    if (!isSkipped(name)) roots.add(name);
  }

  const deployedList = [...new Set(deployedDependencies)];
  const deployedSet = new Set(deployedList);

  for (const pattern of externals) {
    if (pattern.includes("*")) {
      const regex = wildcardToRegExp(pattern);
      for (const dep of deployedList) {
        if (regex.test(dep) && !isSkipped(dep)) {
          roots.add(dep);
        }
      }
    } else if (!isSkipped(pattern)) {
      if (deployedSet.size === 0 || deployedSet.has(pattern)) {
        roots.add(pattern);
      }
    }
  }

  return [...roots].sort();
}

export async function defaultDeployNodeServices({
  repoRoot,
  target,
  deployDir,
}) {
  const platform = PLATFORMS[target];
  if (!platform) {
    throw new Error(`Unknown V2 node-native-deps target: ${target}`);
  }
  await run(
    "pnpm",
    [
      "--filter",
      "@linger/node-services",
      "deploy",
      "--config.inject-workspace-packages=true",
      "--config.node-linker=hoisted",
      "--prod",
      "--ignore-scripts",
      `--os=${platform.os}`,
      `--cpu=${platform.cpu}`,
      ...(platform.libc ? [`--libc=${platform.libc}`] : []),
      deployDir,
    ],
    { cwd: repoRoot },
  );
}

export async function stageNodeNativeDepsForTarget({
  repoRoot = defaultRepoRoot,
  target,
  targetOutDir,
  imports = [],
  lockfileText,
  runDeploy = defaultDeployNodeServices,
}) {
  if (!PLATFORMS[target]) {
    throw new Error(`Unknown V2 node-native-deps target: ${target}`);
  }
  const absOut = path.resolve(targetOutDir);
  await rm(absOut, { recursive: true, force: true });
  await mkdir(absOut, { recursive: true });

  const work = await mkdtemp(path.join(tmpdir(), `linger-v2-deps-${target}-`));
  try {
    const deployedDir = path.join(work, "deploy");
    await runDeploy({ repoRoot, target, deployDir: deployedDir });

    let deployedDependencies = [];
    const deployedPkgPath = path.join(deployedDir, "package.json");
    if (existsSync(deployedPkgPath)) {
      const pkg = JSON.parse(await readFile(deployedPkgPath, "utf8"));
      deployedDependencies = Object.keys({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      });
    }

    const roots = resolveExternalPackageRoots({
      imports,
      deployedDependencies,
    });

    const copied = await copyExternals(
      deployedDir,
      absOut,
      roots,
      modelPackageGroup,
    );

    const modelsManifest = modelPackages(lockfileText, copied.excluded);
    await writeFile(
      path.join(absOut, "models.json"),
      `${JSON.stringify(modelsManifest, null, 2)}\n`,
      "utf8",
    );

    const manifest = {
      schema: 1,
      target,
      layout: "shared-node-deps",
      packageCount: copied.packages.length,
      packages: copied.packages,
      excludedModels: copied.excluded,
    };
    await writeFile(
      path.join(absOut, "node-native-deps-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    return {
      target,
      outDir: absOut,
      packageCount: copied.packages.length,
      packages: copied.packages,
      excluded: copied.excluded,
      modelsManifest,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function stageV2NodeNativeDeps({
  repoRoot = defaultRepoRoot,
  outDir,
  targets = [...RUNTIME_TARGETS],
  nodeServicesDir = null,
  imports = null,
  importsJsonPath = null,
  runDeploy = defaultDeployNodeServices,
} = {}) {
  if (!outDir) throw new Error("outDir is required");
  const absRepo = path.resolve(repoRoot);
  const absOut = path.resolve(outDir);
  await mkdir(absOut, { recursive: true });

  const lockfilePath = path.join(absRepo, "pnpm-lock.yaml");
  const lockfileText = existsSync(lockfilePath)
    ? await readFile(lockfilePath, "utf8")
    : "";

  let resolvedImports = Array.isArray(imports) ? [...imports] : [];
  if (resolvedImports.length === 0 && importsJsonPath) {
    const raw = JSON.parse(
      await readFile(path.resolve(importsJsonPath), "utf8"),
    );
    if (Array.isArray(raw)) {
      resolvedImports = raw.filter((item) => typeof item === "string");
    }
  }

  const results = [];
  const mergedModels = {};
  for (const target of targets) {
    const result = await stageNodeNativeDepsForTarget({
      repoRoot: absRepo,
      target,
      targetOutDir: path.join(absOut, target),
      imports: resolvedImports,
      lockfileText,
      runDeploy,
    });
    results.push(result);
    Object.assign(mergedModels, result.modelsManifest.packages);
  }

  if (nodeServicesDir) {
    const absNsDir = path.resolve(nodeServicesDir);
    await mkdir(absNsDir, { recursive: true });
    await writeFile(
      path.join(absNsDir, "package.json"),
      `${JSON.stringify(
        { name: "@linger/node-services", private: true, type: "module" },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const sortedModels = Object.fromEntries(
      Object.entries(mergedModels).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(
      path.join(absNsDir, "models.json"),
      `${JSON.stringify({ packages: sortedModels }, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    outDir: absOut,
    targets: results.map(({ target, packageCount, excluded }) => ({
      target,
      packageCount,
      excludedModels: Object.keys(excluded),
    })),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const repoRoot = path.resolve(flag("--repo") ?? defaultRepoRoot);
  const outDir = flag("--out");
  if (!outDir) {
    throw new Error(
      "Usage: stage-v2-node-native-deps.mjs --out DIR [--repo DIR] [--targets darwin-arm64,win32-x64,linux-x64] [--node-services-dir DIR] [--imports-json FILE]",
    );
  }
  const targets = (flag("--targets") ?? RUNTIME_TARGETS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const summary = await stageV2NodeNativeDeps({
    repoRoot,
    outDir: path.resolve(outDir),
    targets,
    nodeServicesDir: flag("--node-services-dir")
      ? path.resolve(flag("--node-services-dir"))
      : null,
    importsJsonPath: flag("--imports-json")
      ? path.resolve(flag("--imports-json"))
      : null,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
