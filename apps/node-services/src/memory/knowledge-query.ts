import type {
  PersonalKnowledgeEvidenceReadRequest,
  PersonalKnowledgeEvidenceReadResponse,
  PersonalKnowledgeQueryRequest,
  PersonalKnowledgeQueryResponse,
} from "@linger/wire-contracts/node-services-internal/client";
import type { ChunkSearchProvider } from "./chunk-index.js";

import { chunkSource, type SourceChunk } from "./search/chunks.js";
import { tokenizeSearchText } from "../bm25.js";
import { contentWindow } from "./search/content-window.js";
import {
  searchRawSources,
  resolveSearchRawSources,
  type RawMatch,
} from "./search/raw-query.js";
import {
  rawEvidenceId,
  rawSourceOriginKind,
  type RawOriginKind,
} from "./search/source-store.js";
import { agentWorkspaceRoot } from "./paths.js";

const MAX_DIRECTORY_ITEMS = 64;
// One search returns two separately ranked lists, so long derived reports
// never outrank original evidence on keyword scores alone: items are original
// sources and summaries are the Wiki and Daily/Weekly reports.
const ORIGINAL_KINDS: readonly RawOriginKind[] = [
  "room",
  "recording",
  "mail",
  "my_pages",
  "pocket_note",
  "profile",
];
const SUMMARY_KINDS: readonly RawOriginKind[] = ["wiki", "period_summary"];
const MAX_ENTRIES = { items: 20, summaries: 10 } as const;
// Chunks each list ranks before entries are grouped by source.
const LIST_CANDIDATE_CHUNKS = 60;
// The top entries of each list carry text around their best match; the
// floors keep that many even when the result is trimmed. A small budget, as a
// small context window gives, starts from fewer and shorter bodies.
const BODY_FLOORS = { items: 3, summaries: 2 } as const;
const LARGE_BUDGET_CHARS = 20_000;
const LARGE_LAYOUT = {
  bodies: { items: 5, summaries: 3 },
  chars: { items: 1_500, summaries: 1_500 },
} as const;
const SMALL_LAYOUT = {
  bodies: { items: 3, summaries: 2 },
  chars: { items: 1_200, summaries: 800 },
} as const;
const MIN_BODY_CHARS = 600;
const BODY_SHRINK_STEP = 100;
const SNIPPET_CHARS = 200;
const MAX_ENTRY_SECTIONS = 4;
const MAX_PAGE = 10;
const ROOM_SOURCE_URI =
  /^teamhub:\/\/rooms\/([A-Za-z0-9_-]{1,128})\/messages$/u;
// The Daemon limits one tool result to 15% of the model's context window, at
// most 25,000 tokens, and to 12,000 tokens when the window is unknown; a
// Runtime cuts the middle out of a longer result or saves it to a file.
// Codex counts four bytes per token, so the limit admits limit×4/3 characters
// of three-byte text such as CJK, and the Daemon gives Claude's Bash output as
// many characters. A search or read result is measured in UTF-16 characters
// of JSON, at most three bytes each, so it fits both Runtimes; it keeps 90% of
// that, since the CLI's labels add about 2%.
const WINDOW_OUTPUT_SHARE = 0.15;
const MAX_TOOL_OUTPUT_TOKENS = 25_000;
const UNKNOWN_WINDOW_TOOL_OUTPUT_TOKENS = 12_000;
const CLI_LABEL_ROOM = 0.9;
// A section that does not fit still returns a page this large, so every read
// makes progress.
const MIN_SECTION_PAGE_CHARS = 200;

export class PersonalKnowledgeEvidenceNotFoundError extends Error {
  constructor() {
    super("Personal knowledge evidence was not found");
    this.name = "PersonalKnowledgeEvidenceNotFoundError";
  }
}

/**
 * The most UTF-16 characters of JSON one search or read result may take for a
 * model with this context window in tokens, or with an unknown one.
 */
