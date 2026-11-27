import { ArrowRight01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { useMemo } from "react";

import { Icon } from "@/components/ui/icon";
import type { Translate } from "@/i18n/language";
import { formatMessageParts } from "@/i18n/messages";
import { RichMessage, useTranslation } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";
import {
  toolAppearance,
  toolNameLabel,
} from "@/features/rooms/runtime-status/runtime-tool-presentation";
import type { TeamHubMessageActivityRecord } from "@/features/teamhub/teamhub-types";

import { MessageMarkdown } from "../../chat/message-markdown";
import { runtimeStatusMessages } from "../../runtime-status/runtime-status.messages";
import {
  activityMessageText,
  asObject,
  contentBlockRecords,
  indexToolCalls,
  isAssistantMessage,
  isEventRecord,
  nativeCommand,
  nativeContentBlock,
  nativeOutput,
  nativePayload,
  parseObject,
  reasoningText,
  stringValue,
  thinkingSummary,
  type ToolCallPair,
} from "./native-activity-records";
import { runPanelMessages as m } from "./run-panel.messages";

/** What a call did, worded around what it acted on. */
type CallVerb = (typeof m)[
  | "ran"
  | "read"
  | "edited"
  | "wrote"
  | "searched"
  | "listed"
  | "fetched"
  | "delegated"
  | "called"];

type TrajectoryItem =
  | { key: string; kind: "reasoning"; text: string }
  | { key: string; kind: "reply"; text: string }
  | { key: string; kind: "call"; call: TrajectoryCall };

interface TrajectoryCall {
  /** What the call acted on: a command, a path, a query. */
  detail: string;
  /** Lines added and removed, shown as a diff in place of the output. */
  diff?: string;
  /** The full input, when it says more than the detail. */
  input?: string;
  /** The Runtime-neutral tool kind that picks the row's icon. */
  kind: string;
  output?: string;
  pending: boolean;
  verb: CallVerb;
}

/**
 * A Runtime's native turn, one row per step: what it thought, each command
 * or tool call with what it acted on, and what it replied. A call opens to
 * its full input and output. Reads Codex, Claude Code, Pi, and Antigravity
 * records.
 */
export function RuntimeTrajectoryView({
  live,
  records,
}: {
  /** Whether the turn is still running, so a call without a result is pending. */
  live: boolean;
  records: TeamHubMessageActivityRecord[];
}) {
  const { t } = useTranslation();
  const items = useMemo(
    () => trajectoryItems(t, records, live),
    [t, records, live],
  );
  return (
    <ol
      aria-label={t(runtimeStatusMessages.activityLog)}
      className="space-y-1 text-xs leading-5 font-normal text-app-body"
    >
      {items.map((item) =>
        item.kind === "reasoning" ? (
          <li
            className="flex min-h-8 items-start gap-2 py-1.5 text-app-muted"
            key={item.key}
          >
            <Icon className="mt-0.5 shrink-0" icon={SparklesIcon} size={14} />
            <p className="min-w-0 flex-1">{item.text}</p>
          </li>
        ) : item.kind === "reply" ? (
          <li className="py-2" key={item.key}>
            <MessageMarkdown authorKind="agent" body={item.text} />
          </li>
        ) : (
          <TrajectoryCallRow call={item.call} key={item.key} />
        ),
      )}
    </ol>
  );
}

function TrajectoryCallRow({ call }: { call: TrajectoryCall }) {
  const { catalog, language, t } = useTranslation();
  const { glyph } = toolAppearance(call.kind);
  const output = call.diff ?? call.output;
  const values = { detail: call.detail };
  const label = (
    <span
      className={cn(
        "min-w-0 flex-1 truncate",
        call.pending && "town-shimmer-text",
      )}
      title={formatMessageParts(call.verb, language, catalog, values)
        .map((part) => part.text)
        .join("")}
    >
      <RichMessage
        message={call.verb}
        tags={{
          detail: (text) => <span className="text-app-body">{text}</span>,
        }}
        values={values}
      />
    </span>
  );
  if (!output && !call.input)
    return (
      <li className="flex min-h-8 items-center gap-2 py-1.5 text-app-muted">
        <Icon className="shrink-0" icon={glyph} size={14} />
        {label}
      </li>
    );
  return (
    <li>
      <details className="group">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 py-1.5 text-app-muted hover:text-app-body focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus [&::-webkit-details-marker]:hidden">
          <span className="relative inline-flex size-[14px] shrink-0 items-center justify-center">
            <span className="absolute inset-0 group-hover:hidden group-focus-within:hidden group-open:hidden">
              <Icon icon={glyph} size={14} />
            </span>
            <span className="absolute inset-0 hidden group-hover:block group-focus-within:block group-open:block group-open:rotate-90 motion-reduce:transition-none">
              <Icon icon={ArrowRight01Icon} size={14} />
            </span>
          </span>
          {label}
        </summary>
        <div className="space-y-2 pb-2 pl-[1.4rem]">
          {call.input ? (
            <TrajectoryText label={t(m.input)} text={call.input} />
          ) : null}
          {output ? (
            <TrajectoryText
              diff={Boolean(call.diff)}
              label={t(call.diff ? m.changes : m.output)}
              text={output}
            />
          ) : null}
        </div>
      </details>
    </li>
  );
}

function TrajectoryText({
  diff = false,
  label,
  text,
}: {
  diff?: boolean;
  label: string;
  text: string;
}) {
  return (
    <section aria-label={label}>
      <p className="pb-1 text-app-muted">{label}</p>
      <pre className="workspace-scrollbar max-h-72 overflow-auto rounded-md bg-app-surface-soft px-3 py-2 font-mono text-[11px] leading-[17px] break-words whitespace-pre-wrap text-app-body">
        {diff
          ? text.split("\n").map((line, index) => (
              <span className={cn("block", diffTone(line))} key={index}>
                {line || " "}
              </span>
            ))
          : text.replace(/\n+$/, "")}
      </pre>
    </section>
  );
}

function diffTone(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++"))
    return "text-app-success";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-app-danger";
  return undefined;
}

function trajectoryItems(
  t: Translate,
  records: TeamHubMessageActivityRecord[],
  live: boolean,
): TrajectoryItem[] {
  const ordered = [...records]
    .sort((left, right) => left.ordinal - right.ordinal)
    .flatMap(contentBlockRecords);
  const pairs = indexToolCalls(ordered);
  const items: TrajectoryItem[] = [];
  const seenReasoning = new Set<string>();
  for (const record of ordered) {
    const key = `${record.ordinal}:${items.length}`;
    if (record.category === "reasoning") {
      const text = reasoningSummary(t, record);
      if (!text || seenReasoning.has(text)) continue;
      seenReasoning.add(text);
      items.push({ key, kind: "reasoning", text });
    } else if (
      record.category === "message" &&
      isAssistantMessage(record) &&
      !isEventRecord(record)
    ) {
      items.push({ key, kind: "reply", text: activityMessageText(t, record) });
    } else if (record.category === "tool_call") {
      const pair = record.tool_call_id
        ? pairs.get(record.tool_call_id)
        : undefined;
      items.push({
        call: trajectoryCall(t, record, pair, live),
        key,
        kind: "call",
      });
    }
  }
  return items;
}

/**
 * The readable summary of a reasoning step. Private thinking without a
 * summary says nothing to show, so it is left out.
 */
function reasoningSummary(t: Translate, record: TeamHubMessageActivityRecord) {
  const block = nativeContentBlock(record, nativePayload(record));
  const text = block ? thinkingSummary(block) : reasoningText(t, record);
  return text?.replace(/^\*\*([\s\S]+)\*\*$/, "$1").trim();
}

/**
 * Names a call by what its tool does. Each Runtime names its tools its own
 * way: Codex `exec_command` and `apply_patch`, Claude Code `Bash`, `Read` and
 * `Edit`, Pi `bash`, `read` and `edit`; MCP tools keep their own names.
 */
function trajectoryCall(
  t: Translate,
  record: TeamHubMessageActivityRecord,
  pair: ToolCallPair | undefined,
  live: boolean,
): TrajectoryCall {
  const payload = nativePayload(record);
  const block = nativeContentBlock(record, payload);
  const nativeKind = record.native_type.split(".").pop() ?? "";
  const name =
    record.tool_name ??
    stringValue(block?.name) ??
    stringValue(payload?.name) ??
    nativeKind;
  const rawInput =
    stringValue(payload?.input) ?? stringValue(payload?.arguments);
  const args =
    asObject(block?.input) ??
    asObject(block?.arguments) ??
    asObject(payload?.args) ??
    parseObject(payload?.arguments) ??
    asObject(payload?.action);
  // A hosted search reports its own completion and has no result record.
  const settled = Boolean(pair?.result) || payload?.status === "completed";
  const base = {
    output: pair?.result ? nativeOutput(pair.result) : undefined,
    pending: live && !settled,
  };
  const tool = name.toLowerCase();
  const command = nativeCommand(record);
  if (
    command &&
    [
      "exec_command",
      "shell",
      "local_shell",
      "local_shell_call",
      "bash",
      "powershell",
      "run_command",
    ].includes(tool)
  )
    return { ...base, detail: command, kind: "command", verb: m.ran };
  const path = stringValue(
    args?.AbsolutePath ??
      args?.Path ??
      args?.path ??
      args?.file_path ??
      args?.filePath,
  );
  if (["read", "read_file", "view", "view_file"].includes(tool) && path)
    return { ...base, detail: path, kind: "read", verb: m.read };
  if (tool === "apply_patch") {
    const patch = stringValue(args?.input) ?? rawInput ?? "";
    return {
      ...base,
      detail: patchFiles(patch) || t(m.files),
      diff: patchLines(patch),
      kind: "file_change",
      verb: m.edited,
    };
  }
  if (
    [
      "edit",
      "edit_file",
      "multiedit",
      "write",
      "write_file",
      "str_replace_based_edit_tool",
    ].includes(tool) &&
    path
  )
    return {
      ...base,
      detail: path,
      diff: editLines(args) || undefined,
      kind: "file_change",
      verb: tool === "write" || tool === "write_file" ? m.wrote : m.edited,
    };
  const query = stringValue(
    args?.Query ?? args?.Pattern ?? args?.query ?? args?.pattern,
  );
  if (
    [
      "web_search",
      "web_search_call",
      "websearch",
      "grep",
      "grep_search",
      "glob",
      "find",
      "find_by_name",
    ].includes(tool) &&
    query
  ) {
    const scope = stringValue(
      args?.SearchPath ?? args?.SearchDirectory ?? args?.path,
    );
    return {
      ...base,
      detail: scope ? t(m.searchIn, { query, scope }) : query,
      kind: "search",
      verb: m.searched,
    };
  }
  if (tool === "ls" || tool === "list_dir")
    return {
      ...base,
      detail: stringValue(args?.DirectoryPath) ?? path ?? ".",
      kind: "read",
      verb: m.listed,
    };
  const url = stringValue(args?.url);
  if (["web_fetch", "webfetch"].includes(tool) && url)
    return { ...base, detail: url, kind: "browse", verb: m.fetched };
  const task = stringValue(args?.description);
  if (["task", "agent"].includes(tool) && task)
    return { ...base, detail: task, kind: "delegation", verb: m.delegated };
  const input = args ? JSON.stringify(args, null, 2) : rawInput;
  return {
    ...base,
    detail: toolNameLabel(name),
    ...(input ? { input } : {}),
    kind: "tool",
    verb: m.called,
  };
}

function patchFiles(patch: string) {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => match[1]!.trim())
    .join(", ");
}

