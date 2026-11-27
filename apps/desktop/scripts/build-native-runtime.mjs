// Builds the services Native runs from the source package the app ships, so
// installing them needs no network and no toolchain: Web's production files
// with its static host, Node Services bundled with esbuild
// (bundle-node-services.mjs) beside the production node_modules of what stays
// external, and the pinned Node.js release. Every target has the same layout;
// only the native packages in node_modules and the Node.js archive differ:
//
//   runtime/files.json                   schema, target, source, every file's sha256
//   runtime/node-services/dist/…         the bundles; dist/supervisor.js starts them
//   runtime/node-services/prompts/
//   runtime/node-services/models.json    model packages installed on first use
//   runtime/node-services/node_modules/
//   runtime/web/{dist/,static-host.mjs}
//
// They go to dist/installer/native/runtime-<target>/ as runtime.tar.zst, with
// a manifest pinning both the services and the shared Node.js binary shipped
// once under resources/runtime/bin/ from Computer tools. On macOS, where the
// app's signature must cover every Mach-O file inside it, the services go
// there unpacked as runtime/ (RUNTIME_LAYOUTS); packaging/mac/package.py signs
// both the services and the shared Node.js binary and refreshes the manifest.
//
//   node scripts/build-native-runtime.mjs --target win32-x64 --source linger-<label>.tar.gz [--shipped-source ARCHIVE] [--output DIR]
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import zlib, { createZstdCompress } from "node:zlib";

import { build } from "esbuild";

import { nodeRuntimeEntry } from "../../../scripts/computer-tool-bundle.mjs";
import {
  ensureNodeRuntimeArchive,
  NODE_RUNTIME_RELEASES,
  NODE_RUNTIME_VERSION,
} from "../../../scripts/local-computer-node-distributions.mjs";
import { extractNodeRuntime } from "../../../scripts/prepare-local-computer-release.mjs";
import { run } from "./build-daemon.mjs";
import { bundleNodeServices } from "./bundle-node-services.mjs";
import { resolveSourceArchive } from "./build-teamhub.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));

export const RUNTIME_TARGETS = ["win32-x64", "linux-x64", "darwin-arm64"];
// The folder the archive holds, which the desktop unpacks into the source as
// .simplexai-runtime/offline (packages/local-installation/src/native-runtime.ts).
const ROOT = "runtime";
export const RUNTIME_ARCHIVE = "runtime.tar.zst";
export const RUNTIME_FILES = "files.json";
// Bumped when the layout above changes, so an older desktop refuses it.
export const RUNTIME_SCHEMA = 1;

// "archive": runtime.tar.zst.
// "directory": the unpacked runtime/ folder (signed on macOS).
export const RUNTIME_LAYOUTS = {
  "win32-x64": "archive",
  "linux-x64": "archive",
  "darwin-arm64": "directory",
};
export const RUNTIME_DIRECTORY = ROOT;

