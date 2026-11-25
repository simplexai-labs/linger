import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DAEMON_RUNTIME_PROBE_SCHEMA,
  probeRuntimesWithDaemon,
  recommendRuntimeFromDaemon,
  resolveDaemonExecutable,
  type DaemonRuntimeObservation,
} from "./daemon-runtime-probe.js";
import { inspectSetup } from "./setup-plan.js";
import { prepareRuntime } from "./managed-runtimes.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("resolveDaemonExecutable", () => {
  it.skipIf(process.platform === "win32")(
    "prefers explicit path, then LINGER_COMPUTER_DAEMON, then PATH",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "daemon-resolve-"));
      roots.push(dir);
      const explicit = path.join(dir, "explicit-daemon");
      const fromEnv = path.join(dir, "env-daemon");
      const onPath = path.join(dir, "linger-computer-daemon");
      await Promise.all([
        writeFile(explicit, "#!/bin/sh\n", { mode: 0o700 }),
        writeFile(fromEnv, "#!/bin/sh\n", { mode: 0o700 }),
        writeFile(onPath, "#!/bin/sh\n", { mode: 0o700 }),
      ]);

      expect(
        resolveDaemonExecutable(
          { LINGER_COMPUTER_DAEMON: fromEnv, PATH: dir },
          explicit,
        ),
      ).toMatch(/explicit-daemon$/);
      expect(
        resolveDaemonExecutable({ LINGER_COMPUTER_DAEMON: fromEnv, PATH: dir }),
      ).toMatch(/env-daemon$/);
      expect(resolveDaemonExecutable({ PATH: dir })).toMatch(
        /linger-computer-daemon$/,
      );
      expect(resolveDaemonExecutable({ PATH: "/nonexistent-dir" })).toBeNull();
    },
  );
});

describe("probeRuntimesWithDaemon", () => {
  it("invokes probe-runtimes --json and parses daemon observations", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        schema: DAEMON_RUNTIME_PROBE_SCHEMA,
        runtimes: [
          {
            type: "codex",
            status: "ready",
            installed: true,
            authenticated: true,
            version: "codex-cli 0.171.0",
            required_version: "0.166.0",
            executable: "/opt/homebrew/bin/codex",
          },
          {
            type: "claude",
            status: "incompatible",
            installed: true,
            authenticated: false,
            version: "2.1.100 (Claude Code)",
            required_version: "2.1.282",
            executable: "/usr/local/bin/claude",
            error: {
              code: "RUNTIME_INCOMPATIBLE",
              message: "claude version 2.1.100 is below minimum 2.1.282",
            },
          },
        ],
      }),
      stderr: "",
    }));

    const observations = await probeRuntimesWithDaemon({
      daemonExecutable: "/app/linger-computer-daemon",
      runtimes: ["codex", "claude"],
      configuredPaths: { codex: "/managed/codex" },
      env: { PATH: "/usr/bin:/bin" },
      run,
    });

    expect(run).toHaveBeenCalledWith(
      "/app/linger-computer-daemon",
      [
        "probe-runtimes",
        "--json",
        "--runtime",
        "codex",
        "--runtime",
        "claude",
        "--codex-path",
        "/managed/codex",
      ],
      expect.objectContaining({ timeoutMs: 45_000 }),
    );
    expect(observations).toEqual([
      {
        type: "codex",
        status: "ready",
        installed: true,
        authenticated: true,
        version: "codex-cli 0.171.0",
        requiredVersion: "0.166.0",
        executable: "/opt/homebrew/bin/codex",
      },
      {
        type: "claude",
        status: "incompatible",
        installed: true,
        authenticated: false,
        version: "2.1.100 (Claude Code)",
        requiredVersion: "2.1.282",
        executable: "/usr/local/bin/claude",
        error: {
          code: "RUNTIME_INCOMPATIBLE",
          message: "claude version 2.1.100 is below minimum 2.1.282",
        },
      },
    ]);
  });

  it("returns null cleanly when daemon binary is absent or fails", async () => {
    expect(
      await probeRuntimesWithDaemon({
        env: { PATH: "/nonexistent-dir" },
      }),
    ).toBeNull();
    expect(
      await probeRuntimesWithDaemon({
        daemonExecutable: "/app/linger-computer-daemon",
        run: vi.fn(async () => ({ code: 1, stdout: "", stderr: "failed" })),
      }),
    ).toBeNull();
  });
});

describe("recommendRuntimeFromDaemon", () => {
  const obs = (
    type: DaemonRuntimeObservation["type"],
    status: DaemonRuntimeObservation["status"],
  ): DaemonRuntimeObservation => ({
    type,
    status,
    installed: status !== "not_installed",
    authenticated: status === "ready",
  });

  it("matches computer-readiness.ts order (claude -> codex -> pi, ready strictly first)", () => {
    // Unauthenticated Codex.app must never hijack a ready Claude / CC Switch setup.
    expect(
      recommendRuntimeFromDaemon([
        obs("codex", "authentication_required"),
        obs("claude", "ready"),
        obs("pi", "not_installed"),
      ]),
    ).toBe("claude");

    // Ready CC Switch Codex wins when Claude is not installed.
    expect(
      recommendRuntimeFromDaemon([
        obs("codex", "ready"),
        obs("claude", "not_installed"),
        obs("pi", "not_installed"),
      ]),
    ).toBe("codex");

    // Ready Codex beats incompatible (outdated) Claude.
    expect(
      recommendRuntimeFromDaemon([
        obs("codex", "ready"),
        obs("claude", "incompatible"),
        obs("pi", "not_installed"),
      ]),
    ).toBe("codex");

    // When both are unauthenticated, claude precedes codex (matching computer-readiness.ts).
    expect(
      recommendRuntimeFromDaemon([
        obs("codex", "authentication_required"),
        obs("claude", "authentication_required"),
        obs("pi", "not_installed"),
      ]),
    ).toBe("claude");

    // Empty machine falls back to claude.
    expect(
      recommendRuntimeFromDaemon([
        obs("codex", "not_installed"),
        obs("claude", "not_installed"),
        obs("pi", "not_installed"),
      ]),
    ).toBe("claude");
  });
});

