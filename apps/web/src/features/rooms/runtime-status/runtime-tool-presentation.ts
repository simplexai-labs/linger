import {
  BookOpen01Icon,
  BubbleChatIcon,
  CheckListIcon,
  CommandLineIcon,
  FileEditIcon,
  Globe02Icon,
  Image01Icon,
  RefreshIcon,
  Search01Icon,
  SearchVisualIcon,
  UserGroupIcon,
  UserIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";

import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";

import type { RuntimeActivityEntry } from "./runtime-presentation-events";
import { runtimeStatusMessages as m } from "./runtime-status.messages";

const presentations = {
  command: { glyph: CommandLineIcon, label: m.toolCommand },
  read: { glyph: BookOpen01Icon, label: m.toolRead },
  edit: { glyph: FileEditIcon, label: m.toolEdit },
  search: { glyph: Search01Icon, label: m.toolSearch },
  browser: { glyph: Globe02Icon, label: m.toolBrowser },
  message: { glyph: BubbleChatIcon, label: m.toolMessage },
  message_read: { glyph: BubbleChatIcon, label: m.toolMessageRead },
  delegation: { glyph: UserGroupIcon, label: m.toolDelegation },
  image: { glyph: Image01Icon, label: m.toolImage },
  interaction: { glyph: UserIcon, label: m.toolInteraction },
  recovery: { glyph: RefreshIcon, label: m.toolRecovery },
  review: { glyph: SearchVisualIcon, label: m.toolReview },
  tool: { glyph: Wrench01Icon, label: m.tool },
};
type ToolCategory = keyof typeof presentations;

// The Computer classifies each Runtime's tools into these runtime-neutral kinds.
const kinds: Record<string, ToolCategory> = {
  command: "command",
  read: "read",
  file_change: "edit",
  search: "search",
  browse: "browser",
  message: "message",
  message_read: "message_read",
  image: "image",
  delegation: "delegation",
  response: "message",
  interaction: "interaction",
  recovery: "recovery",
  review: "review",
  tool: "tool",
};

/**
 * How a tool call is shown. A call of the generic kind says nothing on its
 * own, so its tool name labels it when one is known.
 */
export function toolPresentation(t: Translate, kind: string, name?: string) {
  const category = kinds[kind] ?? "tool";
  const { glyph } = presentations[category];
  const label: Message<string> = presentations[category].label;
  const named = category === "tool" && name ? toolNameLabel(name) : "";
  return {
    category,
    glyph,
    label: t(label),
    summary: named || t(summaries[category]),
  };
}

/** A tool call's kind and icon, which read the same in every language. */
export function toolAppearance(kind: string) {
  const category = kinds[kind] ?? "tool";
  const { glyph } = presentations[category];
  return { category, glyph };
}

/**
 * A tool name as words, without an MCP server prefix:
 * `mcp__computer__get_window_state` reads "Get window state".
 */
export function toolNameLabel(name: string) {
  const tool = name.startsWith("mcp__")
    ? name.slice(name.lastIndexOf("__") + 2)
    : name;
  const words = tool.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

const summaries: Record<ToolCategory, Message<string>> = {
  command: m.summaryCommand,
  read: m.summaryRead,
  edit: m.summaryEdit,
  search: m.summarySearch,
  browser: m.summaryBrowser,
  message: m.summaryMessage,
  message_read: m.readingMessages,
  delegation: m.summaryDelegation,
  image: m.workingWithImages,
  interaction: m.stateWaitingForInput,
  recovery: m.recoveringTask,
  review: m.reviewingResults,
  tool: m.summaryTool,
};

export function toolGroupPresentation(
  t: Translate,
  calls: readonly ReturnType<typeof toolPresentation>[],
) {
  const single = calls.length === 1 ? calls[0] : undefined;
  if (single) {
    return { glyph: single.glyph, label: single.summary };
  }
  const categories = [...new Set(calls.map((call) => call.category))];
  const category = categories.length === 1 ? categories[0] : undefined;
  return {
    glyph: calls[0]?.glyph ?? CheckListIcon,
    label:
      calls.length > 1 && (!category || category === "tool")
        ? t(m.workingThroughSteps, { count: calls.length })
        : category
          ? t(summaries[category])
          : t(m.workingThroughTask),
  };
}

export function toolInputFromEntries(
  entries: readonly RuntimeActivityEntry[] = [],
) {
  const entry = entries.find(
    (entry) =>
      entry.type === "content" &&
      entry.block.label?.toLowerCase() === "input" &&
      entry.block.format === "json",
  );
  if (entry?.type === "content") return entry.block.content;
  const fields: Record<string, string> = {};
  const keys: Record<string, string> = {
    command: "command",
    path: "path",
    file: "file_path",
    query: "query",
    url: "url",
  };
  for (const entry of entries) {
    if (entry.type !== "content") continue;
    const key = keys[entry.block.label?.toLowerCase() ?? ""];
    if (key) fields[key] = entry.block.content;
  }
  return fields;
}

// Phrases for Activities the Computer does not name itself, such as an MCP
// tool. An unnamed command has none: the status line keeps its last text.
const statusPhrases: Record<
  Exclude<ToolCategory, "command">,
  Message<string>
> = {
  read: m.phraseRead,
  edit: m.phraseEdit,
  search: m.phraseSearch,
  browser: m.phraseBrowser,
  message: m.phraseMessage,
  message_read: m.readingMessages,
  delegation: m.phraseDelegation,
  image: m.workingWithImages,
  interaction: m.stateWaitingForInput,
  recovery: m.recoveringTask,
  review: m.reviewingResults,
  tool: m.phraseTool,
};

/** How the Room status line names an Activity. */
export interface ActivityStatusLine {
  /** The Runtime's own description, which starts a new group of the line. */
  title?: string;
  /** The steps the Activity takes, in order. */
  steps: readonly string[];
}

/**
 * The Room status line's words for an Activity: the Runtime's description or
 * the steps the Computer read from it, else its kind's phrase.
 */
export function activityStatusLine(
  t: Translate,
  kind: string,
  input?: unknown,
): ActivityStatusLine {
  const fields = inputFields(input);
  const title =
    typeof fields.status_title === "string" ? fields.status_title.trim() : "";
  if (title) return { steps: [], title };
  const steps = Array.isArray(fields.status_steps)
    ? fields.status_steps.filter(
        (step): step is string =>
          typeof step === "string" && step.trim() !== "",
      )
    : [];
  if (steps.length > 0) return { steps };
  const category = toolAppearance(kind).category;
  return { steps: category === "command" ? [] : [t(statusPhrases[category])] };
}

function inputFields(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}
