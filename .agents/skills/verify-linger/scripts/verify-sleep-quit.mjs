#!/usr/bin/env node
// Sleep, wake, crash and quit proof for an installed Linger Desktop that runs
// local models. It attaches to a running app, emulates system sleep by
// freezing the app's process tree (SIGSTOP/SIGCONT, NtSuspendProcess on
// Windows), kills the model engine mid-Run, quits and crashes the app, and
// relaunches it. After each step it checks the processes, the listening ports,
// the Computer's state in TeamHub and a real Run on the local model through
// scripts/acceptance/room-journey.mjs. Evidence goes to
// test-results/verify-linger/sleep-quit.<random>/.
//
// A frozen process tree is not a real sleep: the monotonic clock keeps
// running while processes are stopped, so every timer fires at once on thaw,
// and the GPU, network links and the OS clock do not sleep. The real lid
// close, Windows sleep, hibernate and Modern Standby cases are manual; see
// features/local-models-and-byok.md#sleep-wake-and-quit.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const isWindows = process.platform === "win32";
const PHASES = [
  "baseline",
  "freeze-all",
  "freeze-daemon",
  "run-across-freeze",
  "engine-kill",
  "quit",
  "relaunch",
  "crash",
  "relaunch",
];

const { values: options } = parseArgs({
  options: {
    "app-exe": { type: "string" },
    launch: { type: "string" },
    home: { type: "string", default: path.join(homedir(), ".simplexai") },
    "base-url": { type: "string" },
    "computer-id": { type: "string" },
    phases: { type: "string", default: PHASES.join(",") },
    "freeze-seconds": { type: "string", default: "90" },
    "run-timeout-seconds": { type: "string", default: "420" },
    "quit-command": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (options.help || !options["app-exe"]) {
  process.stdout.write(
    [
      "Usage: node .agents/skills/verify-linger/scripts/verify-sleep-quit.mjs \\",
      "  --app-exe <Linger executable> --launch '<command that starts Linger>' \\",
      "  [--home <Linger home, default ~/.simplexai>] [--base-url <local origin>] \\",
      "  [--computer-id <id>] [--phases a,b,...] [--freeze-seconds 90] \\",
      "  [--run-timeout-seconds 420] [--quit-command '<graceful quit>']",
      "",
      `Phases (default order): ${PHASES.join(", ")}`,
      "The app must be set up with local models and running. Quit on Linux and",
      "macOS sends SIGTERM, which Electron turns into app.quit(); on Windows",
      "pass --quit-command (for example a tray automation), because",
      "`Linger.exe --quit` takes the uninstaller's path and leaves local models.",
      "",
    ].join("\n"),
  );
  process.exit(options.help ? 0 : 2);
}

const appExe = path.resolve(options["app-exe"]);
const home = path.resolve(options.home);
const freezeMs = Number(options["freeze-seconds"]) * 1000;
const runTimeoutSeconds = Number(options["run-timeout-seconds"]);
const evidenceBase = path.join(repoRoot, "test-results", "verify-linger");
mkdirSync(evidenceBase, { recursive: true, mode: 0o700 });
const evidence = mkdtempSync(path.join(evidenceBase, "sleep-quit."));
// The installer's owner account; room-journey.mjs reads its own field names
// from a private copy outside the evidence folder.
const account = JSON.parse(
  readFileSync(
    path.join(home, "instances", "desktop", "local-account.json"),
    "utf8",
  ),
);
const owner = {
  owner_email: account.owner_email ?? account.email,
  owner_password: account.owner_password ?? account.password,
};
const ownerDir = mkdtempSync(path.join(tmpdir(), "linger-sleep-quit-"));
const ownerFile = path.join(ownerDir, "owner.json");
writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
process.on("exit", () => rmSync(ownerDir, { recursive: true, force: true }));
const stopLog = path.join(home, "installer", "local-models-stop.log");

const log = (event, fields = {}) =>
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
  );
const lower = (text) => (isWindows ? text.toLowerCase() : text);

// --- Processes and ports -------------------------------------------------

function listProcesses() {
  if (isWindows) {
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { '{0}`t{1}`t{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CommandLine }";
    const out = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 },
    ).stdout;
    return out
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length >= 3 && parts[2])
      .map(([pid, ppid, ...cmd]) => ({
        pid: Number(pid),
        ppid: Number(ppid),
        cmd: cmd.join("\t"),
      }));
  }
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,stat=,args="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 << 20,
  }).stdout;
  return out
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .filter((m) => !m[3].startsWith("Z"))
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[4] }));
}

