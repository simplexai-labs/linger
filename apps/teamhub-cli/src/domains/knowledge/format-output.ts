import {
  personalKnowledgeQueryOutputSchema,
  sessionFactSchema,
} from "./tools/query.js";
import { ToolExecutionError } from "../../domain-support/errors.js";
import type {
  PersonalKnowledgeEvidenceReadResponse,
  PersonalKnowledgeQueryResponse,
} from "@linger/wire-contracts/node-services-internal/client";
import { PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN } from "@linger/wire-contracts/node-services-internal/client";
import { isRecord } from "@linger/service-kit";

interface KnowledgeEvidenceReadInput {
  evidenceId: string;
  sectionRequests: readonly { offset?: number; sectionId: string }[];
}

/** Standalone CLI output preserves every validated server result and body. */
export function formatKnowledgeCliOutput(
  command: string,
  input: Readonly<Record<string, unknown>>,
  response: unknown,
): Record<string, unknown> {
  if (command === "search") return parseSearchResponse(response);
  if (command === "read") {
    const parsed = parseEvidenceReadResponse(
      response,
      input as unknown as KnowledgeEvidenceReadInput,
    );
    if (!PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN.test(parsed.evidenceId))
      throw unavailable();
    return {
      ...parsed,
      schemaVersion: 2,
      directory: parsed.directory.map(({ id: sectionId, ...entry }) => ({
        sectionId,
        ...entry,
      })),
      sections: parsed.sections.map(({ id: sectionId, ...section }) => ({
        sectionId,
        ...section,
      })),
    };
  }
  throw new TypeError("Unknown knowledge command");
}

/** Memory's search result, validated as the Agent sees it. */
function parseSearchResponse(value: unknown): PersonalKnowledgeQueryResponse {
  if (!isRecord(value)) throw unavailable();
  // Facts are optional leads: drop an invalid one instead of failing the search.
  if (value.facts !== undefined && !Array.isArray(value.facts))
    throw unavailable();
  const facts = (value.facts ?? []).flatMap((fact) => {
    const parsed = sessionFactSchema.safeParse(fact);
    return parsed.success ? [parsed.data] : [];
  });
  const { facts: _facts, ...rest } = value;
  const parsed = personalKnowledgeQueryOutputSchema.safeParse({
    ...rest,
    ...(facts.length ? { facts } : {}),
  });
  if (!parsed.success) throw unavailable();
  const result = parsed.data;
  const entries = [...result.items, ...result.summaries];
  // Each list is labelled S or W in one consecutive run; a later page
  // continues where the previous one stopped.
  const consecutive = (list: readonly { citeAs: string }[], prefix: string) =>
    list.every(
      ({ citeAs }, index) =>
        citeAs.startsWith(prefix) &&
        Number(citeAs.slice(1)) === Number(list[0]!.citeAs.slice(1)) + index,
    );
  if (
    !consecutive(result.items, "S") ||
    !consecutive(result.summaries, "W") ||
    (result.page === 1 &&
      [result.items[0], result.summaries[0]].some(
        (entry) => entry && entry.citeAs.slice(1) !== "1",
      )) ||
    (result.status === "grounded" &&
      (entries.length === 0 || result.gaps.length !== 0)) ||
    (result.status === "partial" &&
      (entries.length === 0 || result.gaps.length === 0)) ||
    (result.status === "empty" &&
      (entries.length !== 0 || result.gaps.length === 0))
  ) {
    throw unavailable();
  }
  return result;
}

function parseDirectory(value: unknown) {
  if (!Array.isArray(value) || value.length > 64) throw unavailable();
  const ids = new Set<string>();
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(Object.keys(candidate), [
        "id",
        "level",
        "purpose",
        "title",
      ]) ||
      !isSectionId(candidate.id) ||
      ids.has(candidate.id) ||
      !isBoundedString(candidate.title, 512) ||
      !Number.isInteger(candidate.level) ||
      (candidate.level as number) < 1 ||
      (candidate.level as number) > 6 ||
      (candidate.purpose !== undefined &&
        !isBoundedString(candidate.purpose, 512))
    ) {
      throw unavailable();
    }
    ids.add(candidate.id);
    return Object.freeze({
      id: candidate.id,
      level: candidate.level as number,
      ...(candidate.purpose === undefined
        ? {}
        : { purpose: candidate.purpose }),
      title: candidate.title,
    });
  });
}