export function knowledgeOutputBudget(
  contextWindow: number | undefined,
): number {
  const toolOutputTokens =
    contextWindow === undefined
      ? UNKNOWN_WINDOW_TOOL_OUTPUT_TOKENS
      : Math.min(contextWindow * WINDOW_OUTPUT_SHARE, MAX_TOOL_OUTPUT_TOKENS);
  // limit×4/3 characters, multiplied before dividing so round limits stay
  // exact.
  return Math.floor((toolOutputTokens * 4 * CLI_LABEL_ROOM) / 3);
}

type ListName = "items" | "summaries";
type SearchEntry = PersonalKnowledgeQueryResponse["items"][number];
type SessionFact = NonNullable<PersonalKnowledgeQueryResponse["facts"]>[number];

/** One source in a list: its best match, its matched chunks and its body size. */
interface ListEntry {
  match: RawMatch;
  matched: Set<string>;
  // Characters of text around the best match; 0 gives a snippet instead.
  body: number;
}

/**
 * One search over every source of the Agent's index, as two separately ranked
 * lists: items are Sessions, recordings, My pages, mail, Pocket Notes and the
 * Profile; summaries are the published Wiki and Daily and Weekly reports.
 * Session facts rank in their own channel. `scope` searches one list with the
 * whole budget, and `page` continues the same search.
 */
export async function queryPersonalKnowledge(
  dataRoot: string,
  input: PersonalKnowledgeQueryRequest,
  options: {
    chunkSearch?: ChunkSearchProvider;
    outputBudgetChars?: number;
  } = {},
): Promise<PersonalKnowledgeQueryResponse> {
  const budget = options.outputBudgetChars ?? knowledgeOutputBudget(undefined);
  const workspaceRoot = agentWorkspaceRoot(dataRoot, input.agent_id);
  const lists: readonly ListName[] =
    input.scope === "summaries"
      ? ["summaries"]
      : input.scope === "originals"
        ? ["items"]
        : ["items", "summaries"];
  const search = (name: ListName) =>
    lists.includes(name)
      ? searchRawSources(
          workspaceRoot,
          {
            ...input,
            originKinds: name === "items" ? ORIGINAL_KINDS : SUMMARY_KINDS,
            limit: LIST_CANDIDATE_CHUNKS,
          },
          options.chunkSearch,
        )
      : Promise.resolve({ matches: [], limited: false });
  const [itemResult, summaryResult, facts] = await Promise.all([
    search("items"),
    search("summaries"),
    options.chunkSearch?.searchFacts?.(input) ?? [],
  ]);
  const terms = new Set(
    tokenizeSearchText([input.query, ...(input.alternates ?? [])].join(" ")),
  );
  const unavailable = [itemResult, summaryResult].some(
    (result) => "unavailable" in result && result.unavailable,
  );
  const limited = itemResult.limited || summaryResult.limited;
  const layout = (
    candidates: Record<ListName, ListEntry[]>,
    remainingFacts: readonly SessionFact[],
    offsets: Record<ListName, number>,
  ) =>
    layoutPage(candidates, remainingFacts, offsets, {
      budget,
      terms,
      single: lists.length === 1,
      // The largest the fields around the lists can be, so the final
      // response always fits.
      envelope: (body) => ({
        schemaVersion: 2,
        status: "partial",
        gaps: [
          { code: "raw_chunk_search_unavailable" },
          { code: "source_search_limited" },
          { code: "results_trimmed" },
        ],
        indexedAt: new Date(0).toISOString(),
        ...(input.scope ? { scope: input.scope } : {}),
        page: MAX_PAGE,
        nextPage: MAX_PAGE + 1,
        ...body,
      }),
    });
  // Earlier pages are laid out again and their entries skipped, so a page
  // continues exactly where the previous one stopped.
  const page = Math.min(Math.max(1, input.page ?? 1), MAX_PAGE);
  let remaining: Record<ListName, ListEntry[]> = {
    items: groupBySource(itemResult.matches, MAX_ENTRIES.items),
    summaries: groupBySource(summaryResult.matches, MAX_ENTRIES.summaries),
  };
  let remainingFacts: readonly SessionFact[] = facts;
  let offsets: Record<ListName, number> = { items: 0, summaries: 0 };
  let result = layout(remaining, remainingFacts, offsets);
  for (let earlier = 1; earlier < page; earlier += 1) {
    remaining = {
      items: remaining.items.slice(result.shown.items),
      summaries: remaining.summaries.slice(result.shown.summaries),
    };
    remainingFacts = remainingFacts.slice(result.shown.facts);
    offsets = {
      items: offsets.items + result.shown.items,
      summaries: offsets.summaries + result.shown.summaries,
    };
    result = layout(remaining, remainingFacts, offsets);
  }
  const more =
    page < MAX_PAGE &&
    (remaining.items.length > result.shown.items ||
      remaining.summaries.length > result.shown.summaries);
  const shown = [...result.body.items, ...result.body.summaries];
  const dates = shown
    .map(({ timeHint }) => Date.parse(timeHint ?? ""))
    .filter(Number.isFinite);
  const gaps = [
    ...(unavailable ? [{ code: "raw_chunk_search_unavailable" }] : []),
    ...(limited ? [{ code: "source_search_limited" }] : []),
    ...(!shown.length && !unavailable
      ? [{ code: "no_relevant_evidence" }]
      : []),
    ...(shown.length && (result.trimmed || more)
      ? [{ code: "results_trimmed" }]
      : []),
  ];
  return {
    schemaVersion: 2,
    // Entries with any gap are partial, so status and gaps never disagree.
    status: !shown.length
      ? unavailable
        ? "partial"
        : "empty"
      : gaps.length
        ? "partial"
        : "grounded",
    gaps,
    indexedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    ...(input.scope ? { scope: input.scope } : {}),
    page,
    ...(more ? { nextPage: page + 1 } : {}),
    ...result.body,
  };
}

