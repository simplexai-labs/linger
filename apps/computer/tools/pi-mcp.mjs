import { execFile } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
// The Daemon puts the Computer tools on NODE_PATH so Pi can load this
// extension. Node has read it by now; put back the value Pi inherited so the
// commands Pi starts never resolve a package from the tools.
if (process.env.LINGER_PI_INHERITED_NODE_PATH !== undefined) {
  if (process.env.LINGER_PI_INHERITED_NODE_PATH)
    process.env.NODE_PATH = process.env.LINGER_PI_INHERITED_NODE_PATH;
  else delete process.env.NODE_PATH;
  delete process.env.LINGER_PI_INHERITED_NODE_PATH;
}
// The Daemon executable that judges a shell command (bash or PowerShell)
// before Pi runs it; the commands Pi starts do not inherit it.
const shellTextHook = process.env.LINGER_PI_SHELL_TEXT_HOOK;
delete process.env.LINGER_PI_SHELL_TEXT_HOOK;
// One-shot prefix warm-up pin metadata consumed at extension load; cleared
// immediately so child processes never observe it.
const strataPinEnvRaw = process.env.LINGER_PI_STRATA_PIN;
delete process.env.LINGER_PI_STRATA_PIN;
// An installed Pi may alias bare package imports to its own version. Resolve
// the pinned public entry by URL so this adapter keeps its shipped API.
const {
  createMcpExtension,
  createPowerShellToolDefinition,
  getPowerShellConfig,
} = await import(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js",
    import.meta.url,
  ).href
);

// Pi's built-in powershell tool sets [Console]::OutputEncoding but omits
// $OutputEncoding, so Windows PowerShell 5.1 encodes piped native-command
// stdin as US-ASCII and corrupts non-ASCII text. UTF8Encoding($false) avoids
// a leading BOM on piped stdin.
export const POWERSHELL_UTF8_PREFIX =
  "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); try { [Console]::OutputEncoding = $OutputEncoding } catch {}; try { if (-not [Console]::IsInputRedirected) { [Console]::InputEncoding = $OutputEncoding } } catch {}";

// Overrides Pi's built-in powershell tool on Windows so every PowerShell
// invocation runs with UTF-8 stdin and stdout encoding.
export function registerWindowsPowerShellTool(
  pi,
  {
    platform = process.platform,
    cwd = process.cwd(),
    createToolDefinition = createPowerShellToolDefinition,
    operations,
  } = {},
) {
  if (
    platform !== "win32" ||
    typeof pi?.registerTool !== "function" ||
    typeof createToolDefinition !== "function"
  ) {
    return false;
  }
  pi.registerTool(
    createToolDefinition(cwd, {
      commandPrefix: POWERSHELL_UTF8_PREFIX,
      ...(operations ? { operations } : {}),
    }),
  );
  return true;
}

// This explicit extension uses Pi's public MCP implementation. It does not
// discover ambient configuration or create another Agent execution loop.
export function loadManagedMcpConfig(configPath) {
  if (!configPath || !isAbsolute(configPath)) {
    throw new Error("Managed Pi MCP configuration is missing");
  }
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("Managed Pi MCP configuration is unsafe");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Managed Pi MCP configuration must be private");
  }
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const servers = Object.entries(parsed.mcpServers ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, config]) => {
      const url = new URL(config.url);
      if (
        config.type !== "http" ||
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.username ||
        url.password ||
        config.command ||
        config.headers ||
        config.auth ||
        config.oauth
      ) {
        throw new Error("Managed Pi MCP requires a bound local proxy");
      }
      return {
        name,
        config: {
          type: "http",
          url: url.href,
          exposure: "direct",
          timeout: config.tool_timeout_sec ?? 180,
        },
        source: configPath,
        scope: "extension",
      };
    });
  return { servers, autoEnableCodemode: false, errors: [] };
}

function isMcpToolName(name) {
  return (
    name.startsWith("mcp__") ||
    name === "list_mcp_resources" ||
    name === "read_mcp_resource"
  );
}

/**
 * Keeps built-in tools in their declared order at the front of the prompt and
 * sorts MCP tools lexicographically at the tail so token-0 tool declarations
 * stay byte-identical across async server connects.
 */
export function sortActiveToolNames(toolNames) {
  const nonMcp = [];
  const mcp = [];
  for (const name of toolNames) {
    if (isMcpToolName(name)) mcp.push(name);
    else nonMcp.push(name);
  }
  mcp.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...nonMcp, ...mcp];
}

