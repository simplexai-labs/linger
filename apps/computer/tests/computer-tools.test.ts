import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  PERMISSION_REVIEW,
  applyManagedPromptOptions,
  compactSkillDescription,
  createManagedPiExtension,
  handleSessionBeforeCompact,
  isConstrainedContext,
  isLocalModel,
  resolveCompactionPolicy,
  resolveEffectiveContextWindow,
  reviewToolCall,
  selectCompactionThinkingLevel,
} from "../tools/pi-mcp.mjs";
import {
  createSyntheticSourceInfo,
  type BuildSystemPromptOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { SETTINGS_DEFAULTS } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-defaults.js";
import {
  renderServersSection,
  type McpServerListing,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.js";
import { createToolSearchToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/tool-search/tool.js";

const run = promisify(execFile);

const BASE_TOOL_SNIPPETS: Record<string, string> = {
  read: "Read file contents",
  bash: "Execute bash commands",
  edit: "Make surgical edits to files",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns",
  find: "Find files by glob pattern",
  ls: "List directory contents",
  tool_search: "Search for tools that are not loaded yet and load the matches",
};

function makeSkill(name: string, description: string): Skill {
  const baseDir = `/workspace/.agents/skills/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    name,
    description,
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, {
      source: "project",
      baseDir,
    }),
    disableModelInvocation: false,
  };
}

const REALISTIC_SKILLS: readonly Skill[] = [
  makeSkill(
    "artifact",
    "Create, format, and inspect standalone files to save, share, print, or present—including PDFs, Word documents, spreadsheets, slides, HTML pages, diagrams, and charts. Use when the user asks for a deliverable file or export rather than an inline chat reply; choose the right tool, verify rendered output visually, and attach the final artifact.",
  ),
  makeSkill(
    "chat-card",
    "Build interactive inline chat cards such as quick charts, checklists, compact dashboards, timers, or micro-tools rendered directly inside the Room conversation. Read this skill before composing a chat card so layout, state updates, and safety constraints follow the Room card contract.",
  ),
  makeSkill(
    "personal-profile",
    "Build, update, and verify the user's personal profile and structured life/work preferences from workspace evidence, conversations, and connected sources. Follow evidence attribution rules strictly and never invent facts or overwrite confirmed user details.",
  ),
  makeSkill(
    "slide-deck",
    "Plan, structure, and generate presentation decks and slide outlines with clear narrative flow, visual hierarchy, and audience-appropriate pacing. Always gather audience, style, and slide count before building a Human-requested deck.",
  ),
  makeSkill(
    "media-generation",
    "Generate and edit images, illustrations, diagrams, and audio/video media assets using configured generation tools. Select aspect ratios, styles, and prompts carefully and inspect output files before delivering them to the Room.",
  ),
  makeSkill(
    "proactive-response",
    "Decide whether to speak or stay silent during proactive wakes, routines, and unaddressed Room messages. Prioritize high-signal updates, avoid duplicate reminders, and keep proactive messages concise and actionable.",
  ),
  makeSkill(
    "collaborate",
    "Coordinate multi-agent collaboration plans, room protocols, role assignments, and handoffs across specialist agents. Publish clear dependencies and ownership so each agent knows its deliverable and receiver.",
  ),
  makeSkill(
    "pptx",
    "Create and edit PowerPoint (.pptx) decks with clean layouts, typography, charts, and visual QA of rendered slide images.",
  ),
];

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

it("keeps Pi's public MCP extension bound to private Operation proxies with deferred exposure", async () => {
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
      const write = (servers) => writeFileSync(file, JSON.stringify({mcpServers:servers}),{mode:0o600});
      write({
        computer: {type:"http",url:"http://127.0.0.1:1234/mcp/computer"},
        extra: {type:"http",url:"http://127.0.0.1:1234/mcp/extra"},
        custom: {type:"http",url:"http://127.0.0.1:1234/mcp/custom",description:"Custom MCP tools"}
      });
      const config = loadManagedMcpConfig(file);
      assert.equal(config.autoEnableCodemode, false);
      assert.equal(config.servers.length, 3);
      for (const entry of config.servers) {
        assert.equal(entry.config.exposure, "deferred");
        assert.ok(entry.config.description && entry.config.description.length > 0);
      }
      assert.match(config.servers[0].config.description, /desktop and browser UI script automation \\(ui_exec, ui_reset\\)/i);
      assert.equal(config.servers[1].config.description, "Managed MCP server tools");
      assert.equal(config.servers[2].config.description, "Custom MCP tools");
      for(const server of [
        {type:"http",url:"https://example.com"},
        {type:"http",url:"http://localhost:1234"},
        {type:"http",url:"http://secret@127.0.0.1:1234"},
        {type:"http",url:"http://127.0.0.1:1234",headers:{Authorization:"credential"}},
        {type:"stdio",url:"http://127.0.0.1:1234",command:"untrusted"}
      ]){write({computer:server});assert.throws(()=>loadManagedMcpConfig(file));}
      write({computer:{type:"http",url:"http://127.0.0.1:1234"}});
      if(process.platform!=="win32"){chmodSync(file,0o644);assert.throws(()=>loadManagedMcpConfig(file),/private/);}
      assert.equal(process.env.NODE_PATH,"inherited");
      assert.equal(process.env.LINGER_PI_INHERITED_NODE_PATH,undefined);
      console.log("private immutable deferred MCP configuration passed");
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
      "private immutable deferred MCP configuration passed",
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
  expect(
    await reviewToolCall(
      { toolName: "tool_search", input: { query: "ui_exec" } },
      ui(""),
    ),
  ).toBeUndefined();
  expect(asked).toEqual([]);
  expect(
    await reviewToolCall(bash, ui(JSON.stringify({ allow: true }))),
  ).toBeUndefined();
  expect(asked).toEqual([{ title: PERMISSION_REVIEW, call: bash }]);
  expect(
    await reviewToolCall(
      { toolName: "mcp__computer__ui_exec", input: {} },
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

it("wires tool_call review, prompt hygiene, and compaction hooks in the managed Pi extension", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const fakePi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
  };
  await createManagedPiExtension({
    getConfigPath: () => undefined,
    getContextWindow: () => "65536",
  })(fakePi as never);

  expect([...handlers.keys()]).toEqual([
    "tool_call",
    "before_agent_start",
    "session_before_compact",
  ]);
  const onToolCall = handlers.get("tool_call")!;
  const asked: string[] = [];
  const ctx = {
    ui: {
      input: async (_title: string, placeholder: string) => {
        asked.push((JSON.parse(placeholder) as { toolName: string }).toolName);
        return JSON.stringify({ allow: false, message: "denied" });
      },
    },
  };
  expect(
    await onToolCall({ toolName: "tool_search", input: { query: "ui" } }, ctx),
  ).toBeUndefined();
  expect(asked).toEqual([]);
  expect(
    await onToolCall({ toolName: "mcp__computer__ui_exec", input: {} }, ctx),
  ).toEqual({ block: true, reason: "denied" });
  expect(asked).toEqual(["mcp__computer__ui_exec"]);
});

describe("managed Pi prompt hygiene and prefix determinism", () => {
  it("keeps customPrompt verbatim, sorts and compacts skill descriptions on constrained models, and surfaces deferred MCP guidance", () => {
    const model64k = {
      provider: "localmodels",
      id: "spark-x2.6-4b-q4km",
      contextWindow: 65_536,
      maxTokens: 32_768,
      reasoning: true,
      api: "openai-completions",
    };

    const baseInput = {
      customPrompt: "Linger room instructions.",
      selectedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      hiddenTools: [],
      toolSnippets: BASE_TOOL_SNIPPETS,
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      cwd: "/workspace",
      contextFiles: [],
      skills: REALISTIC_SKILLS.map((skill) => ({ ...skill })),
    };

    const beforeSystemPrompt = buildSystemPrompt(baseInput);
    expect(beforeSystemPrompt).not.toContain("<docs>");
    expect(beforeSystemPrompt).toContain("Linger room instructions.");

    const deferredServers: McpServerListing[] = [
      {
        entry: {
          name: "computer",
          config: {
            type: "http",
            url: "http://127.0.0.1:9/mcp/computer",
            exposure: "deferred",
            description:
              "Isolated desktop and browser UI script automation (ui_exec, ui_reset)",
          },
          source: "/tmp/linger-mcp.json",
          scope: "extension",
        },
      },
    ];
    const mcpServersSection = renderServersSection(deferredServers);
    expect(mcpServersSection).toBeDefined();

    const afterOptions = applyManagedPromptOptions(
      {
        ...baseInput,
        selectedTools: [...baseInput.selectedTools, "tool_search"],
        sections: { mcp_servers: mcpServersSection! },
        skills: REALISTIC_SKILLS.map((skill) => ({ ...skill })),
      },
      model64k,
      65_536,
    );
    const afterSystemPrompt = buildSystemPrompt(afterOptions);

    expect(afterOptions.customPrompt).toBe("Linger room instructions.");
    expect(afterSystemPrompt).not.toContain("<docs>");
    expect(afterSystemPrompt).not.toContain("docs/tui.md");
    expect(afterSystemPrompt).toContain("<mcp_servers>");
    expect(afterSystemPrompt).toContain(
      "Load the tools of `tool_search` servers with `tool_search`.",
    );
    expect(afterSystemPrompt).toContain(
      "mcp__computer (tool_search): Isolated desktop and browser UI script automation (ui_exec, ui_reset)",
    );
    expect(afterSystemPrompt).toContain("Linger room instructions.");

    // Every skill keeps its exact name and filePath for lazy on-demand read(),
    // sorted deterministically by name with bounded descriptions on 64K local models.
    const namesInPrompt = [
      ...afterSystemPrompt.matchAll(/<name>([^<]+)<\/name>/g),
    ].map((match) => match[1]);
    expect(namesInPrompt).toEqual(
      REALISTIC_SKILLS.map((skill) => skill.name).sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    for (const skill of REALISTIC_SKILLS) {
      expect(afterSystemPrompt).toContain(`<name>${skill.name}</name>`);
      expect(afterSystemPrompt).toContain(
        `<location>${skill.filePath}</location>`,
      );
    }
    for (const skill of afterOptions.skills) {
      expect(skill.description.length).toBeLessThanOrEqual(140);
    }

    // Large non-local cloud models keep full skill descriptions, sorted only.
    const cloud200k = {
      provider: "anthropic",
      id: "claude-opus-4-6",
      contextWindow: 200_000,
    };
    const cloudOptions = applyManagedPromptOptions(
      {
        ...baseInput,
        skills: [...REALISTIC_SKILLS].reverse().map((skill) => ({ ...skill })),
      },
      cloud200k,
      200_000,
    );
    expect(cloudOptions.skills.map((skill) => skill.name)).toEqual(
      namesInPrompt,
    );
    expect(
      cloudOptions.skills.find((skill) => skill.name === "artifact")
        ?.description,
    ).toBe(
      REALISTIC_SKILLS.find((skill) => skill.name === "artifact")?.description,
    );

    // Omitting customPrompt stays untouched (Daemon owns --system-prompt).
    const emptyPromptInput: Partial<BuildSystemPromptOptions> = {
      skills: REALISTIC_SKILLS.map((skill) => ({ ...skill })),
    };
    const emptyPromptOptions = applyManagedPromptOptions(
      emptyPromptInput,
      model64k,
      65_536,
    );
    expect(emptyPromptOptions.customPrompt).toBeUndefined();

    // Deferred MCP replaces direct MCP tool schemas with one compact
    // tool_search schema (~570 chars) + <mcp_servers>.
    const toolSearchSchemaChars = JSON.stringify(
      createToolSearchToolDefinition(),
    ).length;
    const directDesktopMcpSchemaChars = 13_243 + 30_000;
    const beforeTotalChars =
      beforeSystemPrompt.length + directDesktopMcpSchemaChars;
    const afterTotalChars = afterSystemPrompt.length + toolSearchSchemaChars;
    expect(afterTotalChars).toBeLessThan(beforeTotalChars * 0.2);
    expect(
      estimateTokens(beforeTotalChars) - estimateTokens(afterTotalChars),
    ).toBeGreaterThan(10_500);
  });

  it("registers tool_search and populates <mcp_servers> cleanly with non-empty customPrompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "linger-pi-deferred-mcp-"));
    const mcpFile = path.join(root, "mcp.json");
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const registeredTools: Array<{
      name: string;
      description?: string;
      reachesTools?: unknown;
    }> = [];
    const registeredServers = new Map<string, Record<string, unknown>>();
    let activeTools = ["read", "bash", "edit", "write"];
    try {
      await writeFile(
        mcpFile,
        JSON.stringify({
          mcpServers: {
            computer: {
              type: "http",
              url: "http://127.0.0.1:9/mcp/computer",
            },
          },
        }),
        { mode: 0o600 },
      );

      const fakePi = {
        on(event: string, handler: (...args: unknown[]) => unknown) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
        registerTool(definition: {
          name: string;
          description?: string;
          reachesTools?: unknown;
        }) {
          registeredTools.push(definition);
        },
        registerToolRenderer() {},
        registerCommand() {},
        // Managed servers register through the extension API before
        // session_start, which reads them back from getMcpServers.
        registerMcpServer(name: string, config: Record<string, unknown>) {
          registeredServers.set(name, config);
        },
        unregisterMcpServer(name: string) {
          registeredServers.delete(name);
        },
        getMcpServers() {
          return [...registeredServers].map(([name, config]) => ({
            name,
            config,
            extensionPath: "pi-mcp.mjs",
          }));
        },
        getAllTools() {
          return registeredTools;
        },
        getActiveTools() {
          return activeTools;
        },
        setActiveTools(next: string[]) {
          activeTools = [...next];
        },
      };

      await createManagedPiExtension({
        getConfigPath: () => mcpFile,
        getContextWindow: () => "65536",
      })(fakePi as never);

      const toolSearchDef = registeredTools.find(
        (tool) => tool.name === "tool_search",
      );
      expect(toolSearchDef).toBeDefined();
      expect(toolSearchDef?.description).toContain("tool_search");

      const ctx = {
        cwd: "/workspace",
        model: {
          provider: "localmodels",
          id: "spark-x2.6-4b-q4km",
          contextWindow: 65_536,
        },
        modelRegistry: {},
        ui: { notify() {} },
        isProjectTrusted: () => false,
      };
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start" }, ctx);
      }
      expect(activeTools).toContain("tool_search");

      const promptOptions = {
        customPrompt: "Linger room instructions.",
        selectedTools: activeTools,
        hiddenTools: [],
        toolSnippets: BASE_TOOL_SNIPPETS,
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: {} as Record<string, string>,
        cwd: "/workspace",
        contextFiles: [],
        skills: [...REALISTIC_SKILLS].reverse().map((skill) => ({ ...skill })),
      };
      for (const handler of handlers.get("before_agent_start") ?? []) {
        await handler(
          { type: "before_agent_start", systemPromptOptions: promptOptions },
          ctx,
        );
      }

      const rendered = buildSystemPrompt(promptOptions);
      expect(rendered).toContain("Linger room instructions.");
      expect(rendered).not.toContain("<docs>");
      expect(rendered).toContain("<mcp_servers>");
      expect(rendered).toContain(
        "Load the tools of `tool_search` servers with `tool_search`.",
      );
      expect(rendered).toContain(
        "mcp__computer (tool_search): Isolated desktop and browser UI script automation (ui_exec, ui_reset)",
      );
      expect(promptOptions.skills[0]?.name).toBe("artifact");
      expect(promptOptions.skills[0]?.description.length).toBeLessThanOrEqual(
        140,
      );
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown" }, {});
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves byte-for-byte prefix determinism across turns regardless of skill order or MCP connection timing", () => {
    const model = {
      provider: "localmodels",
      id: "spark-x2.6-4b-q4km",
      contextWindow: 65_536,
      reasoning: true,
    };

    const computerServer: McpServerListing = {
      entry: {
        name: "computer",
        config: {
          type: "http",
          url: "http://127.0.0.1:9/mcp/computer",
          exposure: "deferred",
          description:
            "Isolated desktop and browser UI script automation (ui_exec, ui_reset)",
        },
        source: "/tmp/linger-mcp.json",
        scope: "extension",
      },
      connection: undefined,
    };
    const serverBeforeConnect: McpServerListing[] = [computerServer];
    const serverAfterConnect: McpServerListing[] = [
      {
        ...computerServer,
        connection: {
          instructions: "Dynamic server instructions that would bust KV cache",
        },
      },
    ];

    const renderTurn = (
      skills: readonly Skill[],
      selectedTools: string[],
      servers: readonly McpServerListing[],
      extraToolGuidelines: Record<string, string[]> = {},
    ): string => {
      const options = applyManagedPromptOptions(
        {
          customPrompt: "Stable room prompt",
          selectedTools,
          hiddenTools: [],
          toolSnippets: {
            ...BASE_TOOL_SNIPPETS,
            mcp__computer__ui_exec: "Run isolated UI automation script",
          },
          toolGuidelines: {
            edit: ["Use edit for precise changes."],
            ...extraToolGuidelines,
          },
          promptGuidelines: [],
          appendSystemPrompt: "",
          sections: {
            mcp_servers: renderServersSection(servers) ?? "",
          },
          cwd: "/workspace",
          contextFiles: [],
          skills: skills.map((skill) => ({ ...skill })),
        },
        model,
        65_536,
      );
      return buildSystemPrompt(options);
    };

    const turn1 = renderTurn(
      REALISTIC_SKILLS,
      ["read", "bash", "edit", "write", "grep", "find", "ls", "tool_search"],
      serverBeforeConnect,
    );
    const turn2 = renderTurn(
      [...REALISTIC_SKILLS].reverse(),
      ["read", "bash", "edit", "write", "grep", "find", "ls", "tool_search"],
      serverAfterConnect,
    );
    const turn3AfterMcpActivation = renderTurn(
      REALISTIC_SKILLS,
      [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "tool_search",
        "mcp__computer__ui_exec",
      ],
      serverAfterConnect,
      {
        mcp__computer__ui_exec: [
          "Dynamic MCP guideline that must not mutate prefix.",
        ],
      },
    );

    expect(turn1).toContain("Stable room prompt");
    expect(turn1).toContain("<mcp_servers>");
    expect(turn1).toContain(
      "Load the tools of `tool_search` servers with `tool_search`.",
    );
    expect(turn1).not.toContain("Dynamic server instructions");
    expect(turn1).not.toContain("Dynamic MCP guideline");
    expect(turn2).toBe(turn1);
    expect(turn3AfterMcpActivation).toBe(turn1);
  });

  it("compacts verbose skill descriptions cleanly at sentence or word boundaries", () => {
    const short = "Inspect files.";
    expect(compactSkillDescription(short, 140)).toBe(short);

    const multiSentence =
      "Create and format standalone deliverable files for sharing or export. Always inspect rendered output visually and attach the resulting file to the Room with a short summary.";
    expect(compactSkillDescription(multiSentence, 140)).toBe(
      "Create and format standalone deliverable files for sharing or export.",
    );

    const longSentence =
      "Coordinate complex multi-step browser and desktop workflows across multiple local applications with strict verification and permission handling before reporting completion";
    const compacted = compactSkillDescription(longSentence, 100);
    expect(compacted.length).toBeLessThanOrEqual(100);
    expect(compacted.endsWith("…")).toBe(true);
  });
});

describe("managed Pi compaction reasoning and budget bounds", () => {
  it("caps reasoning effort and output budget on 64K local models", () => {
    const openaiLocal64k = {
      provider: "localmodels",
      id: "spark-x2.6-4b-q4km",
      api: "openai-completions",
      contextWindow: 65_536,
      maxTokens: 32_768,
      reasoning: true,
    };
    expect(resolveCompactionPolicy(openaiLocal64k, "high", 65_536)).toEqual({
      thinkingLevel: "low",
      reserveTokens: 8_192,
      keepRecentTokens: 10_240,
      maxSummaryTokens: 2_560,
      effectiveContextWindow: 65_536,
    });

    // Qwen format explicitly supports enable_thinking: false on "off".
    const qwenLocal64k = {
      ...openaiLocal64k,
      compat: { thinkingFormat: "qwen" },
    };
    expect(resolveCompactionPolicy(qwenLocal64k, "high", 65_536)).toMatchObject(
      {
        thinkingLevel: "off",
        reserveTokens: 8_192,
        keepRecentTokens: 10_240,
        maxSummaryTokens: 2_560,
      },
    );

    // Explicit string mapping for off (e.g. off: "none") enforces off on wire.
    const mappedOffModel = {
      ...openaiLocal64k,
      thinkingLevelMap: { off: "none", low: "low", high: "high" },
    };
    expect(selectCompactionThinkingLevel(mappedOffModel, "high")).toBe("off");

    // Model that disallows off and minimal falls back to low; model that only
    // allows high falls back safely to high rather than sending an invalid level.
    expect(
      selectCompactionThinkingLevel(
        {
          ...openaiLocal64k,
          thinkingLevelMap: { off: null, minimal: null, low: "low" },
        },
        "high",
      ),
    ).toBe("low");
    expect(
      selectCompactionThinkingLevel(
        {
          ...openaiLocal64k,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: "high",
          },
        },
        "high",
      ),
    ).toBe("high");
    expect(
      selectCompactionThinkingLevel(
        {
          ...openaiLocal64k,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: "xhigh",
          },
        },
        "xhigh",
      ),
    ).toBe("xhigh");

    // Never raises thinking level above the session's active setting.
    expect(selectCompactionThinkingLevel(openaiLocal64k, "off")).toBe("off");
  });

  it("caps 200K local models, takes the tighter configured context window, and leaves large cloud models untouched", () => {
    const local200k = {
      provider: "localmodels-library",
      id: "qwen3.8-27b",
      api: "openai-completions",
      contextWindow: 200_000,
      maxTokens: 32_768,
      reasoning: true,
      compat: { thinkingFormat: "qwen" },
    };
    expect(resolveCompactionPolicy(local200k, "high", 200_000)).toMatchObject({
      thinkingLevel: "off",
      keepRecentTokens: 16_384,
      maxSummaryTokens: 3_072,
    });

    // Tighter daemon-discovered 64K window overrides a stale 200K model entry.
    expect(resolveEffectiveContextWindow(local200k, "65536")).toBe(65_536);
    expect(resolveCompactionPolicy(local200k, "high", "65536")).toMatchObject({
      reserveTokens: 8_192,
      keepRecentTokens: 10_240,
      maxSummaryTokens: 2_560,
    });

    // Large cloud frontier models pass through unchanged.
    const cloud200k = {
      provider: "anthropic",
      id: "claude-opus-4-6",
      api: "anthropic-messages",
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
    };
    expect(resolveCompactionPolicy(cloud200k, "high", 200_000)).toBeNull();

    // BYOK sentinel models routed through the localmodels gateway are cloud
    // models, not local models: large windows pass through unchanged while
    // small windows still get bounded compaction via context-window size.
    const byok1m = {
      provider: "localmodels",
      id: "localmodels-byok",
      api: "openai-completions",
      contextWindow: 1_048_576,
      maxTokens: 64_000,
      reasoning: true,
    };
    expect(isLocalModel(byok1m)).toBe(false);
    expect(isLocalModel({ id: "localmodels/localmodels-byok" })).toBe(false);
    expect(isConstrainedContext(byok1m, 1_048_576)).toBe(false);
    expect(resolveCompactionPolicy(byok1m, "high", 1_048_576)).toBeNull();
    expect(isConstrainedContext(byok1m, 65_536)).toBe(true);
    expect(resolveCompactionPolicy(byok1m, "high", 65_536)).toMatchObject({
      thinkingLevel: "low",
      reserveTokens: 8_192,
      keepRecentTokens: 10_240,
      maxSummaryTokens: 2_560,
    });
  });

  it("intercepts session_before_compact to enforce capped reasoning, output tokens, and 64K keepRecentTokens", async () => {
    const model = {
      provider: "localmodels",
      id: "spark-x2.6-4b-q4km",
      api: "openai-completions",
      contextWindow: 65_536,
      maxTokens: 32_768,
      reasoning: true,
    };
    const capturedCalls: Array<{
      baseUrl?: string;
      maxTokens?: number;
      reasoning?: string;
      env?: Record<string, string>;
    }> = [];
    let observedScaledSettings: {
      reserveTokens: number;
      keepRecentTokens: number;
    } | null = null;
    let attempt = 0;

    const fakeBranch = [
      { id: "e1", type: "message", message: { role: "user", content: "old" } },
      { id: "e2", type: "message", message: { role: "user", content: "new" } },
    ];
    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "e1",
        messagesToSummarize: [
          {
            role: "user",
            content: [{ type: "text", text: "Summarize this turn." }],
            timestamp: 1,
          },
        ],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 51_800,
        previousSummary: undefined,
        fileOps: {
          read: new Set<string>(),
          written: new Set<string>(),
          edited: new Set<string>(),
        },
        settings: {
          enabled: true,
          reserveTokens: 16_384,
          keepRecentTokens: 20_000,
        },
      },
      branchEntries: fakeBranch,
      customInstructions: undefined,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    };

    const ctx = {
      model,
      thinkingLevel: "high",
      modelRegistry: {
        async getApiKeyAndHeaders() {
          return {
            ok: true,
            apiKey: "local-key",
            headers: {},
            baseUrl: "http://127.0.0.1:18080/v1",
            env: { CUSTOM_AUTH_ENV: "1" },
          };
        },
        streamSimple(
          m: { baseUrl?: string },
          _context: unknown,
          options: {
            maxTokens?: number;
            reasoning?: string;
            env?: Record<string, string>;
          },
        ) {
          attempt += 1;
          capturedCalls.push({
            baseUrl: m.baseUrl,
            maxTokens: options.maxTokens,
            reasoning: options.reasoning,
            env: options.env,
          });
          const shouldFailOnce = attempt === 1;
          return {
            async result() {
              if (shouldFailOnce) {
                return {
                  role: "assistant",
                  content: [],
                  stopReason: "error",
                  errorMessage: "terminated",
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                  },
                };
              }
              return {
                role: "assistant",
                content: [
                  { type: "text", text: "## Goal\nCompacted cleanly." },
                ],
                stopReason: "stop",
                usage: {
                  input: 1000,
                  output: 120,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 1120,
                },
              };
            },
          };
        },
      },
    };

    const outcome = await handleSessionBeforeCompact(event, ctx, {
      configuredContextWindow: 65_536,
      retrySettings: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
      prepareCompactionFn: (
        _entries: unknown,
        settings: { reserveTokens: number; keepRecentTokens: number },
      ) => {
        observedScaledSettings = settings;
        return {
          ...event.preparation,
          firstKeptEntryId: "e2",
          settings,
        };
      },
    });

    expect(observedScaledSettings).toEqual({
      enabled: true,
      reserveTokens: 8_192,
      keepRecentTokens: 10_240,
    });
    expect(capturedCalls).toEqual([
      {
        baseUrl: "http://127.0.0.1:18080/v1",
        maxTokens: 2_560,
        reasoning: "low",
        env: { CUSTOM_AUTH_ENV: "1" },
      },
      {
        baseUrl: "http://127.0.0.1:18080/v1",
        maxTokens: 2_560,
        reasoning: "low",
        env: { CUSTOM_AUTH_ENV: "1" },
      },
    ]);
    expect(outcome?.compaction).toMatchObject({
      firstKeptEntryId: "e2",
      tokensBefore: 51_800,
    });
    expect(outcome?.compaction.summary).toContain("Compacted cleanly.");

    // Cloud >128K models pass through without interception.
    const cloudOutcome = await handleSessionBeforeCompact(event, {
      ...ctx,
      model: {
        provider: "anthropic",
        id: "claude-opus-4-6",
        api: "anthropic-messages",
        contextWindow: 200_000,
        maxTokens: 64_000,
        reasoning: true,
      },
    });
    expect(cloudOutcome).toBeUndefined();
  });

  it("inherits Pi SETTINGS_DEFAULTS.retry when user retry settings are omitted", async () => {
    const model = {
      provider: "localmodels",
      id: "spark-x2.6-4b-q4km",
      api: "openai-completions",
      contextWindow: 65_536,
      maxTokens: 32_768,
      reasoning: true,
    };
    let capturedRetry: unknown;
    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "e1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 50_000,
        previousSummary: undefined,
        fileOps: {
          read: new Set<string>(),
          written: new Set<string>(),
          edited: new Set<string>(),
        },
        settings: {
          enabled: true,
          reserveTokens: 16_384,
          keepRecentTokens: 20_000,
        },
      },
      branchEntries: [],
      customInstructions: undefined,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    };
    await handleSessionBeforeCompact(
      event,
      { model, thinkingLevel: "high" },
      {
        configuredContextWindow: 65_536,
        compactFn: async (...args: unknown[]) => {
          capturedRetry = args[9];
          return {
            summary: "ok",
            firstKeptEntryId: "e1",
            tokensBefore: 50_000,
          };
        },
      },
    );
    expect(capturedRetry).toEqual({
      enabled: SETTINGS_DEFAULTS.retry.enabled,
      maxRetries: SETTINGS_DEFAULTS.retry.maxRetries,
      baseDelayMs: SETTINGS_DEFAULTS.retry.baseDelayMs,
      maxAgentDelayMs: SETTINGS_DEFAULTS.retry.maxAgentDelayMs,
    });
  });
});
