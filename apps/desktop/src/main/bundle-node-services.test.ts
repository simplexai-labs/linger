import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as buildNativeRuntimeModule from "../../scripts/build-native-runtime.mjs";
import { copyExternals } from "../../scripts/build-native-runtime.mjs";
// @ts-expect-error bundle-node-services.mjs has no sibling .d.mts declaration file.
import { bundleNodeServices as rawBundleNodeServices } from "../../scripts/bundle-node-services.mjs";

interface BuildNativeRuntimeExtras {
  modelPackageGroup(name: string): string | undefined;
  OPTIONAL_IMPORTS: Set<string>;
  RUNTIME_PACKAGES: string[];
}

interface BundleNodeServicesResult {
  files: Array<{ file: string; bytes: number }>;
  inputs: string[];
  imports: Set<string>;
}

const { modelPackageGroup, OPTIONAL_IMPORTS, RUNTIME_PACKAGES } =
  buildNativeRuntimeModule as unknown as BuildNativeRuntimeExtras;

const bundleNodeServices = rawBundleNodeServices as (
  repo: string,
  output: string,
) => Promise<BundleNodeServicesResult>;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const SAMPLE_DOC_PATH = path.join(
  REPO_ROOT,
  "apps/node-services/tests/document-normalizer/fixtures/sample.doc",
);

interface BundleFixture {
  workDir: string;
  servicesDir: string;
  imports: Set<string>;
  copiedPackages: Array<{ package: string; version: string }>;
  excludedModels: Record<string, string>;
}

const packageNameFromSpecifier = (specifier: string): string =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

function findPackageDir(fromFile: string, name: string): string | undefined {
  for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
  }
}

// Materializes a real hoisted node_modules directory from the workspace's
// installed packages so copyExternals exercises its real dependency traversal,
// model exclusion, and pdfjs-dist pruning without running a full pnpm deploy.
function hoistWorkspacePackages(
  repoRoot: string,
  roots: string[],
  deployedDir: string,
): void {
  const voicePkg = path.join(repoRoot, "apps/voice-runtime/package.json");
  const entryManifests = [
    path.join(repoRoot, "apps/node-services/package.json"),
    voicePkg,
    path.join(repoRoot, "package.json"),
  ];
  for (const parentPkg of ["@livekit/agents", "@livekit/rtc-node"]) {
    const dir = findPackageDir(voicePkg, parentPkg);
    if (dir) entryManifests.push(path.join(dir, "package.json"));
  }
  const visited = new Set<string>();

  const hoist = (name: string, fromFiles: string[], required: boolean) => {
    if (visited.has(name)) return;
    let sourceDir: string | undefined;
    for (const fromFile of fromFiles) {
      sourceDir = findPackageDir(fromFile, name);
      if (sourceDir) break;
    }
    if (!sourceDir) {
      if (required) {
        throw new Error(
          `Cannot resolve ${name} from ${fromFiles.join(", ")} in workspace`,
        );
      }
      return;
    }
    visited.add(name);
    const destDir = path.join(deployedDir, "node_modules", name);
    mkdirSync(path.dirname(destDir), { recursive: true });
    cpSync(sourceDir, destDir, {
      recursive: true,
      dereference: true,
      filter: (file) =>
        !path
          .relative(sourceDir, file)
          .split(path.sep)
          .includes("node_modules"),
    });
    const manifestPath = path.join(sourceDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const nextFrom = [manifestPath, ...entryManifests];
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      hoist(dep, nextFrom, true);
    }
    for (const dep of Object.keys({
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      hoist(dep, nextFrom, false);
    }
  };

  for (const root of roots) {
    hoist(root, entryManifests, true);
  }
}

function countFiles(directory: string): number {
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const info = lstatSync(full);
      if (info.isDirectory()) walk(full);
      else count += 1;
    }
  };
  walk(directory);
  return count;
}