const TEAMHUB_PROGRAM_PATTERN = /\bteamhub(?:\.(?:exe|cmd))?\b/iu;
const TEAMHUB_SUBCOMMAND_PATTERN = /^[a-z][a-z0-9-]*$/u;

/**
 * Reports whether Pi's Windows powershell tool resolves to Windows PowerShell
 * 5.1 (`powershell.exe`) rather than PowerShell 7 (`pwsh.exe`). Fails open so
 * shell resolution errors never block execution.
 */
export function isWindowsPowerShell51({
  platform = process.platform,
  resolveShell = getPowerShellConfig,
} = {}) {
  if (platform !== "win32" || typeof resolveShell !== "function") {
    return false;
  }
  try {
    const config = resolveShell();
    if (typeof config?.shell !== "string" || !config.shell) {
      return false;
    }
    return win32.basename(config.shell).toLowerCase() === "powershell.exe";
  } catch {
    return false;
  }
}

/**
 * Refuses a bash or powershell call whose TeamHub text the shell would corrupt,
 * by invoking the Daemon's shell-text-hook. Fast-paths skip the hook (and
 * PowerShell 5.1 detection) unless the command names teamhub and contains
 * characters that the target shell can corrupt. A hook that cannot run lets
 * the call proceed.
 */
export async function refuseRewrittenShellText(
  event,
  hook = shellTextHook,
  { isPowerShell51 } = {},
) {
  const command = event?.input?.command;
  if (!hook || typeof command !== "string") {
    return undefined;
  }
  let payload;
  if (event.toolName === "bash") {
    if (!command.includes("teamhub") || !/[$`]/u.test(command)) {
      return undefined;
    }
    payload = { tool_name: "bash", tool_input: { command } };
  } else if (event.toolName === "powershell") {
    if (
      !TEAMHUB_PROGRAM_PATTERN.test(command) ||
      (!command.includes('"') && !command.includes("<<"))
    ) {
      return undefined;
    }
    const ps51 =
      typeof isPowerShell51 === "function"
        ? Boolean(isPowerShell51())
        : isWindowsPowerShell51();
    if (!ps51 && !command.includes("<<")) {
      return undefined;
    }
    payload = {
      tool_name: "powershell",
      powershell_51: ps51,
      tool_input: { command },
    };
  } else {
    return undefined;
  }
  const reason = await new Promise((resolve) => {
    const child = execFile(
      hook,
      ["shell-text-hook"],
      { timeout: 10_000, windowsHide: true },
      (error, _stdout, stderr) => {
        resolve(error?.code === 2 ? stderr.trim() : "");
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
  return reason ? { block: true, reason } : undefined;
}

function stripHereBodies(script, powerShell) {
  if (powerShell) {
    return script.replace(
      /@(['"])[ \t]*\r?\n(?:[\s\S]*?\n)?\1@(?=[ \t]*(?:\r?\n|[;|)&}]|$))/gu,
      "",
    );
  }
  if (!script.includes("<<")) return script;
  const lines = script.split(/\r?\n/u);
  const kept = [];
  const pending = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const { delim, stripTabs } = pending[0];
      if ((stripTabs ? line.replace(/^\t+/u, "") : line) === delim) {
        pending.shift();
      }
      continue;
    }
    kept.push(line);
    const matches = line.matchAll(
      /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/gu,
    );
    for (const match of matches) {
      const delim = match[2] ?? match[3] ?? match[4];
      if (delim) pending.push({ delim, stripTabs: match[1] === "-" });
    }
  }
  return kept.join("\n");
}

function findTeamHubTail(segment, powerShell) {
  let rest = segment.trim();
  let hadParen = false;
  while (rest.length > 0) {
    const next = rest.replace(
      powerShell
        ? /^(?:(?:\$\(|\()+\s*|\$[A-Za-z_][A-Za-z0-9_:]*\s*=\s*|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)/u
        : /^(?:(?:\$\(|\()+\s*|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'`]*)\s+)/u,
      "",
    );
    if (next.length >= rest.length) break;
    if (/^(?:\$\(|\()/u.test(rest)) hadParen = true;
    rest = next;
  }
  let sawCallOp = false;
  if (powerShell) {
    const next = rest.replace(/^(?:&\s*|\.\s+)/u, "");
    if (next.length < rest.length) {
      sawCallOp = true;
      rest = next;
    }
  }
  let program;
  let tail;
  if (rest.startsWith('"') || rest.startsWith("'")) {
    if (powerShell && !sawCallOp) return undefined;
    const close = rest.indexOf(rest[0], 1);
    if (close < 0) return undefined;
    program = rest.slice(1, close);
    tail = rest.slice(close + 1);
  } else {
    const match = /^(\S+)([\s\S]*)$/u.exec(rest);
    if (!match) return undefined;
    program = match[1];
    tail = match[2];
  }
  const base = win32.basename(program.replace(/[\\/]+$/u, "")).toLowerCase();
  if (base !== "teamhub" && base !== "teamhub.exe" && base !== "teamhub.cmd") {
    return undefined;
  }
  const trimmedTail = tail.trim();
  return hadParen ? trimmedTail.replace(/\s*\)+$/u, "") : trimmedTail;
}

