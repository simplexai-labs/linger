import { execFile } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
// The Daemon puts the Computer tools on NODE_PATH so Pi can load this
// extension. Node has read it by now; put back the value Pi inherited so the
// commands Pi starts never resolve a package from the tools.
if (process.env.LINGER_PI_INHERITED_NODE_PATH !== undefined) {
  if (process.env.LINGER_PI_INHERITED_NODE_PATH)
    process.env.NODE_PATH = process.env.LINGER_PI_INHERITED_NODE_PATH;
  else delete process.env.NODE_PATH;
  delete process.env.LINGER_PI_INHERITED_NODE_PATH;
}
// The Daemon executable that judges a bash command before Pi runs it; the
// commands Pi starts do not inherit it.
const shellTextHook = process.env.LINGER_PI_SHELL_TEXT_HOOK;
delete process.env.LINGER_PI_SHELL_TEXT_HOOK;
// An installed Pi may alias bare package imports to its own version. Resolve
// the pinned public entry by URL so this adapter keeps its shipped API.
const { createMcpExtension } = await import(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    import.meta.url,
  ).href
);

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

/**
 * Refuses a bash call whose TeamHub text the shell would rewrite, by the
 * Daemon's shell-text-hook, the check Codex runs before its shell commands.
 * Only a command that names teamhub and holds $ or a backquote can be
 * refused, so no other call starts the hook. A hook that cannot run lets the
 * call proceed.
 */
export async function refuseRewrittenShellText(event, hook = shellTextHook) {
  const command = event.toolName === "bash" ? event.input?.command : undefined;
  if (
    !hook ||
    typeof command !== "string" ||
    !command.includes("teamhub") ||
    !/[$`]/u.test(command)
  ) {
    return undefined;
  }
  const reason = await new Promise((resolve) => {
    const child = execFile(
      hook,
      ["shell-text-hook"],
      { timeout: 10_000 },
      (error, _stdout, stderr) => {
        resolve(error?.code === 2 ? stderr.trim() : "");
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ tool_input: { command } }));
  });
  return reason ? { block: true, reason } : undefined;
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
// commands and MCP tools.
export function reviewedTool(toolName) {
  return toolName === "bash" || toolName.startsWith("mcp__");
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

// The Daemon loads this extension for the shell text check, permission
// review, MCP servers, or any of them. The review hook is always on, because
// a resident Pi process may serve a reviewed Run after one without review.
// A call the shell text check refuses never reaches review.
export default async function managedExtension(pi) {
  pi.on("before_agent_start", () => {
    if (
      typeof pi.getActiveTools !== "function" ||
      typeof pi.setActiveTools !== "function"
    ) {
      return undefined;
    }
    const current = pi.getActiveTools();
    const sorted = sortActiveToolNames(current);
    if (
      sorted.length !== current.length ||
      sorted.some((name, index) => name !== current[index])
    ) {
      pi.setActiveTools(sorted);
    }
    return undefined;
  });
  pi.on(
    "tool_call",
    async (event, ctx) =>
      (await refuseRewrittenShellText(event)) ??
      reviewToolCall(event, ctx.ui, ctx.signal),
  );
  if (process.env.LINGER_PI_MANAGED_MCP_CONFIG) {
    await mountManagedMcp(pi, process.env.LINGER_PI_MANAGED_MCP_CONFIG);
  }
}
