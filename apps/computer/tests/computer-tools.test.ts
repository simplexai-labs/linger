import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("keeps Pi's public MCP extension bound to private Operation proxies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-pi-extension-"));
  try {
    const result = await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      import { chmodSync, writeFileSync } from "node:fs";
      import { loadManagedMcpConfig } from ${JSON.stringify(new URL("../tools/pi-mcp.mjs", import.meta.url).href)};
      const file = ${JSON.stringify(path.join(root, "mcp.json"))};
      const write = (server) => writeFileSync(file, JSON.stringify({mcpServers:{computer:server}}),{mode:0o600});
      write({type:"http",url:"http://127.0.0.1:1234/mcp/fixture"});
      const config=loadManagedMcpConfig(file);
      assert.equal(config.autoEnableCodemode,false);
      assert.equal(config.servers[0].config.exposure,"direct");
      for(const server of [
        {type:"http",url:"https://example.com"},
        {type:"http",url:"http://localhost:1234"},
        {type:"http",url:"http://secret@127.0.0.1:1234"},
        {type:"http",url:"http://127.0.0.1:1234",headers:{Authorization:"credential"}},
        {type:"stdio",url:"http://127.0.0.1:1234",command:"untrusted"}
      ]){write(server);assert.throws(()=>loadManagedMcpConfig(file));}
      write({type:"http",url:"http://127.0.0.1:1234"});
      if(process.platform!=="win32"){chmodSync(file,0o644);assert.throws(()=>loadManagedMcpConfig(file),/private/);}
      assert.equal(process.env.NODE_PATH,"inherited");
      assert.equal(process.env.LINGER_PI_INHERITED_NODE_PATH,undefined);
      console.log("private immutable MCP configuration passed");
    `,
      ],
      {
        timeout: 20_000,
        env: {
          ...process.env,
          NODE_PATH: path.join(root, "tools", "node_modules"),
          LINGER_PI_INHERITED_NODE_PATH: "inherited",
        },
      },
    );
    expect(result.stdout).toContain(
      "private immutable MCP configuration passed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.platform === "win32")(
  "refuses a bash call the Daemon's shell-text-hook refuses",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "linger-pi-shell-text-"));
    try {
      const hook = path.join(root, "daemon");
      await writeFile(
        hook,
        `#!${process.execPath}
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const { tool_input } = JSON.parse(input);
  if (process.argv[2] !== "shell-text-hook" || !tool_input.command.includes("$1")) process.exit(0);
  process.stderr.write("Not run: use a quoted heredoc\\n");
  process.exit(2);
});
`,
        { mode: 0o700 },
      );
      const result = await run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
      import assert from "node:assert/strict";
      import { refuseRewrittenShellText } from ${JSON.stringify(new URL("../tools/pi-mcp.mjs", import.meta.url).href)};
      const hook = ${JSON.stringify(hook)};
      const bash = (command) => ({ toolName: "bash", input: { command } });
      assert.deepEqual(
        await refuseRewrittenShellText(bash('teamhub message send --content "Quote: $180"'), hook),
        { block: true, reason: "Not run: use a quoted heredoc" },
      );
      assert.equal(await refuseRewrittenShellText(bash('teamhub message send --content "Total $TOTAL"'), hook), undefined);
      assert.equal(await refuseRewrittenShellText(bash('teamhub message send --content "Done."'), hook), undefined);
      assert.equal(await refuseRewrittenShellText({ toolName: "read", input: { path: "$1" } }, hook), undefined);
      assert.equal(await refuseRewrittenShellText(bash('teamhub message send --content "$180"'), ${JSON.stringify(path.join(root, "missing"))}), undefined);
      assert.equal(await refuseRewrittenShellText(bash('teamhub message send --content "$180"'), undefined), undefined);
      console.log("shell text check passed");
    `,
        ],
        { timeout: 20_000 },
      );
      expect(result.stdout).toContain("shell text check passed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it("asks the Daemon about Pi commands and MCP calls and blocks unless allowed", async () => {
  const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
  const { PERMISSION_REVIEW, reviewToolCall } = (await import(entry)) as {
    PERMISSION_REVIEW: string;
    reviewToolCall: (
      event: { toolName: string; input: Record<string, unknown> },
      ui: { input: (title: string, placeholder: string) => Promise<unknown> },
    ) => Promise<unknown>;
  };
  const asked: Array<{ title: string; call: unknown }> = [];
  const ui = (answer: string | undefined) => ({
    input: async (title: string, placeholder: string) => {
      asked.push({ title, call: JSON.parse(placeholder) });
      return answer;
    },
  });
  const bash = { toolName: "bash", input: { command: "git push" } };

  expect(
    await reviewToolCall({ toolName: "read", input: {} }, ui("")),
  ).toBeUndefined();
  expect(asked).toEqual([]);
  expect(
    await reviewToolCall(bash, ui(JSON.stringify({ allow: true }))),
  ).toBeUndefined();
  expect(asked).toEqual([{ title: PERMISSION_REVIEW, call: bash }]);
  expect(
    await reviewToolCall(
      { toolName: "mcp__computer__click", input: {} },
      ui(JSON.stringify({ allow: false, message: "not now" })),
    ),
  ).toEqual({ block: true, reason: "not now" });
  expect(await reviewToolCall(bash, ui(undefined))).toEqual({
    block: true,
    reason: "bash was not approved",
  });
});