function listeningPorts() {
  const ports = new Map();
  const add = (pid, port) => {
    if (!ports.has(pid)) ports.set(pid, new Set());
    ports.get(pid).add(port);
  };
  if (isWindows) {
    const out = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-NetTCPConnection -State Listen | ForEach-Object { '{0} {1}' -f $_.OwningProcess,$_.LocalPort }",
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout;
    for (const line of out.split(/\r?\n/)) {
      const [pid, port] = line.trim().split(" ").map(Number);
      if (pid && port) add(pid, port);
    }
  } else if (process.platform === "linux") {
    const out = spawnSync("ss", ["-ltnpH"], { encoding: "utf8" }).stdout;
    for (const line of out.split("\n")) {
      const port = Number(line.match(/:(\d+)\s+\S+:\*?\S*\s/)?.[1]);
      for (const m of line.matchAll(/pid=(\d+)/g)) add(Number(m[1]), port);
    }
  } else {
    const out = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], {
      encoding: "utf8",
    }).stdout;
    let pid = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n"))
        add(pid, Number(line.slice(line.lastIndexOf(":") + 1)));
    }
  }
  return ports;
}

// Groups the processes that belong to this app and installation.
function snapshot() {
  const all = listProcesses();
  const byParent = new Map();
  for (const p of all) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const descendants = (roots) => {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length) {
      const p = queue.pop();
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      queue.push(...(byParent.get(p.pid) ?? []));
    }
    return all.filter((p) => seen.has(p.pid));
  };
  const homeText = lower(home);
  const appText = lower(appExe);
  const exeOf = (cmd) => lower(cmd.replace(/^"([^"]+)".*$/, "$1"));
  const isApp = (p) =>
    exeOf(p.cmd).startsWith(appText) || lower(p.cmd).startsWith(appText);
  const main = all.filter((p) => isApp(p) && !p.cmd.includes("--type="));
  const mainPids = new Set(main.map((p) => p.pid));
  // The app's own daemon: other Computers on the host run the same binary.
  const daemon = all.filter(
    (p) =>
      mainPids.has(p.ppid) &&
      /linger-computer-daemon(\.exe)?"?\s+--config/.test(p.cmd),
  );
  const mine = (p) => lower(p.cmd).includes(homeText);
  // localmodels may keep its gateway binary in the user's data folder.
  const userText = lower(path.dirname(home));
  const services = descendants(
    all.filter((p) => mine(p) && p.cmd.includes("native-process-worker")),
  );
  const servicePids = new Set(services.map((p) => p.pid));
  const controller = all.filter(
    (p) => mine(p) && /localmodels\s+foundations\b/.test(p.cmd),
  );
  const isGateway = (p) =>
    /^bifrost-http/i.test(path.basename(exeOf(p.cmd).split(" ")[0])) &&
    lower(p.cmd).includes(userText);
  const isModelTool = (p) =>
    mine(p) &&
    /[/\\](tools|runtime)[/\\](localmodels|model-services)[/\\]/i.test(p.cmd);
  const localModelRoots = all.filter(
    (p) =>
      !servicePids.has(p.pid) &&
      !controller.includes(p) &&
      (isGateway(p) || isModelTool(p)),
  );
  const daemonTree = descendants(daemon).filter(
    (p) => !daemon.includes(p) && !localModelRoots.includes(p),
  );
  const localModels = descendants(localModelRoots).filter(
    (p) => !controller.includes(p),
  );
  const ports = listeningPorts();
  const portsOf = (group) => [
    ...new Set(group.flatMap((p) => [...(ports.get(p.pid) ?? [])])),
  ];
  const appTree = descendants(main);
  // Processes that must outlive a freeze or a quit: per-request children
  // (database backends, tool calls) come and go.
  const serving = [...services, ...controller, ...localModels]
    .filter((p) => ports.has(p.pid))
    .map((p) => p.pid);
  return {
    at: new Date().toISOString(),
    main,
    app: appTree.filter(isApp),
    daemon,
    daemonTree,
    services,
    controller,
    localModels,
    serving,
    ports: {
      app: portsOf(appTree.filter(isApp)),
      services: portsOf(services),
      localModels: portsOf(localModels),
    },
  };
}

