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
const { compact, createMcpExtension, createToolSearchExtension } = await import(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    import.meta.url,
  ).href
);
const { prepareCompaction } = await import(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js",
    import.meta.url,
  ).href
);
const { SETTINGS_DEFAULTS } = await import(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-defaults.js",
    import.meta.url,
  ).href
);

const CONSTRAINED_CONTEXT_WINDOW_MAX = 128 * 1024;
const SMALL_CONTEXT_WINDOW_MAX = 64 * 1024;
const SMALL_WINDOW_SKILL_DESCRIPTION_MAX = 140;
const CONSTRAINED_SKILL_DESCRIPTION_MAX = 160;
const SMALL_WINDOW_SUMMARY_MAX_TOKENS = 2_560;
const CONSTRAINED_SUMMARY_MAX_TOKENS = 3_072;
const BOUNDED_COMPACTION_HINT =
  "Keep the summary concise and factual (under 600 words). Preserve exact file paths, commands, decisions, and pending next steps.";

const MANAGED_MCP_DESCRIPTIONS = {
  computer:
    "Isolated desktop and browser UI script automation (ui_exec, ui_reset)",
};

const THINKING_LEVEL_RANK = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const EXPLICIT_OFF_THINKING_FORMATS = new Set([
  "qwen",
  "qwen-chat-template",
  "chat-template",
  "zai",
  "deepseek",
  "together",
  "openrouter",
  "string-thinking",
  "baseten",
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parseConfiguredContextWindow(raw) {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    return 0;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function isLocalModel(model) {
  if (!model || typeof model !== "object") {
    return false;
  }
  const provider =
    typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (id === "localmodels-byok" || id.endsWith("/localmodels-byok")) {
    return false;
  }
  return (
    provider === "localmodels" ||
    provider === "localmodels-library" ||
    id.startsWith("localmodels/") ||
    id.startsWith("localmodels-library/")
  );
}

export function resolveEffectiveContextWindow(model, configuredContextWindow) {
  const modelWindow = parseConfiguredContextWindow(model?.contextWindow);
  const configuredWindow = parseConfiguredContextWindow(
    configuredContextWindow,
  );
  if (modelWindow > 0 && configuredWindow > 0) {
    return Math.min(modelWindow, configuredWindow);
  }
  return modelWindow || configuredWindow;
}

export function isConstrainedContext(model, configuredContextWindow) {
  if (isLocalModel(model)) {
    return true;
  }
  const window = resolveEffectiveContextWindow(model, configuredContextWindow);
  return window > 0 && window <= CONSTRAINED_CONTEXT_WINDOW_MAX;
}

export function compactSkillDescription(description, maxChars) {
  if (typeof description !== "string") {
    return "";
  }
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  if (
    sentenceMatch &&
    sentenceMatch[1].length >= 40 &&
    sentenceMatch[1].length <= maxChars
  ) {
    return sentenceMatch[1];
  }
  if (maxChars <= 1) {
    return "";
  }
  const slice = normalized.slice(0, maxChars - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut =
    lastSpace >= Math.floor(maxChars * 0.5) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:\s-]+$/, "")}…`;
}

export function applyManagedPromptOptions(
  options,
  model,
  configuredContextWindow,
) {
  if (!options || typeof options !== "object") {
    return options;
  }
  if (Array.isArray(options.skills) && options.skills.length > 0) {
    const sorted = [...options.skills].sort(
      (a, b) =>
        (a.name ?? "").localeCompare(b.name ?? "") ||
        (a.filePath ?? "").localeCompare(b.filePath ?? ""),
    );
    const constrained = isConstrainedContext(model, configuredContextWindow);
    if (constrained) {
      const effectiveWindow = resolveEffectiveContextWindow(
        model,
        configuredContextWindow,
      );
      const maxDescChars =
        effectiveWindow > 0 && effectiveWindow <= SMALL_CONTEXT_WINDOW_MAX
          ? SMALL_WINDOW_SKILL_DESCRIPTION_MAX
          : CONSTRAINED_SKILL_DESCRIPTION_MAX;
      options.skills = sorted.map((skill) => ({
        ...skill,
        description: compactSkillDescription(skill.description, maxDescChars),
      }));
    } else {
      options.skills = sorted;
    }
  }
  return options;
}

function isThinkingLevelSupported(model, level) {
  const mapped = model?.thinkingLevelMap?.[level];
  if (level === "xhigh" || level === "max") {
    return typeof mapped === "string";
  }
  return mapped !== null;
}

function offDisablesThinkingOnWire(model) {
  if (!isThinkingLevelSupported(model, "off")) {
    return false;
  }
  if (typeof model?.thinkingLevelMap?.off === "string") {
    return true;
  }
  if (model?.api !== "openai-completions") {
    return true;
  }
  const format = model?.compat?.thinkingFormat;
  return (
    typeof format === "string" && EXPLICIT_OFF_THINKING_FORMATS.has(format)
  );
}

export function selectCompactionThinkingLevel(model, currentThinkingLevel) {
  if (!model?.reasoning || currentThinkingLevel === "off") {
    return "off";
  }
  let target;
  if (offDisablesThinkingOnWire(model)) {
    target = "off";
  } else {
    // Prefer "low" over "minimal" because OpenAI-compatible local servers
    // universally recognize "low", whereas unmapped "minimal" can be rejected
    // or ignored.
    target =
      ["low", "minimal", "medium", "high", "xhigh", "max"].find((level) =>
        isThinkingLevelSupported(model, level),
      ) ?? "low";
  }
  if (
    typeof currentThinkingLevel === "string" &&
    currentThinkingLevel in THINKING_LEVEL_RANK &&
    THINKING_LEVEL_RANK[currentThinkingLevel] < THINKING_LEVEL_RANK[target] &&
    isThinkingLevelSupported(model, currentThinkingLevel)
  ) {
    return currentThinkingLevel;
  }
  return target;
}

export function resolveCompactionPolicy(
  model,
  currentThinkingLevel,
  configuredContextWindow,
) {
  if (!model || !isConstrainedContext(model, configuredContextWindow)) {
    return null;
  }
  const effectiveWindow = resolveEffectiveContextWindow(
    model,
    configuredContextWindow,
  );
  const thinkingLevel = selectCompactionThinkingLevel(
    model,
    currentThinkingLevel,
  );
  const smallWindow =
    effectiveWindow > 0 && effectiveWindow <= SMALL_CONTEXT_WINDOW_MAX;
  const reserveTokens = smallWindow
    ? clamp(Math.floor(effectiveWindow * 0.125), 4_096, 16_384)
    : effectiveWindow > 0
      ? clamp(Math.floor(effectiveWindow * 0.125), 8_192, 16_384)
      : 16_384;
  const keepRecentTokens = smallWindow
    ? clamp(Math.floor((effectiveWindow * 0.16) / 256) * 256, 4_096, 20_000)
    : effectiveWindow > 0
      ? clamp(Math.floor((effectiveWindow * 0.15) / 256) * 256, 10_240, 16_384)
      : 16_384;
  const baseMaxSummaryTokens = smallWindow
    ? SMALL_WINDOW_SUMMARY_MAX_TOKENS
    : CONSTRAINED_SUMMARY_MAX_TOKENS;
  const modelMaxTokens = parseConfiguredContextWindow(model.maxTokens);
  const maxSummaryTokens =
    modelMaxTokens > 0
      ? Math.min(baseMaxSummaryTokens, modelMaxTokens)
      : baseMaxSummaryTokens;
  return {
    thinkingLevel,
    reserveTokens,
    keepRecentTokens,
    maxSummaryTokens,
    effectiveContextWindow: effectiveWindow,
  };
}

function resolveCompactionRetrySettings(rawRetry) {
  const defaults = SETTINGS_DEFAULTS.retry;
  const retry = rawRetry && typeof rawRetry === "object" ? rawRetry : {};
  return {
    enabled: retry.enabled ?? defaults.enabled,
    maxRetries: retry.maxRetries ?? defaults.maxRetries,
    baseDelayMs: retry.baseDelayMs ?? defaults.baseDelayMs,
    maxAgentDelayMs: retry.maxAgentDelayMs ?? defaults.maxAgentDelayMs,
  };
}

export async function handleSessionBeforeCompact(event, ctx, deps = {}) {
  const configuredContextWindow = deps.configuredContextWindow;
  const policy = resolveCompactionPolicy(
    ctx?.model,
    ctx?.thinkingLevel,
    configuredContextWindow,
  );
  if (!policy) {
    return undefined;
  }
  const compactFn = deps.compactFn ?? compact;
  const prepareFn = deps.prepareCompactionFn ?? prepareCompaction;
  const existingSettings = event.preparation?.settings ?? {};
  const scaledSettings = {
    enabled: true,
    reserveTokens: Math.min(
      existingSettings.reserveTokens ?? policy.reserveTokens,
      policy.reserveTokens,
    ),
    keepRecentTokens: Math.min(
      existingSettings.keepRecentTokens ?? policy.keepRecentTokens,
      policy.keepRecentTokens,
    ),
  };
  const rePrepared =
    Array.isArray(event.branchEntries) && event.branchEntries.length > 0
      ? prepareFn(event.branchEntries, scaledSettings)
      : undefined;
  const preparation = rePrepared
    ? { ...rePrepared, settings: scaledSettings }
    : { ...event.preparation, settings: scaledSettings };

  let requestModel = ctx.model;
  let apiKey;
  let headers;
  let env;
  if (typeof ctx.modelRegistry?.getApiKeyAndHeaders === "function") {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (auth && auth.ok === false) {
      throw new Error(auth.error || "Missing model authentication");
    }
    apiKey = auth?.apiKey;
    headers = auth?.headers;
    env = auth?.env;
    if (typeof auth?.baseUrl === "string" && auth.baseUrl) {
      requestModel = { ...ctx.model, baseUrl: auth.baseUrl };
    }
  }

  const streamSimple =
    deps.streamSimple ??
    (typeof ctx.modelRegistry?.streamSimple === "function"
      ? ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry)
      : undefined);
  const boundedStreamFn = streamSimple
    ? (model, context, streamOptions = {}) => {
        const requestedMax = streamOptions.maxTokens;
        const cappedMax =
          typeof requestedMax === "number" && requestedMax > 0
            ? Math.min(requestedMax, policy.maxSummaryTokens)
            : policy.maxSummaryTokens;
        const nextOptions = { ...streamOptions, maxTokens: cappedMax };
        if (policy.thinkingLevel === "off") {
          delete nextOptions.reasoning;
        } else {
          nextOptions.reasoning = policy.thinkingLevel;
        }
        return streamSimple(model, context, nextOptions);
      }
    : undefined;

  const customInstructions = event.customInstructions
    ? `${event.customInstructions}\n\n${BOUNDED_COMPACTION_HINT}`
    : BOUNDED_COMPACTION_HINT;

  const retry = resolveCompactionRetrySettings(deps.retrySettings);
  const result = await compactFn(
    preparation,
    requestModel,
    apiKey,
    headers,
    customInstructions,
    event.signal,
    policy.thinkingLevel,
    boundedStreamFn,
    env,
    retry,
  );
  return { compaction: result };
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
  const servers = Object.entries(parsed.mcpServers ?? {}).map(
    ([name, config]) => {
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
      // Static server descriptions prevent the <mcp_servers> system prompt
      // section from mutating after background MCP connections finish, which
      // preserves KV prefix cache reuse across turns.
      const description =
        typeof config.description === "string" && config.description.trim()
          ? config.description.trim()
          : (MANAGED_MCP_DESCRIPTIONS[name] ?? "Managed MCP server tools");
      return {
        name,
        config: {
          type: "http",
          url: url.href,
          description,
          exposure: "deferred",
          timeout: config.tool_timeout_sec ?? 180,
        },
        source: configPath,
        scope: "extension",
      };
    },
  );
  return { servers, autoEnableCodemode: false, errors: [] };
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

// The Daemon loads this extension for prompt hygiene, compaction bounds, the
// shell text check, permission review, MCP servers, or any of them. The review
// hook is always on, because a resident Pi process may serve a reviewed Run
// after one without review. A call the shell text check refuses never reaches
// review.
export function createManagedPiExtension(options = {}) {
  const getConfigPath =
    options.getConfigPath ?? (() => process.env.LINGER_PI_MANAGED_MCP_CONFIG);
  const getContextWindow =
    options.getContextWindow ?? (() => process.env.LINGER_PI_CONTEXT_WINDOW);

  return async (pi) => {
    pi.on(
      "tool_call",
      async (event, ctx) =>
        (await refuseRewrittenShellText(event)) ??
        reviewToolCall(event, ctx.ui, ctx.signal),
    );
    const configPath = getConfigPath();
    if (configPath) {
      await createToolSearchExtension()(pi);
      await mountManagedMcp(pi, configPath);
    }
    pi.on("before_agent_start", (event, ctx) => {
      applyManagedPromptOptions(
        event.systemPromptOptions,
        ctx?.model,
        getContextWindow(),
      );
    });
    pi.on("session_before_compact", (event, ctx) =>
      handleSessionBeforeCompact(event, ctx, {
        configuredContextWindow: getContextWindow(),
        retrySettings:
          typeof pi.getSettings === "function"
            ? pi.getSettings()?.retry
            : undefined,
      }),
    );
  };
}

export default createManagedPiExtension();