const PLATFORMS = {
  "win32-x64": { os: "win32", cpu: "x64" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
};

// Packages the services load at runtime by a name esbuild cannot see:
// createRequire, require.resolve of data files, or a native binding.
export const RUNTIME_PACKAGES = [
  "@livekit/local-inference",
  "sherpa-onnx-node",
];
// Packages that are model data rather than code: the installer leaves them
// out and Node Services downloads them when a feature first needs them
// (apps/node-services/src/model-packages.ts). Local models install
// separately as before.
export const MODEL_PACKAGE_GROUPS = [
  // Silero VAD and the turn detector, embedded in the binding.
  [/^@livekit\/local-inference-/, "voice"],
];
export const modelPackageGroup = (name) =>
  MODEL_PACKAGE_GROUPS.find(([pattern]) => pattern.test(name))?.[1];
// Registries holding the same tarballs; the lockfile integrity checks both.
// Node Services tries the one in its download region (SIMPLEX_REGION) first.
const MODEL_REGISTRIES = [
  "https://registry.npmjs.org/",
  "https://registry.npmmirror.com/",
];
// Imports inside try/catch for features Native does not use; development
// does not install them either.
export const OPTIONAL_IMPORTS = new Set([
  "@pdf-lib/fontkit",
  "bufferutil",
  // jsdom probes optional native `canvas` inside a try/catch; we never install it.
  "canvas",
  "pdf-lib",
  "pnpapi",
  "puppeteer",
  // officeparser lazy-imports tesseract.js only when OCR is enabled; we always pass ocr: false.
  "tesseract.js",
  // Only source files running under tsx register it.
  "tsx",
  "utf-8-validate",
]);

// Dependencies the services never load, left out with everything only they
// need. officeparser imports tesseract.js (an OCR engine with about 40 MB of
// wasm) only when a parse asks for OCR, and document-office-extract.ts
// always passes `ocr: false`.
const UNLOADED_PACKAGES = new Set(["tesseract.js"]);

// Package subtrees that Node Services never loads at runtime (for example
// browser viewer assets, non-legacy builds, and type declaration trees).
const PACKAGE_UNUSED_SUBPATHS = {
  "pdfjs-dist": ["build", "web", "legacy/web", "types"],
};

export function unusedPackageEntry(name, relativePath) {
  const prefixes = PACKAGE_UNUSED_SUBPATHS[name];
  if (!prefixes || !relativePath) return false;
  return prefixes.some(
    (prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

export const runtimeDirectory = (target) =>
  path.join(desktop, "dist/installer/native", `runtime-${target}`);

const sha256File = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

// Source maps, type declarations, TypeScript sources and documentation that
// Node never loads from node_modules; licenses stay.
const unused = (file) => {
  const name = path.basename(file);
  return (
    !/^(?:licen[cs]e|notice|copying|authors)/i.test(name) &&
    /\.(?:map|[cm]?ts|tsx|md|markdown)$/i.test(name)
  );
};

// Copies the packages in `roots` and every package they depend on from the
// hoisted `deployed` node_modules into `output`, at the same paths, so Node
// resolves each the way it did there. Packages `exclude` accepts are listed
// in `excluded` with their version instead.
export async function copyExternals(
  deployed,
  output,
  roots,
  exclude = () => false,
) {
  const copied = new Map();
  const excluded = new Map();
  const missing = [];
  const find = (name, from) => {
    for (let directory = from; ; directory = path.dirname(directory)) {
      const candidate = path.join(directory, "node_modules", name);
      const relative = path.relative(deployed, candidate);
      if (relative.startsWith("..")) return;
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
      if (directory === deployed) return;
    }
  };
  const visit = async (name, from, required) => {
    if (UNLOADED_PACKAGES.has(name)) return;
    const directory = find(name, from);
    if (!directory) {
      if (required)
        missing.push(`${name} (from ${path.relative(deployed, from) || "."})`);
      return;
    }
    if (copied.has(directory) || excluded.has(name)) return;
    const manifest = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    if (exclude(name)) {
      excluded.set(name, manifest.version);
      return;
    }
    copied.set(directory, { name, version: manifest.version });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await visit(dependency, directory, true);
    // Platform packages for other computers are not installed.
    for (const dependency of Object.keys({
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }))
      await visit(dependency, directory, false);
  };
  for (const root of roots) await visit(root, deployed, true);
  if (missing.length)
    throw new Error(`Missing runtime packages: ${missing.join(", ")}`);
  for (const [directory, info] of copied)
    await cp(directory, path.join(output, path.relative(deployed, directory)), {
      recursive: true,
      // Nested packages are copied on their own when something needs them.
      filter: (file) => {
        const relative = path.relative(directory, file);
        const normalized = relative.split(path.sep).join("/");
        return (
          !normalized.split("/").includes("node_modules") &&
          !unused(file) &&
          !unusedPackageEntry(info.name, normalized)
        );
      },
    });
  return {
    packages: [...copied].map(([directory, { version }]) => ({
      package: path.relative(deployed, directory).split(path.sep).join("/"),
      version,
    })),
    excluded: Object.fromEntries([...excluded].sort()),
  };
}

// models.json for the model packages `versions` lists, with each tarball's
// integrity from the source's lockfile.
export function modelPackages(lockfile, versions) {
  const packages = {};
  for (const [name, version] of Object.entries(versions)) {
    const quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const integrity = new RegExp(
      `\\n  '?${quoted}@${version.replaceAll(".", "\\.")}'?:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`,
    ).exec(lockfile)?.[1];
    if (!integrity)
      throw new Error(`pnpm-lock.yaml has no sha512 for ${name}@${version}`);
    const file = `${name.split("/").at(-1)}-${version}.tgz`;
    packages[name] = {
      group: modelPackageGroup(name),
      version,
      integrity,
      tarballs: MODEL_REGISTRIES.map(
        (registry) => `${registry}${name}/-/${file}`,
      ),
    };
  }
  return { packages };
}

// Every file under `root` with its size and sha256, by relative path.
async function listFiles(root) {
  const files = {};
  const walk = async (directory) => {
    for (const entry of (await readdir(directory)).sort()) {
      const file = path.join(directory, entry);
      const info = await lstat(file);
      if (info.isSymbolicLink())
        throw new Error(`${file} is a symbolic link; the runtime copies files`);
      if (info.isDirectory()) await walk(file);
      else
        files[path.relative(root, file).split(path.sep).join("/")] = {
          bytes: info.size,
          sha256: await sha256File(file),
        };
    }
  };
  await walk(root);
  return files;
}

// Shared with scripts/prepare-local-computer-release.mjs so both the Native
// runtime and Computer tools reuse one pinned Node.js download per target.
const nodeCache = path.join(
  desktop,
  "../../.linger-runtime/node-distributions",
);
const SHA256_HEX = /^[0-9a-f]{64}$/u;

// Computes the pinned Node.js binary's digest without copying a second Node.js
// into runtime-<target>/; packaging ships the binary once under
// resources/runtime/bin/ from Computer tools.
async function sharedNodeMetadata(target, work) {
  const release = NODE_RUNTIME_RELEASES[target];
  const cached = await ensureNodeRuntimeArchive(target, nodeCache);
  const extracted = path.join(work, "node-binary");
  await mkdir(extracted, { recursive: true });
  await extractNodeRuntime(cached, extracted, release.archive);
  const binary = nodeRuntimeEntry(target);
  const fullPath = path.join(extracted, binary);
  return {
    version: NODE_RUNTIME_VERSION,
    shared: true,
    binary,
    sha256: await sha256File(fullPath),
    bytes: (await stat(fullPath)).size,
  };
}

// Throws unless `directory` holds the runtime its manifest lists, built for
// `target` from the package with `sourceArchiveSha256`.
export async function verifyRuntime(directory, target, sourceArchiveSha256) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8").catch(() => {
      throw new Error(`${directory} has no Native runtime for ${target}`);
    }),
  );
  if (
    manifest.schema !== RUNTIME_SCHEMA ||
    manifest.target !== target ||
    manifest.sourceArchiveSha256 !== sourceArchiveSha256
  )
    throw new Error(
      `${directory} holds a Native runtime for another target or source package`,
    );
  const layout = RUNTIME_LAYOUTS[target];
  if ((manifest.layout ?? "archive") !== layout)
    throw new Error(`${directory} holds a Native runtime of another layout`);
  const items = [
    layout === "directory" ? manifest.directory : manifest.archive,
  ];
  if (manifest.node?.shared === true) {
    if (
      manifest.node.version !== NODE_RUNTIME_VERSION ||
      manifest.node.binary !== nodeRuntimeEntry(target) ||
      typeof manifest.node.sha256 !== "string" ||
      !SHA256_HEX.test(manifest.node.sha256) ||
      !Number.isSafeInteger(manifest.node.bytes) ||
      manifest.node.bytes <= 0
    )
      throw new Error(
        `${directory}/manifest.json has invalid shared node metadata`,
      );
  } else {
    items.push(manifest.node);
  }
  if (layout === "directory") {
    const files = JSON.parse(
      await readFile(path.join(directory, ROOT, RUNTIME_FILES), "utf8"),
    ).files;
    for (const [file, item] of Object.entries(files))
      items.push({ ...item, file: `${ROOT}/${file}` });
  }
  for (const item of items) {
    const file = path.join(directory, item?.file ?? "missing");
    const bytes = await stat(file).then(
      (info) => info.size,
      () => -1,
    );
    if (bytes !== item?.bytes || (await sha256File(file)) !== item.sha256)
      throw new Error(`${file} does not match ${directory}/manifest.json`);
  }
  return manifest;
}

