import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, expect, it } from "vitest";

import { NODE_RUNTIME_VERSION } from "../../../../scripts/local-computer-node-distributions.mjs";
import * as buildNativeRuntimeModule from "../../scripts/build-native-runtime.mjs";
import {
  buildRuntime,
  copyExternals,
  RUNTIME_ARCHIVE,
  RUNTIME_FILES,
  RUNTIME_SCHEMA,
  verifyRuntime,
} from "../../scripts/build-native-runtime.mjs";

interface BuildNativeRuntimeExtras {
  OPTIONAL_IMPORTS: Set<string>;
  RUNTIME_PACKAGES: string[];
  unusedPackageEntry(name: string, relativePath: string): boolean;
}

const { OPTIONAL_IMPORTS, RUNTIME_PACKAGES, unusedPackageEntry } =
  buildNativeRuntimeModule as unknown as BuildNativeRuntimeExtras;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// A hoisted node_modules as `pnpm deploy --config.node-linker=hoisted` writes
// it, with officeparser and the dependencies its 8.2.0 manifest declares.
const deployed = () => {
  const root = mkdtempSync(path.join(tmpdir(), "build-native-runtime-"));
  roots.push(root);
  const add = (name: string, dependencies: Record<string, string> = {}) => {
    const directory = path.join(root, "deploy/node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name, version: "1.0.0", dependencies }),
    );
    writeFileSync(path.join(directory, "index.js"), "");
  };
  add("officeparser", { "pdfjs-dist": "1", "tesseract.js": "1" });
  add("pdfjs-dist");
  add("tesseract.js", { "tesseract.js-core": "1", "node-fetch": "1" });
  add("tesseract.js-core");
  add("node-fetch");
  return root;
};

it("leaves out the OCR engine officeparser only loads with OCR on", async () => {
  const root = deployed();
  const output = path.join(root, "output");
  const result = await copyExternals(path.join(root, "deploy"), output, [
    "officeparser",
  ]);
  expect(result.packages.map((item) => item.package).sort()).toEqual([
    "node_modules/officeparser",
    "node_modules/pdfjs-dist",
  ]);
  expect(result.excluded).toEqual({});
  expect(existsSync(path.join(output, "node_modules/officeparser"))).toBe(true);
  for (const name of ["tesseract.js", "tesseract.js-core", "node-fetch"])
    expect(existsSync(path.join(output, "node_modules", name))).toBe(false);
});

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

