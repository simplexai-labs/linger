// Bundles Node Services (and the Voice workers it starts) with esbuild into
// the files `tsc` would write, inside `output` laid out like the package:
//
//   dist/{main,document/worker,…}.js
//   node_modules/@linger/voice-runtime/dist/{main,agent,…}.js
//
// Node Services finds its workers and prompts from its package directory
// (src/paths.ts), which each entry gets as LINGER_PACKAGE_ROOT; the Voice
// workers sit beside each other as in dist/. Packages with native code or
// files they load at runtime stay external and come from the production
// node_modules (see build-native-runtime.mjs).
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Native addons, wasm or data files these packages load beside themselves at
// runtime. Pure-JS packages (@livekit/agents, @livekit/rtc-node, jsdom,
// officeparser, word-extractor) are bundled below.
export const NODE_SERVICES_EXTERNALS = [
  "@livekit/rtc-ffi-bindings",
  "@livekit/local-inference",
  "@livekit/local-inference-*",
  "@napi-rs/canvas",
  "@napi-rs/canvas-*",
  "better-sqlite3",
  "sharp",
  "@img/*",
  "pdfjs-dist",
  // Lazy-imported by officeparser only when OCR is enabled; we always pass ocr: false.
  "tesseract.js",
  // Development only: source files register it when they run as .ts.
  "tsx",
];

const NODE_SERVICES_ENTRIES = [
  "main",
  "document/worker",
  "document/computation-worker",
  "document-normalizer/document-normalizer-worker",
];
const VOICE_ENTRIES = ["main", "agent", "recorder-agent", "live-agent"];
// Sibling entrypoints @livekit/agents forks or dynamically imports via
// `new URL("./...", import.meta.url)` at runtime.
const LIVEKIT_AGENT_SUBENTRIES = {
  job_proc_lazy_main: "dist/ipc/job_proc_lazy_main.js",
  inference_proc_lazy_main: "dist/ipc/inference_proc_lazy_main.js",
  "inference/eot/runner": "dist/inference/eot/runner.js",
};

