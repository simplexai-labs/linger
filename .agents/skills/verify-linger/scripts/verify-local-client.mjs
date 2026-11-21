#!/usr/bin/env node
// Cross-platform (Linux, macOS, Windows) verification helper for Linger Desktop,
// Local Installer, Local Installation engine, Local Models, and BYOK surfaces.
// Runs host-applicable deterministic checks and an isolated live Local Installer
// loopback proof, retaining structured evidence under test-results/verify-linger/.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");
const isWindows = process.platform === "win32";
const target = `${process.platform}-${process.arch}`;
const args = new Set(process.argv.slice(2));
const smokeOnly = args.has("--smoke-only");

if (args.has("--help") || args.has("-h")) {
  process.stdout.write(
    [
      "Usage: node .agents/skills/verify-linger/scripts/verify-local-client.mjs [--smoke-only]",
      "",
      "Runs platform-aware deterministic checks for Desktop, Local Installer,",
      "Local Installation, BYOK helpers, and Go Daemon localmodels/model_source,",
      "followed by an isolated live Local Installer loopback proof.",
      "",
      "Options:",
      "  --smoke-only  Skip unit/check suites and run only the isolated live installer proof.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor !== 26 || nodeMinor < 5) {
  process.stderr.write(
    `Use Node >=26.5.0 <27 (found ${process.versions.node}).\n`,
  );
  process.exit(2);
}

function commandName(name) {
  return isWindows ? `${name}.cmd` : name;
}

function runSyncText(command, commandArgs, cwd = repoRoot) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error,
  };
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

const evidenceBase = path.join(repoRoot, "test-results", "verify-linger");
mkdirSync(evidenceBase, { recursive: true, mode: 0o700 });
const evidenceDir = mkdtempSync(path.join(evidenceBase, "local-client."));
process.stdout.write(`Evidence: ${evidenceDir}\n`);

const logPath = path.join(evidenceDir, "run.log");
const logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });

function logLine(text) {
  const line = `${text}\n`;
  process.stdout.write(line);
  logStream.write(line);
}

const head = runSyncText("git", ["rev-parse", "HEAD"]).stdout;
const statusShort = runSyncText("git", ["status", "--short"]).stdout;
const pnpmVersion = runSyncText(commandName("pnpm"), ["--version"]).stdout;
const goVersion = runSyncText("go", ["version"]).stdout;

const sourceInfo = [
  `head=${head}`,
  `target=${target}`,
  `platform=${process.platform}`,
  `arch=${process.arch}`,
  `node=${process.versions.node}`,
  `pnpm=${pnpmVersion || "unavailable"}`,
  `go=${goVersion || "unavailable"}`,
  `smoke_only=${smokeOnly}`,
  ...(statusShort ? ["dirty:", statusShort] : ["dirty=none"]),
].join("\n");
writeFileSync(path.join(evidenceDir, "source.txt"), `${sourceInfo}\n`, {
  mode: 0o600,
});

