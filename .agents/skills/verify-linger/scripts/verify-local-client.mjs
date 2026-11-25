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
const withSetupInspect = args.has("--with-setup-inspect");

if (args.has("--help") || args.has("-h")) {
  process.stdout.write(
    [
      "Usage: node .agents/skills/verify-linger/scripts/verify-local-client.mjs [--smoke-only] [--with-setup-inspect]",
      "",
      "Runs platform-aware deterministic checks for Desktop, Local Installer,",
      "Local Installation, BYOK helpers, and Go Daemon localmodels/model_source,",
      "followed by an isolated live Local Installer loopback proof.",
      "",
      "Options:",
      "  --smoke-only          Skip unit/check suites and run only the isolated live installer proof.",
      "  --with-setup-inspect  Drive an authenticated Chromium session through GET /api/setup",
      "                        (requires network access to download the localmodels kit).",
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
  `with_setup_inspect=${withSetupInspect}`,
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
  writeFileSync(path.join(evidenceDir, "temp-homes.txt"), `${tempHome}\n`, {
    mode: 0o600,
  });
  const installerEntry = path.join(
    repoRoot,
    "apps",
    "linger-installer",
    "dist",
    "installer.js",
  );
  let child;
  const assertions = { withSetupInspect };

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
    if (child.pid) {
      writeFileSync(path.join(evidenceDir, "pids.txt"), `${child.pid}\n`, {
        mode: 0o600,
      });
    }
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

    // Optional Chromium SPA verification when Playwright Chromium is installed.
    let chromiumMod;
    try {
      const pw = await import("@playwright/test");
      if (existsSync(pw.chromium.executablePath())) {
        chromiumMod = pw.chromium;
      }
    } catch {
      chromiumMod = undefined;
    }

    if (chromiumMod) {
      const browserDir = path.join(evidenceDir, "browser");
      mkdirSync(browserDir, { recursive: true, mode: 0o700 });
      const browser = await chromiumMod.launch({ headless: true });
      try {
        const unauthContext = await browser.newContext({
          viewport: { width: 1280, height: 800 },
        });
        try {
          const unauthPage = await unauthContext.newPage();
          const pageErrors = [];
          unauthPage.on("pageerror", (err) => pageErrors.push(err.message));
          await unauthPage.goto(`${origin}/`, {
            waitUntil: "domcontentloaded",
          });
          const alert = unauthPage.getByRole("alert");
          await alert.waitFor({ state: "visible", timeout: 15_000 });
          const alertText = (await alert.textContent()) ?? "";
          if (!alertText.includes("Open the installer again.")) {
            throw new Error(
              `Expected unauthenticated installer alert, got: ${alertText}`,
            );
          }
          assertions.unauthenticatedSpaRendered = true;
          assertions.unauthenticatedPageErrors = pageErrors.length;
          if (pageErrors.length > 0) {
            throw new Error(
              `Unexpected pageerror in installer SPA: ${pageErrors.join("; ")}`,
            );
          }
          await unauthPage.screenshot({
            path: path.join(browserDir, "installer-unauthenticated-guard.png"),
            fullPage: true,
          });
          writeFileSync(
            path.join(browserDir, "installer-unauthenticated-guard.aria.yml"),
            await unauthPage.locator("body").ariaSnapshot(),
            { mode: 0o600 },
          );
        } finally {
          await unauthContext.close();
        }

        if (withSetupInspect) {
          const authContext = await browser.newContext({
            viewport: { width: 1280, height: 800 },
          });
          try {
            const page = await authContext.newPage();
            await page.goto(urlMatch[0], { waitUntil: "domcontentloaded" });
            const heading = page.getByRole("heading", {
              name: "Choose your harness",
              exact: true,
            });
            await heading.waitFor({ state: "visible", timeout: 180_000 });
            assertions.authenticatedHeading = await heading.textContent();
            await page.screenshot({
              path: path.join(browserDir, "installer-choose-harness.png"),
              fullPage: true,
            });
            writeFileSync(
              path.join(browserDir, "installer-choose-harness.aria.yml"),
              await page.locator("body").ariaSnapshot(),
              { mode: 0o600 },
            );
            const planGroup = page.getByRole("radiogroup", {
              name: "Installation plan",
            });
            await planGroup.getByRole("radio", { name: /BYOK/ }).check();
            await page
              .getByRole("textbox", { name: "Base URL", exact: true })
              .fill("http://169.254.169.254/latest");
            await page
              .getByRole("combobox", { name: "Model", exact: true })
              .fill("stub-model");
            const byokResPromise = page.waitForResponse(
              (res) =>
                res.url() === `${origin}/api/byok/check` &&
                res.request().method() === "POST",
              { timeout: 15_000 },
            );
            await page
              .getByRole("button", { name: "Test", exact: true })
              .click();
            const byokRes = await byokResPromise;
            const byokBody = await byokRes.json().catch(() => ({}));
            assertions.byokSsrfCheck = {
              status: byokRes.status(),
              code: byokBody.code ?? null,
            };
            if (
              byokRes.status() !== 400 ||
              byokBody.code !== "BYOK_INVALID_CONFIG"
            ) {
              throw new Error(
                `Expected 400 BYOK_INVALID_CONFIG, got ${byokRes.status()} ${JSON.stringify(byokBody)}`,
              );
            }
            await page
              .getByRole("status")
              .filter({ hasText: "Couldn't connect" })
              .waitFor({ state: "visible", timeout: 10_000 });
            assertions.byokUiRefusalVisible = true;
            await page.screenshot({
              path: path.join(browserDir, "installer-byok-ssrf-refused.png"),
              fullPage: true,
            });
            writeFileSync(
              path.join(browserDir, "installer-byok-ssrf-refused.aria.yml"),
              await page.locator("body").ariaSnapshot(),
              { mode: 0o600 },
            );
            const cookies = await authContext.cookies(origin);
            const sessionCookie = cookies.find(
              (c) => c.httpOnly && c.sameSite === "Strict",
            );
            assertions.cookieFlags = {
              httpOnly: Boolean(sessionCookie?.httpOnly),
              sameSiteStrict: sessionCookie?.sameSite === "Strict",
            };
            if (!sessionCookie) {
              throw new Error(
                "Expected HttpOnly SameSite=Strict cookie after browser bootstrap",
              );
            }
          } finally {
            await authContext.close();
          }
        }
      } finally {
        await browser.close();
      }
    } else if (withSetupInspect) {
      throw new Error(
        "--with-setup-inspect requires Playwright Chromium (pnpm exec playwright install chromium)",
      );
    } else {
      assertions.chromiumSpaCheck = "skipped (Playwright Chromium unavailable)";
    }

    let cookiePair = "";
    if (!withSetupInspect) {
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
      cookiePair = setCookie.split(";")[0];
    }

    assertions.launchFileDeletedAfterExchange = !existsSync(launchFile);
    if (!assertions.launchFileDeletedAfterExchange) {
      throw new Error(
        "Expected launch.html to be deleted immediately after bootstrap token exchange",
      );
    }

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

    if (!withSetupInspect) {
      const envRes = await fetch(`${origin}/api/environment`, {
        headers: { Cookie: cookiePair },
      });
      assertions.environmentStatus = envRes.status;
      if (envRes.status !== 200) {
        throw new Error(
          `Expected 200 from /api/environment, got ${envRes.status}`,
        );
      }

      const configRes = await fetch(`${origin}/api/config`, {
        headers: { Cookie: cookiePair },
      });
      assertions.configStatus = configRes.status;
      if (configRes.status !== 200) {
        throw new Error(
          `Expected 200 from /api/config, got ${configRes.status}`,
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

      const jobsRes = await fetch(`${origin}/api/jobs`, {
        headers: { Cookie: cookiePair },
      });
      assertions.jobsStatus = jobsRes.status;
      if (jobsRes.status !== 200) {
        throw new Error(`Expected 200 from /api/jobs, got ${jobsRes.status}`);
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
  withSetupInspect,
  results,
  skippedOs,
  limitations: [
    "Does not launch Electron GUI, download multi-GB local model weights, invoke a real GPU/Metal/CUDA engine, or call an external BYOK provider.",
    ...(withSetupInspect
      ? []
      : [
          "Skipped GET /api/setup (localmodels kit download + hardware plan) to avoid external network downloads by default; pass --with-setup-inspect to exercise it.",
        ]),
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