const pids = (group) => group.map((p) => p.pid);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

async function waitFor(check, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await delay(intervalMs);
  }
}

// --- Freeze and thaw ------------------------------------------------------

function windowsSuspend(ids, resume) {
  if (!ids.length) return;
  const call = resume ? "NtResumeProcess" : "NtSuspendProcess";
  const script = `
Add-Type -Namespace LV -Name Nt -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);
[DllImport("kernel32.dll")] public static extern System.IntPtr OpenProcess(int a, bool i, int p);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);
'@
foreach ($id in @(${ids.join(",")})) {
  $h = [LV.Nt]::OpenProcess(0x0800, $false, $id)
  if ($h -ne [System.IntPtr]::Zero) { [void][LV.Nt]::${call}($h); [void][LV.Nt]::CloseHandle($h) }
}`;
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true },
  );
}

function freeze(ids) {
  if (isWindows) return windowsSuspend(ids, false);
  for (const pid of ids) {
    try {
      process.kill(pid, "SIGSTOP");
    } catch {
      // Gone already.
    }
  }
}

function thaw(ids) {
  if (isWindows) return windowsSuspend(ids, true);
  for (const pid of ids) {
    try {
      process.kill(pid, "SIGCONT");
    } catch {
      // Gone already.
    }
  }
}

function kill(pid) {
  if (isWindows)
    spawnSync("taskkill.exe", ["/F", "/PID", String(pid)], {
      windowsHide: true,
    });
  else
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
}

// --- TeamHub --------------------------------------------------------------

function baseUrl() {
  if (options["base-url"]) return new URL(options["base-url"]).origin;
  const record = JSON.parse(
    readFileSync(path.join(home, "desktop", "local-server.json"), "utf8"),
  );
  return new URL(record.origin ?? record.serverUrl).origin;
}

