import { ChevronRight, Sparkles } from "lucide-react";
import { useMemo } from "react";

import { toolPresentation } from "@/features/rooms/runtime-status/runtime-tool-presentation";

import type { TeamHubMessageActivityRecord } from "@/features/teamhub/teamhub-types";

import { MessageMarkdown } from "../../chat/message-markdown";
import {
  activityMessageText,
  asObject,
  claudeActivityRecords,
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
  type ToolCallPair,
} from "./runtime-history-view";

type TrajectoryItem =
  | { key: string; kind: "reasoning"; text: string }
  | { key: string; kind: "reply"; text: string }
  | { key: string; kind: "call"; call: TrajectoryCall };

interface TrajectoryCall {
  /** What the call acted on: a command, a path, a query. */
  detail: string;
  /** The full input, when it says more than the detail. */
  input?: string;
  /** The Runtime-neutral tool kind that picks the row's icon. */
  kind: string;
  output?: string;
  /** A patch's lines, coloured as a diff. */
  patch?: string;
  pending: boolean;
  verb: string;
}

/**
 * A Runtime's native turn, one row per step: what it thought, each command
 * or tool call with what it acted on, and what it replied. A call opens to
 * its full input and output.
 */
export function RuntimeTrajectoryView({
  records,
}: {
  records: TeamHubMessageActivityRecord[];
}) {
  const items = useMemo(() => trajectoryItems(records), [records]);
  return (
    <ol
      aria-label="Activity log"
      className="space-y-1 text-xs leading-5 font-normal text-app-body"
    >
      {items.map((item) =>
        item.kind === "reasoning" ? (
          <li
            className="flex min-h-8 items-start gap-2 py-1.5 text-app-muted"
            key={item.key}
          >
            <Sparkles
              aria-hidden="true"
              className="mt-0.5 shrink-0"
              size={15}
            />
            <p className="min-w-0 flex-1">{item.text}</p>
          </li>
        ) : item.kind === "reply" ? (
          <li className="py-2" key={item.key}>
            <div className="room-message-bubble text-[15px] leading-[22px] text-app-ink">
              <MessageMarkdown authorKind="agent" body={item.text} />
            </div>
          </li>
        ) : (
          <TrajectoryCallRow call={item.call} key={item.key} />
        ),
      )}
    </ol>
  );
}