it("verifies archive and directory runtimes with shared node metadata and rejects tampered shared fields", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "build-native-runtime-verify-"));
  roots.push(root);
  const sourceSha = "a".repeat(64);
  const nodeSha = "b".repeat(64);

  // Windows archive layout with shared node.exe (no duplicate archive in runtime-win32-x64/).
  const winDir = path.join(root, "runtime-win32-x64");
  mkdirSync(winDir, { recursive: true });
  const archiveBytes = Buffer.from("zstd-runtime");
  writeFileSync(path.join(winDir, RUNTIME_ARCHIVE), archiveBytes);
  const writeWinManifest = (node: Record<string, unknown>) =>
    writeFileSync(
      path.join(winDir, "manifest.json"),
      JSON.stringify({
        schema: RUNTIME_SCHEMA,
        target: "win32-x64",
        sourceArchiveSha256: sourceSha,
        layout: "archive",
        archive: {
          file: RUNTIME_ARCHIVE,
          sha256: sha256(archiveBytes),
          bytes: archiveBytes.length,
        },
        node,
      }),
    );

  writeWinManifest({
    version: NODE_RUNTIME_VERSION,
    shared: true,
    binary: "runtime/bin/node.exe",
    sha256: nodeSha,
    bytes: 123_456,
  });
  await expect(
    verifyRuntime(winDir, "win32-x64", sourceSha),
  ).resolves.toMatchObject({
    target: "win32-x64",
    node: { shared: true, binary: "runtime/bin/node.exe" },
  });

  for (const badNode of [
    {
      version: "0.0.0",
      shared: true,
      binary: "runtime/bin/node.exe",
      sha256: nodeSha,
      bytes: 123_456,
    },
    {
      version: NODE_RUNTIME_VERSION,
      shared: true,
      binary: "runtime/bin/node",
      sha256: nodeSha,
      bytes: 123_456,
    },
    {
      version: NODE_RUNTIME_VERSION,
      shared: true,
      binary: "runtime/bin/node.exe",
      sha256: "not-a-hex-digest",
      bytes: 123_456,
    },
    {
      version: NODE_RUNTIME_VERSION,
      shared: true,
      binary: "runtime/bin/node.exe",
      sha256: nodeSha,
      bytes: 0,
    },
    {
      version: NODE_RUNTIME_VERSION,
      shared: true,
      binary: "runtime/bin/node.exe",
      sha256: nodeSha,
      bytes: 12.5,
    },
  ]) {
    writeWinManifest(badNode);
    await expect(verifyRuntime(winDir, "win32-x64", sourceSha)).rejects.toThrow(
      "invalid shared node metadata",
    );
  }

  // macOS directory layout with shared node binary (no runtime-darwin-arm64/node/ copy).
  const macDir = path.join(root, "runtime-darwin-arm64");
  const macRuntime = path.join(macDir, "runtime");
  mkdirSync(macRuntime, { recursive: true });
  const script = Buffer.from("export const ok = true;\n");
  writeFileSync(path.join(macRuntime, "index.js"), script);
  const filesJson = Buffer.from(
    JSON.stringify({
      schema: RUNTIME_SCHEMA,
      target: "darwin-arm64",
      sourceArchiveSha256: sourceSha,
      files: {
        "index.js": { bytes: script.length, sha256: sha256(script) },
      },
    }),
  );
  writeFileSync(path.join(macRuntime, RUNTIME_FILES), filesJson);
  writeFileSync(
    path.join(macDir, "manifest.json"),
    JSON.stringify({
      schema: RUNTIME_SCHEMA,
      target: "darwin-arm64",
      sourceArchiveSha256: sourceSha,
      layout: "directory",
      directory: {
        file: `runtime/${RUNTIME_FILES}`,
        sha256: sha256(filesJson),
        bytes: filesJson.length,
      },
      node: {
        version: NODE_RUNTIME_VERSION,
        shared: true,
        binary: "runtime/bin/node",
        sha256: nodeSha,
        bytes: 456_789,
      },
    }),
  );
  await expect(
    verifyRuntime(macDir, "darwin-arm64", sourceSha),
  ).resolves.toMatchObject({
    target: "darwin-arm64",
    node: { shared: true, binary: "runtime/bin/node" },
  });

  // Legacy non-shared node manifest still verifies the local file inside runtime-<target>/.
  const legacyNode = Buffer.from("legacy-node");
  mkdirSync(path.join(macDir, "node", "bin"), { recursive: true });
  writeFileSync(path.join(macDir, "node", "bin", "node"), legacyNode);
  writeFileSync(
    path.join(macDir, "manifest.json"),
    JSON.stringify({
      schema: RUNTIME_SCHEMA,
      target: "darwin-arm64",
      sourceArchiveSha256: sourceSha,
      layout: "directory",
      directory: {
        file: `runtime/${RUNTIME_FILES}`,
        sha256: sha256(filesJson),
        bytes: filesJson.length,
      },
      node: {
        version: NODE_RUNTIME_VERSION,
        file: "node/bin/node",
        sha256: sha256(legacyNode),
        bytes: legacyNode.length,
      },
    }),
  );
  await expect(
    verifyRuntime(macDir, "darwin-arm64", sourceSha),
  ).resolves.toMatchObject({
    node: { file: "node/bin/node" },
  });
});

it("refuses a shipped archive from another commit before touching output", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "build-native-runtime-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const archive = (file: string, ref: string) => {
    const tar = execFileSync("git", [
      "-C",
      repo,
      "archive",
      "--format=tar",
      "--prefix=linger-test/",
      ref,
    ]);
    writeFileSync(file, gzipSync(tar));
  };
  writeFileSync(path.join(repo, "package.json"), '{"name":"linger"}\n');
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "first",
  );
  const firstArchive = path.join(root, "first.tar.gz");
  archive(firstArchive, "HEAD");
  const treeArchive = path.join(root, "tree.tar.gz");
  archive(treeArchive, "HEAD^{tree}");

  writeFileSync(path.join(repo, "README.md"), "second\n");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "second",
  );
  const secondArchive = path.join(root, "second.tar.gz");
  archive(secondArchive, "HEAD");

  const output = path.join(root, "existing-output");
  mkdirSync(output, { recursive: true });
  const sentinel = path.join(output, "sentinel.txt");
  writeFileSync(sentinel, "keep");

  await expect(
    buildRuntime("win32-x64", firstArchive, output, {
      shippedArchive: secondArchive,
    }),
  ).rejects.toThrow(
    /Shipped source archive commit .* does not match build source archive/,
  );
  expect(existsSync(sentinel)).toBe(true);

  await expect(
    buildRuntime("win32-x64", firstArchive, output, {
      shippedArchive: treeArchive,
    }),
  ).rejects.toThrow("does not record its commit");
  expect(existsSync(sentinel)).toBe(true);
});