/** A source's highest-ranked match, with every chunk of it that matched. */
function groupBySource(matches: readonly RawMatch[], max: number): ListEntry[] {
  const bySource = new Map<string, ListEntry>();
  for (const match of matches) {
    const entry = bySource.get(match.source.id);
    if (entry) entry.matched.add(match.chunk.id);
    else
      bySource.set(match.source.id, {
        match,
        matched: new Set([match.chunk.id]),
        body: 0,
      });
  }
  return [...bySource.values()].slice(0, max);
}

/**
 * Lays out one page within the budget. Over budget it drops, in order: the
 * lowest-ranked entries without a body (alternating lists), facts from the
 * tail, bodies beyond each list's floor, then shortens floor bodies. Room left
 * over gives more bodies, items first.
 */
function layoutPage(
  candidates: Record<ListName, ListEntry[]>,
  allFacts: readonly SessionFact[],
  offsets: Record<ListName, number>,
  options: {
    budget: number;
    terms: ReadonlySet<string>;
    single: boolean;
    envelope: (
      body: Pick<
        PersonalKnowledgeQueryResponse,
        "items" | "summaries" | "facts"
      >,
    ) => PersonalKnowledgeQueryResponse;
  },
) {
  const lists: Record<ListName, ListEntry[]> = {
    items: candidates.items.map((entry) => ({ ...entry, body: 0 })),
    summaries: candidates.summaries.map((entry) => ({ ...entry, body: 0 })),
  };
  const shape =
    options.budget >= LARGE_BUDGET_CHARS ? LARGE_LAYOUT : SMALL_LAYOUT;
  // A single-list search gives its list the items' share.
  const startBodies = options.single
    ? { items: shape.bodies.items, summaries: shape.bodies.items }
    : shape.bodies;
  for (const name of ["items", "summaries"] as const)
    lists[name]
      .slice(0, startBodies[name])
      .forEach((entry) => (entry.body = shape.chars[name]));
  let facts = allFacts.slice(
    0,
    fittingPrefix(
      allFacts.length,
      (count) => outputChars(allFacts.slice(0, count)),
      // Facts take at most a quarter, so they never crowd out the lists.
      options.budget / 4,
    ),
  );
  let trimmed = facts.length < allFacts.length;
  const body = () => ({
    ...(facts.length ? { facts } : {}),
    items: lists.items.map((entry, index) =>
      searchEntry(entry, `S${offsets.items + index + 1}`, options.terms),
    ),
    summaries: lists.summaries.map((entry, index) =>
      searchEntry(entry, `W${offsets.summaries + index + 1}`, options.terms),
    ),
  });
  const size = () => outputChars(options.envelope(body()));
  let next: ListName = "items";
  const dropEntryWithoutBody = (): boolean => {
    for (const name of [
      next,
      next === "items" ? "summaries" : "items",
    ] as const) {
      const list = lists[name];
      for (let index = list.length - 1; index >= BODY_FLOORS[name]; index -= 1)
        if (!list[index]!.body) {
          list.splice(index, 1);
          next = name === "items" ? "summaries" : "items";
          return true;
        }
    }
    return false;
  };
  const dropBodyBeyondFloor = (): boolean => {
    for (const name of ["summaries", "items"] as const) {
      const list = lists[name];
      for (let index = list.length - 1; index >= BODY_FLOORS[name]; index -= 1)
        if (list[index]!.body) {
          list[index]!.body = 0;
          return true;
        }
    }
    return false;
  };
  const shortenFloorBody = (): boolean => {
    let longest: ListEntry | undefined;
    for (const name of ["summaries", "items"] as const)
      for (const entry of lists[name].slice(0, BODY_FLOORS[name]))
        if (entry.body > MIN_BODY_CHARS && entry.body > (longest?.body ?? 0))
          longest = entry;
    if (!longest) return false;
    longest.body = Math.max(MIN_BODY_CHARS, longest.body - BODY_SHRINK_STEP);
    return true;
  };
  while (size() > options.budget) {
    trimmed = true;
    if (dropEntryWithoutBody()) continue;
    if (facts.length) {
      facts = facts.slice(0, -1);
      continue;
    }
    if (dropBodyBeyondFloor() || shortenFloorBody()) continue;
    break;
  }
  for (const name of ["items", "summaries"] as const)
    for (const entry of lists[name]) {
      if (entry.body) continue;
      entry.body = shape.chars[name];
      if (size() > options.budget) {
        entry.body = 0;
        break;
      }
    }
  return {
    body: body(),
    trimmed,
    shown: {
      items: lists.items.length,
      summaries: lists.summaries.length,
      facts: facts.length,
    },
  };
}

