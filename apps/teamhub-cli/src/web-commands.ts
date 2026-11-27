import type {
  CommandDefinition,
  CommandExecutionContext,
  CommandOption,
} from "./command-definition.js";
import { assertPositionals, option, values } from "./command-input.js";
import { displayText } from "./display-text.js";
import { CliError } from "./errors.js";
import { teamHubData } from "./http-client.js";

type Json = Record<string, unknown>;
const keyBackends = ["tavily", "brave", "firecrawl", "exa", "you"] as const;
const searchBackends = [...keyBackends, "duckduckgo"] as const;
const openBackends = ["tavily", "firecrawl", "exa", "you", "direct"] as const;
const recencies = ["day", "week", "month", "year"] as const;
const names: Record<string, string> = {
  tavily: "Tavily",
  brave: "Brave Search",
  firecrawl: "Firecrawl",
  exa: "Exa",
  you: "You.com",
  duckduckgo: "DuckDuckGo",
  direct: "Direct",
};
const nameOf = (backend: unknown) =>
  names[String(backend)] ?? "The web search backend";
const line = (value: unknown) =>
  displayText(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
const flag = (description: string, repeatable = false): CommandOption => ({
  description,
  ...(repeatable ? { repeatable: true } : {}),
});
function usage(message: string): never {
  throw new CliError("usage", message);
}
function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value))
    usage(`${name} must be one of ${allowed.join(", ")}.`);
  return value as T;
}
const wait =
  "a card asking for it is in the chat. End your turn: the card's result wakes you with the results or what to run next. If the user declines, don't retry.";
const readyHint = (details: Json) => {
  const ready = Array.isArray(details.ready_backends)
    ? details.ready_backends.filter((item) => typeof item === "string")
    : [];
  return ready.length
    ? `Run again with --backend set to a ready backend (${ready.join(", ")}), or tell the user.`
    : "No other backend is ready; tell the user.";
};

/**
 * Rewrites a TeamHub web search failure into authored text from its code and
 * structured details; TeamHub's own prose is never shown.
 */
function webFailure(error: unknown): never {
  if (!(error instanceof CliError) || error.origin === "local") throw error;
  const details = error.details;
  const name = nameOf(details.backend);
  const authored = (message: string) =>
    new CliError(error.code, message, details);
  switch (error.code.toLowerCase()) {
    case "search_key_requested":
      throw authored(
        details.reason === "free_limit"
          ? `${name}'s free searches without a key are used up. Waiting for the user to add a ${name} API key; ${wait}`
          : details.reason === "rejected"
            ? `Waiting for the user to replace the ${name} API key, which ${name} no longer accepts; ${wait}`
            : `Waiting for the user to add a ${name} API key; ${wait}`,
      );
    case "search_quota_exhausted":
      throw authored(
        `The ${name} account has no credit or quota left. ${readyHint(details)}`,
      );
    case "provider_rate_limited":
      throw authored(
        `${name} is rate limiting web search. ${
          typeof details.retry_after_seconds === "number"
            ? `Wait ${details.retry_after_seconds} seconds and retry, or use another backend.`
            : readyHint(details)
        }`,
      );
    case "tool_execution_failed":
      throw authored(
        `${name} could not read this page. Run again without --backend to open it from this computer, or try another backend.`,
      );
    case "dependency_unavailable":
      if (details.backend !== undefined)
        throw authored(
          `${name} could not be reached. Try again later or use another backend; teamhub web list shows the ready ones.`,
        );
      throw error;
    case "invalid_input":
      if (details.backend !== undefined)
        throw authored(
          `${name} cannot run this command with these filters. Run teamhub web list to see what each backend supports.`,
        );
      throw error;
    default:
      throw error;
  }
}
async function call<T extends Json>(request: Promise<{ data?: T }>) {
  try {
    return (await teamHubData(request)) as Json;
  } catch (error) {
    webFailure(error);
  }
}

