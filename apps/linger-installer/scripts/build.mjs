import { build } from "esbuild";
import { build as buildWeb } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? "dist");
await buildWeb({
  configFile: path.join(root, "vite.config.ts"),
  root,
  build: { outDir: path.join(output, "web") },
});
await build({
  entryPoints: [
    path.resolve(
      root,
      "../../packages/local-installation/src/native-process-worker.mjs",
    ),
  ],
  outfile: path.join(output, "native-process-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
});
await build({
  entryPoints: [
    path.resolve(
      root,
      "../../packages/local-installation/src/v2-esm-resolve.mjs",
    ),
  ],
  outfile: path.join(output, "v2-esm-resolve.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
});
await build({
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(output, "installer.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  external: ["node:*"],
  banner: { js: "#!/usr/bin/env node" },
});
