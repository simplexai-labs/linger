import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);
const installScriptPath = path.join(
  repositoryRoot,
  "scripts/install/install.sh",
);

const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

interface ScriptRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ComputerInvocation {
  argv: string[];
  path: string;
  piAgentDir: string;
}

interface FakeEngineScenario {
  acceptedStack?: boolean;
  lastRunState?: string;
  enforcePrivateRoot?: boolean;
  bootstrapError?: string;
  applyOutputLines?: string[];
  upFailsWithoutShareGpu?: boolean;
  preflightFail?: boolean;
  picks?: Array<{
    role: string;
    id: string;
    quant: string;
    quality: number;
    decodeTokS: number;
    decodeBasis: string;
    card: number;
    shared: boolean;
  }>;
  planPreflightWarn?: string;
  createGatewayPiOnApply?: boolean;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linger-install-test-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function resolvePythonExecutable(): Promise<string> {
  const { stdout } = await execFileAsync("sh", [
    "-c",
    "command -v python3 || command -v python",
  ]);
  const resolved = stdout.trim();
  if (!resolved) {
    throw new Error("python3 is required to run install.sh script tests");
  }
  return resolved;
}

async function createFakeStackScript(
  root: string,
  scenario: FakeEngineScenario,
): Promise<{
  scriptPath: string;
  logPath: string;
  kitHomeLogPath: string;
}> {
  const pythonBin = await resolvePythonExecutable();
  const scriptPath = path.join(root, "fake-stack.sh");
  const logPath = path.join(root, "stack-calls.log");
  const kitHomeLogPath = path.join(root, "kit-homes.log");
  const statusJsonPath = path.join(root, "fixture-status.json");
  const hardwareJsonPath = path.join(root, "fixture-hardware.json");
  const gatewayPiDir = path.join(
    root,
    "home",
    ".local/share/localmodels/tools/gateway-home/.pi/agent",
  );
  const piBinPath = path.join(root, "home", ".local/bin/pi");

  const statusPayload = scenario.acceptedStack
    ? {
        deployments: [{ name: "qwen3.8-27b", state: "active", ok: true }],
        last_run: {
          ok: true,
          plan_id: "plan-123456789abc",
          state: scenario.lastRunState ?? "completed",
          started_at: "2026-11-17T00:00:00Z",
          finished_at: "2026-11-17T00:05:00Z",
        },
      }
    : {
        deployments: [],
        last_run: null,
      };
  await writeFile(statusJsonPath, JSON.stringify(statusPayload));

  const picks = scenario.picks ?? [
    {
      role: "smartest",
      id: "qwen3.8-32b",
      quant: "UD-Q4_K_M",
      quality: 92,
      decodeTokS: 38,
      decodeBasis: "estimated",
      card: 0,
      shared: false,
    },
  ];
  const hardwarePayload = {
    system: "Linux",
    arch: "x86_64",
    ram_total_bytes: 128 * 1024 ** 3,
    ram_available_bytes: 96 * 1024 ** 3,
    disk_free_bytes: 400 * 1024 ** 3,
    cards: [
      {
        index: 0,
        name: "NVIDIA RTX PRO 6000",
        total_bytes: 96 * 1024 ** 3,
        free_bytes: 52 * 1024 ** 3,
        held_by: picks.some((p) => p.shared) ? ["vllm"] : [],
        auto: !picks.some((p) => p.shared),
      },
    ],
    picks: picks.map((p) => ({
      role: p.role,
      id: p.id,
      quant: p.quant,
      quality: p.quality,
      decode_tok_s: p.decodeTokS,
      decode_basis: p.decodeBasis,
      card: p.card,
      shared: p.shared,
    })),
  };
  await writeFile(hardwareJsonPath, JSON.stringify(hardwarePayload));

  const warnFinding: Array<{
    check: string;
    level: string;
    detail: string;
    fix?: string;
  }> = scenario.planPreflightWarn
    ? [
        {
          check: "preflight.gpu",
          level: "warn",
          detail: "2 compute process(es) outside the stack on its GPU",
          fix: "make sure they can share the card",
        },
        {
          check: "preflight.running",
          level: "warn",
          detail:
            "this tool still runs 1 other deployment(s): kokoro-82m-18380",
          fix: "use stack plan --update, or stop one with 'stack service local foo stop'",
        },
        {
          check: "preflight.note",
          level: "warn",
          detail: scenario.planPreflightWarn,
          fix: "Run stack up after reboot, or plan another --llm-port",
        },
      ]
    : [];
  if (scenario.preflightFail) {
    warnFinding.push({
      check: "preflight.disk",
      level: "fail",
      detail: "Not enough free disk space; see stack.sh docs",
      fix: "Free 20 GiB and retry stack plan",
    });
  }
  const planTemplate = {
    plan_id: "plan-abcdef123456",
    llm: {
      model: {
        id: "qwen3.8-27b",
        display_name: "Qwen 3.8 27B",
        quant: "UD-Q4_K_M",
      },
      placement: {
        label: "GPU 0",
      },
      launch: {
        window: 131072,
      },
    },
    decision: {
      model: {
        id: "qwen3-4b",
        display_name: "Qwen 3 4B",
      },
    },
    aux: [
      {
        name: "embed",
        endpoint: { contract: "embedding" },
        model: { id: "bge-m3", display_name: "BGE M3" },
      },
    ],
    budget: {
      download_bytes: 18 * 1024 ** 3,
      disk_needed_bytes: 20 * 1024 ** 3,
      ram_needed_bytes: 8 * 1024 ** 3,
      ram_available_bytes: 96 * 1024 ** 3,
    },
    preflight: {
      counts: {
        pass: 3,
        warn: warnFinding.filter((f) => f.level === "warn").length,
        fail: warnFinding.filter((f) => f.level === "fail").length,
      },
      findings: warnFinding,
    },
  };
  const planTemplatePath = path.join(root, "fixture-plan.json");
  await writeFile(planTemplatePath, JSON.stringify(planTemplate));

  const createPiOnApply = scenario.createGatewayPiOnApply !== false;
  const enforcePrivateRoot = scenario.enforcePrivateRoot ? "1" : "0";
  const applyLines = scenario.applyOutputLines
    ? scenario.applyOutputLines
        .map((line) => `    printf '%s\\n' ${JSON.stringify(line)}`)
        .join("\n")
    : `    printf 'Applied plan %s\\n' "\${4:-}"`;
  const bootstrapFailure = scenario.bootstrapError
    ? `  printf '%s\\n' ${JSON.stringify(scenario.bootstrapError)} >&2\n  exit 2\n`
    : "";
  const upShareGuard = scenario.upFailsWithoutShareGpu
    ? `    if [ "\${2:-}" != "--share-gpu" ]; then\n      printf 'stack: GPU busy; pass --share-gpu\\n' >&2\n      exit 3\n    fi\n`
    : "";
  const content = `#!/bin/sh
set -eu
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [ "${enforcePrivateRoot}" = "1" ] && [ "\${1:-}" = "--bootstrap-json" ]; then
  kit_root="\${LOCALMODELS_KIT_HOME:-\${XDG_CACHE_HOME:-\${HOME}/.cache}/simplex-localmodels/kits}"
  printf '%s\n' "$kit_root" >> ${JSON.stringify(kitHomeLogPath)}
  owner="$(id -u)"
  ancestor="$(dirname "$kit_root")"
  while :; do
    [ ! -L "$ancestor" ] || { printf 'stack.sh: cache root must be a private owned directory\n' >&2; exit 2; }
    if [ -e "$ancestor" ]; then
      bad_parent="$(find "$ancestor" -prune \\( \\( ! -user "$owner" ! -user 0 \\) -o \\( \\( -perm -0020 -o -perm -0002 \\) ! -perm -1000 \\) \\) -print || true)"
      [ -z "$bad_parent" ] || { printf 'stack.sh: cache root must be a private owned directory\n' >&2; exit 2; }
    fi
    [ "$ancestor" != / ] || break
    ancestor="$(dirname "$ancestor")"
  done
fi
case "\${1:-}" in
  --bootstrap-json)
${bootstrapFailure}    printf '{"schema":"localmodels.kit-location/v1","kitRoot":%s,"python":%s,"moduleDir":"modules"}\n' \
      ${JSON.stringify(JSON.stringify(root))} \
      ${JSON.stringify(JSON.stringify(pythonBin))}
    ;;
  status)
    if [ "\${2:-}" = "--json" ]; then
      cat ${JSON.stringify(statusJsonPath)}
    else
      printf 'qwen3.8-27b active\n'
      printf 'Services down after a reboot? python3 -m localmodels stack up starts them without reinstalling\n'
    fi
    ;;
  hardware)
    cat ${JSON.stringify(hardwareJsonPath)}
    ;;
  plan)
    out_file=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--out" ]; then
        out_file="$arg"
      fi
      prev="$arg"
    done
    cp ${JSON.stringify(planTemplatePath)} "$out_file"
    cat "$out_file"
    ;;
  apply)
${applyLines}
    if [ "${createPiOnApply ? "1" : "0"}" = "1" ]; then
      mkdir -p ${JSON.stringify(path.dirname(piBinPath))} ${JSON.stringify(gatewayPiDir)}
      cat <<'PIEOF' > ${JSON.stringify(piBinPath)}
#!/bin/sh
exit 0
PIEOF
      chmod 0755 ${JSON.stringify(piBinPath)}
      printf '{"providers":{}}\n' > ${JSON.stringify(path.join(gatewayPiDir, "models.json"))}
    fi
    ;;
  up)
${upShareGuard}    printf 'Local model stack is ready\n'
    ;;
  remove)
    case " $* " in
      *" --dry-run "*)
        printf 'Would delete cached weights via stack remove --purge\n'
        ;;
      *)
        printf 'Removed. Run stack remove --purge to free downloaded files.\n'
        ;;
    esac
    ;;
  *)
    printf 'stack.sh: unexpected subcommand %s\n' "\${1:-}" >&2
    exit 2
    ;;
esac
`;
  await writeFile(scriptPath, content, { mode: 0o755 });
  return { scriptPath, logPath, kitHomeLogPath };
}

async function startMockLingerServer(
  root: string,
  authorized: boolean,
): Promise<{
  baseUrl: string;
  installerRequests: () => number;
  computerLogPath: string;
}> {
  const computerLogPath = path.join(root, "computer-calls.jsonl");
  const binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  let requestCount = 0;

  const installerScript = `#!/usr/bin/env bash
# linger-computer-launcher-v2
set -euo pipefail
web_origin="\${LINGER_WEB_URL:?LINGER_WEB_URL is required}"
rest="\${web_origin#*://}"
host="\${rest%%:*}"
port="\${rest#"$host"}"
port="\${port#:}"
env_name="local-\${port}"
bin_dir="\${LINGER_COMPUTER_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
launcher="$bin_dir/linger-computer-$env_name"
cat <<'CLI_EOF' > "$launcher"
#!/usr/bin/env bash
# linger-computer-launcher-v2
set -euo pipefail
printf '{"argv":[' >> ${JSON.stringify(computerLogPath)}
first=1
for a in "$@"; do
  if [ "$first" -eq 0 ]; then printf ',' >> ${JSON.stringify(computerLogPath)}; fi
  printf '"%s"' "$(printf '%s' "$a" | sed 's/"/\\"/g')" >> ${JSON.stringify(computerLogPath)}
  first=0
done
printf '],"path":"%s","piAgentDir":"%s"}\n' \
  "$(printf '%s' "\${PATH:-}" | sed 's/"/\\"/g')" \
  "$(printf '%s' "\${PI_CODING_AGENT_DIR:-}" | sed 's/"/\\"/g')" >> ${JSON.stringify(computerLogPath)}

if [ "\${1:-}" = "auth" ] && [ "\${2:-}" = "status" ]; then
  printf '{"version":1,"authorized":${authorized ? "true" : "false"}}\n'
  exit 0
fi
if [ "\${1:-}" = "daemon" ] && [ "\${2:-}" = "status" ]; then
  printf 'Daemon: running\n'
  exit 0
fi
exit 0
CLI_EOF
chmod 0755 "$launcher"
`;

  const server: Server = createServer((req, res) => {
    if (req.url === "/install/linger-computer.sh") {
      requestCount += 1;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(installerScript);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    installerRequests: () => requestCount,
    computerLogPath,
  };
}

async function runInstallScript(
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    input?: string;
    scriptPath?: string;
    cwd?: string;
  },
): Promise<ScriptRunResult> {
  return await new Promise<ScriptRunResult>((resolve, reject) => {
    const child = spawn(
      "bash",
      [options.scriptPath ?? installScriptPath, ...args],
      {
        cwd: options.cwd ?? repositoryRoot,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

function buildTestEnv(root: string, stackScript: string): NodeJS.ProcessEnv {
  const homeDir = path.join(root, "home");
  const binDir = path.join(root, "bin");
  return {
    HOME: homeDir,
    PATH: `/usr/local/bin:/usr/bin:/bin`,
    LINGER_STACK_SCRIPT: stackScript,
    LINGER_COMPUTER_BIN_DIR: binDir,
  };
}

async function readComputerCalls(
  logPath: string,
): Promise<ComputerInvocation[]> {
  const raw = await readFile(logPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComputerInvocation);
}

describe("root install.sh", () => {
  it("prints help without exposing internal stack.sh or PI_CODING_AGENT_DIR details", async () => {
    const root = await createTempRoot();
    const { scriptPath } = await createFakeStackScript(root, {});
    const result = await runInstallScript(["--help"], {
      env: buildTestEnv(root, scriptPath),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--web-url");
    expect(result.stdout).toContain("--connect");
    expect(result.stdout).toContain("--up");
    expect(result.stdout).toContain("--status");
    expect(result.stdout).toContain("--remove");
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain("stack.sh");
    expect(combined).not.toContain("PI_CODING_AGENT_DIR");
    expect(combined).not.toContain("gateway-home");
  });

  it("guides through shared GPU selection, plan approval, and linger-computer login", async () => {
    const root = await createTempRoot();
    const homeDir = path.join(root, "home");
    await mkdir(homeDir, { recursive: true });
    const { scriptPath, logPath } = await createFakeStackScript(root, {
      picks: [
        {
          role: "smartest",
          id: "qwen3.8-32b",
          quant: "UD-Q4_K_M",
          quality: 92,
          decodeTokS: 38,
          decodeBasis: "estimated",
          card: 0,
          shared: true,
        },
        {
          role: "fastest",
          id: "qwen3.8-9b",
          quant: "Q4_K_M",
          quality: 78,
          decodeTokS: 72,
          decodeBasis: "measured-decode",
          card: 0,
          shared: true,
        },
      ],
      planPreflightWarn: "Shared card detected; check stack.sh settings",
    });
    const server = await startMockLingerServer(root, false);

    const result = await runInstallScript(["--web-url", server.baseUrl], {
      env: buildTestEnv(root, scriptPath),
      input: ["2", "y", "24G", "y", "y"].join("\n") + "\n",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[1/4] Checking Linger server");
    expect(result.stdout).toContain(
      "[2/4] Checking hardware and model options",
    );
    expect(result.stdout).toContain(
      "[3/4] Installing and verifying the local model",
    );
    expect(result.stdout).toContain("[4/4] Connecting this computer to Linger");

    const stackCalls = (await readFile(logPath, "utf8")).trim().split("\n");
    const planCall = stackCalls.find((line) => line.startsWith("plan "));
    expect(planCall).toBeDefined();
    expect(planCall).not.toContain("search");
    expect(planCall).toContain("--prefer fastest");
    expect(planCall).toContain("--gpu 0");
    expect(planCall).toContain("--share-gpu");
    expect(planCall).toContain("--gpu-memory 24G");
    expect(planCall).toContain("--decision auto");
    expect(planCall).toContain("--aux embedding,reranker");

    expect(result.stdout).not.toContain("2 compute process(es) outside");
    expect(result.stdout).toContain("kept untouched on separate ports");
    expect(result.stdout).not.toContain("stack service");
    expect(result.stdout).not.toContain("--llm-port");

    const applyCall = stackCalls.find((line) => line.startsWith("apply "));
    expect(applyCall).toContain("--approve plan-abcdef123456");

    expect(server.installerRequests()).toBe(2);
    const computerCalls = await readComputerCalls(server.computerLogPath);
    const expectedPiDir = path.join(
      homeDir,
      ".local/share/localmodels/tools/gateway-home/.pi/agent",
    );
    const expectedPiBin = path.join(homeDir, ".local/bin/pi");

    expect(computerCalls.map((c) => c.argv.slice(0, 2))).toEqual([
      ["auth", "status"],
      ["login", "--web-url"],
      ["runtime", "check"],
    ]);
    expect(computerCalls[1]?.argv).toEqual([
      "login",
      "--web-url",
      server.baseUrl,
      "--pi-path",
      expectedPiBin,
    ]);
    expect(computerCalls[1]?.piAgentDir).toBe(expectedPiDir);
    expect(computerCalls[1]?.path).toContain(path.join(homeDir, ".local/bin"));
    expect(computerCalls[2]?.argv).toEqual([
      "runtime",
      "check",
      "pi",
      "--live",
      "--pi-path",
      expectedPiBin,
    ]);
    expect(computerCalls[2]?.piAgentDir).toBe(expectedPiDir);

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain("stack.sh");
    expect(combined).not.toContain("PI_CODING_AGENT_DIR");
    expect(combined).not.toContain("gateway-home");
  });

  it("exits cleanly when plan approval is declined without downloading or connecting", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "home"), { recursive: true });
    const { scriptPath, logPath } = await createFakeStackScript(root, {});
    const server = await startMockLingerServer(root, false);

    const result = await runInstallScript(["--web-url", server.baseUrl], {
      env: buildTestEnv(root, scriptPath),
      input: ["n", "n"].join("\n") + "\n",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Nothing was downloaded or changed");
    const stackCalls = await readFile(logPath, "utf8");
    expect(stackCalls).not.toContain("apply ");
    expect(server.installerRequests()).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("stack.sh");
  });

  it("reuses an accepted local model stack and restarts an authorized computer daemon", async () => {
    const root = await createTempRoot();
    const homeDir = path.join(root, "home");
    const piDir = path.join(
      homeDir,
      ".local/share/localmodels/tools/gateway-home/.pi/agent",
    );
    const piBin = path.join(homeDir, ".local/bin/pi");
    await mkdir(piDir, { recursive: true });
    await mkdir(path.dirname(piBin), { recursive: true });
    await writeFile(path.join(piDir, "models.json"), "{}");
    await writeFile(piBin, "#!/bin/sh\nexit 0\n");
    await chmod(piBin, 0o755);

    const { scriptPath, logPath } = await createFakeStackScript(root, {
      acceptedStack: true,
    });
    const server = await startMockLingerServer(root, true);

    const result = await runInstallScript(["--web-url", server.baseUrl], {
      env: buildTestEnv(root, scriptPath),
      input: "\n",
    });

    expect(result.code).toBe(0);
    const stackCalls = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(stackCalls).toContain("up");
    expect(stackCalls.some((line) => line.startsWith("hardware"))).toBe(false);
    expect(stackCalls.some((line) => line.startsWith("plan"))).toBe(false);
    expect(stackCalls.some((line) => line.startsWith("apply"))).toBe(false);

    const computerCalls = await readComputerCalls(server.computerLogPath);
    expect(computerCalls.map((c) => c.argv.slice(0, 2))).toEqual([
      ["auth", "status"],
      ["daemon", "restart"],
      ["runtime", "check"],
    ]);
    expect(computerCalls[1]?.piAgentDir).toBe(piDir);
  });

  it("sanitizes day-2 --status and --remove output without exposing stack commands", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "home"), { recursive: true });
    const { scriptPath, logPath } = await createFakeStackScript(root, {
      acceptedStack: true,
    });

    const statusResult = await runInstallScript(["--status"], {
      env: buildTestEnv(root, scriptPath),
    });
    expect(statusResult.code).toBe(0);
    expect(statusResult.stdout).toContain("./scripts/install/install.sh --up");
    expect(statusResult.stdout).not.toContain("stack up");
    expect(statusResult.stdout).not.toContain("localmodels");

    const removeResult = await runInstallScript(
      ["--remove", "--purge", "--yes"],
      {
        env: buildTestEnv(root, scriptPath),
      },
    );
    expect(removeResult.code).toBe(0);
    expect(removeResult.stdout).toContain(
      "./scripts/install/install.sh --remove --purge",
    );
    expect(removeResult.stdout).not.toContain("stack remove");

    const stackCalls = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(stackCalls).toContain("status");
    expect(stackCalls).toContain("remove --purge --yes");
  });

  it("falls back from group-writable XDG cache to a private kit root and temp fallback", async () => {
    const root = await createTempRoot();
    const homeDir = path.join(root, "home");
    const xdgCache = path.join(root, "shared-cache");
    const privateTmp = path.join(root, "private-tmp");
    await mkdir(homeDir, { recursive: true });
    await mkdir(xdgCache, { recursive: true });
    await mkdir(privateTmp, { recursive: true });
    await chmod(root, 0o755);
    await chmod(homeDir, 0o700);
    await chmod(xdgCache, 0o775);
    await chmod(privateTmp, 0o700);

    const { scriptPath, kitHomeLogPath } = await createFakeStackScript(root, {
      enforcePrivateRoot: true,
    });

    const first = await runInstallScript(["--status"], {
      env: {
        ...buildTestEnv(root, scriptPath),
        XDG_CACHE_HOME: xdgCache,
        TMPDIR: privateTmp,
      },
    });
    expect(first.code).toBe(0);
    const firstLogged = (await readFile(kitHomeLogPath, "utf8"))
      .trim()
      .split("\n");
    expect(firstLogged[0]).toBe(path.join(homeDir, ".linger/localmodels/kits"));
    const homeKitStat = await stat(firstLogged[0] ?? "");
    expect(homeKitStat.mode & 0o777).toBe(0o700);

    await chmod(homeDir, 0o775);
    const second = await runInstallScript(["--status"], {
      env: {
        ...buildTestEnv(root, scriptPath),
        XDG_CACHE_HOME: xdgCache,
        TMPDIR: privateTmp,
      },
    });
    expect(second.code).toBe(0);
    const secondLogged = (await readFile(kitHomeLogPath, "utf8"))
      .trim()
      .split("\n");
    expect(
      secondLogged[1]?.startsWith(path.join(privateTmp, "linger-kit.")),
    ).toBe(true);
    expect(await readdir(privateTmp)).toEqual([]);
  });

  it("reassigns colliding Compose ports and preserves LiveKit RTC ports on rerun", async () => {
    const root = await createTempRoot();
    const fakeRepo = path.join(root, "fake-repo");
    const fakeBin = path.join(root, "fake-bin");
    const homeDir = path.join(root, "home");
    const xdgCache = path.join(root, "cache");
    const dockerLogPath = path.join(root, "docker-calls.log");
    const serverStartedPath = path.join(root, "server-started");
    await mkdir(path.join(fakeRepo, "scripts/install"), { recursive: true });
    await mkdir(path.join(fakeRepo, "scripts/installs"), { recursive: true });
    await mkdir(path.join(fakeRepo, ".linger-runtime"), { recursive: true });
    await chmod(path.join(fakeRepo, ".linger-runtime"), 0o555);
    cleanups.push(async () => {
      await chmod(path.join(fakeRepo, ".linger-runtime"), 0o755);
    });
    await mkdir(fakeBin, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(xdgCache, { recursive: true });
    await chmod(homeDir, 0o700);
    await chmod(xdgCache, 0o700);

    const copiedInstallPath = path.join(fakeRepo, "scripts/install/install.sh");
    await copyFile(installScriptPath, copiedInstallPath);
    await chmod(copiedInstallPath, 0o755);

    const { scriptPath: fakeStackPath } = await createFakeStackScript(root, {});
    await copyFile(
      fakeStackPath,
      path.join(fakeRepo, "scripts/installs/stack.sh"),
    );
    await chmod(path.join(fakeRepo, "scripts/installs/stack.sh"), 0o755);

    await writeFile(fakeRepo + "/docker-compose.yml", "services:\n  web:\n");
    await writeFile(
      path.join(fakeRepo, ".env.example"),
      [
        "export WEB_PUBLIC_ORIGIN = 'http://localhost:3000'",
        "AGENT_RUNNER_PUBLIC_GATEWAY_URL=ws://127.0.0.1:4319/v1/runner-gateway",
        "LIVEKIT_URL=ws://127.0.0.1:17880",
        "# POSTGRES_PORT=5432",
        "# TEAMHUB_HTTP_PORT=8080",
        "# WEB_HTTP_PORT=3000",
        "WEB_HTTP_PORT=2999",
        '  export WEB_HTTP_PORT = "3000"',
        "# Keep this comment and the unrelated setting below.",
        "WEB_HTTP_PORT_BACKUP=3000",
      ].join("\n") + "\n",
    );

    await writeFile(
      path.join(fakeBin, "docker"),
      `#!/bin/sh
set -eu
printf '%s\n' "$*" >> ${JSON.stringify(dockerLogPath)}
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "version" ]; then
  printf '2.24.4\n'
  exit 0
fi
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "ps" ]; then
  printf '127.0.0.1:5432->5432/tcp\n'
  exit 0
fi
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "up" ]; then
  touch ${JSON.stringify(serverStartedPath)}
fi
exit 0
`,
      { mode: 0o755 },
    );

    await writeFile(
      path.join(fakeBin, "curl"),
      `#!/bin/sh
set -eu
out=""
url=""
prev=""
for a in "$@"; do
  case "$prev" in
    -o|--output) out="$a" ;;
  esac
  case "$a" in
    http://*|https://*) url="$a" ;;
  esac
  prev="$a"
done
case "$url" in
  "http://localhost:3000/install/linger-computer.sh"|"http://localhost:3001/install/linger-computer.sh")
    if [ ! -f ${JSON.stringify(serverStartedPath)} ]; then exit 22; fi
    body="# linger-computer-launcher-v2"
    if [ -n "$out" ]; then printf '%s\n' "$body" > "$out"; else printf '%s\n' "$body"; fi
    exit 0
    ;;
  *)
    exit 22
    ;;
esac
`,
      { mode: 0o755 },
    );

    const result = await runInstallScript([], {
      scriptPath: copiedInstallPath,
      cwd: fakeRepo,
      env: {
        HOME: homeDir,
        XDG_CACHE_HOME: xdgCache,
        PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin`,
        LINGER_INSTALL_BUSY_PORTS: "3000,17880,7881,7882",
      },
      input: ["1", "y", "n", "n", "n"].join("\n") + "\n",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Port(s) already in use: 3000, 17880, 7881, 7882",
    );
    expect(result.stdout).toContain("Nothing was downloaded or changed.");
    expect(result.stdout).toContain(
      "Linger server is ready at http://localhost:3001",
    );

    const updatedEnv = await readFile(path.join(fakeRepo, ".env"), "utf8");
    expect(
      updatedEnv.match(/^[ \t]*(?:export[ \t]+)?WEB_HTTP_PORT[ \t]*=.*$/gm),
    ).toEqual(["WEB_HTTP_PORT=3001"]);
    expect(
      updatedEnv.match(/^[ \t]*(?:export[ \t]+)?WEB_PUBLIC_ORIGIN[ \t]*=.*$/gm),
    ).toEqual(["WEB_PUBLIC_ORIGIN=http://localhost:3001"]);
    expect(updatedEnv).toContain(
      "# Keep this comment and the unrelated setting below.\nWEB_HTTP_PORT_BACKUP=3000",
    );
    expect(updatedEnv).toContain("LIVEKIT_URL=ws://127.0.0.1:17881");
    expect(updatedEnv).not.toMatch(
      /^LIVEKIT_(HTTP_PORT|RTC_TCP_PORT|RTC_UDP_PORT)=/m,
    );
    expect(updatedEnv).toContain(
      "COMPOSE_FILE=docker-compose.yml:.local/compose.ports.yml",
    );
    expect(updatedEnv).not.toContain("POSTGRES_PORT=5433");
    const overridePath = path.join(fakeRepo, ".local/compose.ports.yml");
    const override = await readFile(overridePath, "utf8");
    expect(override).toContain(
      "entrypoint: /livekit-server --rtc.tcp_port 7883 --udp-port 7884",
    );
    expect(override).not.toContain("command:");
    expect(override).toContain("ports: !override");
    expect(override).toContain('"127.0.0.1:17881:7880"');
    expect(override).toContain(
      '"${LIVEKIT_RTC_BIND_ADDRESS:-127.0.0.1}:7883:7883"',
    );
    expect(override).toContain(
      '"${LIVEKIT_RTC_BIND_ADDRESS:-127.0.0.1}:7884:7884/udp"',
    );

    const dockerCalls = await readFile(dockerLogPath, "utf8");
    expect(dockerCalls).toContain("compose up --build --detach --wait");

    await rm(serverStartedPath);
    const repeated = await runInstallScript([], {
      scriptPath: copiedInstallPath,
      cwd: fakeRepo,
      env: {
        HOME: homeDir,
        XDG_CACHE_HOME: xdgCache,
        PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin`,
        LINGER_INSTALL_BUSY_PORTS: "3000,17880,7881,7882",
      },
      input: ["1", "n", "n", "n"].join("\n") + "\n",
    });
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toContain("Starting Linger with Docker Compose...");
    expect(repeated.stdout).not.toContain("Port(s) already in use:");
    expect(await readFile(path.join(fakeRepo, ".env"), "utf8")).toBe(
      updatedEnv,
    );
    expect(await readFile(overridePath, "utf8")).toBe(override);

    const dockerPath = path.join(fakeBin, "docker");
    await writeFile(
      dockerPath,
      (await readFile(dockerPath, "utf8")).replace("2.24.4", "2.24.3"),
    );
    await rm(serverStartedPath);
    const unsupported = await runInstallScript([], {
      scriptPath: copiedInstallPath,
      cwd: fakeRepo,
      env: {
        HOME: homeDir,
        XDG_CACHE_HOME: xdgCache,
        PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin`,
        LINGER_INSTALL_BUSY_PORTS: "3001,17881,7883",
      },
      input: ["1", "y"].join("\n") + "\n",
    });
    expect(unsupported.code).toBe(1);
    expect(unsupported.stderr).toContain(
      "requires Docker Compose 2.24.4 or later",
    );
    expect(await readFile(path.join(fakeRepo, ".env"), "utf8")).toBe(
      updatedEnv,
    );
    expect(await readFile(overridePath, "utf8")).toBe(override);
  });

  it("validates CLI flags, conflicting modes, and standalone menu outside repo", async () => {
    const root = await createTempRoot();
    const { scriptPath } = await createFakeStackScript(root, {});
    const env = buildTestEnv(root, scriptPath);

    const shortHelp = await runInstallScript(["-h"], { env });
    expect(shortHelp.code).toBe(0);
    expect(shortHelp.stdout).toContain("--web-url");

    const unknown = await runInstallScript(["--bogus"], { env });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown option: --bogus");

    const conflict = await runInstallScript(["--connect", "--up"], { env });
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain(
      "Options --connect and --up cannot be combined",
    );

    const missingUrl = await runInstallScript(["--web-url"], { env });
    expect(missingUrl.code).toBe(1);
    expect(missingUrl.stderr).toContain("--web-url requires an origin URL");

    const invalidUrl = await runInstallScript(["--web-url", "not-a-url"], {
      env,
    });
    expect(invalidUrl.code).toBe(1);
    expect(invalidUrl.stderr).toContain("Invalid Linger server URL");

    const standaloneDir = path.join(root, "standalone");
    await mkdir(standaloneDir, { recursive: true });
    const standalonePath = path.join(standaloneDir, "install.sh");
    await copyFile(installScriptPath, standalonePath);
    await chmod(standalonePath, 0o755);

    const saHelp = await runInstallScript(["--help"], {
      scriptPath: standalonePath,
      cwd: standaloneDir,
      env,
    });
    expect(saHelp.code).toBe(0);
    expect(saHelp.stdout).toContain("Usage: ./install.sh");

    const saMenu = await runInstallScript(["--web-url", "http://127.0.0.1:9"], {
      scriptPath: standalonePath,
      cwd: standaloneDir,
      env,
      input: "9\n",
    });
    expect(saMenu.code).toBe(1);
    expect(saMenu.stdout).not.toContain("Docker Compose");
    expect(saMenu.stderr).toContain("Invalid choice: 9");
  });

  it("supports custom URL retry/force/skip and local-models-only flows", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "home"), { recursive: true });
    const { scriptPath } = await createFakeStackScript(root, {});
    const server = await startMockLingerServer(root, false);
    const standaloneDir = path.join(root, "standalone");
    await mkdir(standaloneDir, { recursive: true });
    const standalonePath = path.join(standaloneDir, "install.sh");
    await copyFile(installScriptPath, standalonePath);
    await chmod(standalonePath, 0o755);

    const customRetry = await runInstallScript(
      ["--web-url", "http://127.0.0.1:9"],
      {
        scriptPath: standalonePath,
        cwd: standaloneDir,
        env: buildTestEnv(root, scriptPath),
        input:
          [
            "1",
            "bad-url",
            "http://127.0.0.1:9",
            "n",
            server.baseUrl,
            "n",
            "n",
          ].join("\n") + "\n",
      },
    );
    expect(customRetry.code).toBe(0);
    expect(customRetry.stdout).toContain("Invalid URL");
    expect(customRetry.stdout).toContain(
      `Found Linger server at ${server.baseUrl}`,
    );

    const skipResult = await runInstallScript(
      ["--web-url", "http://127.0.0.1:9"],
      {
        scriptPath: standalonePath,
        cwd: standaloneDir,
        env: buildTestEnv(root, scriptPath),
        input: ["2", "n", "y"].join("\n") + "\n",
      },
    );
    expect(skipResult.code).toBe(0);
    expect(skipResult.stdout).toContain("Continuing with local models only");
    expect(skipResult.stdout).toContain("./install.sh --connect --web-url");
  });

  it("handles Compose port decline, owner retry, and explicit URL reset", async () => {
    const root = await createTempRoot();
    const fakeRepo = path.join(root, "fake-repo");
    const fakeBin = path.join(root, "fake-bin");
    const homeDir = path.join(root, "home");
    const xdgCache = path.join(root, "cache");
    const teamhubLog = path.join(root, "teamhub.log");
    await mkdir(path.join(fakeRepo, "scripts/install"), { recursive: true });
    await mkdir(path.join(fakeRepo, "scripts/installs"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(xdgCache, { recursive: true });
    await chmod(homeDir, 0o700);
    await chmod(xdgCache, 0o700);

    const copiedInstallPath = path.join(fakeRepo, "scripts/install/install.sh");
    await copyFile(installScriptPath, copiedInstallPath);
    await chmod(copiedInstallPath, 0o755);

    const { scriptPath: fakeStackPath } = await createFakeStackScript(root, {});
    await copyFile(
      fakeStackPath,
      path.join(fakeRepo, "scripts/installs/stack.sh"),
    );
    await chmod(path.join(fakeRepo, "scripts/installs/stack.sh"), 0o755);

    await writeFile(fakeRepo + "/docker-compose.yml", "services:\n  web:\n");
    await writeFile(
      path.join(fakeRepo, ".env.example"),
      "WEB_PUBLIC_ORIGIN=http://localhost:3000\n# WEB_HTTP_PORT=3000\n",
    );

    const server = await startMockLingerServer(root, false);
    const serverPort = new URL(server.baseUrl).port;

    await writeFile(
      path.join(fakeBin, "docker"),
      `#!/bin/sh
set -eu
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "version" ]; then
  printf 'Docker Compose version v2.40.2\n'
  exit 0
fi
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "exec" ]; then
  cat > ${JSON.stringify(teamhubLog)}
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    await writeFile(
      path.join(fakeBin, "curl"),
      `#!/bin/sh
set -eu
out=""
url=""
prev=""
for a in "$@"; do
  case "$prev" in -o|--output) out="$a" ;; esac
  case "$a" in http://*|https://*) url="$a" ;; esac
  prev="$a"
done
case "$url" in
  "${server.baseUrl}/install/linger-computer.sh")
    body="# linger-computer-launcher-v2"
    if [ -n "$out" ]; then printf '%s\n' "$body" > "$out"; else printf '%s\n' "$body"; fi
    exit 0
    ;;
  *)
    exit 22
    ;;
esac
`,
      { mode: 0o755 },
    );

    const env: NodeJS.ProcessEnv = {
      HOME: homeDir,
      XDG_CACHE_HOME: xdgCache,
      PATH: `${fakeBin}:/usr/local/bin:/usr/bin:/bin`,
      LINGER_INSTALL_BUSY_PORTS: "3000",
    };

    const declinedPorts = await runInstallScript([], {
      scriptPath: copiedInstallPath,
      cwd: fakeRepo,
      env,
      input: ["1", "n"].join("\n") + "\n",
    });
    expect(declinedPorts.code).toBe(1);
    expect(declinedPorts.stderr).toContain("Free those ports");

    await writeFile(
      path.join(fakeRepo, ".env"),
      `WEB_PUBLIC_ORIGIN=${server.baseUrl}\nWEB_HTTP_PORT=${serverPort}\n`,
    );

    const resetExplicit = await runInstallScript(
      ["--web-url", "http://127.0.0.1:9"],
      {
        scriptPath: copiedInstallPath,
        cwd: fakeRepo,
        env: { ...env, LINGER_INSTALL_BUSY_PORTS: "" },
        input: ["1", "y", "", "short", "", "n", "n"].join("\n") + "\n",
      },
    );
    expect(resetExplicit.code).toBe(0);
    expect(resetExplicit.stdout).toContain(
      "Password must be at least 8 characters",
    );
    expect(resetExplicit.stdout).toContain(
      `Linger server is ready at ${server.baseUrl}`,
    );
    expect((await readFile(teamhubLog, "utf8")).trim()).toBe("test1234");
  });

  it("handles GPU cancel, memory cap retry, preflight failures, and stack sanitization", async () => {
    const root = await createTempRoot();
    await mkdir(path.join(root, "home"), { recursive: true });
    const server = await startMockLingerServer(root, false);

    const bootErr = await createFakeStackScript(root, {
      bootstrapError: "stack: GPU service owners unknown",
    });
    const bootRes = await runInstallScript(["--status"], {
      env: buildTestEnv(root, bootErr.scriptPath),
    });
    expect(bootRes.code).toBe(1);
    expect(bootRes.stderr).toContain("install.sh: GPU service owners unknown");
    expect(bootRes.stderr).not.toContain("stack:");

    const sharedScenario = await createFakeStackScript(root, {
      picks: [
        {
          role: "smartest",
          id: "qwen3.8-27b",
          quant: "UD-Q4_K_M",
          quality: 54,
          decodeTokS: 109,
          decodeBasis: "estimated",
          card: 0,
          shared: true,
        },
      ],
      preflightFail: true,
      applyOutputLines: [
        "stack.sh: internal note",
        "Applied plan plan-abcdef123456",
      ],
    });

    const gpuDecline = await runInstallScript(["--web-url", server.baseUrl], {
      env: buildTestEnv(root, sharedScenario.scriptPath),
      input: "n\n",
    });
    expect(gpuDecline.code).toBe(0);
    expect(gpuDecline.stdout).toContain("Installation cancelled.");

    const preflightAbort = await runInstallScript(
      ["--web-url", server.baseUrl],
      {
        env: buildTestEnv(root, sharedScenario.scriptPath),
        input: ["y", "badcap", "16384M", "n"].join("\n") + "\n",
      },
    );
    expect(preflightAbort.code).toBe(1);
    expect(preflightAbort.stdout).toContain(
      "Please enter a size like 24G or 16384M",
    );
    expect(preflightAbort.stderr).toContain("Preflight checks failed");
    expect(preflightAbort.stdout).not.toContain("stack.sh");

    const liveSanitize = await createFakeStackScript(root, {
      applyOutputLines: [
        "stack: starting service via stack.sh",
        "Applied plan plan-abcdef123456",
      ],
    });
    const applyRes = await runInstallScript(["--web-url", server.baseUrl], {
      env: buildTestEnv(root, liveSanitize.scriptPath),
      input: ["n", "y"].join("\n") + "\n",
    });
    expect(applyRes.code).toBe(0);
    expect(applyRes.stdout).not.toContain("stack.sh");
    expect(applyRes.stdout).not.toContain("stack:");
  });

  it("handles up --share-gpu retry, --update replan, --connect, --up, and interactive purge", async () => {
    const root = await createTempRoot();
    const homeDir = path.join(root, "home");
    const piDir = path.join(
      homeDir,
      ".local/share/localmodels/tools/gateway-home/.pi/agent",
    );
    await mkdir(piDir, { recursive: true });
    await writeFile(path.join(piDir, "models.json"), "{}");

    const { scriptPath, logPath } = await createFakeStackScript(root, {
      acceptedStack: true,
      upFailsWithoutShareGpu: true,
    });
    const server = await startMockLingerServer(root, true);
    const env = buildTestEnv(root, scriptPath);

    const shareRetry = await runInstallScript(["--web-url", server.baseUrl], {
      env,
      input: ["1", "y"].join("\n") + "\n",
    });
    expect(shareRetry.code).toBe(0);
    expect(shareRetry.stdout).toContain(
      "Retry starting while sharing GPU with other running processes?",
    );

    const replan = await runInstallScript(["--web-url", server.baseUrl], {
      env,
      input: ["2", "n", "n"].join("\n") + "\n",
    });
    expect(replan.code).toBe(0);

    const connectOnly = await runInstallScript(
      ["--connect", "--web-url", server.baseUrl],
      { env },
    );
    expect(connectOnly.code).toBe(0);

    const upMode = await runInstallScript(
      ["--up", "--web-url", server.baseUrl],
      {
        env: buildTestEnv(
          root,
          (await createFakeStackScript(root, { acceptedStack: true }))
            .scriptPath,
        ),
      },
    );
    expect(upMode.code).toBe(0);

    const purgeCancel = await runInstallScript(["--remove", "--purge"], {
      env,
      input: "n\n",
    });
    expect(purgeCancel.code).toBe(0);
    expect(purgeCancel.stdout).toContain("Nothing deleted.");

    const purgeConfirm = await runInstallScript(["--remove", "--purge"], {
      env,
      input: "y\n",
    });
    expect(purgeConfirm.code).toBe(0);
    expect(purgeConfirm.stdout).toContain(
      "./scripts/install/install.sh --remove --purge",
    );

    const calls = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(calls).toContain("up --share-gpu");
    expect(
      calls.some((c) => c.startsWith("plan ") && c.includes("--update")),
    ).toBe(true);
    expect(calls).toContain("remove --purge --dry-run");
    expect(calls).toContain("remove --purge --yes");
  });
});

describe("scripts/install/install.ps1 and release pin parity", () => {
  it("keeps scripts/install/install.ps1 free of CJK and aligned with CLI flags and helpers", async () => {
    const ps1 = await readFile(
      path.join(repositoryRoot, "scripts", "install", "install.ps1"),
      "utf8",
    );
    expect(ps1.startsWith("#requires -Version 5.1")).toBe(true);
    expect(/[\u3400-\u9fff\uf900-\ufaff]/.test(ps1)).toBe(false);

    for (const flag of [
      "--web-url",
      "--update",
      "--connect",
      "--up",
      "--status",
      "--remove",
      "--purge",
      "-y",
      "--yes",
      "-h",
      "--help",
    ]) {
      expect(ps1).toContain(flag);
    }

    expect(ps1).toContain("SetAccessRuleProtection($true, $false)");
    expect(ps1).toContain("[IO.Path]::PathSeparator");
    expect(ps1).toContain(
      "Set-DotEnvKey $EnvPath 'COMPOSE_FILE' \"docker-compose.yml$sep$overrideRel\"",
    );
    expect(ps1).toContain("--rtc.tcp_port");
    expect(ps1).toContain("Docker Compose 2.24.4 or later");
    expect(ps1).toContain(
      "Reminder: change the default password in Settings -> Security.",
    );
    expect(ps1).toContain("Test-IsElevated");
    expect(ps1).toContain("PI_CODING_AGENT_DIR");
    expect(ps1).toContain("SystemRoot");
    expect(ps1).toContain("PATHEXT");
    expect(ps1).toContain("pi.cmd");
    expect(ps1).toContain(
      "Invoke-Stack @('apply', $planFile, '--approve', $planId)",
    );
    expect(ps1).not.toContain("@('apply', '--plan'");
    expect(ps1).not.toContain("LINGER_STACK_SCRIPT_URL");
    expect(ps1).not.toContain("Test-IsAclBootstrapFailure");
    expect(ps1).toContain("@('auth', 'status', '--json')");
    expect(ps1).toContain("Get-StackInvokePath");
    expect(ps1).toContain("Format-SanitizedLine");
    expect(ps1).toContain("gateway-home");
    expect(ps1).toContain("localmodels");
  });

  // Linux CI has no PowerShell runtime; scripts/install/install.tests.ps1 runs
  // natively on Windows (PS 5.1 & PS 7) and via this Windows-gated case.
  it.runIf(process.platform === "win32")(
    "runs the PowerShell behavioral branch suite for scripts/install/install.ps1",
    async () => {
      const ps1 = path.join(
        repositoryRoot,
        "scripts",
        "install",
        "install.ps1",
      );
      const suite = path.join(
        repositoryRoot,
        "scripts",
        "install",
        "install.tests.ps1",
      );
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          suite,
          "-InstallScriptPath",
          ps1,
        ],
        { cwd: repositoryRoot, encoding: "utf8", timeout: 120_000 },
      );
      expect(stdout).toContain("ASSERTIONS PASSED");
    },
    // Longer than the suite's own 120 s limit, so vitest does not end it first.
    180_000,
  );

  it("documents the Windows guided installer command in README.md", async () => {
    const readme = await readFile(
      path.join(repositoryRoot, "README.md"),
      "utf8",
    );
    expect(readme).toContain(
      "powershell -ExecutionPolicy Bypass -File .\\scripts\\install\\install.ps1",
    );
  });

  it("keeps stack.ps1 release pins aligned with stack.sh", async () => {
    const [stackSh, stackPs1] = await Promise.all([
      readFile(
        path.join(repositoryRoot, "scripts", "installs", "stack.sh"),
        "utf8",
      ),
      readFile(
        path.join(repositoryRoot, "scripts", "installs", "stack.ps1"),
        "utf8",
      ),
    ]);
    const shVersion = stackSh.match(/^STACK_VERSION='([^']+)'/m)?.[1];
    const shCommit = stackSh.match(/^STACK_SOURCE_COMMIT='([^']+)'/m)?.[1];
    const shNpm = stackSh.match(/^STACK_NPM_VERSION='([^']+)'/m)?.[1];
    expect(shVersion).toBeTruthy();
    expect(shCommit).toBeTruthy();
    expect(shNpm).toBeTruthy();
    expect(stackPs1).toContain(`$StackVersion = '${shVersion}'`);
    expect(stackPs1).toContain(`$StackSourceCommit = '${shCommit}'`);
    expect(stackPs1).toContain(`$StackNpmVersion = '${shNpm}'`);
  });

  it("keeps standalone install script stack pins synchronized and free of floating domain URLs", async () => {
    const syncScript = path.join(
      repositoryRoot,
      "scripts",
      "sync-install-stack-pin.mjs",
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [syncScript, "--check"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(stdout).toContain("Verified install stack pins");

    const [shBody, ps1Body] = await Promise.all([
      readFile(installScriptPath, "utf8"),
      readFile(
        path.join(repositoryRoot, "scripts", "install", "install.ps1"),
        "utf8",
      ),
    ]);
    expect(shBody).not.toContain("simplexai.com/stack");
    expect(ps1Body).not.toContain("simplexai.com/stack");
  });

  it("downloads, SHA-256 verifies, and rejects tampered @simplexai/localmodels tarballs when run standalone", async () => {
    const buildSingleFileTgz = (entryName: string, content: Buffer): Buffer => {
      const header = Buffer.alloc(512);
      header.write(entryName, 0, "ascii");
      header.write("0000755\0", 100, "ascii");
      header.write("0000000\0", 108, "ascii");
      header.write("0000000\0", 116, "ascii");
      header.write(
        `${content.length.toString(8).padStart(11, "0")}\0`,
        124,
        "ascii",
      );
      header.write("00000000000\0", 136, "ascii");
      header.write("        ", 148, "ascii");
      header.write("0", 156, "ascii");
      header.write("ustar\0", 257, "ascii");
      header.write("00", 263, "ascii");
      let sum = 0;
      for (const byte of header) {
        sum += byte;
      }
      header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
      const pad = (512 - (content.length % 512)) % 512;
      const tar = Buffer.concat([
        header,
        content,
        Buffer.alloc(pad),
        Buffer.alloc(1024),
      ]);
      return gzipSync(tar);
    };

    const startMockNpm = async (expectedUrlPath: string, tgzBytes: Buffer) => {
      const srv = createServer((req, res) => {
        if (req.url === expectedUrlPath) {
          res.writeHead(200, { "content-type": "application/gzip" });
          res.end(tgzBytes);
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
      await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) =>
            srv.close((err) => (err ? reject(err) : resolve())),
          ),
      );
      const addr = srv.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    };

    const root = await createTempRoot();
    await mkdir(path.join(root, "home"), { recursive: true });
    await chmod(path.join(root, "home"), 0o700);
    const standaloneDir = path.join(root, "standalone");
    await mkdir(standaloneDir, { recursive: true });
    const standaloneSh = path.join(standaloneDir, "install.sh");
    await copyFile(installScriptPath, standaloneSh);
    await chmod(standaloneSh, 0o755);

    const shRaw = await readFile(standaloneSh, "utf8");
    const npmVer = shRaw.match(/^STACK_PIN_NPM_VERSION='([^']+)'/m)?.[1];
    expect(npmVer).toBeTruthy();
    const tarUrlPath = `/@simplexai/localmodels/-/localmodels-${npmVer}.tgz`;

    // 1. Unmodified install.sh rejects a tampered package/stack.sh immediately.
    const tamperedUrl = await startMockNpm(
      tarUrlPath,
      buildSingleFileTgz(
        "package/stack.sh",
        Buffer.from("#!/bin/sh\necho bad\n"),
      ),
    );
    const envBase = buildTestEnv(root, "");
    delete envBase.LINGER_STACK_SCRIPT;
    delete envBase.LINGER_STACK_URL;
    const tamperedRes = await runInstallScript(["--status"], {
      scriptPath: standaloneSh,
      cwd: standaloneDir,
      env: { ...envBase, SIMPLEX_NPM_REGISTRY: tamperedUrl },
    });
    expect(tamperedRes.code).toBe(1);
    expect(tamperedRes.stderr).toContain(
      "Local model runtime bootstrap checksum mismatch.",
    );

    // 1b. Bounded streaming caps uncompressed package/stack.sh at 16 MiB.
    const oversizedUrl = await startMockNpm(
      tarUrlPath,
      buildSingleFileTgz(
        "package/stack.sh",
        Buffer.alloc(16 * 1024 * 1024 + 64),
      ),
    );
    const oversizedRes = await runInstallScript(["--status"], {
      scriptPath: standaloneSh,
      cwd: standaloneDir,
      env: { ...envBase, SIMPLEX_NPM_REGISTRY: oversizedUrl },
    });
    expect(oversizedRes.code).toBe(1);
    expect(oversizedRes.stderr).toContain(
      "Local model runtime bootstrap exceeds maximum size.",
    );

    // 2. Standalone install.sh extracts and runs verified package/stack.sh when SHA-256 matches.
    const fakeBody = Buffer.from(
      `#!/bin/sh
if [ "\${1:-}" = "--bootstrap-json" ]; then
  printf '{"schema":"localmodels.kit-location/v1","python":"/bin/sh"}\\n'
  exit 0
fi
if [ "\${1:-}" = "status" ]; then
  printf 'qwen3.8-27b active\\n'
  exit 0
fi
exit 0
`,
      "utf8",
    );
    const fakeSha = createHash("sha256").update(fakeBody).digest("hex");
    const pinnedSh = path.join(standaloneDir, "install-pinned.sh");
    await writeFile(
      pinnedSh,
      shRaw.replace(
        /STACK_PIN_SHA256='[a-f0-9]+'/,
        `STACK_PIN_SHA256='${fakeSha}'`,
      ),
      { mode: 0o755 },
    );
    const goodUrl = await startMockNpm(
      tarUrlPath,
      buildSingleFileTgz("package/stack.sh", fakeBody),
    );
    const goodRes = await runInstallScript(["--status"], {
      scriptPath: pinnedSh,
      cwd: standaloneDir,
      env: { ...envBase, SIMPLEX_NPM_REGISTRY: goodUrl },
    });
    expect(goodRes.code).toBe(0);
    expect(goodRes.stdout).toContain("qwen3.8-27b active");
  });
});
