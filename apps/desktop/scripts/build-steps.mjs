// Shared build primitives used by both `build.mjs` (full/release builds) and
// `scripts/dev.mjs` (watch + auto-restart development loop).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { buildTeamhubLauncher } from "./build-daemon.mjs";
import { hostedDiagnosticsUploadUrl } from "./diagnostics-upload-url.mjs";

// Some bundled dependencies still call require().
const REQUIRE_SHIM = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
};

export function runNodeScript(script, args, failure, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(failure)),
    );
  });
}

export function desktopEsbuildConfigs({
  desktopDir,
  version,
  sourceArchive = null,
  sourceDependencies = null,
  diagnosticsUploadUrl = hostedDiagnosticsUploadUrl(
    process.env.LINGER_DIAGNOSTICS_UPLOAD_URL,
  ),
}) {
  const common = {
    absWorkingDir: desktopDir,
    bundle: true,
    platform: "node",
    target: "node24",
    sourcemap: true,
    external: ["electron"],
    define: {
      __DESKTOP_VERSION__: JSON.stringify(version),
      __SOURCE_ARCHIVE__: JSON.stringify(sourceArchive),
      __SOURCE_DEPENDENCIES__: JSON.stringify(sourceDependencies),
      __HOSTED_DIAGNOSTICS_UPLOAD_URL__: JSON.stringify(diagnosticsUploadUrl),
    },
    logLevel: "warning",
  };
  return [
    {
      ...common,
      entryPoints: ["src/main/index.ts"],
      outfile: "dist/main/index.mjs",
      format: "esm",
      banner: REQUIRE_SHIM,
      loader: {
        ".html": "text",
        ".png": "binary",
        ".svg": "binary",
        ".woff2": "binary",
      },
    },
    {
      ...common,
      entryPoints: ["src/preload/index.ts"],
      outfile: "dist/preload/index.cjs",
      format: "cjs",
    },
    {
      ...common,
      entryPoints: ["src/preload/shell.ts"],
      outfile: "dist/preload/shell.cjs",
      format: "cjs",
    },
    {
      ...common,
      entryPoints: ["src/preload/setup.ts"],
      outfile: "dist/preload/setup.cjs",
      format: "cjs",
    },
  ];
}

export function resolveDistributionFile(desktopDir, daemonTargets, env) {
  if (env.LINGER_DESKTOP_DISTRIBUTION) return env.LINGER_DESKTOP_DISTRIBUTION;
  const tracked = daemonTargets
    .map((target) => path.join(desktopDir, "distribution", `${target}.json`))
    .filter((file) => existsSync(file));
  return tracked.length === 1 ? tracked[0] : undefined;
}

async function fileMatchesPin(file, expectedBytes, expectedSha256) {
  try {
    const bytes = await readFile(file);
    return (
      bytes.length === expectedBytes &&
      createHash("sha256").update(bytes).digest("hex") === expectedSha256
    );
  } catch {
    return false;
  }
}

