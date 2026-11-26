// Builds the offline file viewer (viewer/main.ts) into one self-contained
// HTML file, assets/viewer/viewer.html, which the app ships as an asset and
// opens in a WebView. EAS runs this after installing dependencies
// (eas-build-post-install); run `pnpm viewer:build` before `expo start`.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(app, "assets", "viewer", "viewer.html");

const result = await build({
  entryPoints: [join(app, "viewer", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  // iOS 15.1 is the app's floor; WebKit there runs ES2022 and module workers.
  target: ["safari15", "chrome100"],
  minify: true,
  write: false,
  legalComments: "none",
  loader: { ".css": "text" },
  // Debug-only requires inside a PSD parser that open-file-viewer bundles.
  external: ["util"],
  // The pdf.js worker ships as text and starts from a blob: URL.
  plugins: [
    {
      name: "text-worker",
      setup(builder) {
        builder.onResolve({ filter: /pdf\.worker\.min\.mjs$/ }, (args) => ({
          path: join(
            app,
            "node_modules",
            "pdfjs-dist",
            "build",
            args.path.split("/").pop(),
          ),
          namespace: "worker-text",
        }));
        builder.onLoad(
          { filter: /.*/, namespace: "worker-text" },
          async (args) => ({
            contents: await (
              await import("node:fs/promises")
            ).readFile(args.path, "utf8"),
            loader: "text",
          }),
        );
      },
    },
  ],
});

// A </script> inside the bundle would end the inline script early.
const script = result.outputFiles[0].text.replaceAll("</script", "<\\/script");

// file: and data: and blob: only: the page and the file it shows never reach
// the network. 'unsafe-eval' stays off; pdf.js falls back without it.
const policy = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "worker-src blob:",
  "style-src 'unsafe-inline'",
  "img-src file: data: blob:",
  "media-src file: data: blob:",
  "font-src file: data: blob:",
  "connect-src file: data: blob:",
  "frame-src about: data:",
].join("; ");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes">
<style>
  html, body { margin: 0; background: #f7f7f5; color: #1f1f1d; -webkit-text-size-adjust: 100%; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; }
  #root.fill { position: fixed; inset: 0; }
  #root.fill iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  #root.pages { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
  #root.pages canvas { width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  #root.table { overflow: auto; }
  #root.table table { border-collapse: collapse; font-size: 13px; background: #fff; }
  #root.table th, #root.table td { border: 1px solid #e3e3df; padding: 6px 8px; white-space: nowrap; text-align: left; }
  #root.table th { position: sticky; top: 0; background: #f0f0ec; }
  #root.diagram { padding: 16px; }
  #root.diagram svg { max-width: 100%; height: auto; }
  #root.image { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  #root.image img, #root.image video { max-width: 100%; max-height: 100vh; }
  #root.text pre { margin: 0; padding: 16px; white-space: pre-wrap; word-break: break-word; font: 13px/1.5 ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">${script}</script>
</body>
</html>
`;

await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(`viewer: ${output} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);