function TrajectoryCallRow({ call }: { call: TrajectoryCall }) {
  const { icon: ToolIcon } = toolPresentation(call.kind);
  const output = call.patch ?? call.output;
  const label = (
    <span
      className={`min-w-0 flex-1 truncate ${call.pending ? "town-shimmer-text" : ""}`}
      title={`${call.verb} ${call.detail}`}
    >
      {call.verb} <span className="text-app-body">{call.detail}</span>
    </span>
  );
  if (!output && !call.input)
    return (
      <li className="flex min-h-8 items-center gap-2 py-1.5 text-app-muted">
        <ToolIcon aria-hidden="true" className="shrink-0" size={15} />
        {label}
      </li>
    );
  return (
    <li>
      <details className="group">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 py-1.5 text-app-muted hover:text-app-body focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus [&::-webkit-details-marker]:hidden">
          <span className="relative inline-flex size-[15px] shrink-0 items-center justify-center">
            <ToolIcon
              aria-hidden="true"
              className="absolute inset-0 m-auto group-hover:hidden group-focus-within:hidden group-open:hidden"
              size={15}
            />
            <ChevronRight
              aria-hidden="true"
              className="absolute inset-0 m-auto hidden group-hover:block group-focus-within:block group-open:block group-open:rotate-90 motion-reduce:transition-none"
              size={15}
            />
          </span>
          {label}
        </summary>
        <div className="space-y-2 pb-2 pl-[1.45rem]">
          {call.input ? (
            <TrajectoryText label="Input" text={call.input} />
          ) : null}
          {output ? (
            <TrajectoryText
              diff={Boolean(call.patch)}
              label={call.patch ? "Changes" : "Output"}
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
      <pre className="workspace-scrollbar max-h-72 overflow-auto rounded-md bg-app-surface-soft px-3 py-2 font-mono text-[11px] leading-[17px] whitespace-pre-wrap break-words text-app-body">
        {diff
          ? text.split("\n").map((line, index) => (
              <span className={`block ${diffTone(line)}`} key={index}>
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
  return "";
}

function trajectoryItems(
  records: TeamHubMessageActivityRecord[],
): TrajectoryItem[] {
  const ordered = [...records]
    .sort((left, right) => left.ordinal - right.ordinal)
    .flatMap(claudeActivityRecords);
  const pairs = indexToolCalls(ordered);
  const items: TrajectoryItem[] = [];
  const seenReasoning = new Set<string>();
  for (const record of ordered) {
    const key = `${record.ordinal}:${items.length}`;
    if (record.category === "reasoning") {
      const text = reasoningText(record)
        ?.replace(/^\*\*([\s\S]+)\*\*$/, "$1")
        .trim();
      if (!text || seenReasoning.has(text)) continue;
      seenReasoning.add(text);
      items.push({ key, kind: "reasoning", text });
    } else if (
      record.category === "message" &&
      isAssistantMessage(record) &&
      !isEventRecord(record)
    ) {
      items.push({ key, kind: "reply", text: activityMessageText(record) });
    } else if (record.category === "tool_call") {
      const pair = record.tool_call_id
        ? pairs.get(record.tool_call_id)
        : undefined;
      items.push({ call: trajectoryCall(record, pair), key, kind: "call" });
    }
  }
  return items;
}

/** Names a call by what its tool does, from the tool's own name and input. */
function trajectoryCall(
  record: TeamHubMessageActivityRecord,
  pair: ToolCallPair | undefined,
): TrajectoryCall {
  const payload = nativePayload(record);
  const block = nativeContentBlock(record, payload);
  const name =
    record.tool_name ?? stringValue(block?.name) ?? stringValue(payload?.name);
  const rawInput =
    stringValue(payload?.input) ?? stringValue(payload?.arguments);
  const args =
    asObject(block?.input) ?? parseObject(payload?.arguments) ?? undefined;
  const output = pair?.result ? nativeOutput(pair.result) : undefined;
  const base = { output, pending: !pair?.result };
  const tool = (name ?? "tool").toLowerCase();
  const command = nativeCommand(record);
  if (command && /^(exec_command|shell|local_shell|bash)$/.test(tool))
    return { ...base, detail: command, kind: "command", verb: "Ran" };
  const path = stringValue(args?.path ?? args?.file_path ?? args?.filePath);
  if (/^(read_file|read|view)$/.test(tool) && path)
    return { ...base, detail: path, kind: "read", verb: "Read" };
  const patch =
    tool === "apply_patch" ? (stringValue(args?.input) ?? rawInput) : undefined;
  if (patch !== undefined)
    return {
      ...base,
      detail: patchFiles(patch) || "files",
      // The envelope only repeats the file names the row already shows.
      patch: patch
        .split("\n")
        .filter(
          (line) =>
            !/^\*\*\* (Begin Patch|End Patch|Add File:|Update File:|Delete File:)|^@@$/.test(
              line,
            ),
        )
        .join("\n"),
      kind: "file_change",
      verb: "Edited",
    };
  if (/^(edit|write|multiedit|str_replace_based_edit_tool)$/.test(tool) && path)
    return {
      ...base,
      detail: path,
      input: JSON.stringify(args, null, 2),
      kind: "file_change",
      verb: "Edited",
    };
  const query = stringValue(args?.query);
  if (/^(web_search|websearch)$/.test(tool) && query)
    return { ...base, detail: query, kind: "search", verb: "Searched" };
  const url = stringValue(args?.url);
  if (/^(web_fetch|webfetch)$/.test(tool) && url)
    return { ...base, detail: url, kind: "browse", verb: "Fetched" };
  const input = args ? JSON.stringify(args, null, 2) : rawInput;
  return {
    ...base,
    detail: name ?? "tool",
    ...(input ? { input } : {}),
    kind: "tool",
    verb: "Called",
  };
}

function patchFiles(patch: string) {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
    .map((match) => match[1]!.trim())
    .join(", ");
}