function minimalPdfBuffer(text = "PDF text layer"): Uint8Array {
  const escaped = text.replace(/[\\()]/gu, "\\$&");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function minimalDocxBuffer(): Uint8Array {
  const entries = [
    {
      name: "[Content_Types].xml",
      value: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      value: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    {
      name: "word/document.xml",
      value: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Cafe\u0301</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second line</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`,
    },
  ];
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const value = Buffer.from(entry.value, "utf8");
    const crc = crc32(value);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(value.byteLength, 18);
    localHeader.writeUInt32LE(value.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localParts.push(localHeader, name, value);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(value.byteLength, 20);
    centralHeader.writeUInt32LE(value.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.byteLength + name.byteLength + value.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.byteLength, 12);
  endOfCentralDirectory.writeUInt32LE(localOffset, 16);
  return Buffer.concat([
    ...localParts,
    centralDirectory,
    endOfCentralDirectory,
  ]);
}

// Strips pnpm's NODE_PATH shim so workers and child processes in the isolated
// temp directory can never resolve packages from the workspace node_modules.
function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_PATH;
  return env;
}

async function runNormalizerWorker(
  workerPath: string,
  request: {
    filename?: string;
    mediaType: string;
    source: Uint8Array;
  },
): Promise<{ ok: true; markdown: string } | { ok: false; code: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { env: isolatedEnv() });
    const copy = new ArrayBuffer(request.source.byteLength);
    new Uint8Array(copy).set(request.source);
    let settled = false;
    worker.once(
      "message",
      (reply: { ok: boolean; markdown?: ArrayBuffer; code?: string }) => {
        settled = true;
        if (reply.ok && reply.markdown) {
          resolve({
            ok: true,
            markdown: new TextDecoder().decode(new Uint8Array(reply.markdown)),
          });
        } else {
          resolve({ ok: false, code: reply.code ?? "UNKNOWN" });
        }
      },
    );
    worker.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    worker.once("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Normalizer worker exited with code ${code}`));
      }
    });
    worker.postMessage(
      {
        filename: request.filename,
        mediaType: request.mediaType,
        source: copy,
      },
      [copy],
    );
  });
}