export async function buildRuntime(
  target,
  archive,
  output = runtimeDirectory(target),
  options = {},
) {
  const platform = PLATFORMS[target];
  if (!platform || !NODE_RUNTIME_RELEASES[target])
    throw new Error(`Unknown Native runtime target ${target}`);
  const { commit, sourceArchiveSha256 } = await resolveSourceArchive(
    archive,
    options.shippedArchive,
  );
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), "linger-runtime-"));
  const timings = {};
  const timed = async (name, action) => {
    const started = Date.now();
    const result = await action();
    timings[name] = Math.round((Date.now() - started) / 100) / 10;
    console.log(`native runtime: ${name} took ${timings[name]}s`);
    return result;
  };
  try {
    const source = path.join(work, "source");
    const root = path.join(work, ROOT);
    const services = path.join(root, "node-services");
    const web = path.join(root, "web");
    await mkdir(source);
    await run("tar", ["-xzf", archive, "-C", source, "--strip-components=1"]);
    await timed("install", () =>
      run(
        "pnpm",
        [
          "install",
          "--filter",
          "@linger/node-services...",
          "--filter",
          "@linger/web...",
          "--frozen-lockfile",
          "--prefer-offline",
          "--reporter",
          "append-only",
        ],
        { cwd: source },
      ),
    );
    const [, { bundled, packages }, downloadedNode] = await Promise.all([
      timed("web", async () => {
        const webSource = path.join(source, "apps/web");
        // Forward --skip-precompress to build:assets so Web keeps one build
        // recipe while skipping .gz/.br twins the loopback host does not serve.
        await run(
          "pnpm",
          [
            "--filter",
            "@linger/web",
            "run",
            "build:assets",
            "--skip-precompress",
          ],
          { cwd: source },
        );
        await cp(path.join(webSource, "dist"), path.join(web, "dist"), {
          recursive: true,
        });
        await build({
          absWorkingDir: webSource,
          entryPoints: [path.join(webSource, "static-host.mjs")],
          outfile: path.join(web, "static-host.mjs"),
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node26",
          logLevel: "warning",
        });
      }),
      (async () => {
        const bundledResult = await timed("node-services", async () => {
          const result = await bundleNodeServices(source, services);
          await cp(
            path.join(source, "apps/node-services/prompts"),
            path.join(services, "prompts"),
            { recursive: true },
          );
          await writeFile(
            path.join(services, "package.json"),
            JSON.stringify(
              { name: "@linger/node-services", private: true, type: "module" },
              null,
              2,
            ),
          );
          return result;
        });
        const packagesResult = await timed("externals", async () => {
          const deployed = path.join(work, "deploy");
          await run(
            "pnpm",
            [
              "--filter",
              "@linger/node-services",
              "deploy",
              "--config.inject-workspace-packages=true",
              "--config.node-linker=hoisted",
              "--prod",
              // Every native package here ships prebuilt per platform.
              "--ignore-scripts",
              `--os=${platform.os}`,
              `--cpu=${platform.cpu}`,
              ...(platform.libc ? [`--libc=${platform.libc}`] : []),
              deployed,
            ],
            { cwd: source },
          );
          const builtins = new Set(builtinModules);
          const roots = new Set(RUNTIME_PACKAGES);
          for (const specifier of bundledResult.imports) {
            const name = packageName(specifier);
            if (!builtins.has(name) && !OPTIONAL_IMPORTS.has(name))
              roots.add(name);
          }
          const copied = await copyExternals(
            deployed,
            services,
            [...roots].sort(),
            modelPackageGroup,
          );
          await writeFile(
            path.join(services, "models.json"),
            JSON.stringify(
              modelPackages(
                await readFile(path.join(source, "pnpm-lock.yaml"), "utf8"),
                copied.excluded,
              ),
              null,
              2,
            ),
          );
          return copied;
        });
        return { bundled: bundledResult, packages: packagesResult };
      })(),
      timed("node", () => sharedNodeMetadata(target, work)),
    ]);
    const layout = RUNTIME_LAYOUTS[target];
    const node = downloadedNode;
    await timed("archive", async () => {
      const files = await listFiles(root);
      await writeFile(
        path.join(root, RUNTIME_FILES),
        JSON.stringify(
          {
            schema: RUNTIME_SCHEMA,
            target,
            sourceCommit: commit,
            sourceArchiveSha256,
            files,
          },
          null,
          1,
        ),
      );
      if (layout === "directory") return;
      await run("tar", [
        "--sort=name",
        "--format=posix",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mtime=@0",
        "-cf",
        path.join(work, "runtime.tar"),
        "-C",
        work,
        ROOT,
      ]);
      // zstd keeps a quarter less than gzip -9 and unpacks faster; the desktop
      // decompresses it with Node's zlib, since Windows' tar may lack zstd.
      await pipeline(
        createReadStream(path.join(work, "runtime.tar")),
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
        createWriteStream(path.join(output, RUNTIME_ARCHIVE)),
      );
    });
    await timed("report", async () => {
      const files = JSON.parse(
        await readFile(path.join(root, RUNTIME_FILES), "utf8"),
      ).files;
      const report = {
        files: Object.keys(files).length,
        bytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0),
        bundles: bundled.files,
        packages: packages.packages,
        models: packages.excluded,
      };
      await writeFile(
        path.join(output, "report.json"),
        JSON.stringify({ ...report, timings }, null, 2),
      );
    });
    let contents;
    if (layout === "directory") {
      await cp(root, path.join(output, ROOT), { recursive: true });
      const files = path.join(output, ROOT, RUNTIME_FILES);
      contents = {
        layout,
        directory: {
          file: `${ROOT}/${RUNTIME_FILES}`,
          sha256: await sha256File(files),
          bytes: (await stat(files)).size,
        },
      };
    } else {
      const archived = path.join(output, RUNTIME_ARCHIVE);
      contents = {
        layout,
        archive: {
          file: RUNTIME_ARCHIVE,
          sha256: await sha256File(archived),
          bytes: (await stat(archived)).size,
        },
      };
    }
    await writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify(
        {
          schema: RUNTIME_SCHEMA,
          target,
          sourceCommit: commit,
          sourceArchiveSha256,
          ...contents,
          node,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return verifyRuntime(output, target, sourceArchiveSha256);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--target") || !args.includes("--source"))
    throw new Error(
      "Usage: build-native-runtime.mjs --target win32-x64 --source ARCHIVE [--shipped-source ARCHIVE] [--output DIR]",
    );
  const hasShipped = args.includes("--shipped-source");
  const shippedArchive = hasShipped ? value("--shipped-source") : undefined;
  if (hasShipped && !shippedArchive)
    throw new Error("--shipped-source requires an archive path");
  console.log(
    JSON.stringify(
      await buildRuntime(
        value("--target"),
        value("--source"),
        args.includes("--output") ? path.resolve(value("--output")) : undefined,
        shippedArchive ? { shippedArchive } : undefined,
      ),
      null,
      2,
    ),
  );
}
