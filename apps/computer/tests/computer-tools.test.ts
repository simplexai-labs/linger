import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
      assert.equal(await refuseRewrittenShellText({ toolName: "powershell", input: { command: 'teamhub message send --content "Quote: $180"' } }, hook), undefined);
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
  const { PERMISSION_REVIEW, reviewToolCall, reviewedTool } = (await import(
    entry
  )) as {
    PERMISSION_REVIEW: string;
    reviewedTool: (toolName: string) => boolean;
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
  const powershell = {
    toolName: "powershell",
    input: { command: "Invoke-WebRequest https://example.com" },
  };

  expect(reviewedTool("bash")).toBe(true);
  expect(reviewedTool("powershell")).toBe(true);
  expect(reviewedTool("mcp__computer__click")).toBe(true);
  expect(reviewedTool("read")).toBe(false);

  expect(
    await reviewToolCall({ toolName: "read", input: {} }, ui("")),
  ).toBeUndefined();
  expect(asked).toEqual([]);
  expect(
    await reviewToolCall(bash, ui(JSON.stringify({ allow: true }))),
  ).toBeUndefined();
  expect(
    await reviewToolCall(powershell, ui(JSON.stringify({ allow: true }))),
  ).toBeUndefined();
  expect(asked).toEqual([
    { title: PERMISSION_REVIEW, call: bash },
    { title: PERMISSION_REVIEW, call: powershell },
  ]);
  expect(
    await reviewToolCall(
      powershell,
      ui(JSON.stringify({ allow: false, message: "denied" })),
    ),
  ).toEqual({ block: true, reason: "denied" });
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
  expect(await reviewToolCall(powershell, ui(undefined))).toEqual({
    block: true,
    reason: "powershell was not approved",
  });
});

