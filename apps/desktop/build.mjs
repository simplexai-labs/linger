// Bundles main (ESM) and the sandboxed preloads (CJS) into dist/, and builds
// the Go daemon that runs agents. Workspace packages are bundled from source.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { buildDaemon } from "./scripts/build-daemon.mjs";
import {
  buildInstallerBundle,
  buildTeamhubCli,
  desktopEsbuildConfigs,
} from "./scripts/build-steps.mjs";
import { stageDesktopComputerTools } from "./scripts/stage-computer-tools.mjs";
import { buildTeamhub, TEAMHUB_TARGETS } from "./scripts/build-teamhub.mjs";
import {
  buildRuntime,
  RUNTIME_TARGETS,
} from "./scripts/build-native-runtime.mjs";

const desktopDir = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(
  await readFile(path.join(desktopDir, "package.json"), "utf8"),
);
// The platforms this build is for: this machine unless
// LINGER_DESKTOP_DAEMON_TARGETS lists targets, comma-separated (packaging
// builds the one it ships).
const daemonTargets = process.env.LINGER_DESKTOP_DAEMON_TARGETS?.split(
  ",",
).filter(Boolean) ?? [`${process.platform}-${process.arch}`];
// The linger source package that "Run on this computer" installs. Release
// builds pin it, either bundled in the app (LINGER_SOURCE_ARCHIVE_FILE) or
// downloaded; without it the desktop offers only an existing checkout.
const bundledSource = process.env.LINGER_SOURCE_ARCHIVE_FILE;
// Full committed source archive used to compile prebuilt TeamHub binaries and
// the Native runtime when LINGER_SOURCE_ARCHIVE_FILE ships a minimal skeleton.
const buildSource = process.env.LINGER_BUILD_SOURCE_ARCHIVE_FILE;
if (buildSource && !bundledSource) {
  throw new Error(
    "LINGER_BUILD_SOURCE_ARCHIVE_FILE requires LINGER_SOURCE_ARCHIVE_FILE",
  );
}
// Other hosts serving the same file, separated by spaces; the desktop tries
// them in order when the first one fails or stalls.
function mirrors(name, value) {
  const urls = value?.split(/\s+/).filter(Boolean) ?? [];
  for (const url of urls)
    if (!url.startsWith("https://"))
      throw new Error(`${name} must list https URLs: ${url}`);
  return urls.length ? { mirrors: urls } : {};
}
const sourceArchive = await (async () => {
  if (bundledSource) {
    const sha256 = createHash("sha256")
      .update(await readFile(bundledSource))
      .digest("hex");
    return { file: path.join("source", path.basename(bundledSource)), sha256 };
  }
  const url = process.env.LINGER_SOURCE_ARCHIVE_URL;
  const sha256 = process.env.LINGER_SOURCE_ARCHIVE_SHA256;
  if (!url && !sha256) return null;
  if (!url?.startsWith("https://") || !/^[0-9a-f]{64}$/.test(sha256 ?? ""))
    throw new Error(
      "LINGER_SOURCE_ARCHIVE_URL must be https and LINGER_SOURCE_ARCHIVE_SHA256 a sha256 hex digest",
    );
  return {
    url,
    ...mirrors(
      "LINGER_SOURCE_ARCHIVE_MIRRORS",
      process.env.LINGER_SOURCE_ARCHIVE_MIRRORS,
    ),
    sha256,
  };
})();
// The dependency store published beside a downloaded source package for
// this build's platform (scripts/prepare-source-dependencies.mjs). Without it
// the installer fetches the packages from a registry.
const sourceDependencies = (() => {
  const url = process.env.LINGER_SOURCE_DEPENDENCIES_URL;
  const sha256 = process.env.LINGER_SOURCE_DEPENDENCIES_SHA256;
  if (!url && !sha256) return null;
  if (!url?.startsWith("https://") || !/^[0-9a-f]{64}$/.test(sha256 ?? ""))
    throw new Error(
      "LINGER_SOURCE_DEPENDENCIES_URL must be https and LINGER_SOURCE_DEPENDENCIES_SHA256 a sha256 hex digest",
    );
  return {
    url,
    ...mirrors(
      "LINGER_SOURCE_DEPENDENCIES_MIRRORS",
      process.env.LINGER_SOURCE_DEPENDENCIES_MIRRORS,
    ),
    sha256,
  };
})();

await Promise.all(
  desktopEsbuildConfigs({
    desktopDir,
    version,
    sourceArchive,
    sourceDependencies,
  }).map((config) => build(config)),
);

// The local installer that "Run on this computer" opens. It runs under a
// pinned Node 26 that the desktop downloads, not the app's own Node.
await buildInstallerBundle({
  desktopDir,
  daemonTargets,
  bundledSource,
  sourceArchive,
});

// TeamHub compiled from the source package for targets that should not
// compile it themselves (Windows); the desktop hands the binaries to Native.
const teamhubTargets = daemonTargets.filter((target) =>
  TEAMHUB_TARGETS.includes(target),
);
// The services Native runs, built from the same package, with the Node.js
// that runs them, so installing Native there needs no network.
const runtimeTargets = daemonTargets.filter((target) =>
  RUNTIME_TARGETS.includes(target),
);
// Run the independent packaging build steps concurrently across available cores:
// native TeamHub binaries, Native runtime services, teamhub CLI, and the Go
// daemon + Computer tools (sequenced so buildDaemon finishes clearing
// dist/computer before stageDesktopComputerTools links into it).
const buildNativeOutputs = async () => {
  if (!sourceArchive || (!teamhubTargets.length && !runtimeTargets.length))
    return;
  let archive = buildSource || bundledSource;
  const shippedOptions = buildSource
    ? { shippedArchive: bundledSource }
    : undefined;
  const work = archive
    ? undefined
    : await mkdtemp(path.join(tmpdir(), "linger-source-"));
  try {
    if (!archive) {
      archive = path.join(work, "source.tar.gz");
      const response = await fetch(sourceArchive.url);
      if (!response.ok)
        throw new Error(`${sourceArchive.url}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        sourceArchive.sha256
      )
        throw new Error(
          `${sourceArchive.url} does not match LINGER_SOURCE_ARCHIVE_SHA256`,
        );
      await writeFile(archive, bytes);
    }
    await Promise.all([
      (async () => {
        for (const target of teamhubTargets) {
          const manifest = await buildTeamhub(
            target,
            archive,
            undefined,
            shippedOptions,
          );
          console.log(
            `TeamHub binaries for ${target} from ${manifest.sourceCommit.slice(0, 12)}`,
          );
        }
      })(),
      (async () => {
        for (const target of runtimeTargets) {
          const manifest = await buildRuntime(
            target,
            archive,
            undefined,
            shippedOptions,
          );
          console.log(
            `Native runtime for ${target} from ${manifest.sourceCommit.slice(0, 12)}: ${manifest.layout === "directory" ? "a folder" : `${manifest.archive.bytes} bytes`}`,
          );
        }
      })(),
    ]);
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
};

// The Go Local Computer daemon (dist/computer/<platform>-<arch>/) for each
// target, and the browser and computer-control tools it loads
// (dist/computer-tools/<platform>-<arch>/). Without the tools the daemon runs
// but offers Agents no browser or computer use.
const buildDaemonAndTools = async () => {
  await buildDaemon(daemonTargets);
  await stageDesktopComputerTools(daemonTargets);
};

await Promise.all([
  buildNativeOutputs(),
  buildTeamhubCli({ desktopDir, daemonTargets }),
  buildDaemonAndTools(),
]);