it("synchronizes managed MCP servers dynamically and reports structured verdicts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-pi-sync-mcp-"));
  try {
    const configPath = path.join(root, "linger-mcp.json");
    const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
    const mod = (await import(entry)) as {
      MCP_SYNC_COMMAND: string;
      MCP_SYNC_DIALOG: string;
      mountManagedMcp: (
        pi: Record<string, unknown>,
        configPath: string,
        mountExtension: (pi: Record<string, unknown>) => Promise<void>,
      ) => Promise<void>;
    };
    const writeConfig = (mcpServers: Record<string, unknown>) =>
      writeFile(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
    const proxy = (port: number, name: string) => ({
      type: "http",
      url: `http://127.0.0.1:${port}/mcp/tok/${name}`,
    });
    await writeConfig({});

    type EventHandler = (event: unknown, ctx: unknown) => Promise<void> | void;
    type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
    const registered = new Map<string, Record<string, unknown>>();
    const handlers = new Map<string, EventHandler[]>();
    const commands = new Map<string, { handler: CommandHandler }>();
    const notifications: string[] = [];
    let nextNotice: { message: string; type: "warning" | "error" } | undefined;

    const emit = async (event: string, payload: unknown) => {
      // Real Pi exposes ExtensionContext.ui as a getter-only property.
      const ui = {
        get notify() {
          return (_message: string, type: string) => notifications.push(type);
        },
      };
      const ctx = {
        get ui() {
          return ui;
        },
      };
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    };

    const fakePi = {
      on: (event: string, handler: EventHandler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      getMcpServers: () =>
        [...registered.entries()].map(([name, config]) => ({
          name,
          config: structuredClone(config),
          extensionPath: entry,
        })),
      registerMcpServer: (name: string, config: Record<string, unknown>) => {
        registered.set(name, structuredClone(config));
        void emit("mcp_servers_change", { servers: fakePi.getMcpServers() });
      },
      unregisterMcpServer: (name: string) => {
        if (registered.delete(name)) {
          void emit("mcp_servers_change", { servers: fakePi.getMcpServers() });
        }
      },
      registerCommand: (name: string, def: { handler: CommandHandler }) => {
        commands.set(name, def);
      },
    };

    await mod.mountManagedMcp(fakePi, configPath, async (mcpPi) => {
      (mcpPi.on as typeof fakePi.on)(
        "mcp_servers_change",
        async (_ev, rawCtx) => {
          const { ui } = rawCtx as {
            ui: { notify: (message: string, type: string) => void };
          };
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (nextNotice) {
            const notice = nextNotice;
            nextNotice = undefined;
            ui.notify(notice.message, notice.type);
          }
        },
      );
    });
    expect(registered.size).toBe(0);

    const runSync = async () => {
      let verdict: { title: string; payload: unknown } | undefined;
      await commands.get(mod.MCP_SYNC_COMMAND)!.handler("", {
        ui: {
          input: async (title: string, placeholder: string) => {
            verdict = { title, payload: JSON.parse(placeholder) };
            return "ok";
          },
        },
      });
      return verdict;
    };

    const ok = { title: mod.MCP_SYNC_DIALOG, payload: { ok: true } };
    await writeConfig({
      computer: proxy(4101, "computer"),
      docs: proxy(4101, "docs"),
    });
    expect(await runSync()).toEqual(ok);
    expect([...registered.keys()].sort()).toEqual(["computer", "docs"]);

    // Replace one server and drop the other.
    await writeConfig({ computer: proxy(4102, "computer") });
    expect(await runSync()).toEqual(ok);
    expect([...registered.keys()]).toEqual(["computer"]);
    expect(registered.get("computer")?.url).toBe(proxy(4102, "computer").url);

    // Per-server connection warnings pass through without failing warm attach.
    nextNotice = {
      type: "warning",
      message: "MCP servers need attention:\n  flaky: failed",
    };
    await writeConfig({
      computer: proxy(4102, "computer"),
      flaky: proxy(4102, "flaky"),
    });
    expect(await runSync()).toEqual(ok);

    // Hard runtime errors fail the verdict so the Daemon falls back cleanly.
    nextNotice = { type: "error", message: "MCP failed to load: boom" };
    await writeConfig({
      computer: proxy(4102, "computer"),
      flaky: proxy(4102, "flaky"),
      broken: proxy(4102, "broken"),
    });
    expect(await runSync()).toEqual({
      title: mod.MCP_SYNC_DIALOG,
      payload: { ok: false, error: "MCP failed to load: boom" },
    });
    expect(notifications).toEqual(["warning", "error"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("sorts managed MCP servers and active tool names deterministically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-pi-tool-order-"));
  try {
    const file = path.join(root, "mcp.json");
    const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
    const mod = (await import(entry)) as {
      default: (pi: Record<string, unknown>) => Promise<void>;
      loadManagedMcpConfig: (configPath: string) => {
        servers: Array<{ name: string }>;
      };
      sortActiveToolNames: (names: string[]) => string[];
    };

    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          zeta: { type: "http", url: "http://127.0.0.1:1001/zeta" },
          alpha: { type: "http", url: "http://127.0.0.1:1002/alpha" },
          mid: { type: "http", url: "http://127.0.0.1:1003/mid" },
        },
      }),
      { mode: 0o600 },
    );
    expect(mod.loadManagedMcpConfig(file).servers.map((s) => s.name)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);

    expect(
      mod.sortActiveToolNames([
        "read",
        "mcp__zeta__b",
        "bash",
        "mcp__alpha__z",
        "edit",
        "read_mcp_resource",
        "mcp__alpha__a",
        "list_mcp_resources",
      ]),
    ).toEqual([
      "read",
      "bash",
      "edit",
      "list_mcp_resources",
      "mcp__alpha__a",
      "mcp__alpha__z",
      "mcp__zeta__b",
      "read_mcp_resource",
    ]);

    const handlers = new Map<string, () => Promise<void> | void>();
    let currentTools = ["read", "bash", "mcp__zeta__b", "mcp__alpha__a"];
    const setCalls: string[][] = [];
    const fakePi = {
      on: (event: string, handler: () => Promise<void> | void) => {
        handlers.set(event, handler);
      },
      getActiveTools: () => currentTools,
      setActiveTools: (next: string[]) => {
        setCalls.push(next);
        currentTools = next;
      },
    };
    const prevConfig = process.env.LINGER_PI_MANAGED_MCP_CONFIG;
    delete process.env.LINGER_PI_MANAGED_MCP_CONFIG;
    try {
      await mod.default(fakePi);
    } finally {
      if (prevConfig !== undefined) {
        process.env.LINGER_PI_MANAGED_MCP_CONFIG = prevConfig;
      }
    }
    const beforeStart = handlers.get("before_agent_start");
    expect(beforeStart).toBeTypeOf("function");
    await beforeStart!();
    expect(setCalls).toEqual([
      ["read", "bash", "mcp__alpha__a", "mcp__zeta__b"],
    ]);
    // Running again when already sorted does not trigger an extra rebuild.
    await beforeStart!();
    expect(setCalls).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