it("registers the UTF-8 PowerShell override only on Windows", async () => {
  const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
  const { POWERSHELL_UTF8_PREFIX, registerWindowsPowerShellTool } =
    (await import(entry)) as {
      POWERSHELL_UTF8_PREFIX: string;
      registerWindowsPowerShellTool: (
        pi: { registerTool?: (tool: Record<string, unknown>) => void },
        options?: {
          platform?: string;
          cwd?: string;
          operations?: {
            exec: (
              command: string,
              cwd: string,
              options: { onData: (data: Buffer) => void },
            ) => Promise<{ exitCode: number }>;
          };
        },
      ) => boolean;
    };

  const registered: Array<Record<string, unknown>> = [];
  const fakePi = {
    registerTool: (tool: Record<string, unknown>) => {
      registered.push(tool);
    },
  };

  expect(registerWindowsPowerShellTool(fakePi, { platform: "darwin" })).toBe(
    false,
  );
  expect(registerWindowsPowerShellTool(fakePi, { platform: "linux" })).toBe(
    false,
  );
  expect(registerWindowsPowerShellTool({}, { platform: "win32" })).toBe(false);
  expect(registered).toEqual([]);

  const executed: Array<{ command: string; cwd: string }> = [];
  const ok = registerWindowsPowerShellTool(fakePi, {
    platform: "win32",
    cwd: "C:\\workspace",
    operations: {
      exec: async (command, cwd, { onData }) => {
        executed.push({ command, cwd });
        onData(Buffer.from("ok\n", "utf8"));
        return { exitCode: 0 };
      },
    },
  });
  expect(ok).toBe(true);
  expect(registered).toHaveLength(1);
  const tool = registered[0];
  expect(tool).toBeDefined();
  if (!tool) throw new Error("expected powershell tool");
  expect(tool.name).toBe("powershell");

  const execute = tool.execute as (
    toolCallId: string,
    params: { command: string },
  ) => Promise<unknown>;
  const sample = "@'\nHello \u4f60\u597d\n'@ | teamhub message send --file -";
  await execute("call_1", { command: sample });
  expect(executed).toEqual([
    {
      command: `${POWERSHELL_UTF8_PREFIX}\n${sample}`,
      cwd: "C:\\workspace",
    },
  ]);
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

it("stages a compact self-contained computer-tools bundle with bundled Pi MCP, jiti, Playwright MCP, and QuickJS", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-staged-tools-"));
  const methods: string[] = [];
  let server: Server | undefined;
  try {
    const bundler = (await import(
      new URL("../scripts/bundle-computer-tools.mjs", import.meta.url).href
    )) as {
      COMPUTER_TOOL_VERSIONS: { pi: string };
      stageComputerTools: (
        bundle: string,
        options: { target: string },
      ) => Promise<{
        assets: Array<{ path: string; size_bytes: number }>;
        packages: Array<{ name: string; version: string; path: string }>;
      }>;
      validatedComputerToolAssets: (
        bundle: string,
        target: string,
      ) => Promise<string[]>;
    };
    const manifest = await bundler.stageComputerTools(root, {
      target: "linux-x64",
    });
    const validated = await bundler.validatedComputerToolAssets(
      root,
      "linux-x64",
    );
    expect(validated).toContain("cli/computer-tools/manifest.json");
    expect(manifest.assets.length).toBeLessThan(400);
    expect(manifest.packages).toEqual(
      expect.arrayContaining([
        {
          name: "@earendil-works/pi-coding-agent",
          version: bundler.COMPUTER_TOOL_VERSIONS.pi,
          path: "node_modules/@earendil-works/pi-coding-agent",
        },
        expect.objectContaining({
          name: "jiti",
          path: "node_modules/jiti",
        }),
      ]),
    );

    // Minimal loopback Streamable HTTP MCP server so the staged bundle's lazy
    // MCP runtime (runtime.lazy.js -> runtime.js -> @earendil-works/pi-mcp)
    // executes a real initialize + tools/list + tools/call + shutdown cycle.
    server = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET") {
          response.writeHead(405);
          response.end();
          return;
        }
        if (request.method === "DELETE") {
          methods.push("DELETE");
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405);
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.method) methods.push(message.method);
        if (message.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        const reply = (result: Record<string, unknown>, extraHeaders = {}) => {
          response.writeHead(200, {
            "content-type": "application/json",
            ...extraHeaders,
          });
          response.end(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
          );
        };
        if (message.method === "initialize") {
          reply(
            {
              protocolVersion:
                typeof message.params?.protocolVersion === "string"
                  ? message.params.protocolVersion
                  : "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture-mcp", version: "1.0.0" },
            },
            { "mcp-session-id": "fixture-session-1" },
          );
          return;
        }
        if (message.method === "tools/list") {
          reply({
            tools: [
              {
                name: "echo_ping",
                description: "Echo ping fixture",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
          });
          return;
        }
        if (message.method === "tools/call") {
          const toolArgs = (message.params?.arguments ?? {}) as Record<
            string,
            unknown
          >;
          const text = typeof toolArgs.text === "string" ? toolArgs.text : "";
          reply({
            content: [
              {
                type: "text",
                text: `pong:${text}`,
              },
            ],
          });
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
      })().catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture MCP server did not bind a TCP port");

    const toolsDir = path.join(root, "cli", "computer-tools");
    const expectedJitiDir = await realpath(
      path.join(toolsDir, "node_modules", "jiti"),
    );
    const piMcpPath = path.join(toolsDir, "extensions", "pi-mcp.mjs");
    const mcpConfigPath = path.join(root, "managed-mcp.json");
    await writeFile(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          computer: {
            type: "http",
            url: `http://127.0.0.1:${address.port}/mcp/fixture`,
          },
        },
      }),
      { mode: 0o600 },
    );

    // Run outside the repository with no inherited repo NODE_PATH so any
    // missing bundled dependency fails immediately.
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.NODE_PATH;

    const piResult = await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      import { realpathSync } from "node:fs";
      import { createRequire } from "node:module";
      import path from "node:path";

      const req = createRequire(import.meta.url);
      const jitiEntry = req.resolve("jiti");
      assert.ok(
        realpathSync(jitiEntry).startsWith(${JSON.stringify(expectedJitiDir)} + path.sep),
        "jiti must resolve from staged computer-tools",
      );
      const { createJiti } = req("jiti");
      const jiti = createJiti(import.meta.url, {
        moduleCache: false,
        fsCache: false,
      });
      // Load extensions/pi-mcp.mjs through staged jiti, matching Pi's loader.
      const piMcp = await jiti.import(${JSON.stringify(piMcpPath)});
      assert.equal(process.env.NODE_PATH, undefined, "pi-mcp restores NODE_PATH");
      assert.equal(typeof piMcp.default, "function");

      const loaded = piMcp.loadManagedMcpConfig(${JSON.stringify(mcpConfigPath)});
      assert.equal(loaded.servers.length, 1);
      assert.equal(loaded.servers[0].name, "computer");

      const registered = new Map();
      const handlers = new Map();
      const commands = new Map();
      const tools = new Map();
      const renderers = [];
      const notices = [];
      const fakePi = {
        on: (event, handler) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        getMcpServers: () =>
          [...registered.entries()].map(([name, config]) => ({
            name,
            config: structuredClone(config),
            extensionPath: ${JSON.stringify(piMcpPath)},
          })),
        registerMcpServer: (name, config) => {
          registered.set(name, structuredClone(config));
        },
        unregisterMcpServer: (name) => {
          registered.delete(name);
        },
        registerCommand: (name, def) => {
          commands.set(name, def);
        },
        registerTool: (def) => {
          tools.set(def.name, def);
        },
        registerToolRenderer: (renderer) => {
          renderers.push(renderer);
        },
        getAllTools: () => [...tools.values()],
        getActiveTools: () => [...tools.keys()],
        setActiveTools: () => {},
        events: { emit: () => {}, on: () => () => {} },
      };

      await piMcp.default(fakePi);
      assert.ok(commands.has("mcp"), "real createMcpExtension registers /mcp command");
      assert.ok(commands.has(piMcp.MCP_SYNC_COMMAND), "registers managed sync command");
      assert.ok(renderers.length > 0, "registers MCP tool renderers");
      assert.deepEqual([...registered.keys()], ["computer"]);

      const ctx = {
        cwd: ${JSON.stringify(root)},
        isProjectTrusted: () => true,
        modelRegistry: { getApiKeyForProvider: async () => undefined },
        ui: {
          notify: (message, type) => {
            notices.push({ message: String(message), type });
          },
        },
      };
      for (const start of handlers.get("session_start") ?? []) {
        await start({}, ctx);
      }
      // before_agent_start awaits direct MCP servers, exercising lazy
      // loadMcpRuntime() -> runtime.js -> StreamableHttpTransport -> tools/list.
      for (const before of handlers.get("before_agent_start") ?? []) {
        await before({ systemPromptOptions: { sections: {} } }, ctx);
      }

      const tool = tools.get("mcp__computer__echo_ping");
      assert.ok(tool, "registered MCP tool from loopback server");
      const result = await tool.execute("call_1", { text: "hello-bundle" });
      assert.equal(result.content?.[0]?.text, "pong:hello-bundle");

      for (const shutdown of handlers.get("session_shutdown") ?? []) {
        await shutdown({}, ctx);
      }
      assert.deepEqual(
        notices.filter((entry) => entry.type === "error"),
        [],
        "no MCP error notifications",
      );
      console.log("staged bundled pi-mcp end-to-end passed");
    `,
      ],
      {
        cwd: root,
        env: {
          ...cleanEnv,
          NODE_PATH: path.join(toolsDir, "node_modules"),
          LINGER_PI_INHERITED_NODE_PATH: "",
          LINGER_PI_MANAGED_MCP_CONFIG: mcpConfigPath,
        },
        timeout: 20_000,
      },
    );
    expect(piResult.stdout).toContain(
      "staged bundled pi-mcp end-to-end passed",
    );
    expect(methods).toEqual(
      expect.arrayContaining([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
        "DELETE",
      ]),
    );

    const playwrightResult = await run(
      process.execPath,
      [path.join(toolsDir, "node_modules/@playwright/mcp/cli.js"), "--help"],
      { cwd: root, env: cleanEnv, timeout: 20_000 },
    );
    expect(playwrightResult.stdout).toContain("--browser");

    const quickjsResult = await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import { readFile } from "node:fs/promises";
      import { QuickJS } from "quickjs-wasi";
      const wasm = await readFile("node_modules/quickjs-wasi/quickjs.wasm");
      using vm = await QuickJS.create({ wasm });
      using value = vm.evalCode("6 * 7");
      console.log(value.toNumber());
    `,
      ],
      { cwd: toolsDir, env: cleanEnv, timeout: 20_000 },
    );
    expect(quickjsResult.stdout.trim()).toBe("42");

    if (process.platform !== "win32") {
      // Desktop packaged layout: invoke staged bin/pi through an external
      // symlink matching <home>/runtime/bundled-pi/bin/pi -> .../cli/computer-tools/bin/pi.
      const runtimeBinDir = path.join(root, "runtime", "bin");
      await mkdir(runtimeBinDir, { recursive: true });
      await symlink(process.execPath, path.join(runtimeBinDir, "node"));
      const externalLink = path.join(
        root,
        "external-home",
        "runtime",
        "bundled-pi",
        "bin",
        "pi",
      );
      await mkdir(path.dirname(externalLink), { recursive: true });
      await symlink(path.join(toolsDir, "bin", "pi"), externalLink);
      const desktopVersion = await run(externalLink, ["--version"], {
        cwd: root,
        env: cleanEnv,
        timeout: 20_000,
      });
      expect(desktopVersion.stdout).toContain(
        bundler.COMPUTER_TOOL_VERSIONS.pi,
      );

      // Standalone Local Computer symlink layout:
      // lib-1.0.0/cli/computer-tools -> ../../deps-sha/computer-tools
      // lib-1.0.0/runtime -> ../deps-sha/runtime
      const standaloneRoot = path.join(root, "standalone");
      const depsDir = path.join(standaloneRoot, "deps-abc");
      await mkdir(path.join(depsDir, "runtime", "bin"), { recursive: true });
      await rename(toolsDir, path.join(depsDir, "computer-tools"));
      await symlink(
        process.execPath,
        path.join(depsDir, "runtime", "bin", "node"),
      );
      const standaloneCliDir = path.join(standaloneRoot, "lib-1.0.0", "cli");
      await mkdir(standaloneCliDir, { recursive: true });
      await symlink(
        path.join("..", "..", "deps-abc", "computer-tools"),
        path.join(standaloneCliDir, "computer-tools"),
      );
      await symlink(
        path.join("..", "deps-abc", "runtime"),
        path.join(standaloneRoot, "lib-1.0.0", "runtime"),
      );
      const standaloneDirect = await run(
        path.join(standaloneCliDir, "computer-tools", "bin", "pi"),
        ["--version"],
        { cwd: standaloneRoot, env: cleanEnv, timeout: 20_000 },
      );
      expect(standaloneDirect.stdout).toContain(
        bundler.COMPUTER_TOOL_VERSIONS.pi,
      );

      const standaloneLink = path.join(
        standaloneRoot,
        "home",
        "runtime",
        "bundled-pi",
        "bin",
        "pi",
      );
      await mkdir(path.dirname(standaloneLink), { recursive: true });
      await symlink(
        path.join(standaloneCliDir, "computer-tools", "bin", "pi"),
        standaloneLink,
      );
      const standaloneViaLink = await run(standaloneLink, ["--version"], {
        cwd: standaloneRoot,
        env: cleanEnv,
        timeout: 20_000,
      });
      expect(standaloneViaLink.stdout).toContain(
        bundler.COMPUTER_TOOL_VERSIONS.pi,
      );
    }
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("enables pipefail for each managed Pi bash call only after review allows it", async () => {
  const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
  interface ToolCallEvent {
    toolName: string;
    input?: { command?: unknown };
  }
  interface ToolCallContext {
    ui: { input: (title: string, placeholder: string) => Promise<unknown> };
  }
  type ToolCallHandler = (
    event: ToolCallEvent,
    ctx: ToolCallContext,
  ) => Promise<unknown>;
  const mod = (await import(entry)) as {
    PIPEFAIL_PREFIX: string;
    enablePipefail: (event: ToolCallEvent) => void;
    default: (pi: {
      on: (event: string, handler: ToolCallHandler) => void;
    }) => Promise<void>;
  };

  const bash = { toolName: "bash", input: { command: "false | head -1" } };
  mod.enablePipefail(bash);
  expect(bash.input.command).toBe(`${mod.PIPEFAIL_PREFIX}false | head -1`);
  mod.enablePipefail(bash);
  expect(bash.input.command).toBe(`${mod.PIPEFAIL_PREFIX}false | head -1`);

  const read = { toolName: "read", input: { command: "false | head -1" } };
  mod.enablePipefail(read);
  expect(read.input.command).toBe("false | head -1");

  const powershell = {
    toolName: "powershell",
    input: { command: "Get-Date | Out-String" },
  };
  mod.enablePipefail(powershell);
  expect(powershell.input.command).toBe("Get-Date | Out-String");

  const malformed = { toolName: "bash", input: { command: 42 } };
  mod.enablePipefail(malformed);
  expect(malformed.input.command).toBe(42);

  let toolCall: ToolCallHandler | undefined;
  await mod.default({
    on: (event, handler) => {
      if (event === "tool_call") toolCall = handler;
    },
  });

  const allowedReviewed: Array<unknown> = [];
  const hooked = { toolName: "bash", input: { command: "false | head -1" } };
  const allowedResult = await toolCall!(hooked, {
    ui: {
      input: async (_title, placeholder) => {
        allowedReviewed.push(JSON.parse(placeholder));
        return JSON.stringify({ allow: true });
      },
    },
  });
  expect(allowedReviewed).toEqual([
    { toolName: "bash", input: { command: "false | head -1" } },
  ]);
  expect(allowedResult).toBeUndefined();
  expect(hooked.input.command).toBe(`${mod.PIPEFAIL_PREFIX}false | head -1`);

  const deniedReviewed: Array<unknown> = [];
  const denied = { toolName: "bash", input: { command: "git push" } };
  const deniedResult = await toolCall!(denied, {
    ui: {
      input: async (_title, placeholder) => {
        deniedReviewed.push(JSON.parse(placeholder));
        return JSON.stringify({ allow: false, message: "denied" });
      },
    },
  });
  expect(deniedReviewed).toEqual([
    { toolName: "bash", input: { command: "git push" } },
  ]);
  expect(deniedResult).toEqual({ block: true, reason: "denied" });
  expect(denied.input.command).toBe("git push");
});