function searchEntry(
  { match: { source, chunk, chunks }, matched, body }: ListEntry,
  citeAs: string,
  terms: ReadonlySet<string>,
): SearchEntry {
  const roomId = ROOM_SOURCE_URI.exec(source.sourceUri)?.[1];
  return {
    citeAs,
    evidenceId: rawEvidenceId(source),
    kind: rawSourceOriginKind(source),
    title: source.title,
    timeHint: source.date,
    ...(body
      ? { content: contentWindow(chunk.content, terms, body) }
      : {
          snippet: contentWindow(chunk.content, terms, SNIPPET_CHARS)
            .replace(/\s+/gu, " ")
            .trim(),
        }),
    sections: entrySections(chunks, matched),
    ...(roomId ? { roomId } : {}),
  };
}

/** Matched sections first, then their neighbors, in document order. */
function entrySections(
  chunks: readonly SourceChunk[],
  matchedIds: ReadonlySet<string>,
) {
  const keep = new Set<number>();
  chunks.forEach((chunk, index) => {
    if (!matchedIds.has(chunk.id)) return;
    for (const neighbor of [index - 1, index, index + 1])
      if (neighbor >= 0 && neighbor < chunks.length) keep.add(neighbor);
  });
  const ordered = [...keep].sort((a, b) => a - b);
  return [
    ...ordered.filter((index) => matchedIds.has(chunks[index]!.id)),
    ...ordered.filter((index) => !matchedIds.has(chunks[index]!.id)),
  ]
    .slice(0, MAX_ENTRY_SECTIONS)
    .sort((a, b) => a - b)
    .map((index) => ({
      sectionId: chunks[index]!.id,
      title: chunks[index]!.heading.slice(0, 512),
    }));
}

export async function readPersonalKnowledgeEvidence(
  dataRoot: string,
  input: PersonalKnowledgeEvidenceReadRequest,
  options: {
    rawSourceProvider?: ChunkSearchProvider;
    outputBudgetChars?: number;
  } = {},
): Promise<PersonalKnowledgeEvidenceReadResponse> {
  if (!input.evidence_id.startsWith("raw_")) {
    throw new PersonalKnowledgeEvidenceNotFoundError();
  }
  return readRawEvidence(
    agentWorkspaceRoot(dataRoot, input.agent_id),
    input,
    options.outputBudgetChars ?? knowledgeOutputBudget(undefined),
    options.rawSourceProvider,
  );
}

