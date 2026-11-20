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
  browser:
    "Playwright browser automation tools for web pages, navigation, snapshots, clicks, typing, and tabs",
};

const BASE_TOOL_ORDER = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "tool_search",
];

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

// Keep the base preamble independent of dynamically loaded mcp__* tools so
// tool_search activations never mutate the cached system-prompt prefix.
function buildManagedPreamble(options) {
  const hidden = new Set(options.hiddenTools ?? []);
  const snippets = options.toolSnippets ?? {};
  const toolGuidelines = options.toolGuidelines ?? {};
  const promptGuidelines = Array.isArray(options.promptGuidelines)
    ? options.promptGuidelines
    : [];
  const declaredBase = [
    ...new Set(
      (options.selectedTools ?? []).filter(
        (name) => !hidden.has(name) && !name.startsWith("mcp__"),
      ),
    ),
  ].sort((a, b) => {
    const ai = BASE_TOOL_ORDER.indexOf(a);
    const bi = BASE_TOOL_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  const toolLines = declaredBase
    .filter((name) => Boolean(snippets[name]))
    .map((name) => `- ${name}: ${snippets[name]}`);
  const lines = [
    "You are an autonomous assistant operating in a managed workspace with local tools.",
  ];
  if (toolLines.length > 0) {
    lines.push("", "Available tools:", ...toolLines);
  }
  const rules = [];
  const seenRules = new Set();
  const addRule = (rule) => {
    if (typeof rule !== "string") {
      return;
    }
    const normalized = rule.trim();
    if (!normalized || seenRules.has(normalized)) {
      return;
    }
    seenRules.add(normalized);
    rules.push(normalized);
  };
  const hasBash = declaredBase.includes("bash");
  const hasPowerShell = declaredBase.includes("powershell");
  const hasGrep = declaredBase.includes("grep");
  const hasFind = declaredBase.includes("find");
  const hasLs = declaredBase.includes("ls");
  if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
    if (hasBash && hasPowerShell) {
      addRule(
        "Use bash or PowerShell for file operations like listing, searching, and finding files",
      );
    } else if (hasPowerShell) {
      addRule(
        "Use PowerShell for file operations like listing, searching, and finding files",
      );
    } else {
      addRule("Use bash for file operations like ls, rg, find");
    }
  }
  for (const name of declaredBase) {
    for (const rule of toolGuidelines[name] ?? []) {
      addRule(rule);
    }
  }
  for (const rule of promptGuidelines) {
    addRule(rule);
  }
  if (declaredBase.includes("tool_search")) {
    addRule(
      "Deferred MCP server tools are listed in <mcp_servers>; call tool_search to load matching tools before calling them.",
    );
  }
  addRule("Be concise and show exact file paths when referencing files.");
  lines.push("", "Guidelines:", ...rules.map((rule) => `- ${rule}`));
  return lines.join("\n");
}

export function applyManagedPromptOptions(
  options,
  model,
  configuredContextWindow,
) {
  if (!options || typeof options !== "object") {
    return options;
  }
  if (!options.customPrompt) {
    options.customPrompt = buildManagedPreamble(options);
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
      ["low", "minimal", "medium", "high"].find((level) =>
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

export function createManagedPiExtension(options = {}) {
  const getConfigPath =
    options.getConfigPath ?? (() => process.env.LINGER_PI_MANAGED_MCP_CONFIG);
  const getContextWindow =
    options.getContextWindow ?? (() => process.env.LINGER_PI_CONTEXT_WINDOW);

  return (pi) => {
    if (getConfigPath()) {
      createToolSearchExtension()(pi);
      createMcpExtension({
        loadConfig: () => loadManagedMcpConfig(getConfigPath()),
        updateConfig: () => {
          throw new Error("Operation MCP configuration is immutable");
        },
      })(pi);
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