describe.skipIf(
  process.platform === "win32" || !process.env.LINGER_COMPUTER_DAEMON,
)("end-to-end against real compiled linger-computer-daemon", () => {
  it(
    "verifies CC Switch Codex and CC Switch Claude end-to-end through the real Go daemon binary",
    { timeout: 30_000 },
    async () => {
      const daemonExe = process.env.LINGER_COMPUTER_DAEMON!;
      const home = await mkdtemp(path.join(tmpdir(), "daemon-e2e-ccswitch-"));
      roots.push(home);
      const binDir = path.join(home, ".local", "bin");
      const codexDir = path.join(home, ".codex");
      const claudeDir = path.join(home, ".claude");
      await Promise.all([
        mkdir(binDir, { recursive: true }),
        mkdir(codexDir, { recursive: true }),
        mkdir(claudeDir, { recursive: true }),
      ]);

      // CC Switch Codex: requires_openai_auth=false + stale auth.json + failing `codex login status`.
      await writeFile(
        path.join(codexDir, "config.toml"),
        `model_provider = "ccswitch"\n\n[model_providers.ccswitch]\nbase_url = "https://proxy.example/v1"\nrequires_openai_auth = false\n`,
      );
      await writeFile(
        path.join(codexDir, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "expired" },
        }),
      );
      const codexExe = path.join(binDir, "codex");
      await writeFile(
        codexExe,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.171.0'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo 'Not logged in' >&2; exit 1; fi
if [ -e "$CODEX_HOME/auth.json" ]; then echo 'stale auth.json leaked' >&2; exit 2; fi
read initialize
echo '{"id":1,"result":{"userAgent":"e2e-codex"}}'
if read initialized && read account; then
  echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}'
fi
`,
        { mode: 0o700 },
      );

      // CC Switch Claude: ~/.claude/settings.json carries ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL.
      await writeFile(
        path.join(claudeDir, "settings.json"),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: "ccswitch-token",
            ANTHROPIC_BASE_URL: "https://relay.example",
          },
        }),
      );
      const claudeExe = path.join(binDir, "claude");
      await writeFile(
        claudeExe,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo '2.1.310 (Claude Code)'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  if [ "$ANTHROPIC_AUTH_TOKEN" = "ccswitch-token" ] && [ "$ANTHROPIC_BASE_URL" = "https://relay.example" ] && [ "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" = "1" ]; then
    echo '{"loggedIn":true,"authMethod":"apiKey"}'
    exit 0
  fi
  echo '{"loggedIn":false}'
  exit 1
fi
read req
echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-computer-doctor"}}'
`,
        { mode: 0o700 },
      );

      const probeEnv: NodeJS.ProcessEnv = {
        HOME: home,
        PATH: "/usr/bin:/bin",
        LINGER_COMPUTER_DAEMON: daemonExe,
      };
      const observations = await probeRuntimesWithDaemon({
        runtimes: ["codex", "claude"],
        env: probeEnv,
        daemonExecutable: daemonExe,
      });
      expect(observations).not.toBeNull();
      expect(observations?.find((o) => o.type === "codex")).toMatchObject({
        status: "ready",
        installed: true,
        authenticated: true,
        requiredVersion: "0.166.0",
        executable: codexExe,
      });
      expect(observations?.find((o) => o.type === "claude")).toMatchObject({
        status: "ready",
        installed: true,
        authenticated: true,
        requiredVersion: "2.1.282",
        executable: claudeExe,
      });

      // Full setup-plan flow with localmodels returning ONLY facts + stack (no harness runtimes).
      const setupReport = await inspectSetup({
        home,
        env: probeEnv,
        daemonExecutable: daemonExe,
        probeRuntimes: probeRuntimesWithDaemon,
        localmodels: vi.fn(async () => ({
          code: 0,
          stdout: JSON.stringify({
            schema: "localmodels.setup-report/v1",
            facts: {
              platform: process.platform,
              arch: process.arch,
              ram: { total_bytes: 16 * 1024 ** 3 },
              disk: { free_bytes: 100 * 1024 ** 3 },
              gpus: [],
            },
            stack: {
              available: false,
              state: "unavailable",
              reasons: [{ code: "ram-insufficient", message: "too small" }],
              plan: null,
            },
          }),
          stderr: "",
        })),
      });
      expect(setupReport.recommendation).toBe("claude");
      expect(
        setupReport.runtimes.find((r) => r.choice === "codex"),
      ).toMatchObject({
        installed: true,
        auth: "authenticated",
        status: "ready",
      });
      expect(
        setupReport.runtimes.find((r) => r.choice === "claude"),
      ).toMatchObject({
        installed: true,
        auth: "authenticated",
        status: "ready",
      });

      // Full prepareRuntime flow for CC Switch Codex: must return ready, never RUNTIME_AUTH_REQUIRED.
      const outcome = await prepareRuntime(
        "codex",
        {
          home,
          env: probeEnv,
          reuseInstalled: true,
          signal: new AbortController().signal,
          onEvent: vi.fn(),
        },
        {
          daemonExecutable: daemonExe,
          probeRuntimes: probeRuntimesWithDaemon,
          localmodels: vi.fn(async () => ({
            code: 1,
            stdout: "",
            stderr: "harness status removed",
          })),
        },
      );
      expect(outcome).toMatchObject({ code: 0, state: "ready" });
    },
  );
});