const backendSchema = (allowed: readonly string[]) => ({
  enum: [...allowed],
});
const searchResultSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    url: { type: "string" },
    snippet: { type: "string" },
    published_at: { type: "string" },
  },
  required: ["title", "url", "snippet"],
};
const pageSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    title: { type: "string" },
    markdown: {
      type: "string",
      description: "The page as Markdown; absent when saved with --output.",
    },
    path: {
      type: "string",
      description: "The file written with --output.",
    },
    truncated: {
      type: "boolean",
      description: "True when the page was longer than 20,000 characters.",
    },
  },
  required: ["url", "truncated"],
};

const webSearch: CommandDefinition = {
  command: ["web", "search"],
  toolName: "web_search",
  operationId: false,
  description:
    "Search the web through a provider with the deployment's saved API key.",
  readOnly: true,
  usage: [
    "teamhub web search <query> [--backend tavily|brave|firecrawl|exa|you|duckduckgo] [--limit 1-20] [--recency day|week|month|year] [--site <domain>]...",
  ],
  arguments: ["<query>  What to search for; 1-400 characters."],
  options: {
    "--backend": flag(
      "tavily, brave, firecrawl, exa, you or duckduckgo. Without it the user's default runs, else the first backend with a key, else duckduckgo, which needs none.",
    ),
    "--limit": flag(
      "Results to return; 1-20 up to the backend's max_limit, default 10.",
    ),
    "--recency": flag("Only results from the past day, week, month or year."),
    "--site": flag(
      "Only results from this domain; repeat up to the backend's max_sites (teamhub web list).",
      true,
    ),
  },
  notes: [
    "A backend never falls back to another one. When it needs an API key, TeamHub posts a card asking the user for it; end your turn and the card's result wakes you with the results.",
  ],
  examples: [
    'teamhub web search "rust 2026 edition release date"',
    'teamhub web search "postgres 19 features" --recency month --site postgresql.org',
  ],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 400 },
      backend: backendSchema(searchBackends),
      limit: { type: "integer", minimum: 1, maximum: 20 },
      recency: { enum: [...recencies] },
      sites: {
        type: "array",
        maxItems: 10,
        items: { type: "string", minLength: 3, maxLength: 253 },
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { results: { type: "array", items: searchResultSchema } },
    required: ["results"],
  },
  normalize: async (args) => {
    const query = args.positionals.join(" ").trim();
    if (!query || [...query].length > 400)
      usage("Provide a search query of 1-400 characters.");
    const backend = choice(
      option(args, "--backend"),
      searchBackends,
      "--backend",
    );
    const recency = choice(option(args, "--recency"), recencies, "--recency");
    const limitText = option(args, "--limit");
    const limit = limitText === undefined ? undefined : Number(limitText);
    if (
      limit !== undefined &&
      (!/^\d+$/u.test(limitText!) || limit < 1 || limit > 20)
    )
      usage("--limit must be an integer from 1 to 20.");
    const sites = values(args, "--site").map((site) => site.trim());
    if (
      sites.length > 10 ||
      new Set(sites).size !== sites.length ||
      sites.some(
        (site) => site.length < 3 || site.length > 253 || /\s/u.test(site),
      )
    )
      usage("--site takes up to 10 distinct domains of 3-253 characters.");
    return {
      input: {
        query,
        ...(backend ? { backend } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(recency ? { recency } : {}),
        ...(sites.length ? { sites } : {}),
      },
    };
  },
  execute: async (input, context) => {
    const result = await call(
      context.client.api.POST("/api/agent/v1/web/search", {
        body: input as never,
      }),
    );
    return { results: Array.isArray(result.results) ? result.results : [] };
  },
  render: (result) => {
    const results = result.results as Json[];
    if (!results.length)
      return "No results. Try a shorter query, drop --recency or --site, or another ready backend from teamhub web list.";
    return results
      .map((item, index) =>
        [
          `${index + 1}. ${line(item.title) || line(item.url)}`,
          `   ${line(item.url)}`,
          ...(item.published_at
            ? [`   Published: ${line(item.published_at)}`]
            : []),
          ...(line(item.snippet) ? [`   ${line(item.snippet)}`] : []),
        ].join("\n"),
      )
      .join("\n\n");
  },
};