function stripQuotedText(text, powerShell) {
  return text.replace(
    powerShell
      ? /'(?:''|[^'])*'|"(?:`.|""|[^"`])*"/gu
      : /'[^']*'|"(?:\\.|[^"\\])*"/gu,
    '""',
  );
}

/**
 * Normalizes a bash or powershell command into a retry signature for the
 * consecutive-failure loop guard. Help/schema lookups return undefined so
 * checking flags never counts toward or triggers a block.
 */
export function shellFailureSignature(toolName, command) {
  if (
    (toolName !== "bash" && toolName !== "powershell") ||
    typeof command !== "string"
  ) {
    return undefined;
  }
  let effective = command;
  if (toolName === "bash" && effective.startsWith(PIPEFAIL_PREFIX)) {
    effective = effective.slice(PIPEFAIL_PREFIX.length);
  }
  const trimmed = effective.trim();
  if (!trimmed) return undefined;
  const powerShell = toolName === "powershell";
  const cleaned = stripHereBodies(effective, powerShell).replace(
    powerShell ? /`[ \t]*\r?\n/gu : /\\\r?\n/gu,
    powerShell ? " " : "",
  );
  const segments = cleaned
    .split(/(?:\r?\n|;|&&|\|\||\|&|\||[{}])/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("#"));
  let lastTeamHubTail;
  for (const segment of segments) {
    const tail = findTeamHubTail(segment, powerShell);
    if (tail !== undefined) lastTeamHubTail = tail;
  }
  if (lastTeamHubTail !== undefined) {
    const unquotedTail = stripQuotedText(lastTeamHubTail, powerShell).trim();
    const words = unquotedTail ? unquotedTail.split(/\s+/u) : [];
    if (
      words.some(
        (word) => word === "--help" || word === "-h" || word === "--schema",
      )
    ) {
      return undefined;
    }
    const subcommands = [];
    for (const word of words) {
      if (!TEAMHUB_SUBCOMMAND_PATTERN.test(word) || subcommands.length >= 2) {
        break;
      }
      subcommands.push(word);
    }
    return subcommands.length > 0
      ? `teamhub ${subcommands.join(" ")}`
      : "teamhub";
  }
  if (
    segments.length === 1 &&
    stripQuotedText(segments[0], powerShell)
      .split(/\s+/u)
      .some((word) => word === "--help" || word === "--schema")
  ) {
    return undefined;
  }
  return `${toolName}:${trimmed.replace(/\s+/gu, " ")}`;
}

const FAILURE_LOOP_WARN_THRESHOLD = 3;
const FAILURE_LOOP_BLOCK_THRESHOLD = 5;

class FailureLoopTracker {
  #streakSignature = "";
  #streakCount = 0;

  reset() {
    this.#streakSignature = "";
    this.#streakCount = 0;
  }

  beforeToolCall(event) {
    if (event?.toolName !== "bash" && event?.toolName !== "powershell") {
      return undefined;
    }
    const signature = shellFailureSignature(
      event.toolName,
      event.input?.command,
    );
    if (
      signature &&
      signature === this.#streakSignature &&
      this.#streakCount >= FAILURE_LOOP_BLOCK_THRESHOLD
    ) {
      const isTeamHub = signature.startsWith("teamhub");
      return {
        block: true,
        reason: isTeamHub
          ? `[Linger loop guard] Blocked after ${this.#streakCount} consecutive failures of ${signature}. Stop retrying minor variations: run "${signature} --help" to check file/stdin flags, change approach (for example write input files with the write tool), or stop and explain the blocker to the user.`
          : `[Linger loop guard] Blocked after ${this.#streakCount} consecutive failures of ${signature}. Do not keep retrying the same failing command; inspect the error, change approach, or stop and explain the blocker to the user.`,
      };
    }
    return undefined;
  }

  onToolResult(event) {
    if (event?.isError !== true) {
      this.#streakSignature = "";
      this.#streakCount = 0;
      return undefined;
    }
    if (event.toolName !== "bash" && event.toolName !== "powershell") {
      return undefined;
    }
    const signature = shellFailureSignature(
      event.toolName,
      event.input?.command,
    );
    if (!signature) {
      return undefined;
    }
    if (signature === this.#streakSignature) {
      this.#streakCount += 1;
    } else {
      this.#streakSignature = signature;
      this.#streakCount = 1;
    }
    if (this.#streakCount === FAILURE_LOOP_WARN_THRESHOLD) {
      const existingContent = Array.isArray(event.content) ? event.content : [];
      const isTeamHub = signature.startsWith("teamhub");
      const guidance = isTeamHub
        ? `Do not keep retrying minor quoting or syntax tweaks; check "${signature} --help" for file/stdin options, change approach, or report the blocker.`
        : "Do not keep retrying the same failing command; inspect the error, change approach, or report the blocker.";
      return {
        content: [
          ...existingContent,
          {
            type: "text",
            text: `\n\n[Linger loop guard] ${signature} has failed ${this.#streakCount} times in a row. ${guidance}`,
          },
        ],
        ...(event.structuredContent !== undefined
          ? { structuredContent: event.structuredContent }
          : {}),
      };
    }
    return undefined;
  }
}