it.skipIf(process.platform === "win32")(
  "runs the shell text check before enabling pipefail and leaves refused commands unchanged",
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "linger-pi-pipefail-shell-text-"),
    );
    try {
      const hook = path.join(root, "daemon.mjs");
      const recorded = path.join(root, "command");
      const original = 'teamhub message send --content "Quote: $180"';
      await writeFile(
        hook,
        `#!${process.execPath}
import { writeFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const { tool_input } = JSON.parse(input);
  writeFileSync(${JSON.stringify(recorded)}, String(tool_input.command ?? ""));
  if (process.argv[2] !== "shell-text-hook" || tool_input.command !== ${JSON.stringify(original)}) process.exit(0);
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
      import managedExtension from ${JSON.stringify(new URL("../tools/pi-mcp.mjs", import.meta.url).href)};
      let toolCall;
      await managedExtension({
        on: (event, handler) => {
          if (event === "tool_call") toolCall = handler;
        },
      });
      let uiCalls = 0;
      const event = { toolName: "bash", input: { command: ${JSON.stringify(original)} } };
      const blocked = await toolCall(event, {
        ui: {
          input: async () => {
            uiCalls += 1;
            return JSON.stringify({ allow: true });
          },
        },
      });
      assert.deepEqual(blocked, { block: true, reason: "Not run: use a quoted heredoc" });
      assert.equal(uiCalls, 0);
      assert.equal(event.input.command, ${JSON.stringify(original)});
      console.log("refused shell text stayed unprefixed");
    `,
        ],
        {
          timeout: 20_000,
          env: {
            ...process.env,
            LINGER_PI_SHELL_TEXT_HOOK: hook,
          },
        },
      );
      expect(result.stdout).toContain("refused shell text stayed unprefixed");
      expect(await readFile(recorded, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(process.platform === "win32")(
  "enforces pipefail in bash while staying compatible with sh and opt-out",
  async () => {
    const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
    const { PIPEFAIL_PREFIX } = (await import(entry)) as {
      PIPEFAIL_PREFIX: string;
    };
    const shellOptions = {
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    };

    let bashFailureCode: unknown;
    try {
      await run(
        "/bin/bash",
        ["--norc", "--noprofile", "-c", `${PIPEFAIL_PREFIX}false | head -1`],
        shellOptions,
      );
    } catch (error) {
      bashFailureCode = (error as { code?: unknown }).code;
    }
    expect(typeof bashFailureCode).toBe("number");
    expect(bashFailureCode).not.toBe(0);

    await expect(
      run(
        "/bin/bash",
        [
          "--norc",
          "--noprofile",
          "-c",
          `${PIPEFAIL_PREFIX}set +o pipefail\nfalse | head -1`,
        ],
        shellOptions,
      ),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });

    await expect(
      run(
        "/bin/bash",
        ["--norc", "--noprofile", "-c", `${PIPEFAIL_PREFIX}true`],
        shellOptions,
      ),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });

    await expect(
      run("/bin/sh", ["-c", `${PIPEFAIL_PREFIX}true`], shellOptions),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });

    await expect(
      run(
        "/bin/sh",
        ["-n", "-c", `${PIPEFAIL_PREFIX}false | head -1`],
        shellOptions,
      ),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
  },
  30_000,
);

