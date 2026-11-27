import type { TeamHubMessageActivityRecord } from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";

import { runPanelMessages as m } from "./run-panel.messages";

// Reads native Runtime history records of every Runtime's shape: Codex
// response items, Claude Code transcript lines, Pi session messages, and
// Antigravity transcript entries.

type HistoryCategory = TeamHubMessageActivityRecord["category"];

/** The shell command a native tool call ran, for any Runtime's shape. */
export function nativeCommand(record: TeamHubMessageActivityRecord) {
  const payload = nativePayload(record);
  const block = nativeContentBlock(record, payload);
  const input =
    asObject(block?.input) ??
    asObject(block?.arguments) ??
    asObject(payload?.args) ??
    parseObject(payload?.arguments) ??
    asObject(payload?.action) ??
    payload;
  const command = input?.CommandLine ?? input?.cmd ?? input?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter(isString).join(" ");
  return undefined;
}

export function nativeOutput(record: TeamHubMessageActivityRecord) {
  const payload = nativePayload(record);
  const block = nativeContentBlock(record, payload);
  return (
    stringValue(payload?.output) ??
    textContent(block?.content) ??
    textContent(payload?.content)
  );
}

export function parseObject(value: unknown) {
  if (typeof value !== "string") return asObject(value);
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function activityMessageText(
  t: Translate,
  record: TeamHubMessageActivityRecord,
) {
  const payload = nativePayload(record);
  return (
    stringValue(payload?.message) ??
    stringValue(payload?.text) ??
    textContent(payload?.content) ??
    t(m.noMessageText)
  );
}

export function nativePayload(record: TeamHubMessageActivityRecord) {
  const nativeRecord = asObject(record.native_record);
  return (
    asObject(nativeRecord?.payload) ??
    asObject(nativeRecord?.message) ??
    nativeRecord
  );
}

function contentBlockCategory(type: unknown): HistoryCategory | undefined {
  switch (type) {
    case "text":
      return "message";
    case "thinking":
    case "redacted_thinking":
      return "reasoning";
    case "tool_use":
    case "server_tool_use":
    case "toolCall":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    default:
      return undefined;
  }
}

export function contentBlockRecords(
  record: TeamHubMessageActivityRecord,
): TeamHubMessageActivityRecord[] {
  const native = asObject(record.native_record);
  if (native?.type === "PLANNER_RESPONSE") {
    const expanded = antigravityPlannerRecords(record, native);
    if (expanded.length > 0) return expanded;
    return [record];
  }
  const blocks = messageContentBlocks(record);
  if (!blocks) return [record];
  const message = asObject(native!.message)!;
  return blocks.flatMap((block) => {
    const category = contentBlockCategory(block.type);
    if (!category) return [];
    return [
      {
        ...record,
        category,
        tool_call_id: stringValue(block.id ?? block.tool_use_id),
        tool_name: stringValue(block.name),
        native_record: {
          ...native!,
          message: { ...message, content: [block] },
        },
      },
    ];
  });
}

function antigravityPlannerRecords(
  record: TeamHubMessageActivityRecord,
  native: JsonObject,
): TeamHubMessageActivityRecord[] {
  const { tool_calls: rawToolCalls, ...base } = native;
  const result: TeamHubMessageActivityRecord[] = [];
  if (typeof native.content === "string" && native.content.trim().length > 0) {
    result.push({
      ...record,
      category: "message",
      role: "assistant",
      tool_call_id: undefined,
      tool_name: undefined,
      native_record: base,
    });
  }
  if (Array.isArray(rawToolCalls)) {
    const { content: _content, ...toolBase } = base;
    for (let toolIndex = 0; toolIndex < rawToolCalls.length; toolIndex += 1) {
      const call = asObject(rawToolCalls[toolIndex]);
      if (!call) continue;
      const name = stringValue(call.name);
      const rawArgs = asObject(call.args);
      const args = rawArgs ? decodeAntigravityArgs(rawArgs) : undefined;
      result.push({
        ...record,
        category: "tool_call",
        role: "assistant",
        tool_call_id:
          stringValue(call.id) ??
          `antigravity-tool-${record.ordinal}-${toolIndex}`,
        tool_name: name,
        native_record: {
          ...toolBase,
          ...(name !== undefined ? { name } : {}),
          ...(args !== undefined ? { args } : {}),
        },
      });
    }
  }
  return result;
}

/**
 * Antigravity transcripts serialize string values inside
 * `PLANNER_RESPONSE.tool_calls[*].args` as JSON string literals. Unwrap those
 * while leaving plain strings and non-string values unchanged.
 */
function decodeAntigravityArgs(args: JsonObject): JsonObject {
  const decoded: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    decoded[key] = decodeAntigravityArgValue(value);
  }
  return decoded;
}

function decodeAntigravityArgValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    trimmed.length < 2 ||
    !trimmed.startsWith('"') ||
    !trimmed.endsWith('"')
  ) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