describe("bundleNodeServices isolated runtime verification", () => {
  let fixture: BundleFixture;

  beforeAll(async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "bundle-node-services-"));
    // Must live outside the repository so Node cannot fall back to workspace node_modules.
    expect(path.relative(REPO_ROOT, workDir).startsWith("..")).toBe(true);
    const servicesDir = path.join(workDir, "node-services");
    const deployedDir = path.join(workDir, "deploy");
    mkdirSync(servicesDir, { recursive: true });
    mkdirSync(deployedDir, { recursive: true });

    const bundled = await bundleNodeServices(REPO_ROOT, servicesDir);
    writeFileSync(
      path.join(servicesDir, "package.json"),
      JSON.stringify(
        { name: "@linger/node-services", private: true, type: "module" },
        null,
        2,
      ),
    );

    const builtins = new Set(builtinModules);
    const roots = new Set<string>(RUNTIME_PACKAGES);
    for (const specifier of bundled.imports) {
      const name = packageNameFromSpecifier(specifier);
      if (!builtins.has(name) && !OPTIONAL_IMPORTS.has(name)) {
        roots.add(name);
      }
    }

    hoistWorkspacePackages(REPO_ROOT, [...roots].sort(), deployedDir);
    const copied = await copyExternals(
      deployedDir,
      servicesDir,
      [...roots].sort(),
      modelPackageGroup,
    );

    fixture = {
      workDir,
      servicesDir,
      imports: bundled.imports,
      copiedPackages: copied.packages,
      excludedModels: copied.excluded,
    };
  }, 60_000);

  afterAll(() => {
    if (fixture?.workDir) {
      rmSync(fixture.workDir, { recursive: true, force: true });
    }
  });

  it("excludes bundled packages from external imports and keeps node_modules under 600 files", () => {
    const barePackages = new Set(
      [...fixture.imports].map(packageNameFromSpecifier),
    );
    for (const bundled of [
      "jsdom",
      "css-tree",
      "officeparser",
      "word-extractor",
      "@livekit/agents",
      "@livekit/rtc-node",
    ]) {
      expect(barePackages.has(bundled)).toBe(false);
      expect(
        existsSync(path.join(fixture.servicesDir, "node_modules", bundled)),
      ).toBe(false);
    }

    expect(barePackages.has("@livekit/rtc-ffi-bindings")).toBe(true);
    expect(barePackages.has("pdfjs-dist")).toBe(true);
    expect(
      existsSync(
        path.join(
          fixture.servicesDir,
          "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
        ),
      ),
    ).toBe(true);
    for (const pruned of ["build", "web", "legacy/web", "types"]) {
      expect(
        existsSync(
          path.join(fixture.servicesDir, "node_modules/pdfjs-dist", pruned),
        ),
      ).toBe(false);
    }

    const totalNodeModulesFiles = countFiles(
      path.join(fixture.servicesDir, "node_modules"),
    );
    expect(totalNodeModulesFiles).toBeLessThan(600);
  });

  it("runs bundled jsdom with default-stylesheet CSS, css-tree, getComputedStyle and DOMParser without external jsdom", async () => {
    const probePath = path.join(fixture.workDir, "verify-dom-worker.mjs");
    const workerUrl = pathToFileURL(
      path.join(fixture.servicesDir, "dist/document/computation-worker.js"),
    ).href;
    writeFileSync(
      probePath,
      [
        'import { parentPort } from "node:worker_threads";',
        `await import(${JSON.stringify(workerUrl)});`,
        'const style = document.createElement("style");',
        'style.textContent = ".probe { color: rgb(255, 0, 0); display: block; }";',
        "document.head.appendChild(style);",
        'const el = document.createElement("div");',
        'el.className = "probe";',
        'el.textContent = "hello";',
        "document.body.appendChild(el);",
        "const computed = window.getComputedStyle(el);",
        'const parsed = new DOMParser().parseFromString("<p id=\\"x\\">parsed</p>", "text/html");',
        "let syncXhrError = null;",
        "try {",
        "  const xhr = new window.XMLHttpRequest();",
        '  xhr.open("GET", "http://document-runtime.internal/test", false);',
        "  xhr.send();",
        "} catch (err) {",
        "  syncXhrError = err instanceof Error ? err.message : String(err);",
        "}",
        "parentPort.postMessage({",
        '  queriedText: document.querySelector(".probe")?.textContent,',
        "  computedColor: computed.color,",
        "  computedDisplay: computed.display,",
        '  parsedText: parsed.querySelector("#x")?.textContent,',
        "  syncXhrError,",
        "});",
        "parentPort.close();",
      ].join("\n"),
    );

    const result = await new Promise<{
      queriedText: string | null;
      computedColor: string;
      computedDisplay: string;
      parsedText: string | null;
      syncXhrError: string | null;
    }>((resolve, reject) => {
      const worker = new Worker(probePath, { env: isolatedEnv() });
      let settled = false;
      worker.once("message", (msg) => {
        settled = true;
        resolve(msg);
      });
      worker.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      worker.once("exit", (code) => {
        if (!settled) {
          settled = true;
          reject(new Error(`DOM probe worker exited with code ${code}`));
        }
      });
    });

    expect(result.queriedText).toBe("hello");
    expect(result.computedColor).toBe("rgb(255, 0, 0)");
    expect(result.computedDisplay).toBe("block");
    expect(result.parsedText).toBe("parsed");
    expect(result.syncXhrError).toContain("Synchronous XMLHttpRequest");
  }, 30_000);

  it("extracts PDF, DOCX and legacy DOC through the bundled document-normalizer worker", async () => {
    const workerPath = path.join(
      fixture.servicesDir,
      "dist/document-normalizer/document-normalizer-worker.js",
    );

    const pdf = await runNormalizerWorker(workerPath, {
      filename: "sample.pdf",
      mediaType: "application/pdf",
      source: minimalPdfBuffer("Bundled PDF text layer"),
    });
    expect(pdf).toEqual({
      ok: true,
      markdown: "Bundled PDF text layer\n",
    });

    const docx = await runNormalizerWorker(workerPath, {
      filename: "sample.docx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: minimalDocxBuffer(),
    });
    expect(docx).toEqual({
      ok: true,
      markdown: "**Caf\u00e9**\n\nSecond line\n",
    });

    const doc = await runNormalizerWorker(workerPath, {
      filename: "sample.doc",
      mediaType: "application/msword",
      source: readFileSync(SAMPLE_DOC_PATH),
    });
    expect(doc.ok).toBe(true);
    if (doc.ok) {
      expect(doc.markdown).toContain("SimplexAI Office Preview");
    }

    const invalidDoc = await runNormalizerWorker(workerPath, {
      filename: "bad.doc",
      mediaType: "application/msword",
      source: Buffer.from("not-an-ole-document"),
    });
    expect(invalidDoc).toEqual({
      ok: false,
      code: "DOCUMENT_SOURCE_INVALID",
    });
  }, 30_000);

  it("bundles all @linger/voice-runtime entries and @livekit/agents subentries with working native bindings", () => {
    const voiceDist = path.join(
      fixture.servicesDir,
      "node_modules/@linger/voice-runtime/dist",
    );
    const expectedEntries = [
      "main.js",
      "agent.js",
      "recorder-agent.js",
      "live-agent.js",
      "job_proc_lazy_main.js",
      "inference_proc_lazy_main.js",
      "inference/eot/runner.js",
    ];
    for (const rel of expectedEntries) {
      expect(existsSync(path.join(voiceDist, rel))).toBe(true);
    }

    // Verify shared chunks referencing job_proc_lazy_main / inference_proc_lazy_main
    // live directly in dist/ so `new URL("./...", import.meta.url)` resolves to the
    // bundled subentry files.
    const topLevelFiles = readdirSync(voiceDist).filter((name) =>
      name.endsWith(".js"),
    );
    const jobProcReferrer = topLevelFiles.find((name) =>
      readFileSync(path.join(voiceDist, name), "utf8").includes(
        "job_proc_lazy_main",
      ),
    );
    const inferenceProcReferrer = topLevelFiles.find((name) =>
      readFileSync(path.join(voiceDist, name), "utf8").includes(
        "inference_proc_lazy_main",
      ),
    );
    expect(jobProcReferrer).toBeDefined();
    expect(inferenceProcReferrer).toBeDefined();
    const jobUrl = new URL(
      "./job_proc_lazy_main.js",
      pathToFileURL(path.join(voiceDist, jobProcReferrer!)),
    );
    const inferenceUrl = new URL(
      "./inference_proc_lazy_main.js",
      pathToFileURL(path.join(voiceDist, inferenceProcReferrer!)),
    );
    expect(existsSync(fileURLToPath(jobUrl))).toBe(true);
    expect(existsSync(fileURLToPath(inferenceUrl))).toBe(true);

    // Load all 7 bundled voice-runtime modules inside an isolated child process
    // outside the repository, confirming native @livekit/rtc-ffi-bindings loads.
    const probePath = path.join(fixture.workDir, "verify-voice-runtime.mjs");
    writeFileSync(
      probePath,
      [
        'import { createRequire } from "node:module";',
        'import { pathToFileURL } from "node:url";',
        'import path from "node:path";',
        `const voiceDist = ${JSON.stringify(voiceDist)};`,
        "const load = (rel) => import(pathToFileURL(path.join(voiceDist, rel)).href);",
        'await load("main.js");',
        'const agent = await load("agent.js");',
        'const recorder = await load("recorder-agent.js");',
        'const live = await load("live-agent.js");',
        'await load("job_proc_lazy_main.js");',
        'await load("inference_proc_lazy_main.js");',
        'const runner = await load("inference/eot/runner.js");',
        'const req = createRequire(path.join(voiceDist, "main.js"));',
        'const ffiPath = req.resolve("@livekit/rtc-ffi-bindings");',
        'const ffi = req("@livekit/rtc-ffi-bindings");',
        "console.log(JSON.stringify({",
        "  agentEntry: typeof agent.default?.entry,",
        "  recorderEntry: typeof recorder.default?.entry,",
        "  liveEntry: typeof live.default?.entry,",
        "  runnerDefault: typeof runner.default,",
        "  runnerMethod: runner.EOT_INFERENCE_METHOD,",
        "  ffiPath,",
        '  ffiHasFfiRequest: typeof ffi.FfiRequest === "function",',
        "}));",
        "process.exit(0);",
      ].join("\n"),
    );

    const stdout = execFileSync(process.execPath, [probePath], {
      cwd: fixture.servicesDir,
      encoding: "utf8",
      env: isolatedEnv({
        TEAMHUB_BASE_URL: "http://127.0.0.1:8080",
        LINGER_SECRET_SEED: "test-secret-seed-for-bundle-verification",
        // Exercises fluent-ffmpeg's setFfmpegPath / __dirname path at import time.
        LIVEKIT_FFMPEG_PATH: "/nonexistent/ffmpeg",
      }),
    }).trim();

    const parsed = JSON.parse(stdout) as {
      agentEntry: string;
      recorderEntry: string;
      liveEntry: string;
      runnerDefault: string;
      runnerMethod: string;
      ffiPath: string;
      ffiHasFfiRequest: boolean;
    };
    expect(parsed.agentEntry).toBe("function");
    expect(parsed.recorderEntry).toBe("function");
    expect(parsed.liveEntry).toBe("function");
    expect(parsed.runnerDefault).toBe("function");
    expect(parsed.runnerMethod).toBe("lk_eot_audio");
    expect(parsed.ffiPath.startsWith(fixture.servicesDir)).toBe(true);
    expect(parsed.ffiHasFfiRequest).toBe(true);
  }, 30_000);
});