const patch = spawnSync("git", ["diff", "--no-ext-diff", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
writeFileSync(path.join(evidenceDir, "source.patch"), patch.stdout ?? "", {
  mode: 0o600,
});

const changedRaw = [
  spawnSync("git", ["diff", "--name-only", "--diff-filter=d", "-z", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout ?? "",
  spawnSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout ?? "",
].join("");
const changedFiles = [
  ...new Set(changedRaw.split("\0").filter((entry) => entry.length > 0)),
];
const hashes = changedFiles
  .filter((rel) => existsSync(path.join(repoRoot, rel)))
  .map((rel) => `${sha256File(path.join(repoRoot, rel))}  ${rel}`);
writeFileSync(
  path.join(evidenceDir, "changed-files.sha256"),
  hashes.length > 0 ? `${hashes.join("\n")}\n` : "",
  { mode: 0o600 },
);

async function runStep(name, command, commandArgs, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const startedAt = Date.now();
  logLine(`=== [${name}] ${command} ${commandArgs.join(" ")} ===`);
  return await new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });
    child.on("error", (error) => {
      const durationMs = Date.now() - startedAt;
      logLine(`ERROR [${name}]: ${error.message}`);
      resolve({
        name,
        status: "failed",
        exitCode: 1,
        durationMs,
        error: error.message,
      });
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      const exitCode = code ?? 1;
      resolve({
        name,
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        durationMs,
      });
    });
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function runLiveInstallerProof() {
  const startedAt = Date.now();
  const buildResult = await runStep("installer-build", commandName("pnpm"), [
    "--filter",
    "@linger/linger-installer",
    "build",
  ]);
  if (buildResult.status !== "passed") {
    return {
      name: "live-installer-loopback-proof",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: "Failed to build @linger/linger-installer",
    };
  }

  const tmpBase =
    process.platform === "darwin" && existsSync("/private/tmp")
      ? "/private/tmp"
      : tmpdir();
  const tempHome = mkdtempSync(path.join(tmpBase, "linger-verify-installer-"));
  const installerEntry = path.join(
    repoRoot,
    "apps",
    "linger-installer",
    "dist",
    "installer.js",
  );
  let child;
  const assertions = {};

  try {
    logLine(
      `=== [live-installer-loopback-proof] Starting isolated installer in ${tempHome} ===`,
    );
    child = spawn(
      process.execPath,
      [
        installerEntry,
        "--home",
        tempHome,
        "--source-repo",
        repoRoot,
        "--instance",
        "verify-local-client",
        "--no-open",
        "--port",
        "0",
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout.on("data", (chunk) => logStream.write(chunk));
    child.stderr.on("data", (chunk) => logStream.write(chunk));

    const launchFile = path.join(tempHome, "installer", "launch.html");
    const launchReady = await waitForFile(launchFile, 15_000);
    if (!launchReady) {
      throw new Error("Timed out waiting for installer/launch.html");
    }

    if (!isWindows) {
      const dirMode = statSync(path.join(tempHome, "installer")).mode & 0o777;
      const fileMode = statSync(launchFile).mode & 0o777;
      assertions.posixPrivateModes = {
        installerDirMode: dirMode.toString(8),
        launchHtmlMode: fileMode.toString(8),
      };
      if (dirMode !== 0o700 || fileMode !== 0o600) {
        throw new Error(
          `Expected 700/600 permissions, got ${dirMode.toString(8)}/${fileMode.toString(8)}`,
        );
      }
    } else {
      assertions.windowsPrivateAclNote =
        "Windows DACL verified by windows-private.native.test.ts";
    }

    const launchHtml = readFileSync(launchFile, "utf8");
    const urlMatch = /http:\/\/127\.0\.0\.1:\d+\/[^"'<>\s]+/.exec(launchHtml);
    if (!urlMatch) {
      throw new Error("Could not extract loopback launch URL from launch.html");
    }
    const parsedLaunch = new URL(urlMatch[0]);
    const origin = parsedLaunch.origin;
    const hashParams = new URLSearchParams(parsedLaunch.hash.replace(/^#/, ""));
    const token =
      parsedLaunch.searchParams.get("token") ?? hashParams.get("token");
    if (!token) {
      throw new Error("Could not extract one-time bootstrap token");
    }
    assertions.loopbackOrigin = origin;

    const missingOriginRes = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assertions.missingOriginStatus = missingOriginRes.status;
    if (missingOriginRes.status !== 403) {
      throw new Error(
        `Expected 403 for missing Origin, got ${missingOriginRes.status}`,
      );
    }

    const sessionRes = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    });
    assertions.sessionExchangeStatus = sessionRes.status;
    const setCookie = sessionRes.headers.get("set-cookie") ?? "";
    assertions.cookieFlags = {
      httpOnly: /;\s*HttpOnly/i.test(setCookie),
      sameSiteStrict: /;\s*SameSite=Strict/i.test(setCookie),
    };
    if (
      sessionRes.status !== 200 ||
      !assertions.cookieFlags.httpOnly ||
      !assertions.cookieFlags.sameSiteStrict
    ) {
      throw new Error(
        `Session exchange failed or missing cookie flags (HTTP ${sessionRes.status})`,
      );
    }
    const cookiePair = setCookie.split(";")[0];

    const replayRes = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    });
    assertions.tokenReplayStatus = replayRes.status;
    if (replayRes.status !== 401) {
      throw new Error(
        `Expected 401 on one-time token replay, got ${replayRes.status}`,
      );
    }

    const envRes = await fetch(`${origin}/api/environment`, {
      headers: { Cookie: cookiePair },
    });
    assertions.environmentStatus = envRes.status;
    if (envRes.status !== 200) {
      throw new Error(
        `Expected 200 from /api/environment, got ${envRes.status}`,
      );
    }

    const instancesRes = await fetch(`${origin}/api/instances`, {
      headers: { Cookie: cookiePair },
    });
    assertions.instancesStatus = instancesRes.status;
    if (instancesRes.status !== 200) {
      throw new Error(
        `Expected 200 from /api/instances, got ${instancesRes.status}`,
      );
    }

    const ssrfRes = await fetch(`${origin}/api/byok/check`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookiePair,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtime: "pi",
        baseUrl: "http://169.254.169.254/latest",
        path: "/v1",
        endpoint: "/chat/completions",
        apiKey: "disposable-verify-key",
        model: "stub-model",
      }),
    });
    const ssrfBody = await ssrfRes.json().catch(() => ({}));
    assertions.byokSsrfCheck = {
      status: ssrfRes.status,
      code: ssrfBody.code ?? null,
    };
    if (ssrfRes.status !== 400 || ssrfBody.code !== "BYOK_INVALID_CONFIG") {
      throw new Error(
        `Expected 400 BYOK_INVALID_CONFIG for metadata URL, got ${ssrfRes.status} ${JSON.stringify(ssrfBody)}`,
      );
    }

    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    child = undefined;

    const stopOut = runSyncText(process.execPath, [
      installerEntry,
      "--home",
      tempHome,
      "--instance",
      "verify-local-client",
      "--stop",
    ]);
    assertions.stopExitCode = stopOut.status;
    assertions.stopOutput = stopOut.stdout;
    if (stopOut.status !== 0) {
      throw new Error(`Headless --stop failed: ${stopOut.stderr}`);
    }

    logLine("=== [live-installer-loopback-proof] PASSED ===");
    return {
      name: "live-installer-loopback-proof",
      status: "passed",
      durationMs: Date.now() - startedAt,
      assertions,
    };
  } catch (error) {
    logLine(
      `=== [live-installer-loopback-proof] FAILED: ${error instanceof Error ? error.message : String(error)} ===`,
    );
    return {
      name: "live-installer-loopback-proof",
      status: "failed",
      durationMs: Date.now() - startedAt,
      assertions,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
}

const results = [];
const skippedOs = [];

if (!smokeOnly) {
  results.push(
    await runStep("service-kit-byok", commandName("pnpm"), [
      "--filter",
      "@linger/service-kit",
      "exec",
      "vitest",
      "run",
      "src/byok-endpoint.test.ts",
    ]),
  );
  results.push(
    await runStep("local-installation-suite", commandName("pnpm"), [
      "--filter",
      "@linger/local-installation",
      "test",
    ]),
  );
  results.push(
    await runStep("linger-installer-suite", commandName("pnpm"), [
      "--filter",
      "@linger/linger-installer",
      "test",
    ]),
  );
  results.push(
    await runStep("desktop-suite", commandName("pnpm"), [
      "--filter",
      "@linger/desktop",
      "test",
    ]),
  );
  const pythonCmd = isWindows ? "python" : "python3";
  results.push(
    await runStep("desktop-packaging-python", pythonCmd, [
      "-m",
      "unittest",
      "discover",
      "-s",
      "apps/desktop/packaging",
      "-p",
      "*_test.py",
    ]),
  );
  results.push(
    await runStep(
      "daemon-localmodels-and-model-source-go",
      "go",
      [
        "test",
        "-count=1",
        "./internal/localmodels",
        "./internal/daemon",
        "./internal/computerconfig",
        "-run",
        "Test(Refresh|Download|Load|Unload|Cancel|Job|Answer|Following|AFailed|Restarted|PiModel|ChangeOf|ToolCommand|InitialRefresh|FailedPi|EnsurePi|Overlay|ModelSource|AgentRuntimeModel|MapStatus|LocalModels|HandleModelSource|LocalModelsConfig)",
      ],
      { cwd: path.join(repoRoot, "apps", "computer", "local-daemon") },
    ),
  );

  if (isWindows) {
    results.push(
      await runStep("windows-native-acl-and-process", commandName("pnpm"), [
        "--filter",
        "@linger/local-installation",
        "exec",
        "vitest",
        "run",
        "src/windows-private.native.test.ts",
        "src/native-process-windows-live.test.ts",
      ]),
    );
  } else {
    skippedOs.push({
      check: "windows-native-acl-and-process",
      reason: `Requires win32-x64 host (current host is ${target})`,
    });
    skippedOs.push({
      check: "windows-nsi-setup-and-uninstall",
      reason: `Requires Windows 10/11 x64 desktop (current host is ${target})`,
    });
  }

  if (process.platform !== "darwin") {
    skippedOs.push({
      check: "macos-dmg-gatekeeper-tcc-and-app-bundle-updater",
      reason: `Requires darwin-arm64 host on macOS 14.0+ (current host is ${target})`,
    });
  }
  if (process.platform !== "linux") {
    skippedOs.push({
      check: "linux-x64-glibc-and-proc-native-checks",
      reason: `Requires linux-x64 host (current host is ${target})`,
    });
  }
}

results.push(await runLiveInstallerProof());

const failed = results.filter((entry) => entry.status !== "passed");
const exitCode = failed.length === 0 ? 0 : 1;

const proof = {
  feature: "desktop-and-local-models",
  head,
  hostTarget: target,
  smokeOnly,
  results,
  skippedOs,
  limitations: [
    "Does not launch Electron GUI, download multi-GB local model weights, invoke a real GPU/Metal/CUDA engine, or call an external BYOK provider.",
    "Run platform-specific GUI, auto-updater, hardware model deployment, and uninstall recipes in features/desktop-and-installer.md and features/local-models-and-byok.md on each target OS.",
  ],
  status: exitCode === 0 ? "passed" : "failed",
};

writeFileSync(
  path.join(evidenceDir, "proof.json"),
  `${JSON.stringify(proof, null, 2)}\n`,
  { mode: 0o600 },
);
writeFileSync(path.join(evidenceDir, "exit-code.txt"), `${exitCode}\n`, {
  mode: 0o600,
});
logStream.end();

process.stdout.write(`Evidence retained: ${evidenceDir}\n`);
process.exit(exitCode);