export function createFailureLoopTracker() {
  return new FailureLoopTracker();
}

const managedMcpExtension = createMcpExtension({
  // Managed servers register through the extension API so a resident process
  // can attach or replace them between Runs without restarting Pi.
  loadConfig: () => ({ servers: [], autoEnableCodemode: false, errors: [] }),
  updateConfig: () => {
    throw new Error("Operation MCP configuration is immutable");
  },
});

// PERMISSION_REVIEW names the Daemon's review dialog. Pi forwards the dialog
// over RPC; the Daemon answers with a JSON verdict, {"allow", "message"}.
export const PERMISSION_REVIEW = "linger.permission_review";

// MCP_SYNC_COMMAND reloads the managed MCP config file into a resident Pi
// process before a Run adopts it; MCP_SYNC_DIALOG reports its structured result.
export const MCP_SYNC_COMMAND = "linger-sync-mcp";
export const MCP_SYNC_DIALOG = "linger.mcp_sync";

// reviewedTool reports whether a call goes to the Daemon's permission review:
// shell commands and MCP tools.
export function reviewedTool(toolName) {
  return (
    toolName === "bash" ||
    toolName === "powershell" ||
    toolName.startsWith("mcp__")
  );
}

export const PIPEFAIL_PREFIX =
  'if [ -n "${BASH_VERSION:-}${ZSH_VERSION:-}" ]; then set -o pipefail; fi\n';

/**
 * Enables pipefail for each bash call without spawning an extra subshell,
 * guarded on BASH_VERSION/ZSH_VERSION so a POSIX sh fallback without pipefail
 * does not abort. Runs only after the shell text check and permission review
 * pass so reviewers and allowlists inspect the original command. Under
 * pipefail, pipelines whose downstream reader closes early (such as | head)
 * can exit with SIGPIPE (141); a command that wants to opt out can run
 * `set +o pipefail`.
 */
export function enablePipefail(event) {
  if (event.toolName !== "bash") return;
  const command = event.input?.command;
  if (typeof command !== "string" || command.startsWith(PIPEFAIL_PREFIX))
    return;
  event.input.command = `${PIPEFAIL_PREFIX}${command}`;
}

// reviewToolCall asks the Daemon about one call and blocks it unless the
// verdict allows it. A missing or unreadable answer blocks the call.
// The Daemon allows every call of a Run without permission review.
export async function reviewToolCall(event, ui, signal) {
  if (!reviewedTool(event.toolName)) return undefined;
  const answer = await ui.input(
    PERMISSION_REVIEW,
    JSON.stringify({ toolName: event.toolName, input: event.input ?? {} }),
    signal ? { signal } : undefined,
  );
  let verdict;
  try {
    verdict = JSON.parse(answer ?? "");
  } catch {
    verdict = undefined;
  }
  if (verdict?.allow === true) return undefined;
  return {
    block: true,
    reason:
      typeof verdict?.message === "string" && verdict.message
        ? verdict.message
        : `${event.toolName} was not approved`,
  };
}