const webOpen: CommandDefinition = {
  command: ["web", "open"],
  toolName: "web_open",
  operationId: false,
  description:
    "Read one web page as Markdown, from this computer or through a provider.",
  readOnly: true,
  usage: [
    "teamhub web open <url> [--backend direct|tavily|firecrawl|exa|you] [--output <file>]",
  ],
  arguments: ["<url>  An absolute http or https URL."],
  options: {
    "--backend": flag(
      "direct (default) fetches the page from this computer; tavily, firecrawl, exa or you read it through the provider, which helps with pages that need JavaScript or block plain requests.",
    ),
    "--output": flag(
      "Save the Markdown to this new file instead of printing it; never overwrites.",
    ),
  },
  notes: [
    "The Markdown is cut at 20,000 characters; truncated says when it was.",
    "To search, run teamhub web search; never open a search engine's results page.",
  ],
  examples: [
    "teamhub web open https://www.postgresql.org/about/news/",
    "teamhub web open https://example.com/report --backend firecrawl --output report.md",
  ],
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2048 },
      backend: backendSchema(openBackends),
      output: { type: "string" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  outputSchema: pageSchema,
  normalize: async (args, reader) => {
    assertPositionals(args, 1);
    const { webURL } = await import("./web-page.js");
    const url = args.positionals[0]!.trim();
    if (!webURL(url))
      usage("Provide an absolute http or https URL of at most 2048 bytes.");
    const backend = choice(
      option(args, "--backend"),
      openBackends,
      "--backend",
    );
    const output = option(args, "--output");
    if (output !== undefined && (!output.trim() || output === "-"))
      usage("--output requires a local file path.");
    return {
      input: {
        url,
        ...(backend && backend !== "direct" ? { backend } : {}),
        ...(output !== undefined ? { output: reader.localPath(output) } : {}),
      },
    };
  },
  execute: async (input, context) => {
    const output = input.output as string | undefined;
    const { assertNewOutput, saveConnectorBytes } =
      await import("./connector-files.js");
    if (output !== undefined) await assertNewOutput(output, context.cwd);
    const page = input.backend
      ? await call(
          context.client.api.POST("/api/agent/v1/web/open", {
            body: { url: input.url, backend: input.backend } as never,
          }),
        )
      : await openDirectPage(String(input.url), context);
    const result: Json = {
      url: page.url,
      ...(page.title ? { title: page.title } : {}),
      truncated: page.truncated === true,
    };
    if (output === undefined) return { ...result, markdown: page.markdown };
    const saved = await saveConnectorBytes(
      Buffer.from(displayText(page.markdown ?? ""), "utf8"),
      output,
      context,
    );
    return { ...result, path: saved.path };
  },
  render: (result) =>
    [
      `URL: ${line(result.url)}`,
      ...(result.title ? [`Title: ${line(result.title)}`] : []),
      ...(result.truncated
        ? ["Truncated: the page is longer than the 20,000 characters shown."]
        : []),
      ...(typeof result.path === "string"
        ? [`Saved: ${line(result.path)}`]
        : ["", displayText(result.markdown ?? "")]),
    ].join("\n"),
};
async function openDirectPage(
  url: string,
  context: CommandExecutionContext,
): Promise<Json> {
  const { openDirect } = await import("./web-page.js");
  return { ...(await openDirect(url, context)) };
}