const JSDOM_DEFAULT_STYLESHEET_RE =
  /fs\.readFileSync\(\s*path\.resolve\(\s*__dirname\s*,\s*["']\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css["']\s*\)\s*,\s*\{\s*encoding:\s*["']utf-8["']\s*\}\s*\)/;
const JSDOM_SYNC_XHR_RESOLVE_RE =
  /const syncWorkerFile\s*=\s*require\.resolve\(\s*["']\.\/xhr-sync-worker\.js["']\s*\);/;
const JSDOM_SYNC_XHR_WORKER_RE = /new Worker\(\s*syncWorkerFile\s*\)/;
const OFFICEPARSER_REQUIRE_AVAILABLE_RE =
  /function isRequireAvailable\(\)\s*\{[\s\S]*?return typeof require !== ['"]undefined['"] && typeof require\.resolve === ['"]function['"];\s*\}/;

// The package directory as a URL relative to the bundled file `outputFile`.
export const packageRootFrom = (outputFile) =>
  `${path.posix.relative(path.posix.dirname(outputFile), ".") || "."}/`;

function resolvePackageDir(fromFile, name) {
  const req = createRequire(fromFile);
  let directory = path.dirname(req.resolve(name));
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === name) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot locate package ${name} from ${fromFile}`);
    directory = parent;
  }
}

function createBundlePlugins(matched) {
  const jsdomPlugin = {
    name: "linger-bundle-jsdom",
    setup(pluginBuild) {
      pluginBuild.onLoad(
        {
          filter:
            /[/\\]jsdom[/\\]lib[/\\]jsdom[/\\]living[/\\]css[/\\]helpers[/\\]computed-style\.js$/,
        },
        async (args) => {
          const source = await readFile(args.path, "utf8");
          if (!JSDOM_DEFAULT_STYLESHEET_RE.test(source))
            throw new Error(
              `Expected default-stylesheet.css readFileSync pattern in ${args.path}`,
            );
          const cssPath = path.resolve(
            path.dirname(args.path),
            "../../../browser/default-stylesheet.css",
          );
          const cssText = await readFile(cssPath, "utf8");
          matched.add("jsdom:computed-style");
          return {
            contents: source.replace(JSDOM_DEFAULT_STYLESHEET_RE, () =>
              JSON.stringify(cssText),
            ),
            loader: "js",
          };
        },
      );

      pluginBuild.onLoad(
        {
          filter:
            /[/\\]jsdom[/\\]lib[/\\]jsdom[/\\]living[/\\]xhr[/\\]XMLHttpRequest-impl\.js$/,
        },
        async (args) => {
          const source = await readFile(args.path, "utf8");
          if (
            !JSDOM_SYNC_XHR_RESOLVE_RE.test(source) ||
            !JSDOM_SYNC_XHR_WORKER_RE.test(source)
          )
            throw new Error(`Expected sync XHR worker pattern in ${args.path}`);
          matched.add("jsdom:xhr");
          const patched = source
            .replace(JSDOM_SYNC_XHR_RESOLVE_RE, "")
            .replace(
              JSDOM_SYNC_XHR_WORKER_RE,
              '(() => { throw new Error("Synchronous XMLHttpRequest is not supported in bundled jsdom"); })()',
            );
          return { contents: patched, loader: "js" };
        },
      );

      // css-tree's ESM files load JSON via createRequire(import.meta.url),
      // which esbuild cannot inline, whereas its CJS files use static
      // require(). Redirecting to CJS also deduplicates css-tree across CJS
      // and ESM callers inside the bundle.
      pluginBuild.onResolve({ filter: /^css-tree(?:\/.*)?$/ }, (args) => {
        const from =
          args.importer || path.join(args.resolveDir, "package.json");
        const resolved = createRequire(from).resolve(args.path);
        if (/[/\\]css-tree[/\\]lib[/\\]/.test(resolved))
          throw new Error(
            `Expected CJS resolution for ${args.path}, got ${resolved}`,
          );
        matched.add("jsdom:css-tree");
        return { path: resolved };
      });

      pluginBuild.onLoad(
        {
          filter: /[/\\]css-tree[/\\]lib[/\\](?:data|data-patch|version)\.js$/,
        },
        (args) => {
          throw new Error(
            `Unexpected css-tree ESM data file in bundle: ${args.path}`,
          );
        },
      );
    },
  };

  const officeparserPlugin = {
    name: "linger-bundle-officeparser",
    setup(pluginBuild) {
      // Because our ESM banner defines `require`, officeparser's
      // isRequireAvailable() would otherwise probe node_modules with
      // require.resolve('file-type') instead of taking its bundled import()
      // fallback.
      pluginBuild.onLoad(
        {
          filter: /[/\\]officeparser[/\\]dist[/\\]utils[/\\]moduleLoader\.js$/,
        },
        async (args) => {
          const source = await readFile(args.path, "utf8");
          if (!OFFICEPARSER_REQUIRE_AVAILABLE_RE.test(source))
            throw new Error(`Expected isRequireAvailable() in ${args.path}`);
          matched.add("officeparser:module-loader");
          return {
            contents: source.replace(
              OFFICEPARSER_REQUIRE_AVAILABLE_RE,
              "function isRequireAvailable() { return false; }",
            ),
            loader: "js",
          };
        },
      );
    },
  };

  return [jsdomPlugin, officeparserPlugin];
}

function baseBuildOptions(repo, plugins, define = {}) {
  return {
    absWorkingDir: repo,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    // The source exports of workspace packages, like `tsx` in development.
    conditions: ["import", "node"],
    mainFields: ["module", "main"],
    external: NODE_SERVICES_EXTERNALS,
    plugins,
    define,
    legalComments: "none",
    minifyWhitespace: true,
    minifySyntax: true,
    metafile: true,
    logLevel: "warning",
    banner: {
      // CommonJS dependencies inside the bundle expect require, __filename and __dirname.
      js: 'import { createRequire as __lingerRequire } from "node:module"; const require = __lingerRequire(import.meta.url); const __filename = import.meta.filename; const __dirname = import.meta.dirname;',
    },
  };
}

async function bundle(repo, output, entry, outputFile, plugins, define = {}) {
  const result = await build({
    ...baseBuildOptions(repo, plugins, define),
    entryPoints: [path.join(repo, entry)],
    outfile: path.join(output, outputFile),
  });
  return result.metafile;
}

async function bundleVoiceRuntime(repo, output, plugins) {
  const agentsDir = resolvePackageDir(
    path.join(repo, "apps/voice-runtime/package.json"),
    "@livekit/agents",
  );
  const entryPoints = {};
  for (const entry of VOICE_ENTRIES)
    entryPoints[entry] = path.join(repo, `apps/voice-runtime/src/${entry}.ts`);
  for (const [name, relative] of Object.entries(LIVEKIT_AGENT_SUBENTRIES)) {
    const resolved = path.join(agentsDir, relative);
    if (!existsSync(resolved))
      throw new Error(`Missing @livekit/agents subentry: ${resolved}`);
    entryPoints[name] = resolved;
  }
  const result = await build({
    ...baseBuildOptions(repo, plugins),
    entryPoints,
    outdir: path.join(output, "node_modules/@linger/voice-runtime/dist"),
    splitting: true,
    // Keep shared chunks directly in dist/ so relative URLs such as
    // `new URL("./job_proc_lazy_main.js", import.meta.url)` and
    // `new URL("./inference/eot/runner.js", import.meta.url)` resolve cleanly
    // from any shared chunk.
    chunkNames: "[name]-[hash]",
  });
  return result.metafile;
}

export async function bundleNodeServices(repo, output) {
  const files = [];
  const inputs = new Set();
  // Bare imports the bundles left for node_modules.
  const imports = new Set();
  const matched = new Set();
  const plugins = createBundlePlugins(matched);
  const record = (metafile) => {
    for (const [file, info] of Object.entries(metafile.outputs)) {
      files.push({ file, bytes: info.bytes });
      for (const input of Object.keys(info.inputs)) inputs.add(input);
      for (const item of info.imports)
        if (item.external && !item.path.startsWith("node:"))
          imports.add(item.path);
    }
  };
  const nodeServices = (entry, outputFile) =>
    bundle(repo, output, entry, outputFile, plugins, {
      LINGER_PACKAGE_ROOT: JSON.stringify(packageRootFrom(outputFile)),
    });
  const metafiles = await Promise.all([
    ...NODE_SERVICES_ENTRIES.map((entry) =>
      nodeServices(`apps/node-services/src/${entry}.ts`, `dist/${entry}.js`),
    ),
    bundleVoiceRuntime(repo, output, plugins),
    // Waits for TeamHub and restarts the service after a crash, as in
    // development (scripts/dev-supervisor.ts --compiled).
    nodeServices(
      "apps/node-services/scripts/dev-supervisor.ts",
      "dist/supervisor.js",
    ),
  ]);
  for (const required of [
    "jsdom:computed-style",
    "jsdom:xhr",
    "jsdom:css-tree",
    "officeparser:module-loader",
  ]) {
    if (!matched.has(required))
      throw new Error(
        `Bundle rewrite ${required} did not match any input module`,
      );
  }
  for (const metafile of metafiles) record(metafile);
  const worker = "src/agent/observability/agent-log-file-worker.mjs";
  await mkdir(path.join(output, "dist/agent/observability"), {
    recursive: true,
  });
  await copyFile(
    path.join(repo, "apps/node-services", worker),
    path.join(output, "dist/agent/observability/agent-log-file-worker.mjs"),
  );
  // The worker's package exports and module type.
  await writeFile(
    path.join(output, "node_modules/@linger/voice-runtime/package.json"),
    JSON.stringify(
      {
        name: "@linger/voice-runtime",
        private: true,
        type: "module",
        exports: { "./worker": { default: "./dist/main.js" } },
      },
      null,
      2,
    ),
  );
  return { files, inputs: [...inputs], imports };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repo, output] = process.argv.slice(2);
  const result = await bundleNodeServices(
    path.resolve(repo),
    path.resolve(output),
  );
  for (const { file, bytes } of result.files)
    console.log(`${(bytes / 1e6).toFixed(2).padStart(7)} MB ${file}`);
  console.log([...result.imports].sort().join("\n"));
}