it("prunes unused browser viewer and non-legacy subtrees from pdfjs-dist", async () => {
  expect(unusedPackageEntry("pdfjs-dist", "build")).toBe(true);
  expect(unusedPackageEntry("pdfjs-dist", "build/pdf.mjs")).toBe(true);
  expect(unusedPackageEntry("pdfjs-dist", "web")).toBe(true);
  expect(unusedPackageEntry("pdfjs-dist", "web/viewer.mjs")).toBe(true);
  expect(unusedPackageEntry("pdfjs-dist", "legacy/web")).toBe(true);
  expect(unusedPackageEntry("pdfjs-dist", "legacy/web/viewer.mjs")).toBe(true);
  expect(unusedPackageEntry("pdfjs-dist", "types")).toBe(true);
  expect(unusedPackageEntry("pdfjs-dist", "types/src/pdf.d.ts")).toBe(true);
  expect(unusedPackageEntry("pdfjs-dist", "legacy/build/pdf.mjs")).toBe(false);
  expect(unusedPackageEntry("pdfjs-dist", "cmaps/Adobe-GB1-UCS2.bcmap")).toBe(
    false,
  );
  expect(unusedPackageEntry("pdfjs-dist", "standard_fonts/Helvetica.pfb")).toBe(
    false,
  );
  expect(unusedPackageEntry("pdfjs-dist", "wasm/openjpeg.wasm")).toBe(false);
  expect(unusedPackageEntry("other-package", "build/index.js")).toBe(false);
  expect(unusedPackageEntry("other-package", "web/viewer.mjs")).toBe(false);

  const root = mkdtempSync(path.join(tmpdir(), "build-native-runtime-pdfjs-"));
  roots.push(root);
  const pkgDir = path.join(root, "deploy/node_modules/pdfjs-dist");
  const write = (rel: string, content = "") => {
    const file = path.join(pkgDir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write(
    "package.json",
    JSON.stringify({ name: "pdfjs-dist", version: "6.2.108" }),
  );
  write("LICENSE", "Apache-2.0");
  write("README.md", "# pdfjs-dist");
  write("legacy/build/pdf.mjs", "export const getDocument = () => {};");
  write("legacy/build/pdf.mjs.map", "{}");
  write("legacy/build/pdf.worker.mjs", "export const worker = true;");
  write("cmaps/Adobe-GB1-UCS2.bcmap", "cmap");
  write("standard_fonts/Helvetica.pfb", "font");
  write("wasm/openjpeg.wasm", "wasm");
  write("iccs/CGATS001Compat-v2-micro.icc", "icc");
  write("image_decoders/pdf.image_decoders.mjs", "export {};");
  write("build/pdf.mjs", "browser-only");
  write("web/viewer.mjs", "browser-viewer");
  write("legacy/web/viewer.mjs", "legacy-viewer");
  write("types/src/pdf.d.ts", "export {};");

  const output = path.join(root, "output");
  await copyExternals(path.join(root, "deploy"), output, ["pdfjs-dist"]);

  const outPkg = path.join(output, "node_modules/pdfjs-dist");
  for (const kept of [
    "package.json",
    "LICENSE",
    "legacy/build/pdf.mjs",
    "legacy/build/pdf.worker.mjs",
    "cmaps/Adobe-GB1-UCS2.bcmap",
    "standard_fonts/Helvetica.pfb",
    "wasm/openjpeg.wasm",
    "iccs/CGATS001Compat-v2-micro.icc",
    "image_decoders/pdf.image_decoders.mjs",
  ]) {
    expect(existsSync(path.join(outPkg, kept))).toBe(true);
  }
  for (const dropped of [
    "build",
    "web",
    "legacy/web",
    "types",
    "legacy/build/pdf.mjs.map",
    "README.md",
  ]) {
    expect(existsSync(path.join(outPkg, dropped))).toBe(false);
  }
});

it("copies native voice packages and ignores optional OCR and canvas imports", () => {
  expect(RUNTIME_PACKAGES).toEqual([
    "@livekit/local-inference",
    "sherpa-onnx-node",
  ]);
  expect(OPTIONAL_IMPORTS.has("tesseract.js")).toBe(true);
  expect(OPTIONAL_IMPORTS.has("canvas")).toBe(true);
});
