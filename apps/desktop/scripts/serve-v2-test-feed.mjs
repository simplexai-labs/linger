#!/usr/bin/env node
// Zero-dependency local/LAN test feed server for Linger V2 signed per-service
// upgrade packs. Serves the exact CI-signed `app-manifest.json` + `.sig` bytes
// without modification so Ed25519 signature verification stays 100% intact,
// and lets testers switch between step-00..step-04 live via Web UI, HTTP API,
// or interactive terminal commands.
//
// Usage:
//   node serve-test-feed.mjs [--step 00] [--port 8787] [--host 127.0.0.1]
//   node serve-test-feed.mjs --https [--host 0.0.0.0] [--port 8443]
//   node serve-test-feed.mjs --https --cert ./cert.pem --key ./key.pem
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function detectLanIPv4s() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        ips.push(entry.address);
      }
    }
  }
  return [...new Set(ips)].sort();
}

function generateSelfSignedCert(extraIps = []) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "linger-feed-tls-"));
  const keyPath = path.join(tempDir, "key.pem");
  const certPath = path.join(tempDir, "cert.pem");
  const sanEntries = [
    "DNS:localhost",
    "IP:127.0.0.1",
    "IP:::1",
    ...extraIps.map((ip) => `IP:${ip}`),
  ].join(",");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "30",
      "-nodes",
      "-subj",
      "/CN=Linger V2 Local Test Feed",
      "-addext",
      `subjectAltName=${sanEntries}`,
    ],
    { stdio: "ignore" },
  );
  return {
    tempDir,
    keyPath,
    certPath,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    cleanup() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function loadTestKitIndex(rootDir) {
  const indexPath = path.join(rootDir, "manifest-index.json");
  if (!existsSync(indexPath)) {
    throw new Error(`manifest-index.json not found in ${rootDir}`);
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!Array.isArray(index.steps) || index.steps.length === 0) {
    throw new Error(`manifest-index.json in ${rootDir} has no steps`);
  }
  return index;
}

export function resolveStepEntry(steps, selector) {
  if (!selector) return steps[0];
  const raw = String(selector).trim().toLowerCase();
  const padded = /^\d+$/.test(raw) ? raw.padStart(2, "0") : raw;
  return (
    steps.find((s) => s.id.toLowerCase() === raw) ??
    steps.find((s) => s.id.toLowerCase().startsWith(`step-${padded}`)) ??
    steps.find((s) => s.appVersion.toLowerCase() === raw)
  );
}

function renderDashboardHtml({ feedUrl, index, activeStep, downloadHistory }) {
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const isHttp = feedUrl.startsWith("http://");
  const rows = index.steps
    .map((step) => {
      const isActive = step.id === activeStep.id;
      const changed = step.changedModules.join(", ");
      return `<tr class="${isActive ? "active" : ""}">
        <td><strong>${esc(step.id)}</strong>${isActive ? ' <span class="badge">ACTIVE</span>' : ""}</td>
        <td><code>${esc(step.appVersion)}</code></td>
        <td><code>${esc(changed)}</code></td>
        <td>${esc(step.updateBehavior)}</td>
        <td>${step.rollbackSafe === false ? '<span class="warn">rollbackSafe:false</span>' : "safe"}</td>
        <td><button onclick="switchStep('${esc(step.id)}')" ${isActive ? "disabled" : ""}>${isActive ? "Serving" : "Activate"}</button></td>
      </tr>`;
    })
    .join("\n");

  const logs = downloadHistory
    .slice(-40)
    .reverse()
    .map(
      (item) =>
        `<tr><td>${esc(item.at)}</td><td><code>${esc(item.stepId)}</code></td><td><code>${esc(item.path)}</code></td><td>${esc(item.status)}</td><td>${esc(item.size ? formatBytes(item.size) : "-")}</td></tr>`,
    )
    .join("\n");

  const envLoopback = isHttp ? "LINGER_ALLOW_LOOPBACK_TEST_FEED=1 " : "";
  const winLoopback = isHttp
    ? '$env:LINGER_ALLOW_LOOPBACK_TEST_FEED="1"; '
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Linger V2 Signed Test Feed Control Panel</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; background: #0f172a; color: #e2e8f0; }
    h1, h2 { margin: 0 0 12px; }
    .meta { background: #1e293b; padding: 14px 18px; border-radius: 10px; margin-bottom: 18px; border: 1px solid #334155; }
    code, pre { background: #020617; padding: 2px 6px; border-radius: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #93c5fd; }
    pre { padding: 12px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; background: #1e293b; border-radius: 10px; overflow: hidden; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; font-size: 13px; }
    tr.active { background: #172554; }
    .badge { background: #22c55e; color: #052e16; font-size: 11px; padding: 2px 7px; border-radius: 999px; margin-left: 6px; font-weight: 700; }
    .warn { background: #f59e0b; color: #451a03; font-size: 11px; padding: 2px 7px; border-radius: 999px; font-weight: 700; }
    button { background: #3b82f6; color: #fff; border: 0; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-weight: 600; }
    button:disabled { background: #475569; cursor: default; }
  </style>
</head>
<body>
  <h1>Linger V2 Signed Test Feed</h1>
  <div class="meta">
    <div>Feed URL: <code>${esc(feedUrl)}</code> &nbsp;|&nbsp; Active Step: <strong>${esc(activeStep.id)}</strong> (<code>${esc(activeStep.appVersion)}</code>) &nbsp;|&nbsp; Signed: <code>${esc(index.signedWith)}</code></div>
    <p style="margin:10px 0 6px;">Launch Linger pointed at this local test feed:</p>
    <pre># macOS
${envLoopback}LINGER_UPDATE_FEED_URL=${esc(feedUrl)} LINGER_BUNDLE_CHECK_DELAY_MS=3000 LINGER_BUNDLE_CHECK_INTERVAL_MS=10000 /Applications/Linger.app/Contents/MacOS/Linger

# Linux
${envLoopback}LINGER_UPDATE_FEED_URL=${esc(feedUrl)} LINGER_BUNDLE_CHECK_DELAY_MS=3000 LINGER_BUNDLE_CHECK_INTERVAL_MS=10000 ./linger

# Windows PowerShell
${winLoopback}$env:LINGER_UPDATE_FEED_URL="${esc(feedUrl)}"; $env:LINGER_BUNDLE_CHECK_DELAY_MS="3000"; $env:LINGER_BUNDLE_CHECK_INTERVAL_MS="10000"; & "$env:LOCALAPPDATA\\Programs\\Linger\\Linger.exe"</pre>
  </div>

  <h2>2+1 Signed Upgrade Steps</h2>
  <table>
    <thead><tr><th>Step</th><th>App Version</th><th>Changed Module(s)</th><th>Expected Behavior</th><th>Rollback</th><th>Action</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Live Client Requests (verify only 1/3 bundle downloads per incremental step)</h2>
  <table>
    <thead><tr><th>Time</th><th>Active Step</th><th>Path</th><th>HTTP</th><th>Bytes</th></tr></thead>
    <tbody>${logs || '<tr><td colspan="5" style="color:#94a3b8;">No requests yet. Launch Linger or trigger Check for Updates.</td></tr>'}</tbody>
  </table>

  <script>
    async function switchStep(step) {
      await fetch('/__test/switch?step=' + encodeURIComponent(step), { method: 'POST' });
      location.reload();
    }
    setInterval(() => { location.reload(); }, 4000);
  </script>
</body>
</html>`;
}

export async function createTestFeedServer({
  rootDir = scriptDir,
  initialStep,
  host = "127.0.0.1",
  port = 8787,
  useHttps = false,
  certPath = null,
  keyPath = null,
  quiet = false,
} = {}) {
  const index = loadTestKitIndex(rootDir);
  let activeStep = resolveStepEntry(index.steps, initialStep) ?? index.steps[0];
  const downloadHistory = [];
  let generatedTls = null;

  const log = (msg) => {
    if (!quiet) process.stdout.write(`${msg}\n`);
  };

  let feedUrl = `${useHttps ? "https" : "http"}://${host}:${port}`;

  const handler = (req, res) => {
    const parsed = new URL(req.url ?? "/", feedUrl);
    const pathname = decodeURIComponent(parsed.pathname);

    if (pathname === "/" || pathname === "/index.html") {
      const html = renderDashboardHtml({
        feedUrl,
        index,
        activeStep,
        downloadHistory,
      });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    if (pathname === "/__test/status") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify(
          {
            feedUrl,
            activeStep,
            steps: index.steps,
            downloadHistory,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (pathname === "/__test/reset-log") {
      downloadHistory.length = 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/__test/switch") {
      const target = parsed.searchParams.get("step");
      const found = resolveStepEntry(index.steps, target);
      if (!found) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: `Unknown step: ${target}` }),
        );
        return;
      }
      activeStep = found;
      log(
        `[FEED] Switched active step -> ${activeStep.id} (${activeStep.appVersion}, changed: ${activeStep.changedModules.join(", ")})`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          activeStep: activeStep.id,
          appVersion: activeStep.appVersion,
          changedModules: activeStep.changedModules,
        }),
      );
      return;
    }

    // Channel manifest & Ed25519 signature (exact untouched CI-signed bytes!)
    const manifestMatch =
      /^\/channels\/(stable|beta|canary)\/(app-manifest\.json(?:\.sig)?)$/.exec(
        pathname,
      );
    if (manifestMatch) {
      const fileName = manifestMatch[2];
      const filePath = path.join(rootDir, "steps", activeStep.id, fileName);
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const bytes = readFileSync(filePath);
      downloadHistory.push({
        at: new Date().toISOString().slice(11, 19),
        stepId: activeStep.id,
        path: pathname,
        status: 200,
        size: bytes.length,
      });
      log(
        `[FEED] ${req.method} ${pathname} [${activeStep.id} / ${activeStep.appVersion}] -> 200 (${formatBytes(bytes.length)})`,
      );
      res.writeHead(200, {
        "content-type": fileName.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8",
        "content-length": String(bytes.length),
        "cache-control": "no-store",
      });
      res.end(bytes);
      return;
    }

    // Content-addressed bundle artifacts under /bundles/<bundleId>/<fileName>
    const bundleMatch = /^\/bundles\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(
      pathname,
    );
    if (bundleMatch) {
      const [, bundleId, fileName] = bundleMatch;
      const bundlesRoot = path.resolve(rootDir, "bundles");
      const filePath = path.resolve(bundlesRoot, bundleId, fileName);
      if (
        !filePath.startsWith(`${bundlesRoot}${path.sep}`) ||
        !existsSync(filePath)
      ) {
        res.writeHead(404);
        res.end("Bundle not found");
        return;
      }
      const size = statSync(filePath).size;
      downloadHistory.push({
        at: new Date().toISOString().slice(11, 19),
        stepId: activeStep.id,
        path: pathname,
        status: 200,
        size,
      });
      log(
        `[FEED] DOWNLOAD ${bundleId}/${fileName} -> 200 (${formatBytes(size)})`,
      );
      res.writeHead(200, {
        "content-type": "application/zstd",
        "content-length": String(size),
        "cache-control": "public, max-age=31536000, immutable",
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  };

  let server;
  if (useHttps) {
    let key;
    let cert;
    if (certPath && keyPath) {
      cert = readFileSync(certPath);
      key = readFileSync(keyPath);
    } else {
      generatedTls = generateSelfSignedCert(detectLanIPv4s());
      cert = generatedTls.cert;
      key = generatedTls.key;
    }
    server = https.createServer({ key, cert }, handler);
  } else {
    server = http.createServer(handler);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const displayHost =
    host === "0.0.0.0" ? (detectLanIPv4s()[0] ?? "127.0.0.1") : host;
  feedUrl = `${useHttps ? "https" : "http"}://${displayHost}:${actualPort}`;

  return {
    server,
    port: actualPort,
    feedUrl,
    certPath: certPath ?? generatedTls?.certPath ?? null,
    getActiveStep: () => activeStep,
    setStep(selector) {
      const found = resolveStepEntry(index.steps, selector);
      if (!found) throw new Error(`Unknown step: ${selector}`);
      activeStep = found;
      return activeStep;
    },
    getDownloadHistory: () => [...downloadHistory],
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      generatedTls?.cleanup();
    },
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
  const useHttps = args.includes("--https");
  const rootDir = path.resolve(flag("--root") ?? scriptDir);
  const host = flag("--host") ?? "127.0.0.1";
  const port = Number(flag("--port") ?? (useHttps ? "8443" : "8787"));
  const initialStep = flag("--step") ?? "00";
  const certPath = flag("--cert") ? path.resolve(flag("--cert")) : null;
  const keyPath = flag("--key") ? path.resolve(flag("--key")) : null;

  const instance = await createTestFeedServer({
    rootDir,
    initialStep,
    host,
    port,
    useHttps,
    certPath,
    keyPath,
  });

  const index = loadTestKitIndex(rootDir);
  const step = instance.getActiveStep();
  process.stdout.write(
    "\n============================================================\n",
  );
  process.stdout.write(" Linger V2 Signed Test Upgrade Feed Server\n");
  process.stdout.write(
    "============================================================\n",
  );
  process.stdout.write(` Dashboard & Feed : ${instance.feedUrl}\n`);
  process.stdout.write(` Active Step      : ${step.id} (${step.appVersion})\n`);
  process.stdout.write(
    ` Changed Modules  : ${step.changedModules.join(", ")}\n`,
  );
  if (instance.certPath) {
    process.stdout.write(` TLS Self-Signed  : ${instance.certPath}\n`);
  }
  process.stdout.write("\n Available Steps:\n");
  for (const s of index.steps) {
    process.stdout.write(
      `   [${s.id.slice(5, 7)}] ${s.id.padEnd(25)} ${s.appVersion.padEnd(18)} changed=${s.changedModules.join(",")}\n`,
    );
  }
  process.stdout.write("\n Switch step anytime:\n");
  process.stdout.write("   - Type 00..04 + Enter in this terminal, OR\n");
  process.stdout.write(`   - Open ${instance.feedUrl} in your browser, OR\n`);
  process.stdout.write(
    `   - curl -X POST "${instance.feedUrl}/__test/switch?step=01"\n\n`,
  );

  if (!args.includes("--no-tty") && process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on("line", (line) => {
      const cmd = line.trim();
      if (!cmd) return;
      if (cmd === "q" || cmd === "quit" || cmd === "exit") {
        void instance.close().then(() => process.exit(0));
        return;
      }
      try {
        const next = instance.setStep(cmd);
        process.stdout.write(
          `[FEED] Active step -> ${next.id} (${next.appVersion}, changed: ${next.changedModules.join(", ")})\n`,
        );
      } catch (err) {
        process.stdout.write(
          `[FEED] ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      void instance.close().then(() => process.exit(0));
    });
  }
}
