import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export function probePi(executable, args, options, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, windowsHide: true });
    const output = createInterface({ input: child.stdout });
    const pending = new Set(["get_state", "get_commands"]);
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => finish("RPC deadline exceeded"), timeoutMs);
    function finish(reason) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      output.close();
      const diagnostic = stderr.trim().slice(-1500).replaceAll("\x1b", "");
      const settle = () =>
        reason
          ? reject(
              new Error(
                `Pi smoke: ${reason}${diagnostic ? `\n${diagnostic}` : ""}`,
              ),
            )
          : resolve();
      // Windows keeps the working directory busy until the process exits, so
      // the caller may remove it only after that.
      if (
        child.pid === undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return settle();
      child.once("exit", settle);
      // A failed kill delivers no exit event.
      if (!child.kill()) settle();
    }
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1500);
    });
    child.on("error", (error) =>
      finish(`process error: ${error.code ?? error.name}`),
    );
    child.on("close", (code) =>
      finish(`process closed before handshake (exit ${code})`),
    );
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finish("RPC stdin failed");
    });
    output.on("line", (line) => {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      if (reply?.type === "extension_error")
        return finish("extension initialization failed");
      if (reply?.type !== "response" || !pending.has(reply.id)) return;
      if (reply.command !== reply.id || reply.success !== true)
        return finish("RPC command failed");
      if (
        reply.id === "get_commands" &&
        !reply.data?.commands?.some(
          (command) => command.name === "mcp" && command.source === "extension",
        )
      )
        return finish("the managed MCP command was not registered");
      pending.delete(reply.id);
      if (!pending.size) finish();
    });
    for (const type of pending)
      child.stdin.write(`${JSON.stringify({ id: type, type })}\n`);
  });
}

export async function assertNoFreshHarnessPi(home) {
  const root = join(home, "runtime", "harness", "tools", "pi");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const downloaded = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, "pi.exe");
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      downloaded.push(candidate);
    }
  }
  if (downloaded.length > 0) {
    throw new Error(
      `Expected bundled Pi reuse, but harness downloaded Pi into ${downloaded.join(", ")}`,
    );
  }
}