it("detects Windows PowerShell 5.1 only on win32 and fails open on errors", async () => {
  const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
  const { isWindowsPowerShell51 } = (await import(entry)) as {
    isWindowsPowerShell51: (options?: {
      platform?: string;
      resolveShell?: () => { shell: string; args: string[] };
    }) => boolean;
  };

  expect(
    isWindowsPowerShell51({
      platform: "win32",
      resolveShell: () => ({
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: [],
      }),
    }),
  ).toBe(true);
  expect(
    isWindowsPowerShell51({
      platform: "win32",
      resolveShell: () => ({
        shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        args: [],
      }),
    }),
  ).toBe(false);
  expect(
    isWindowsPowerShell51({
      platform: "darwin",
      resolveShell: () => ({ shell: "powershell.exe", args: [] }),
    }),
  ).toBe(false);
  expect(
    isWindowsPowerShell51({
      platform: "linux",
      resolveShell: () => ({ shell: "powershell.exe", args: [] }),
    }),
  ).toBe(false);
  expect(
    isWindowsPowerShell51({
      platform: "win32",
      resolveShell: () => {
        throw new Error("no powershell");
      },
    }),
  ).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "routes powershell shell-text checks to shell-text-hook with lazy PS 5.1 fast-paths",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "linger-pi-ps-hook-"));
    try {
      const hook = path.join(root, "daemon");
      const logFile = path.join(root, "calls.jsonl");
      await writeFile(
        hook,
        `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), payload }) + "\\n");
  if (payload.tool_input.command.includes("<<")) {
    process.stderr.write("Not run: PowerShell does not support POSIX heredocs\\n");
    process.exit(2);
  }
  if (payload.powershell_51 && payload.tool_input.command.includes("'[{")) {
    process.stderr.write("Not run: Windows PowerShell 5.1 strips embedded double quotes\\n");
    process.exit(2);
  }
  process.exit(0);
});
`,
        { mode: 0o700 },
      );

      const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
      const { refuseRewrittenShellText } = (await import(entry)) as {
        refuseRewrittenShellText: (
          event: { toolName: string; input?: { command?: string } },
          hook?: string,
          options?: { isPowerShell51?: () => boolean },
        ) => Promise<{ block: boolean; reason: string } | undefined>;
      };

      const ps = (command: string) => ({
        toolName: "powershell",
        input: { command },
      });
      let ps51Calls = 0;
      const isPs51True = () => {
        ps51Calls += 1;
        return true;
      };
      let ps7Calls = 0;
      const isPs51False = () => {
        ps7Calls += 1;
        return false;
      };

      // Fast-path skips both hook and isPowerShell51 when command has no
      // teamhub or no double quotes / heredoc operator.
      expect(
        await refuseRewrittenShellText(
          ps(`node -e 'console.log("hi")'`),
          hook,
          {
            isPowerShell51: isPs51True,
          },
        ),
      ).toBeUndefined();
      expect(
        await refuseRewrittenShellText(
          ps("teamhub message ask-user --title Pick --questions-file q.json"),
          hook,
          { isPowerShell51: isPs51True },
        ),
      ).toBeUndefined();
      expect(ps51Calls).toBe(0);

      // PowerShell 7 with double quotes and no << skips spawning the hook.
      expect(
        await refuseRewrittenShellText(
          ps(
            `teamhub message ask-user --title "Pick" --questions '[{"question":"Where?"}]'`,
          ),
          hook,
          { isPowerShell51: isPs51False },
        ),
      ).toBeUndefined();
      expect(ps7Calls).toBe(1);

      // PowerShell 5.1 with double quotes invokes shell-text-hook and blocks on exit 2.
      const ps51Cmd = `teamhub message ask-user --title "Pick" --questions '[{"question":"Where?"}]'`;
      expect(
        await refuseRewrittenShellText(ps(ps51Cmd), hook, {
          isPowerShell51: isPs51True,
        }),
      ).toEqual({
        block: true,
        reason: "Not run: Windows PowerShell 5.1 strips embedded double quotes",
      });
      expect(ps51Calls).toBe(1);

      // PowerShell 5.1 command allowed by hook (exit 0) passes through.
      expect(
        await refuseRewrittenShellText(
          ps('teamhub message send --content "Done."'),
          hook,
          { isPowerShell51: isPs51True },
        ),
      ).toBeUndefined();

      // PowerShell 7 with POSIX heredoc invokes shell-text-hook with powershell_51: false.
      const heredocCmd = "teamhub message send --file - <<'EOF'\nHello\nEOF";
      expect(
        await refuseRewrittenShellText(ps(heredocCmd), hook, {
          isPowerShell51: isPs51False,
        }),
      ).toEqual({
        block: true,
        reason: "Not run: PowerShell does not support POSIX heredocs",
      });

      // Missing or unset hook fails open.
      expect(
        await refuseRewrittenShellText(
          ps(ps51Cmd),
          path.join(root, "missing"),
          {
            isPowerShell51: isPs51True,
          },
        ),
      ).toBeUndefined();
      expect(
        await refuseRewrittenShellText(ps(ps51Cmd), "", {
          isPowerShell51: isPs51True,
        }),
      ).toBeUndefined();

      const recorded = (await readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(recorded).toEqual([
        {
          argv: ["shell-text-hook"],
          payload: {
            tool_name: "powershell",
            powershell_51: true,
            tool_input: { command: ps51Cmd },
          },
        },
        {
          argv: ["shell-text-hook"],
          payload: {
            tool_name: "powershell",
            powershell_51: true,
            tool_input: { command: 'teamhub message send --content "Done."' },
          },
        },
        {
          argv: ["shell-text-hook"],
          payload: {
            tool_name: "powershell",
            powershell_51: false,
            tool_input: { command: heredocCmd },
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it("warns at 3 consecutive failures, blocks at 5, preserves structuredContent, exempts --help, and resets cleanly", async () => {
  const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
  const { createFailureLoopTracker, PIPEFAIL_PREFIX, shellFailureSignature } =
    (await import(entry)) as {
      PIPEFAIL_PREFIX: string;
      shellFailureSignature: (
        toolName: string,
        command: string,
      ) => string | undefined;
      createFailureLoopTracker: () => {
        reset: () => void;
        beforeToolCall: (
          event: Record<string, unknown>,
        ) => { block: boolean; reason: string } | undefined;
        onToolResult: (event: Record<string, unknown>) =>
          | {
              content?: Array<{ type: string; text: string }>;
              structuredContent?: unknown;
            }
          | undefined;
      };
    };

  expect(
    shellFailureSignature(
      "powershell",
      `@'\n[{"a":"b"}]\n'@ | teamhub.exe message ask-user --title "Pick" --questions-file -`,
    ),
  ).toBe("teamhub message ask-user");
  expect(
    shellFailureSignature(
      "powershell",
      `$q = '[{"a":"b"}]'; & teamhub.cmd message ask-user --title "Pick" --questions $q`,
    ),
  ).toBe("teamhub message ask-user");
  expect(
    shellFailureSignature(
      "powershell",
      `& "C:\\bin\\teamhub.exe" message ask-user --title "Pick"`,
    ),
  ).toBe("teamhub message ask-user");
  expect(
    shellFailureSignature(
      "powershell",
      `&"C:\\bin\\teamhub.exe" message ask-user --title "Pick"`,
    ),
  ).toBe("teamhub message ask-user");
  expect(
    shellFailureSignature("powershell", "./teamhub message send --content hi"),
  ).toBe("teamhub message send");
  expect(
    shellFailureSignature("powershell", "teamhub message ask-user `\n  --help"),
  ).toBeUndefined();
  expect(
    shellFailureSignature("powershell", `$body = "teamhub" + ' says "hello"'`),
  ).toBe(`powershell:$body = "teamhub" + ' says "hello"'`);
  expect(shellFailureSignature("powershell", "& teamhub @args")).toBe(
    "teamhub",
  );
  expect(
    shellFailureSignature(
      "bash",
      "teamhub docs update doc-1 --command str_replace --pattern a --content b",
    ),
  ).toBe("teamhub docs update");
  expect(shellFailureSignature("bash", 'teamhub message search "budget"')).toBe(
    "teamhub message search",
  );
  expect(shellFailureSignature("bash", "teamhub message search budget")).toBe(
    "teamhub message search",
  );
  expect(
    shellFailureSignature(
      "bash",
      "teamhub docs comment reply thr_1 --content hi",
    ),
  ).toBe("teamhub docs comment");
  expect(
    shellFailureSignature(
      "bash",
      "teamhub image-gen --provider fal --model fal-ai/flux/dev --prompt fox",
    ),
  ).toBe("teamhub image-gen");
  expect(
    shellFailureSignature(
      "bash",
      "cat <<'EOF' | teamhub message send --file -\nteamhub docs create --title \"fake\"\nEOF",
    ),
  ).toBe("teamhub message send");
  expect(
    shellFailureSignature(
      "bash",
      `${PIPEFAIL_PREFIX}teamhub message ask-user --title "Pick"`,
    ),
  ).toBe("teamhub message ask-user");
  expect(
    shellFailureSignature("powershell", "teamhub message ask-user --help"),
  ).toBeUndefined();
  expect(
    shellFailureSignature("bash", "teamhub message ask-user -h"),
  ).toBeUndefined();
  expect(
    shellFailureSignature("bash", "teamhub message ask-user --schema --json"),
  ).toBeUndefined();
  expect(
    shellFailureSignature("bash", 'teamhub message send --content "--help"'),
  ).toBe("teamhub message send");
  expect(
    shellFailureSignature(
      "bash",
      'teamhub message send --content "see --help here"',
    ),
  ).toBe("teamhub message send");
  expect(
    shellFailureSignature(
      "powershell",
      "teamhub message send --content 'it''s --help and -h here'",
    ),
  ).toBe("teamhub message send");
  expect(
    shellFailureSignature("bash", 'teamhub message send --content "hi" --help'),
  ).toBeUndefined();
  expect(
    shellFailureSignature(
      "bash",
      'df -h; teamhub message ask-user --title "Pick" --questions-file q.json',
    ),
  ).toBe("teamhub message ask-user");
  expect(
    shellFailureSignature(
      "powershell",
      'teamhub apps list; teamhub message ask-user --title "Pick" --questions-file q.json',
    ),
  ).toBe("teamhub message ask-user");
  expect(
    shellFailureSignature(
      "powershell",
      "teamhub apps list; teamhub message ask-user --help",
    ),
  ).toBeUndefined();
  expect(shellFailureSignature("bash", "df -h")).toBe("bash:df -h");
  expect(shellFailureSignature("bash", "git status --help")).toBeUndefined();
  expect(shellFailureSignature("bash", 'echo "--help"')).toBe(
    'bash:echo "--help"',
  );
  expect(shellFailureSignature("bash", 'echo "see --help here"')).toBe(
    'bash:echo "see --help here"',
  );
  expect(shellFailureSignature("bash", "pnpm   test\n")).toBe("bash:pnpm test");
  expect(shellFailureSignature("read", "teamhub message send")).toBeUndefined();

  const tracker = createFailureLoopTracker();
  const variants = [
    `teamhub message ask-user --title "Pick" --questions '[{"a":"b"}]'`,
    `$q = '[{"a":"b"}]'; teamhub message ask-user --title "Pick" --questions $q`,
    `teamhub.exe message ask-user --title "Pick" --questions-file missing.json`,
    `@'\n[]\n'@ | teamhub message ask-user --title "Pick" --questions-file -`,
    `& teamhub.cmd message ask-user --title "Pick" --questions-file broken.json`,
  ];

  for (let i = 0; i < variants.length; i += 1) {
    const call = {
      toolCallId: `call_${i}`,
      toolName: "powershell",
      input: { command: variants[i] },
    };
    expect(tracker.beforeToolCall(call)).toBeUndefined();
    const structuredContent = { exitCode: 2 };
    const result = tracker.onToolResult({
      ...call,
      isError: true,
      content: [{ type: "text", text: "invalid_input" }],
      structuredContent,
    });
    if (i === 2) {
      expect(result).toEqual({
        content: [
          { type: "text", text: "invalid_input" },
          {
            type: "text",
            text: expect.stringContaining(
              "[Linger loop guard] teamhub message ask-user has failed 3 times in a row.",
            ),
          },
        ],
        structuredContent,
      });
    } else {
      expect(result).toBeUndefined();
    }
  }

  // 6th call (after 5 consecutive failures) is blocked.
  expect(
    tracker.beforeToolCall({
      toolCallId: "call_blocked",
      toolName: "powershell",
      input: { command: "teamhub message ask-user --title 'Again'" },
    }),
  ).toEqual({
    block: true,
    reason: expect.stringContaining(
      "Blocked after 5 consecutive failures of teamhub message ask-user.",
    ),
  });

  // --help is never blocked and succeeding resets the streak.
  const helpCall = {
    toolCallId: "call_help",
    toolName: "powershell",
    input: { command: "teamhub message ask-user --help" },
  };
  expect(tracker.beforeToolCall(helpCall)).toBeUndefined();
  expect(
    tracker.onToolResult({
      ...helpCall,
      isError: false,
      content: [{ type: "text", text: "Usage..." }],
    }),
  ).toBeUndefined();
  expect(
    tracker.beforeToolCall({
      toolCallId: "call_after_help",
      toolName: "powershell",
      input: { command: "teamhub message ask-user --title 'After help'" },
    }),
  ).toBeUndefined();

  // Succeeding with another tool (such as write) also resets a streak, and
  // non-teamhub guidance omits "--help" suggestions.
  for (let i = 0; i < 5; i += 1) {
    const call = {
      toolCallId: `bash_${i}`,
      toolName: "bash",
      input: { command: `${PIPEFAIL_PREFIX}npm test` },
    };
    const res = tracker.onToolResult({ ...call, isError: true, content: [] });
    if (i === 2) {
      expect(res?.content?.[0]?.text).toContain(
        "bash:npm test has failed 3 times in a row. Do not keep retrying the same failing command",
      );
      expect(res?.content?.[0]?.text).not.toContain("--help");
    }
  }
  const bashBlocked = tracker.beforeToolCall({
    toolCallId: "bash_blocked",
    toolName: "bash",
    input: { command: "npm test" },
  });
  expect(bashBlocked).toMatchObject({
    block: true,
    reason: expect.stringContaining(
      "Blocked after 5 consecutive failures of bash:npm test.",
    ),
  });
  expect(bashBlocked?.reason).not.toContain("--help");
  // Distinct non-teamhub command is not blocked.
  expect(
    tracker.beforeToolCall({
      toolCallId: "bash_other",
      toolName: "bash",
      input: { command: "npm run lint" },
    }),
  ).toBeUndefined();

  tracker.onToolResult({
    toolCallId: "write_1",
    toolName: "write",
    isError: false,
    content: [],
  });
  expect(
    tracker.beforeToolCall({
      toolCallId: "bash_after_write",
      toolName: "bash",
      input: { command: "npm test" },
    }),
  ).toBeUndefined();

  // reset() clears streak across Runs in a resident Pi process.
  for (let i = 0; i < 5; i += 1) {
    const call = {
      toolCallId: `res_${i}`,
      toolName: "bash",
      input: { command: "npm test" },
    };
    tracker.onToolResult({ ...call, isError: true, content: [] });
  }
  expect(
    tracker.beforeToolCall({
      toolCallId: "res_blocked",
      toolName: "bash",
      input: { command: "npm test" },
    }),
  ).toMatchObject({ block: true });
  tracker.reset();
  expect(
    tracker.beforeToolCall({
      toolCallId: "res_after_reset",
      toolName: "bash",
      input: { command: "npm test" },
    }),
  ).toBeUndefined();
});

it("wires loop guard reset on before_agent_start and blocks before review in managedExtension", async () => {
  const entry = new URL("../tools/pi-mcp.mjs", import.meta.url).href;
  const mod = (await import(entry)) as {
    default: (pi: Record<string, unknown>) => Promise<void>;
  };

  type Handler = (
    event: Record<string, unknown>,
    ctx?: Record<string, unknown>,
  ) => unknown;
  const handlers = new Map<string, Handler[]>();
  const fakePi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
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

  let reviewCalls = 0;
  const ctx = {
    ui: {
      input: async () => {
        reviewCalls += 1;
        return JSON.stringify({ allow: true });
      },
    },
  };
  const emitToolCall = async (event: Record<string, unknown>) => {
    for (const handler of handlers.get("tool_call") ?? []) {
      const result = await handler(event, ctx);
      if (result) return result;
    }
    return undefined;
  };
  const emitToolResult = async (event: Record<string, unknown>) => {
    for (const handler of handlers.get("tool_result") ?? []) {
      const result = await handler(event, ctx);
      if (result) return result;
    }
    return undefined;
  };

  // 5 consecutive bash failures trigger warning on 3rd and block on 6th before review.
  for (let i = 0; i < 5; i += 1) {
    const call = {
      toolCallId: `loop_${i}`,
      toolName: "bash",
      input: { command: `teamhub message ask-user --title "T${i}"` },
    };
    expect(await emitToolCall(call)).toBeUndefined();
    const res = await emitToolResult({
      ...call,
      isError: true,
      content: [{ type: "text", text: "bad" }],
    });
    if (i === 2) {
      expect(res).toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("failed 3 times in a row"),
          }),
        ]),
      });
    }
  }
  expect(reviewCalls).toBe(5);
  const loopBlocked = await emitToolCall({
    toolCallId: "loop_5",
    toolName: "bash",
    input: { command: 'teamhub message ask-user --title "T5"' },
  });
  expect(loopBlocked).toMatchObject({
    block: true,
    reason: expect.stringContaining("Blocked after 5 consecutive failures"),
  });
  expect(reviewCalls).toBe(5);

  // before_agent_start resets the streak for the next Run.
  for (const start of handlers.get("before_agent_start") ?? []) {
    await start({}, ctx);
  }
  expect(
    await emitToolCall({
      toolCallId: "loop_next_run",
      toolName: "bash",
      input: { command: 'teamhub message ask-user --title "Fresh"' },
    }),
  ).toBeUndefined();
  expect(reviewCalls).toBe(6);
});
