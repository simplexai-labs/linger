import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import yauzl from "yauzl";

const execFileAsync = promisify(execFile);
const computerRoot = fileURLToPath(new URL("../", import.meta.url));
export const COMPUTER_TOOL_VERSIONS = Object.freeze({
  playwright: "0.0.83",
  pi: "1.5.2",
  cua: "0.35.4",
  quickjs: "3.6.2",
});
export const piRuntimeEntry = (target) =>
  target.startsWith("win32-") ? "bin/pi.exe" : "bin/pi";
// The entry imports the three sibling modules. Plain scripts need no
// optional QuickJS extensions; the bundled Pi also loads the base VM.
const quickjsFiles = [
  "LICENSE",
  "package.json",
  "quickjs.wasm",
  "dist/index.js",
  "dist/extensions.js",
  "dist/version.js",
  "dist/wasi-shim.js",
];
export const QUICKJS_TOOL_ASSETS = Object.freeze(
  quickjsFiles.map((name) => `node_modules/quickjs-wasi/${name}`),
);
// Pinned Cua desktop drivers per release target. Windows drives the signed-in
// desktop through the standalone driver; it needs no app bundle or SDK.
const cuaArchive = (name, sha256, entry, required) =>
  Object.freeze({
    name,
    sha256,
    url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.35.4/${name}`,
    root: `${name.replace(/\.(tar\.gz|zip)$/u, "")}/`,
    entry,
    required,
  });
const darwinCua = cuaArchive(
  "cua-driver-rs-0.35.4-darwin-universal.tar.gz",
  "97d5ea2fd446331947c717c433d4cf5aae063f4824e1ba24303c4696184ec52e",
  "cua/cua-driver",
  ["cua/cua-driver", "cua/CuaDriver.app/Contents/MacOS/cua-driver"],
);
export const CUA_ARCHIVES = Object.freeze({
  "darwin-arm64": darwinCua,
  "darwin-x64": darwinCua,
  "win32-x64": cuaArchive(
    "cua-driver-rs-0.35.4-windows-x86_64.zip",
    "823ca4b340ca85301dd65f116cfb26282c40a66f1fc465a225ee103b6b74af5b",
    "cua/cua-driver.exe",
    ["cua/cua-driver.exe"],
  ),
  "win32-arm64": cuaArchive(
    "cua-driver-rs-0.35.4-windows-arm64.zip",
    "fdbbbc27f814bb850c359268f977a61d0fbd89eb1d2776e3762d36f1a752dd02",
    "cua/cua-driver.exe",
    ["cua/cua-driver.exe"],
  ),
});
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function packageRoot(name, from) {
  const require = createRequire(pathToFileURL(path.join(from, "package.json")));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    const manifest = await readFile(
      path.join(candidate, "package.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch(() => null);
    if (manifest?.name === name) return realpath(candidate);
  }
  throw new Error(`Cannot resolve tool package ${name}`);
}

const piAllowedPaths = new Set([
  "",
  "package.json",
  "LICENSE",
  "dist",
  "dist/bundle",
  "dist/modes",
  "dist/modes/interactive",
  "dist/modes/interactive/theme",
  "dist/modes/interactive/theme/dark.json",
  "dist/modes/interactive/theme/light.json",
  "dist/modes/interactive/assets",
  "dist/modes/interactive/assets/clankolas.png",
  "dist/core",
  "dist/core/export-html",
  "dist/core/export-html/template.css",
  "dist/core/export-html/template.html",
  "dist/core/export-html/template.js",
  "dist/core/export-html/vendor",
]);

const piExternalRuntimePackages = ["jiti", "@silvia-odwyer/photon-node"];

const piRequiredStagedFiles = [
  "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  "node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js",
  "node_modules/jiti/package.json",
  "node_modules/@silvia-odwyer/photon-node/package.json",
];

// Pi's dist/bundle/ already embeds its JS dependencies; copy only the bundle,
// its runtime assets, and the two zero-dependency external packages it loads
// dynamically (jiti for TS extensions and photon-node for WASM image resizing).
async function stagePiRuntimePackages(destination, installed, versions) {
  const piName = "@earendil-works/pi-coding-agent";
  const source = await packageRoot(piName, computerRoot);
  const manifest = JSON.parse(
    await readFile(path.join(source, "package.json"), "utf8"),
  );
  if (manifest.version !== COMPUTER_TOOL_VERSIONS.pi)
    throw new Error(`Expected ${piName}@${COMPUTER_TOOL_VERSIONS.pi}`);
  const piTarget = path.join(destination, "node_modules", piName);
  if (installed.has(piTarget)) {
    if (installed.get(piTarget) !== source)
      throw new Error(`Conflicting tool dependency ${piName}`);
  } else {
    installed.set(piTarget, source);
    await cp(source, piTarget, {
      recursive: true,
      dereference: false,
      filter: (entry) => {
        const relative = path.relative(source, entry).split(path.sep).join("/");
        if (piAllowedPaths.has(relative)) return true;
        return (
          (relative.startsWith("dist/bundle/") ||
            relative.startsWith("dist/core/export-html/vendor/")) &&
          !/\.(?:map|d\.[cm]?ts)$/u.test(relative)
        );
      },
    });
    versions.push({
      name: piName,
      version: manifest.version,
      path: path.relative(destination, piTarget).split(path.sep).join("/"),
    });
  }
  for (const depName of piExternalRuntimePackages) {
    const depSource = await packageRoot(depName, source);
    const depManifest = JSON.parse(
      await readFile(path.join(depSource, "package.json"), "utf8"),
    );
    const depTarget = path.join(destination, "node_modules", depName);
    if (installed.has(depTarget)) {
      if (installed.get(depTarget) === depSource) continue;
      throw new Error(`Conflicting tool dependency ${depName}`);
    }
    installed.set(depTarget, depSource);
    await cp(depSource, depTarget, {
      recursive: true,
      dereference: false,
      filter: (entry) => {
        const relative = path.relative(depSource, entry);
        if (!relative) return true;
        const parts = relative.split(path.sep);
        return (
          !parts.some(
            (part) =>
              part === "node_modules" ||
              part === ".git" ||
              part === "README.md" ||
              part === "__tests__" ||
              part === "docs" ||
              part === "examples" ||
              part.startsWith("test"),
          ) && !/\.(?:map|d\.[cm]?ts)$/u.test(entry)
        );
      },
    });
    versions.push({
      name: depName,
      version: depManifest.version,
      path: path.relative(destination, depTarget).split(path.sep).join("/"),
    });
  }
  for (const relative of piRequiredStagedFiles) {
    const info = await lstat(path.join(destination, relative)).catch(
      () => null,
    );
    if (!info?.isFile())
      throw new Error(`Bundled Pi runtime asset is missing: ${relative}`);
  }
}

// Preserve upstream modules and dynamic resources. Resolution uses only this
// worktree's frozen installation; no npx, npm install, or runtime download.
async function stagePackages(destination) {
  const installed = new Map();
  const versions = [];
  async function copyPackage(name, from, parent, ancestors = new Map()) {
    const source = await packageRoot(name, from);
    if (ancestors.has(source)) return;
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    const rootPath = path.join(destination, "node_modules", name);
    let target = rootPath;
    if (installed.has(rootPath)) {
      if (installed.get(rootPath) === source) return;
      target = path.join(parent, "node_modules", name);
    }
    if (installed.get(target) === source) return;
    if (installed.has(target))
      throw new Error(`Conflicting tool dependency ${name}`);
    installed.set(target, source);
    await cp(source, target, {
      recursive: true,
      dereference: false,
      filter: (entry) => {
        const parts = path.relative(source, entry).split(path.sep);
        if (
          name === "quickjs-wasi" &&
          manifest.version === COMPUTER_TOOL_VERSIONS.quickjs
        ) {
          const relative = parts.join("/");
          return (
            !relative || relative === "dist" || quickjsFiles.includes(relative)
          );
        }
        return (
          !parts.some((part) =>
            [
              "node_modules",
              ".git",
              "test",
              "tests",
              "__tests__",
              "docs",
              "examples",
            ].includes(part),
          ) && !/\.(?:map|d\.[cm]?ts)$/u.test(entry)
        );
      },
    });
    versions.push({
      name,
      version: manifest.version,
      path: path.relative(destination, target).split(path.sep).join("/"),
    });
    const next = new Map(ancestors);
    next.set(source, target);
    const required = manifest.dependencies ?? {};
    const optional = manifest.optionalDependencies ?? {};
    for (const dependency of [
      ...new Set([...Object.keys(required), ...Object.keys(optional)]),
    ].sort()) {
      if (dependency in optional) {
        try {
          await packageRoot(dependency, source);
        } catch {
          continue;
        }
      }
      await copyPackage(dependency, source, target, next);
    }
  }
  for (const [name, version] of [
    ["quickjs-wasi", COMPUTER_TOOL_VERSIONS.quickjs],
    ["@playwright/mcp", COMPUTER_TOOL_VERSIONS.playwright],
  ]) {
    const source = await packageRoot(name, computerRoot);
    const manifest = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    if (manifest.version !== version)
      throw new Error(`Expected ${name}@${version}`);
    await copyPackage(name, computerRoot, destination);
  }
  await stagePiRuntimePackages(destination, installed, versions);
  return versions.sort((a, b) => a.path.localeCompare(b.path));
}

async function ensureCuaArchive(release, cacheDirectory) {
  await mkdir(cacheDirectory, { recursive: true });
  const archive = path.join(cacheDirectory, release.name);
  const valid = async () => sha256(await readFile(archive)) === release.sha256;
  try {
    if (await valid()) return archive;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const partial = `${archive}.${process.pid}.partial`;
  try {
    const response = await fetch(release.url, {
      // This pinned release is about 80 MiB. CI can reach GitHub over a slow
      // link; bound the complete transfer without requiring a fast mirror.
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok || !response.body)
      throw new Error("Cua release download failed");
    await pipeline(
      response.body,
      createWriteStream(partial, { mode: 0o600, flags: "wx" }),
    );
    if (sha256(await readFile(partial)) !== release.sha256)
      throw new Error("Cua release checksum mismatch");
    await rename(partial, archive);
  } finally {
    await rm(partial, { force: true });
  }
  return archive;
}

// The MCP proxy and signed app are the only macOS Cua execution paths; the
// standalone driver is the only Windows one. SDK libraries, Node bindings, the
// UIA and cursor-theme helpers, and headers are not loaded, so they are not
// shipped.
const keptCuaFile = (relative) =>
  relative.startsWith("CuaDriver.app/") ||
  relative === "CuaDriver.app" ||
  [
    "cua-driver",
    "cua-driver.exe",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ].includes(relative);

const cuaRelativePath = (release, name) => {
  if (!name.startsWith(release.root))
    throw new Error("Unexpected Cua archive root");
  const relative = name.slice(release.root.length).replace(/\/$/u, "");
  if (
    relative &&
    (relative
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
      relative.includes("\\"))
  )
    throw new Error("Unsafe Cua archive path");
  return relative;
};

async function extractCuaZip(release, archive, destination) {
  const zip = await promisify(yauzl.open)(archive, {
    lazyEntries: true,
    decodeStrings: true,
  });
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        (async () => {
          const relative = cuaRelativePath(release, entry.fileName);
          const directory = entry.fileName.endsWith("/");
          if (!relative || directory || !keptCuaFile(relative)) return;
          // Unix mode bits in the high word mark links; refuse them.
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
            throw new Error("Cua archive links are not permitted");
          const target = path.join(destination, relative);
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await promisify(zip.openReadStream.bind(zip))(entry);
          await pipeline(
            stream,
            createWriteStream(target, {
              flags: "wx",
              mode: relative.endsWith(".exe") ? 0o755 : 0o644,
            }),
          );
        })().then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function extractCua(release, archive, destination) {
  if (release.name.endsWith(".zip"))
    return extractCuaZip(release, archive, destination);
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    (async () => {
      const relative = cuaRelativePath(release, header.name);
      if (!relative || !keptCuaFile(relative)) {
        stream.resume();
        return;
      }
      const target = path.join(destination, relative);
      if (header.type === "directory") {
        await mkdir(target, { recursive: true });
        stream.resume();
        return;
      }
      if (header.type !== "file")
        throw new Error("Cua archive links are not permitted");
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(
        stream,
        createWriteStream(target, {
          flags: "wx",
          mode: header.mode & 0o111 ? 0o755 : 0o644,
        }),
      );
    })().then(next, (error) => extract.destroy(error));
  });
  await pipeline(createReadStream(archive), createGunzip(), extract);
}

async function assetFiles(root, relative = "") {
  const files = [];
  for (const entry of (await readdir(path.join(root, relative))).sort()) {
    const name = path.posix.join(relative, entry);
    const info = await lstat(path.join(root, name));
    if (info.isSymbolicLink())
      throw new Error(`Tool asset links are not permitted: ${name}`);
    if (info.isDirectory()) files.push(...(await assetFiles(root, name)));
    else if (info.isFile()) {
      const data = await readFile(path.join(root, name));
      files.push({
        path: name,
        size_bytes: data.length,
        sha256: sha256(data),
        mode: info.mode & 0o111 ? 0o755 : 0o644,
      });
    } else throw new Error(`Unsupported tool asset: ${name}`);
  }
  return files;
}

// The pnpm patch keeps focus emulation on CDP connections; without it Agents
// cannot work in background tabs at once. An install that skipped the patch
// would still bundle, so check the staged file itself.
async function assertPlaywrightPatched(root, packages) {
  const core = packages.filter(({ name }) => name === "playwright-core");
  if (core.length === 0) throw new Error("Playwright core was not staged");
  for (const { path: relative } of core) {
    const bundle = await readFile(
      path.join(root, relative, "lib/coreBundle.js"),
      "utf8",
    );
    if (!bundle.includes("// Linger: keep focus emulation on every CDP"))
      throw new Error(
        `${relative}/lib/coreBundle.js lacks the focus emulation patch`,
      );
  }
}

// The daemon names this node_modules on Pi's module path, because a Pi
// installed without its dependencies loads the extension through jiti only
// from there.
function assertPiExtensionLoader(packages) {
  if (
    !packages.some(
      ({ name, path: relative }) =>
        name === "jiti" && relative === "node_modules/jiti",
    )
  )
    throw new Error("jiti was not staged at the top of node_modules");
}

const posixPiLauncherScript = [
  "#!/bin/sh",
  "set -eu",
  "self=$0",
  'while [ -L "$self" ]; do',
  '  link=$(readlink "$self")',
  '  case "$link" in',
  "    /*) self=$link ;;",
  '    *) self=$(dirname -- "$self")/$link ;;',
  "  esac",
  "done",
  'here=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd -P)',
  'tools=$(dirname -- "$here")',
  'for candidate in "$tools/../../runtime/bin/node" "$tools/../runtime/bin/node"; do',
  '  if [ -x "$candidate" ]; then',
  '    exec "$candidate" "$tools/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"',
  "  fi",
  "done",
  'echo "linger bundled pi: runtime/bin/node not found" >&2',
  "exit 127",
  "",
].join("\n");

async function stagePiLauncher(root, target) {
  await mkdir(path.join(root, "bin"), { recursive: true });
  const output = path.join(root, piRuntimeEntry(target));
  if (target.startsWith("win32-")) {
    const goarch = target === "win32-arm64" ? "arm64" : "amd64";
    await execFileAsync(
      "go",
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags",
        "-s -w",
        "-o",
        output,
        "./cmd/linger-pi-launcher",
      ],
      {
        cwd: path.join(computerRoot, "local-daemon"),
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOOS: "windows",
          GOARCH: goarch,
        },
      },
    );
    return;
  }
  await writeFile(output, posixPiLauncherScript, { mode: 0o755 });
  await chmod(output, 0o755);
}

export async function stageComputerTools(
  bundle,
  {
    target = `${process.platform}-${process.arch}`,
    cacheDirectory = path.join(os.homedir(), ".cache/linger-computer-tools"),
  } = {},
) {
  const root = path.join(bundle, "cli/computer-tools");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const packages = await stagePackages(root);
  await assertPlaywrightPatched(root, packages);
  assertPiExtensionLoader(packages);
  await mkdir(path.join(root, "extensions"), { recursive: true });
  await cp(
    path.join(computerRoot, "tools/pi-mcp.mjs"),
    path.join(root, "extensions/pi-mcp.mjs"),
  );
  await stagePiLauncher(root, target);
  const cua = CUA_ARCHIVES[target];
  if (cua)
    await extractCua(
      cua,
      await ensureCuaArchive(cua, cacheDirectory),
      path.join(root, "cua"),
    );
  const assets = await assetFiles(root);
  const manifest = {
    schema_version: 1,
    versions: COMPUTER_TOOL_VERSIONS,
    target,
    playwright_entry: "node_modules/@playwright/mcp/cli.js",
    pi_extension: "extensions/pi-mcp.mjs",
    pi_entry: piRuntimeEntry(target),
    cua_entry: cua?.entry ?? "",
    packages,
    assets,
    artifact_sha256: sha256(JSON.stringify(assets)),
  };
  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function validatedComputerToolAssets(bundle, target) {
  const root = path.join(bundle, "cli/computer-tools");
  const manifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.target !== target ||
    JSON.stringify(manifest.versions) !==
      JSON.stringify(COMPUTER_TOOL_VERSIONS) ||
    !Array.isArray(manifest.assets) ||
    sha256(JSON.stringify(manifest.assets)) !== manifest.artifact_sha256
  )
    throw new Error("Invalid Computer tool manifest");
  if (
    manifest.playwright_entry !== "node_modules/@playwright/mcp/cli.js" ||
    manifest.pi_extension !== "extensions/pi-mcp.mjs" ||
    manifest.pi_entry !== piRuntimeEntry(target) ||
    manifest.cua_entry !== (CUA_ARCHIVES[target]?.entry ?? "")
  )
    throw new Error("Invalid Computer tool entrypoints");
  const actual = await assetFiles(root);
  const expected = manifest.assets;
  const withoutManifest = actual.filter(
    (asset) => asset.path !== "manifest.json",
  );
  if (JSON.stringify(withoutManifest) !== JSON.stringify(expected))
    throw new Error("Computer tool assets do not match their manifest");
  for (const required of [
    manifest.playwright_entry,
    manifest.pi_extension,
    manifest.pi_entry,
    ...QUICKJS_TOOL_ASSETS,
    ...(CUA_ARCHIVES[target]?.required ?? []),
  ]) {
    if (!required || !expected.some((asset) => asset.path === required))
      throw new Error("Computer tool entrypoint is missing");
  }
  const piAsset = expected.find((asset) => asset.path === manifest.pi_entry);
  if (!target.startsWith("win32-") && !(piAsset.mode & 0o111))
    throw new Error("Computer tool Pi entrypoint is not executable");
  return [
    "cli/computer-tools/manifest.json",
    ...expected.map((asset) => `cli/computer-tools/${asset.path}`),
  ];
}