function runPowerShellCommand(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error(`PowerShell smoke: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1500);
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(
        new Error(
          `PowerShell smoke: process error: ${error.code ?? error.name}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        const diagnostic = stderr.trim().slice(-1500);
        reject(
          new Error(
            `PowerShell smoke: exited with ${code}${diagnostic ? `\n${diagnostic}` : ""}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

export async function probeBundledPowerShell(
  executable,
  { nodeExecutable, expectedVersion = "7.6.10", timeoutMs = 15_000 } = {},
) {
  const versionOutput = await runPowerShellCommand(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ],
    timeoutMs,
  );
  const actualVersion = versionOutput.trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `PowerShell smoke: expected version ${expectedVersion}, got ${actualVersion || "(empty)"}`,
    );
  }
  if (nodeExecutable) {
    const quotedNode = nodeExecutable.replaceAll("'", "''");
    const expectedArg = '[{"question":"a b"}]';
    const command = `& '${quotedNode}' -e 'process.stdout.write(process.argv[1])' '${expectedArg}'`;
    const echoed = await runPowerShellCommand(
      executable,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      timeoutMs,
    );
    if (echoed !== expectedArg) {
      throw new Error(
        `PowerShell smoke: native JSON argument mismatch: expected ${expectedArg}, got ${echoed}`,
      );
    }
  }
}

async function main() {
  const home = process.env.LINGER_HOME;
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    !home ||
    !isAbsolute(home)
  )
    throw new Error(
      "Expected a Windows x64 package and an absolute smoke home",
    );
  const resources = join(dirname(process.execPath), "resources");
  const node = join(resources, "runtime", "bin", "node.exe");
  const bundledPwsh = join(resources, "runtime", "pwsh", "pwsh.exe");
  const installer = join(resources, "app", "dist", "installer", "installer.js");
  const bundledPi = join(resources, "cli", "computer-tools", "bin", "pi.exe");
  const extension = join(
    resources,
    "cli",
    "computer-tools",
    "extensions",
    "pi-mcp.mjs",
  );
  await access(node);
  await access(bundledPwsh);
  await access(installer);
  await access(bundledPi);
  await access(extension);
  const pwshStart = performance.now();
  await probeBundledPowerShell(bundledPwsh, { nodeExecutable: node });
  console.log(
    JSON.stringify({
      phase: "bundled_pwsh",
      version: "7.6.10",
      result: "passed",
      elapsed_ms: Math.round(performance.now() - pwshStart),
    }),
  );
  await mkdir(home);
  const source = join(home, "unused-source");
  await mkdir(source);
  const managerEnv = { ...process.env };
  delete managerEnv.ELECTRON_RUN_AS_NODE;
  delete managerEnv.NODE_PATH;
  delete managerEnv.NODE_OPTIONS;
  const started = performance.now();
  const manager = spawn(
    node,
    [
      installer,
      "--home",
      home,
      "--source-repo",
      source,
      "--instance",
      "desktop",
      "--external-computer",
      "--no-open",
      "--port",
      "0",
    ],
    { cwd: home, env: managerEnv, windowsHide: true, stdio: "ignore" },
  );
  let managerError;
  manager.on("error", (error) => {
    managerError = error.code ?? error.name;
  });
  function checkManager() {
    if (managerError || manager.exitCode !== null)
      throw new Error(
        `Packaged installer exited (${managerError ?? manager.exitCode})`,
      );
  }
  try {
    const launcher = join(home, "installer", "launch.html");
    const startup = AbortSignal.timeout(45_000);
    let session;
    while (!session) {
      checkManager();
      const html = await readFile(launcher, "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      session =
        /href="(http:\/\/127\.0\.0\.1:\d{1,5})\/#token=([A-Za-z0-9_-]{43})"/.exec(
          html,
        );
      if (!session) await delay(500, undefined, { signal: startup });
    }
    const [, origin, token] = session;
    let cookie;
    async function request(route, signal, body) {
      checkManager();
      const response = await fetch(origin + route, {
        ...(body && { method: "POST", body: JSON.stringify(body) }),
        headers: {
          origin,
          "content-type": "application/json",
          ...(cookie && { cookie }),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `Installer API returned ${response.status} at ${route}`,
        );
      if (route === "/api/session")
        cookie = response.headers.getSetCookie()[0]?.split(";")[0];
      return response.json();
    }
    await request("/api/session", startup, { token });
    if (!cookie)
      throw new Error("The packaged installer did not establish a session");
    const preparation = AbortSignal.timeout(780_000);
    let job = await request("/api/jobs", preparation, {
      instance: "desktop",
      preparation: "pi",
    });
    if (!/^[a-f0-9-]{36}$/.test(job.id))
      throw new Error("Installer returned an invalid job ID");
    const jobRoute = `/api/jobs/${job.id}`;
    let lastStatus = "";
    const logProgress = (current) => {
      const key = `${current.state}:${current.stage ?? ""}:${current.message ?? ""}`;
      if (key === lastStatus) return;
      lastStatus = key;
      console.log(
        JSON.stringify({
          phase: "pi_preparation_progress",
          job_id: current.id,
          state: current.state,
          ...(current.stage ? { stage: current.stage } : {}),
          ...(current.message ? { message: current.message } : {}),
          elapsed_ms: Math.round(performance.now() - started),
        }),
      );
    };
    logProgress(job);
    try {
      while (job.state === "queued" || job.state === "running") {
        await delay(1000, undefined, { signal: preparation });
        job = await request(jobRoute, preparation);
        logProgress(job);
      }
    } catch (error) {
      if (preparation.aborted) {
        console.log(
          JSON.stringify({
            phase: "pi_preparation_timeout",
            job_id: job.id,
            state: job.state,
            ...(job.stage ? { stage: job.stage } : {}),
            ...(job.message ? { message: job.message } : {}),
            elapsed_ms: Math.round(performance.now() - started),
          }),
        );
      }
      throw error;
    }
    console.log(
      JSON.stringify({
        phase: "pi_preparation",
        job_id: job.id,
        state: job.state,
        code: job.errorCode,
        ...(job.message ? { message: job.message } : {}),
        elapsed_ms: Math.round(performance.now() - started),
      }),
    );
    if (job.state !== "succeeded")
      throw new Error("Packaged Pi preparation did not succeed");

    await assertNoFreshHarnessPi(home);
    const config = join(home, "mcp.json");
    await writeFile(config, '{"mcpServers":{}}', { flag: "wx", mode: 0o600 });
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: join(home, "pi-profile"),
      LINGER_PI_MANAGED_MCP_CONFIG: config,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const probeStart = performance.now();
    // Resource flags match PiRPCResourceArgs in
    // apps/computer/local-daemon/internal/provider/native/pi_catalog.go.
    await probePi(
      bundledPi,
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
        "--system-prompt",
        "",
        "--extension",
        extension,
        "--tools",
        "read,powershell,edit,write,grep,find,ls,mcp__*",
      ],
      { cwd: home, env },
    );
    console.log(
      JSON.stringify({
        phase: "pi_mcp_rpc",
        result: "passed",
        elapsed_ms: Math.round(performance.now() - probeStart),
      }),
    );
  } finally {
    if (manager.pid && manager.exitCode === null)
      spawnSync("taskkill.exe", ["/PID", String(manager.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