let session;
async function api(route, body) {
  const origin = baseUrl();
  if (!session) {
    const response = await fetch(`${origin}/v0/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier: owner.owner_email,
        password: owner.owner_password,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`login: HTTP ${response.status}`);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const { identity } = await response.json();
    session = {
      cookie,
      tenant: identity.actors.find((actor) => actor.tenant_id).tenant_id,
    };
  }
  const response = await fetch(
    `${origin}${route.replace("{tenant}", encodeURIComponent(session.tenant))}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: session.cookie,
        origin,
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 401) session = undefined;
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}

async function computer() {
  try {
    const inventory = await api("/v0/tenants/{tenant}/local-computers");
    const items = inventory.items ?? [];
    const id =
      options["computer-id"] ??
      (items.length === 1 ? items[0].computer_id : undefined);
    return items.find((item) => item.computer_id === id);
  } catch (error) {
    return { status: "unreachable", error: String(error) };
  }
}

async function online(timeoutMs) {
  const started = Date.now();
  const found = await waitFor(
    async () => {
      const c = await computer();
      return c?.status === "online" ? c : undefined;
    },
    timeoutMs,
    2000,
  );
  return found ? Date.now() - started : undefined;
}

// A real Run on the Computer's Pi with its default local model.
function journey() {
  const lines = [];
  let resolveSent;
  const sent = new Promise((resolve) => (resolveSent = resolve));
  const done = (async () => {
    const c = await computer();
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts", "acceptance", "room-journey.mjs")],
      {
        env: {
          ...process.env,
          LINGER_ACCEPTANCE_BASE_URL: `${baseUrl()}/`,
          LINGER_ACCEPTANCE_COMPUTER_ID: c?.computer_id ?? "missing",
          LINGER_ACCEPTANCE_OWNER_FILE: ownerFile,
          LINGER_ACCEPTANCE_TIMEOUT_SECONDS: String(runTimeoutSeconds),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        lines.push(line);
        if (line.includes('"phase":"sent"')) resolveSent(true);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => lines.push(chunk.trim()));
    const code = await new Promise((resolve) => child.on("close", resolve));
    resolveSent(false);
    const last = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .at(-1);
    return { code, outcome: last?.phase ?? "error", lines };
  })();
  return { sent, done };
}

// The status TeamHub shows for the Run a journey started: active, completed
// or aborted; "timeout" when it stays active.
async function runStatus(result, timeoutMs) {
  const sent = result.lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .find((entry) => entry?.phase === "sent");
  if (!sent) return "not_sent";
  const route = `/v0/rooms/${encodeURIComponent(sent.room_id)}/runtime-presentation-runs?message_id=${encodeURIComponent(sent.message_id)}`;
  const status = await waitFor(
    async () => {
      const page = await api(route).catch(() => undefined);
      const run = page?.items?.find((item) => item.agent?.id === sent.agent_id);
      return run && run.status !== "active" ? run.status : undefined;
    },
    timeoutMs,
    3000,
  );
  return status ?? "timeout";
}

// --- Phases ---------------------------------------------------------------

// room-journey.mjs outcomes of a Run that replied as asked.
const COMPLETED = ["room_observed", "verified"];

const results = [];
let step = 0;
async function record(name, run) {
  step += 1;
  const id = `${String(step).padStart(2, "0")}-${name}`;
  log("phase.started", { phase: id });
  const before = snapshot();
  const checks = [];
  const check = (what, ok, details = {}) => {
    checks.push({ what, ok, ...details });
    log(ok ? "check.passed" : "check.failed", { phase: id, what, ...details });
  };
  const notes = [];
  try {
    await run({ before, check, note: (text) => notes.push(text) });
  } catch (error) {
    check("phase ran", false, { error: String(error?.stack ?? error) });
  }
  const after = snapshot();
  const result = {
    phase: id,
    status: checks.every((c) => c.ok) ? "passed" : "failed",
    checks,
    notes,
    before,
    after,
  };
  results.push(result);
  await writeFile(
    path.join(evidence, `${id}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  log("phase.finished", { phase: id, status: result.status });
}

// Starts a journey once the Computer is online, and once more when the first
// attempt fails before it sends its message (TeamHub still waking up).
async function startJourney() {
  await online(180_000);
  const first = journey();
  if (await first.sent) return first;
  await first.done;
  await delay(5_000);
  await online(60_000);
  return journey();
}

async function runCheck(check, label) {
  const { done } = await startJourney();
  const result = await done;
  check(label, COMPLETED.includes(result.outcome), {
    outcome: result.outcome,
    tail: result.lines.slice(-2),
  });
  return result;
}

const everything = (s) => [
  ...pids(s.app),
  ...pids(s.daemon),
  ...pids(s.daemonTree),
  ...pids(s.services),
  ...pids(s.controller),
  ...pids(s.localModels),
];

async function freezeFor(s, check) {
  const ids = everything(s);
  freeze(ids);
  log("freeze", { pids: ids.length, ms: freezeMs });
  try {
    await delay(freezeMs);
  } finally {
    thaw(ids);
    log("thaw", { pids: ids.length });
  }
  const lasting = [...pids(s.main), ...pids(s.daemon), ...s.serving];
  check(
    "the app, daemon and serving processes survived",
    lasting.every(alive),
    {
      lost: lasting.filter((pid) => !alive(pid)),
    },
  );
}

const phases = {
  async baseline({ before, check }) {
    check("app is running", before.main.length === 1, {
      main: pids(before.main),
    });
    check("one daemon", before.daemon.length === 1, {
      daemon: pids(before.daemon),
    });
    check("local model processes are up", before.localModels.length > 0, {
      ports: before.ports.localModels,
    });
    check("Computer is online", (await online(60_000)) !== undefined);
    await runCheck(check, "a Run on the local model completes");
  },

  // Lid close or system sleep with the whole stack on this computer.
  async "freeze-all"({ before, check }) {
    await freezeFor(before, check);
    const ms = await online(180_000);
    check("Computer is online again after thaw", ms !== undefined, { ms });
    const after = snapshot();
    check("still one daemon", after.daemon.length === 1, {
      daemon: pids(after.daemon),
    });
    await runCheck(check, "a Run after wake completes");
  },

  // The Computer asleep while TeamHub stays up (a remote server, or a
  // Computer that lost its network).
  async "freeze-daemon"({ before, check, note }) {
    const ids = [...pids(before.daemon), ...pids(before.daemonTree)];
    const frozenAt = Date.now();
    freeze(ids);
    try {
      const offline = await waitFor(
        async () =>
          (await computer())?.status === "offline" ? true : undefined,
        freezeMs,
        2000,
      );
      note(
        `TeamHub marked the Computer offline while frozen: ${offline === true} after ${Date.now() - frozenAt} ms`,
      );
      await delay(Math.max(0, freezeMs - (Date.now() - frozenAt)));
    } finally {
      thaw(ids);
    }
    const ms = await online(120_000);
    check("Computer reconnects after thaw", ms !== undefined, { ms });
    await runCheck(check, "a Run after reconnect completes");
  },

  // Sleep in the middle of a Run.
  async "run-across-freeze"({ check, note }) {
    const run = await startJourney();
    const sent = await run.sent;
    check("Run started", sent);
    await delay(2_000);
    await freezeFor(snapshot(), check);
    const result = await run.done;
    // room-journey.mjs gives up when TeamHub is frozen under its requests;
    // the Run's own status says how it ended.
    const status = await runStatus(result, runTimeoutSeconds * 1000);
    note(`in-flight Run: journey ${result.outcome}, Run status ${status}`);
    check(
      "the in-flight Run reaches a terminal state",
      status === "completed" || status === "aborted",
      { status, tail: result.lines.slice(-2) },
    );
    await runCheck(check, "the next Run completes");
  },

  // The model engine dies in the middle of a Run (driver reset after
  // resume, out-of-memory kill).
  async "engine-kill"({ check, note }) {
    const run = await startJourney();
    check("Run started", await run.sent);
    await delay(3_000);
    const s = snapshot();
    const ports = listeningPorts();
    const engines = s.localModels.filter(
      (p) => ports.has(p.pid) && !/bifrost-http/i.test(p.cmd),
    );
    note(
      `killed engines: ${engines.map((p) => p.cmd.slice(0, 160)).join(" | ")}`,
    );
    check("found a model engine to kill", engines.length > 0);
    for (const p of engines) kill(p.pid);
    const result = await run.done;
    const status = await runStatus(result, runTimeoutSeconds * 1000);
    note(`in-flight Run: journey ${result.outcome}, Run status ${status}`);
    check(
      "the in-flight Run reaches a terminal state",
      status === "completed" || status === "aborted",
      { status, tail: result.lines.slice(-2) },
    );
    await runCheck(check, "the next Run loads the model again and completes");
  },

  async quit({ before, check, note }) {
    // The app rewrites the log on every quit; its text can repeat.
    const quitAt = Date.now();
    if (options["quit-command"]) {
      spawnSync(options["quit-command"], { shell: true, stdio: "inherit" });
    } else if (isWindows) {
      throw new Error("pass --quit-command on Windows");
    } else {
      for (const p of before.main) process.kill(p.pid, "SIGTERM");
    }
    check(
      "app exits",
      (await waitFor(() => !before.main.some((p) => alive(p.pid)), 60_000)) ===
        true,
    );
    check(
      "daemon exits with the app",
      (await waitFor(
        () => !before.daemon.some((p) => alive(p.pid)),
        15_000,
      )) === true,
    );
    const outcome = await waitFor(() => {
      if (!existsSync(stopLog) || statSync(stopLog).mtimeMs < quitAt - 1000)
        return undefined;
      const text = readFileSync(stopLog, "utf8");
      const line = text.trim().split("\n").at(-1);
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    }, 150_000);
    check(
      "the local model stop finished without failures",
      outcome?.failed?.length === 0,
      {
        outcome,
      },
    );
    const engines = pids(before.localModels);
    const gone = await waitFor(() => !engines.some(alive), 30_000);
    check("model engines and the model gateway exited", gone === true, {
      left: engines.filter(alive),
    });
    const ports = listeningPorts();
    const held = before.ports.localModels.filter((port) =>
      [...ports.values()].some((set) => set.has(port)),
    );
    check("their ports are free", held.length === 0, { held });
    check(
      "the collaboration services keep running",
      before.serving
        .filter((pid) => pids(before.services).includes(pid))
        .every(alive),
    );
    const leftovers = snapshot();
    check("no daemon is left", leftovers.daemon.length === 0, {
      daemon: pids(leftovers.daemon),
    });
    note(`kept: controller ${pids(leftovers.controller).join(",") || "none"}`);
  },

  // A crash or force quit: no before-quit, so no local model stop.
  async crash({ before, check, note }) {
    for (const p of before.main) kill(p.pid);
    check(
      "daemon exits when the app dies",
      (await waitFor(
        () => !before.daemon.some((p) => alive(p.pid)),
        15_000,
      )) === true,
      { daemon: pids(before.daemon) },
    );
    await delay(5_000);
    const after = snapshot();
    note(
      `local model processes left running after the crash: ${after.localModels.length} (ports ${after.ports.localModels.join(",")})`,
    );
    check("no app process is left", after.app.length === 0, {
      app: pids(after.app),
    });
  },

  async relaunch({ before, check }) {
    if (!options.launch) throw new Error("pass --launch");
    check("nothing of the app runs before relaunch", before.main.length === 0);
    spawn(options.launch, {
      shell: true,
      detached: !isWindows,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    const started = await waitFor(() => snapshot().main.length === 1, 60_000);
    check("app starts", started === true);
    const ms = await online(300_000);
    check("Computer is online after relaunch", ms !== undefined, { ms });
    const s = snapshot();
    check("one daemon", s.daemon.length === 1, { daemon: pids(s.daemon) });
    // Runs reach the model through the stack's gateway; the library's
    // per-model state is a separate view and may stay idle.
    const serving = await waitFor(
      () => {
        const ports = snapshot().ports.localModels;
        return ports.length > 1 ? ports : undefined;
      },
      300_000,
      5_000,
    );
    check("the model engine and gateway listen again", serving !== undefined, {
      ports: serving,
    });
    await runCheck(check, "a Run after relaunch completes");
  },
};

log("evidence", { dir: evidence });
for (const name of options.phases.split(",").map((value) => value.trim())) {
  const run = phases[name];
  if (!run) {
    log("phase.unknown", { phase: name });
    process.exitCode = 2;
    continue;
  }
  await record(name, run);
}
const summary = results.map((r) => ({ phase: r.phase, status: r.status }));
await writeFile(
  path.join(evidence, "summary.json"),
  `${JSON.stringify({ platform: process.platform, summary }, null, 2)}\n`,
  { mode: 0o600 },
);
log("summary", { summary });
if (results.some((r) => r.status !== "passed")) process.exitCode = 1;