export async function buildInstallerBundle({
  desktopDir,
  daemonTargets,
  bundledSource,
  sourceArchive = null,
  env = process.env,
  preserveNativeArchives = false,
  allowMissingNativeArchives = false,
  log = console.log,
}) {
  const installerScript = path.resolve(
    desktopDir,
    "../linger-installer/scripts/build.mjs",
  );
  const installerDist = path.resolve(desktopDir, "../linger-installer/dist");
  const targetDir = path.join(desktopDir, "dist", "installer");

  await runNodeScript(
    installerScript,
    [],
    "installer build failed",
    desktopDir,
  );

  if (preserveNativeArchives && existsSync(targetDir)) {
    for (const entry of await readdir(targetDir, { withFileTypes: true })) {
      if (entry.name === "native") continue;
      await rm(path.join(targetDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  } else {
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
  }
  await cp(installerDist, targetDir, { recursive: true });

  if (bundledSource && sourceArchive?.file) {
    await mkdir(path.join(targetDir, "source"), { recursive: true });
    await cp(bundledSource, path.join(targetDir, sourceArchive.file));
  }

  const distribution = resolveDistributionFile(desktopDir, daemonTargets, env);
  if (!distribution) return { distribution: null, missingNative: [] };

  const value = JSON.parse(await readFile(distribution, "utf8"));
  if (
    typeof value.platform !== "string" ||
    typeof value.arch !== "string" ||
    !value.localmodelsTool ||
    !Array.isArray(value.nativeSources)
  )
    throw new Error(
      `${distribution} needs platform, arch, localmodelsTool and nativeSources`,
    );
  // The installer refuses a distribution for another computer.
  if (!daemonTargets.includes(`${value.platform}-${value.arch}`))
    throw new Error(
      `${distribution} is for ${value.platform}-${value.arch}, not ${daemonTargets.join(", ")}`,
    );
  const voiceTools = value.voiceTools ?? [];
  if (!Array.isArray(voiceTools))
    throw new Error(`${distribution}: voiceTools must be a list`);

  const missingNative = [];
  for (const source of [...value.nativeSources, ...voiceTools]) {
    if (source.file === undefined) continue;
    if (
      typeof source.file !== "string" ||
      !/^native\/[\w.-]+\.tar\.gz$/.test(source.file)
    )
      throw new Error(
        `${distribution}: bundled file must be native/<name>.tar.gz`,
      );
    const destination = path.join(targetDir, source.file);
    if (
      preserveNativeArchives &&
      (await fileMatchesPin(destination, source.bytes, source.sha256))
    )
      continue;
    const from = path.join(
      env.LINGER_NATIVE_POSTGRES_DIR ||
        path.join(homedir(), ".cache", "linger-desktop"),
      path.basename(source.file),
    );
    const bytes = await readFile(from).catch(() => null);
    if (!bytes) {
      if (allowMissingNativeArchives) {
        missingNative.push(path.basename(source.file));
        continue;
      }
      throw new Error(
        `${distribution} bundles ${path.basename(source.file)}; put it in LINGER_NATIVE_POSTGRES_DIR (see AGENTS.md)`,
      );
    }
    if (
      bytes.length !== source.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== source.sha256
    )
      throw new Error(`${from} does not match ${distribution}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(from, destination);
  }

  if (missingNative.length > 0) {
    log(
      `[desktop-dev] Skipping missing native archives (${missingNative.join(", ")}); not needed when connecting to --server.`,
    );
  }

  await writeFile(
    path.join(targetDir, "distribution.json"),
    JSON.stringify({
      platform: value.platform,
      arch: value.arch,
      localmodelsTool: value.localmodelsTool,
      nativeSources: value.nativeSources,
      voiceTools,
    }),
  );
  return { distribution, missingNative };
}

export async function buildTeamhubCli({ desktopDir, daemonTargets = [] }) {
  const outdir = path.join(desktopDir, "dist", "teamhub-cli");
  await runNodeScript(
    path.resolve(desktopDir, "../teamhub-cli/scripts/build-cli.mjs"),
    ["--outdir", outdir],
    "teamhub CLI build failed",
    desktopDir,
  );
  await Promise.all([
    rm(path.join(outdir, "teamhub.cmd"), { force: true }),
    rm(path.join(outdir, "teamhub.exe"), { force: true }),
  ]);
  await writeFile(
    path.join(outdir, "teamhub"),
    (
      await readFile(path.join(desktopDir, "scripts", "teamhub.sh"), "utf8")
    ).replace(/\r\n/g, "\n"),
    { mode: 0o755 },
  );
  const windowsTarget = daemonTargets.find((target) =>
    target.startsWith("win32-"),
  );
  if (windowsTarget) {
    await buildTeamhubLauncher(windowsTarget, path.join(outdir, "teamhub.exe"));
  }
}