export function reasoningText(
  t: Translate,
  record: TeamHubMessageActivityRecord,
): string | undefined {
  const payload = nativePayload(record);
  const block = nativeContentBlock(record, payload);
  if (block?.type === "thinking" || block?.type === "redacted_thinking") {
    return thinkingSummary(block) ?? t(m.thinkingHidden);
  }
  return stringValue(payload?.text) ?? textContent(payload?.summary);
}

export function nativeContentBlock(
  record: TeamHubMessageActivityRecord,
  payload: JsonObject | undefined,
) {
  if (!Array.isArray(payload?.content)) return undefined;
  const blocks = payload.content.flatMap((value) => {
    const block = asObject(value);
    return block ? [block] : [];
  });
  switch (record.category) {
    case "tool_call":
      return blocks.find(
        (block) =>
          contentBlockCategory(block.type) === "tool_call" &&
          (!record.tool_call_id || block.id === record.tool_call_id),
      );
    case "tool_result":
      return blocks.find(
        (block) =>
          block.type === "tool_result" &&
          (!record.tool_call_id || block.tool_use_id === record.tool_call_id),
      );
    case "reasoning":
      return blocks.find(
        (block) =>
          block.type === "thinking" || block.type === "redacted_thinking",
      );
    default:
      return undefined;
  }
}

export function isUserMessage(record: TeamHubMessageActivityRecord) {
  return record.role === "user" || record.native_type.endsWith(".user_message");
}

export function isAssistantMessage(record: TeamHubMessageActivityRecord) {
  return (
    record.role === "assistant" || record.native_type.endsWith(".agent_message")
  );
}

export function isEventRecord(record: TeamHubMessageActivityRecord) {
  return record.native_type.startsWith("event_msg.");
}

function textContent(value: unknown): string | undefined {
  const parts = collectText(value).filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectText);
  const object = asObject(value);
  if (!object) return [];
  if (typeof object.text === "string") return [object.text];
  return object.content === undefined ? [] : collectText(object.content);
}

export function indexToolCalls(records: TeamHubMessageActivityRecord[]) {
  const candidates = new Map<
    string,
    {
      calls: TeamHubMessageActivityRecord[];
      results: TeamHubMessageActivityRecord[];
    }
  >();
  for (const record of records) {
    const blocks = messageContentBlocks(record);
    if (blocks) {
      for (const block of blocks) {
        const category = contentBlockCategory(block.type);
        const id = stringValue(
          category === "tool_result" ? block.tool_use_id : block.id,
        );
        if (!id || (category !== "tool_call" && category !== "tool_result"))
          continue;
        const candidate = candidates.get(id) ?? { calls: [], results: [] };
        candidate[category === "tool_call" ? "calls" : "results"].push(record);
        candidates.set(id, candidate);
      }
      continue;
    }
    if (
      !record.tool_call_id ||
      (record.category !== "tool_call" && record.category !== "tool_result")
    ) {
      continue;
    }
    const current = candidates.get(record.tool_call_id) ?? {
      calls: [],
      results: [],
    };
    current[record.category === "tool_call" ? "calls" : "results"].push(record);
    candidates.set(record.tool_call_id, current);
  }
  const pairs = new Map<string, ToolCallPair>();
  for (const [callId, candidate] of candidates) {
    if (candidate.calls.length > 1 || candidate.results.length > 1) continue;
    pairs.set(callId, {
      ...(candidate.calls[0] ? { call: candidate.calls[0] } : {}),
      ...(candidate.results[0] ? { result: candidate.results[0] } : {}),
    });
  }
  return pairs;
}

type JsonObject = Record<string, unknown>;

export interface ToolCallPair {
  readonly call?: TeamHubMessageActivityRecord;
  readonly result?: TeamHubMessageActivityRecord;
}

/**
 * The content blocks of a Runtime that records a whole message per line:
 * Claude Code's user and assistant lines, and Pi's assistant messages. A Pi
 * tool result is its own line, already a tool_result record.
 */
function messageContentBlocks(
  record: TeamHubMessageActivityRecord,
): JsonObject[] | undefined {
  const native = asObject(record.native_record);
  const message = asObject(native?.message);
  const claudeLine = native?.type === "user" || native?.type === "assistant";
  const piAssistant =
    native?.type === "message" && message?.role === "assistant";
  if (!claudeLine && !piAssistant) return undefined;
  if (typeof message?.content === "string")
    return [{ type: "text", text: message.content }];
  return Array.isArray(message?.content)
    ? message.content.flatMap((value) => {
        const block = asObject(value);
        return block ? [block] : [];
      })
    : undefined;
}

export function thinkingSummary(block: JsonObject): string | undefined {
  if (typeof block.summary === "string") return block.summary;
  if (!Array.isArray(block.summary)) return undefined;
  return (
    block.summary
      .flatMap((part) => {
        const text = asObject(part)?.text;
        return typeof text === "string" ? [text] : [];
      })
      .join("\n\n") || undefined
  );
}

export function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