const quotaText = (quota: Json | undefined): string => {
  if (!quota || quota.from === "unavailable") return "";
  const unit = quota.unit ? ` ${line(quota.unit)}` : "";
  const amount =
    typeof quota.remaining === "number"
      ? typeof quota.limit === "number"
        ? `${quota.remaining} of ${quota.limit}${unit} left`
        : `${quota.remaining}${unit} left`
      : "";
  return [
    amount,
    quota.plan ? `plan ${line(quota.plan)}` : "",
    quota.resets_at ? `resets ${line(quota.resets_at)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
};
const webList: CommandDefinition = {
  command: ["web", "list"],
  toolName: "list_web_backends",
  operationId: false,
  description:
    "List the web search backends with what each supports, whether it is ready, and its quota.",
  readOnly: true,
  usage: ["teamhub web list [--backend <backend>]"],
  options: {
    "--backend": flag(
      "Show only this backend: tavily, brave, firecrawl, exa, you, duckduckgo or direct.",
    ),
  },
  inputSchema: {
    type: "object",
    properties: {
      backend: backendSchema([...searchBackends, "direct"]),
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      default_search: { type: "string" },
      chosen_default_search: { type: "string" },
      default_open: { type: "string" },
      can_save_keys: { type: "boolean" },
      backends: { type: "array", items: { type: "object" } },
    },
    required: ["default_search", "default_open", "backends"],
  },
  normalize: async (args) => {
    assertPositionals(args, 0);
    const backend = choice(
      option(args, "--backend"),
      [...searchBackends, "direct"],
      "--backend",
    );
    return { input: backend ? { backend } : {} };
  },
  execute: async (input, context) =>
    call(
      context.client.api.POST("/api/agent/v1/web/backends/query", {
        body: input as never,
      }),
    ),
  render: (result) => {
    const backends = Array.isArray(result.backends)
      ? (result.backends as Json[])
      : [];
    const rows = backends.map((item) => {
      const status = line(item.status);
      const parts = [
        `${line(item.id).padEnd(10)} ${status.padEnd(13)} ${(item.commands as unknown[]).map(line).join(", ")}`,
        Array.isArray(item.filters) && item.filters.length
          ? `filters: ${item.filters.map(line).join(", ")}${typeof item.max_sites === "number" && item.max_sites ? ` (up to ${item.max_sites} sites)` : ""}`
          : "",
        item.tier === "free" ? `free: ${line(item.tier_text)}` : "",
        quotaText(item.quota as Json | undefined),
        status !== "ready" && item.free_tier
          ? `free tier: ${line(item.free_tier)}`
          : "",
      ];
      return parts.filter(Boolean).join("  |  ");
    });
    const chosen = result.chosen_default_search ? " (chosen by the user)" : "";
    return [
      `Default search: ${line(result.default_search)}${chosen}. Default open: ${line(result.default_open)}.`,
      ...rows,
      ...(backends.some((item) => item.status !== "ready")
        ? [
            "A backend that is not ready needs an API key: run teamhub web connect <backend> to ask the user for it.",
          ]
        : []),
    ].join("\n");
  },
};

const webConnect: CommandDefinition = {
  command: ["web", "connect"],
  toolName: "connect_web_backend",
  operationId: false,
  description:
    "Ask the user for a web search backend's API key: posts a key card in this chat unless the backend is already ready.",
  // Like apps connect it only requests a card; TeamHub reuses a pending one,
  // so a repeated call needs no receipt.
  readOnly: true,
  usage: ["teamhub web connect <tavily|brave|firecrawl|exa|you>"],
  arguments: ["<backend>  tavily, brave, firecrawl, exa or you."],
  options: {},
  notes: [
    "When it posts the card, end your turn. The card's result wakes you when the user adds a key or declines. Never ask for an API key in a message.",
  ],
  inputSchema: {
    type: "object",
    properties: { backend: backendSchema(keyBackends) },
    required: ["backend"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { enum: ["ready", "connection_requested"] },
      backend: { type: "object" },
      message_id: { type: "string" },
      interaction_id: { type: "string" },
    },
    required: ["status"],
  },
  normalize: async (args) => {
    assertPositionals(args, 1);
    return {
      input: { backend: choice(args.positionals[0], keyBackends, "<backend>") },
    };
  },
  execute: async (input, context) => {
    const result = await call(
      context.client.api.POST("/api/agent/v1/web/connect", {
        body: input as never,
      }),
    );
    if (result.status !== "ready" && result.status !== "connection_requested")
      throw new CliError(
        "invalid_response",
        "TeamHub did not answer the web search key request.",
      );
    return result;
  },
  render: (result) => {
    const backend = result.backend as Json | undefined;
    return result.status === "ready"
      ? `${nameOf(backend?.id)} is ready. Run your web command again.`
      : `Key card posted (${line(result.message_id)}). End your turn now; the card's result wakes you when the user adds a key or declines.`;
  },
};

export const webCommandDefinitions: readonly CommandDefinition[] = [
  webSearch,
  webOpen,
  webList,
  webConnect,
];