/** A Codex patch's lines; its envelope only repeats the files the row names. */
function patchLines(patch: string) {
  return patch
    .split("\n")
    .filter(
      (line) =>
        !/^\*\*\* (Begin Patch|End Patch|Add File:|Update File:|Delete File:)|^@@$/.test(
          line,
        ),
    )
    .join("\n");
}

/**
 * An edit tool's input as removed and added lines: Claude Code's
 * `old_string`/`new_string` (or `edits` of them, or `content` to write),
 * Pi's `oldText`/`newText`, and Antigravity's `Target`/`Replacement`/`Content`.
 */
function editLines(args: Record<string, unknown> | undefined) {
  const prefix = (text: unknown, mark: string) =>
    typeof text === "string" ? text.split("\n").map((line) => mark + line) : [];
  const content = args?.content ?? args?.Content;
  if (typeof content === "string") return prefix(content, "+").join("\n");
  const listed = args?.edits;
  const edits = Array.isArray(listed) ? listed : [args];
  return edits
    .flatMap((value) => {
      const edit = asObject(value);
      const lines = [
        ...prefix(edit?.old_string ?? edit?.oldText ?? edit?.Target, "-"),
        ...prefix(edit?.new_string ?? edit?.newText ?? edit?.Replacement, "+"),
      ];
      return lines.length ? [lines.join("\n")] : [];
    })
    .join("\n\n");
}