function rawDirectory(chunks: SourceChunk[]) {
  return chunks.slice(0, MAX_DIRECTORY_ITEMS).map((chunk) => ({
    id: chunk.id,
    level: 2,
    title: chunk.heading.slice(0, 512),
  }));
}

async function readRawEvidence(
  workspaceRoot: string,
  input: PersonalKnowledgeEvidenceReadRequest,
  budget: number,
  rawSourceProvider?: ChunkSearchProvider,
): Promise<PersonalKnowledgeEvidenceReadResponse> {
  const { sources } = await resolveSearchRawSources(
    workspaceRoot,
    input,
    [
      {
        sourceId: /^raw_([a-f0-9]{16})_/u.exec(input.evidence_id)?.[1] ?? "",
        anchorPath: "",
      },
    ],
    rawSourceProvider,
  );
  const matches = sources.filter(
    (entry) => rawEvidenceId(entry) === input.evidence_id,
  );
  // An ambiguous short ID never selects one of several sources.
  const source = matches.length === 1 ? matches[0] : undefined;
  const text = source
    ? await rawSourceProvider?.readRawSource?.(input, source)
    : undefined;
  if (!source || text === undefined)
    throw new PersonalKnowledgeEvidenceNotFoundError();
  const chunks = chunkSource(text);
  const pages = input.section_requests.flatMap((request) => {
    const chunk = chunks.find((entry) => entry.id === request.section_id);
    const offset = request.offset ?? 0;
    return chunk && offset <= chunk.content.length ? [{ chunk, offset }] : [];
  });
  const missingSections = input.section_requests
    .filter(
      (request) => !pages.some(({ chunk }) => chunk.id === request.section_id),
    )
    .map((request) => request.section_id);
  const response: PersonalKnowledgeEvidenceReadResponse = {
    schemaVersion: 1,
    evidenceId: input.evidence_id,
    title: source.title,
    source: {
      kind: rawSourceOriginKind(source),
      ref: rawEvidenceId(source),
      label: source.title,
    },
    timeHint: source.date,
    directory: rawDirectory(chunks),
    sections: [],
    missingSections,
    complete: false,
  };
  // Sections share what the rest of the response leaves in request order; a
  // section's unused share carries over to the ones after it.
  let remaining = budget - outputChars(response);
  pages.forEach(({ chunk, offset }, index) => {
    const share = Math.max(
      Math.floor(remaining / (pages.length - index)),
      MIN_SECTION_PAGE_CHARS,
    );
    const section = (length: number) => {
      const content = chunk.content.slice(offset, offset + length);
      const truncated = offset + content.length < chunk.content.length;
      return {
        id: chunk.id,
        title: chunk.heading.slice(0, 512),
        level: 2,
        offset,
        content,
        truncated,
        ...(truncated ? { nextOffset: offset + content.length } : {}),
      };
    };
    let length = fittingPrefix(
      chunk.content.length - offset,
      (count) => outputChars(section(count)) + 1,
      share,
    );
    // A page never ends inside a surrogate pair, and never ends empty while
    // text remains.
    if (isHighSurrogate(chunk.content.charCodeAt(offset + length - 1)))
      length -= 1;
    if (length === 0 && offset < chunk.content.length)
      length = isHighSurrogate(chunk.content.charCodeAt(offset)) ? 2 : 1;
    const page = section(length);
    response.sections.push(page);
    remaining -= outputChars(page) + 1;
  });
  response.complete =
    missingSections.length === 0 &&
    response.sections.every((section) => !section.truncated);
  return response;
}

function outputChars(value: unknown): number {
  return JSON.stringify(value).length;
}

/** The largest count in [0, total] whose measured size stays within budget. */
function fittingPrefix(
  total: number,
  measure: (count: number) => number,
  budget: number,
): number {
  let [low, high] = [0, total];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(middle) <= budget) low = middle;
    else high = middle - 1;
  }
  return low;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