/**
 * Mounts Pi's MCP extension behind the managed config file and registers the
 * sync command a resident Pi process uses when a Run attaches or changes its
 * MCP servers.
 */
export async function mountManagedMcp(
  pi,
  configPath,
  mountExtension = managedMcpExtension,
) {
  const pendingChanges = [];
  let syncError = "";
  const shadow = (target, props) =>
    Object.create(
      target,
      Object.fromEntries(
        Object.entries(props).map(([key, value]) => [
          key,
          { value, enumerable: true, configurable: true },
        ]),
      ),
    );
  const mcpPi = shadow(pi, {
    on: (event, handler) => {
      if (event !== "mcp_servers_change") return pi.on(event, handler);
      return pi.on(event, (ev, ctx) => {
        let pending;
        try {
          // Only hard runtime errors fail warm attach; per-server connection
          // warnings pass through just as they do on a cold start.
          const wrappedUi = shadow(ctx.ui, {
            notify: (message, type) => {
              if (type === "error") {
                const text = String(message ?? "").trim();
                if (text)
                  syncError = syncError ? `${syncError}\n${text}` : text;
              }
              ctx.ui.notify(message, type);
            },
          });
          pending = Promise.resolve(
            handler(ev, shadow(ctx, { ui: wrappedUi })),
          );
        } catch (error) {
          pending = Promise.reject(error);
        }
        pendingChanges.push(pending);
        return pending;
      });
    },
  });

  await mountExtension(mcpPi);
  for (const entry of loadManagedMcpConfig(configPath).servers) {
    pi.registerMcpServer(entry.name, entry.config);
  }

  const awaitChanges = async (mutated, phase) => {
    if (mutated === 0) return;
    if (pendingChanges.length === 0) {
      throw new Error(`MCP server change handler did not run on ${phase}`);
    }
    await Promise.all(pendingChanges.splice(0));
  };

  const sync = async () => {
    const desired = new Map(
      loadManagedMcpConfig(configPath).servers.map((entry) => [
        entry.name,
        entry.config,
      ]),
    );
    pendingChanges.length = 0;
    let removed = 0;
    for (const existing of pi.getMcpServers()) {
      const wanted = desired.get(existing.name);
      if (
        wanted &&
        JSON.stringify(existing.config) === JSON.stringify(wanted)
      ) {
        continue;
      }
      pi.unregisterMcpServer(existing.name);
      removed += 1;
    }
    await awaitChanges(removed, "removal");

    syncError = "";
    pendingChanges.length = 0;
    const remaining = new Map(
      pi
        .getMcpServers()
        .map((server) => [server.name, JSON.stringify(server.config)]),
    );
    let added = 0;
    for (const [name, config] of desired) {
      if (remaining.get(name) === JSON.stringify(config)) continue;
      pi.registerMcpServer(name, config);
      added += 1;
    }
    await awaitChanges(added, "registration");
    return syncError ? { ok: false, error: syncError } : { ok: true };
  };

  pi.registerCommand(MCP_SYNC_COMMAND, {
    description: "Synchronize managed MCP servers for the adopted Run",
    handler: async (_args, ctx) => {
      let verdict;
      try {
        verdict = await sync();
      } catch (error) {
        verdict = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await ctx.ui.input(MCP_SYNC_DIALOG, JSON.stringify(verdict));
    },
  });
}

const STRATA_PIN_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const STRATA_PIN_ALLOWED_KEYS = new Set([
  "name",
  "prefill_only",
  "resident",
  "anchor",
]);

/**
 * Validates and normalizes the PolyStrata `strata_pin` payload passed into
 * one-shot Pi warm-up turns via LINGER_PI_STRATA_PIN.
 */
export function parseStrataPinConfig(raw) {
  if (!raw || typeof raw !== "string") {
    return undefined;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid LINGER_PI_STRATA_PIN payload");
  }
  for (const key of Object.keys(parsed)) {
    if (!STRATA_PIN_ALLOWED_KEYS.has(key)) {
      throw new Error(`Unsupported strata_pin field: ${key}`);
    }
  }
  if (
    typeof parsed.name !== "string" ||
    parsed.name === "." ||
    parsed.name === ".." ||
    !STRATA_PIN_NAME_PATTERN.test(parsed.name)
  ) {
    throw new Error("Invalid strata_pin.name");
  }
  if (typeof parsed.prefill_only !== "boolean") {
    throw new Error("Invalid strata_pin.prefill_only");
  }
  const resident = parsed.resident ?? "ram";
  if (resident !== "ram" && resident !== "spill") {
    throw new Error("Invalid strata_pin.resident");
  }
  if (
    parsed.anchor !== undefined &&
    (typeof parsed.anchor !== "string" || parsed.anchor.length === 0)
  ) {
    throw new Error("Invalid strata_pin.anchor");
  }
  return {
    name: parsed.name,
    prefill_only: parsed.prefill_only,
    resident,
    ...(parsed.anchor !== undefined ? { anchor: parsed.anchor } : {}),
  };
}

/**
 * Injects the Bifrost extra-param passthrough header and top-level `strata_pin`
 * object onto Pi provider requests during post-load prefix warm-up.
 */
export function registerStrataPinHooks(pi, pinSpec) {
  pi.on("before_provider_headers", (event) => {
    if (event?.headers && typeof event.headers === "object") {
      event.headers["x-bf-passthrough-extra-params"] = "true";
    }
  });
  pi.on("before_provider_request", (event) => {
    if (!event?.payload || typeof event.payload !== "object") {
      return undefined;
    }
    return {
      ...event.payload,
      strata_pin: pinSpec,
    };
  });
}

// The Daemon loads this extension for every Pi Run to enforce bash pipefail,
// the shell-text-hook check (POSIX bash and Windows PowerShell), the
// consecutive shell failure loop guard, permission review, managed MCP
// servers, and the Windows PowerShell UTF-8 override. The review hook stays on
// because a resident Pi process may serve a reviewed Run after an unreviewed
// one. A call a shell guard refuses never reaches review, and a refused call is
// neither run nor rewritten.
export default async function managedExtension(pi) {
  registerWindowsPowerShellTool(pi);
  const strataPinConfig = parseStrataPinConfig(strataPinEnvRaw);
  if (strataPinConfig) {
    registerStrataPinHooks(pi, strataPinConfig);
  }
  const failureLoop = createFailureLoopTracker();
  let cachedPowerShell51;
  const isPowerShell51 = () => {
    if (cachedPowerShell51 === undefined) {
      cachedPowerShell51 = isWindowsPowerShell51();
    }
    return cachedPowerShell51;
  };
  pi.on("tool_call", async (event, ctx) => {
    if (strataPinConfig) {
      return { block: true, reason: "prefix warmup does not execute tools" };
    }
    const blocked =
      (await refuseRewrittenShellText(event, shellTextHook, {
        isPowerShell51,
      })) ??
      failureLoop.beforeToolCall(event) ??
      (await reviewToolCall(event, ctx.ui, ctx.signal));
    if (blocked) return blocked;
    enablePipefail(event);
    return undefined;
  });
  pi.on("tool_result", (event) => failureLoop.onToolResult(event));
  if (process.env.LINGER_PI_MANAGED_MCP_CONFIG) {
    await mountManagedMcp(pi, process.env.LINGER_PI_MANAGED_MCP_CONFIG);
  }
  // Register after mountManagedMcp so createMcpExtension's before_agent_start
  // (waitForDirectServers) finishes initialize + tools/list + registerTool
  // before we sort active tool names or validate warm-up readiness.
  pi.on("before_agent_start", (_event, ctx) => {
    failureLoop.reset();
    if (
      typeof pi.getActiveTools !== "function" ||
      typeof pi.setActiveTools !== "function"
    ) {
      return undefined;
    }
    const current = pi.getActiveTools();
    if (
      strataPinConfig &&
      process.env.LINGER_PI_MANAGED_MCP_CONFIG &&
      typeof pi.getMcpServers === "function" &&
      pi.getMcpServers().length > 0 &&
      !current.some((name) => name.startsWith("mcp__"))
    ) {
      ctx?.ui?.notify?.(
        "Managed MCP tools did not register before prefix warm-up",
        "error",
      );
      ctx?.abort?.();
      return undefined;
    }
    const sorted = sortActiveToolNames(current);
    if (
      sorted.length !== current.length ||
      sorted.some((name, index) => name !== current[index])
    ) {
      pi.setActiveTools(sorted);
    }
    return undefined;
  });
}