function parseEvidenceSource(value: unknown) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(Object.keys(value), ["kind", "label", "ref"]) ||
    !isBoundedString(value.kind, 64) ||
    !isBoundedString(value.ref, 1_024) ||
    /[\r\n]/u.test(value.ref) ||
    (value.label !== undefined && !isBoundedString(value.label, 512))
  ) {
    throw unavailable();
  }
  return Object.freeze({
    kind: value.kind,
    ...(value.label === undefined ? {} : { label: value.label }),
    ref: value.ref,
  });
}

function parseEvidenceReadResponse(
  value: unknown,
  input: KnowledgeEvidenceReadInput,
): PersonalKnowledgeEvidenceReadResponse {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(Object.keys(value), [
      "complete",
      "directory",
      "evidenceId",
      "missingSections",
      "schemaVersion",
      "sections",
      "source",
      "timeHint",
      "title",
    ]) ||
    value.schemaVersion !== 1 ||
    value.evidenceId !== input.evidenceId ||
    !isBoundedString(value.title, 512) ||
    (value.timeHint !== undefined && !isBoundedString(value.timeHint, 128)) ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.sections) ||
    value.sections.length > 8 ||
    !Array.isArray(value.missingSections) ||
    value.missingSections.length > 8
  ) {
    throw unavailable();
  }

  const requested = new Map(
    input.sectionRequests.map((request) => [request.sectionId, request]),
  );
  if (requested.size !== input.sectionRequests.length) throw unavailable();

  const directory = parseDirectory(value.directory);
  const accountedFor = new Set<string>();
  const sections = value.sections.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(Object.keys(candidate), [
        "content",
        "id",
        "level",
        "nextOffset",
        "offset",
        "title",
        "truncated",
      ]) ||
      !isSectionId(candidate.id) ||
      accountedFor.has(candidate.id) ||
      !requested.has(candidate.id) ||
      !isBoundedString(candidate.title, 512) ||
      !Number.isInteger(candidate.level) ||
      (candidate.level as number) < 1 ||
      (candidate.level as number) > 6 ||
      typeof candidate.content !== "string" ||
      candidate.content.length > 12_000 ||
      !isIntegerBetween(candidate.offset, 0, 200_000) ||
      candidate.offset !== (requested.get(candidate.id)?.offset ?? 0) ||
      typeof candidate.truncated !== "boolean" ||
      (candidate.nextOffset !== undefined &&
        (!candidate.truncated ||
          !isIntegerBetween(candidate.nextOffset, 1, 200_000) ||
          candidate.nextOffset <= candidate.offset))
    ) {
      throw unavailable();
    }
    accountedFor.add(candidate.id);
    return Object.freeze({
      content: candidate.content,
      id: candidate.id,
      level: candidate.level as number,
      ...(candidate.nextOffset === undefined
        ? {}
        : { nextOffset: candidate.nextOffset }),
      offset: candidate.offset,
      title: candidate.title,
      truncated: candidate.truncated,
    });
  });

  const missingSections = value.missingSections.map((sectionId) => {
    if (
      !isSectionId(sectionId) ||
      accountedFor.has(sectionId) ||
      !requested.has(sectionId)
    ) {
      throw unavailable();
    }
    accountedFor.add(sectionId);
    return sectionId;
  });
  if (accountedFor.size !== requested.size) throw unavailable();
  if (
    value.complete &&
    (missingSections.length !== 0 ||
      sections.some(({ truncated }) => truncated))
  ) {
    throw unavailable();
  }

  return Object.freeze({
    complete: value.complete,
    directory,
    evidenceId: value.evidenceId,
    missingSections,
    schemaVersion: 1 as const,
    sections,
    source: parseEvidenceSource(value.source),
    ...(value.timeHint === undefined ? {} : { timeHint: value.timeHint }),
    title: value.title,
  });
}

function hasOnlyKeys(actual: string[], allowed: string[]): boolean {
  return actual.every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isSectionId(value: unknown): value is string {
  return isBoundedString(value, 128) && /^[a-z0-9][a-z0-9_-]*$/u.test(value);
}

function isIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function unavailable(): ToolExecutionError {
  return new ToolExecutionError(
    "personal_knowledge_unavailable",
    "Personal knowledge is temporarily unavailable",
    { retryable: true },
  );
}
