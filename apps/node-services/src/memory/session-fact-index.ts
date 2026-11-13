import { createHash } from "node:crypto";
import type { PersonalKnowledgeQueryResponse } from "@linger/wire-contracts/node-services-internal/client";
import type postgres from "postgres";
import { tokenizeSearchText } from "../bm25.js";
import { chunkSource, type SourceChunk } from "./search/chunks.js";
import { RRF_K } from "./search/rrf.js";
import {
  AS_OF_WEIGHT,
  selectLatestOnOrBefore,
  selectWithTemporalCoverage,
  TEMPORAL_POOL_SIZE,
  windowBounds,
} from "./search/temporal-window.js";
import type { ChunkSearchInput } from "./chunk-index.js";
import { RAW_EVIDENCE_PREFIX_LENGTH } from "./search/source-store.js";
import {
  extractWindowBatch,
  FACT_BATCH_WINDOWS,
  factWindows,
  type ExtractedFact,
  type FactBatchWindow,
  type FactWindow,
} from "./session-fact-extraction.js";
import { isComputerOffline } from "../runtime-model-call.js";
import { memoryDatabase } from "./database.js";
import { localDateWindow } from "./date.js";
import { memoryLogger } from "./run-telemetry.js";
import { sha256Hex } from "@linger/service-kit/node";

/** Facts each recall branch contributes before fusion. Hindsight reads up to
 * 1,000 per arm at its high budget; facts are short, so 100 stays cheap. */
const FACT_CANDIDATES = 100;
/** Facts returned beside, never instead of, the Raw chunk candidates; the
 * knowledge search keeps as many as fit its fact share of the output budget. */
const FACT_RESULTS = 30;
/** Extraction chains one sync keeps on its endpoint's queue at once; the
 * queue decides how many of them run. */
const DEFAULT_EXTRACTION_CONCURRENCY = 2;
/** Raw origins facts are extracted from. My pages, the Wiki, period reports
 * and the Profile keep Raw chunk recall only: documents are read on demand and
 * the others are derived or already structured. */
const FACT_ORIGINS = ["room", "recording", "pocket_note", "mail"];
/** Mail classes extracted on their own; a thread the Human replied to is
 * extracted whole, whatever its classes. Marketing, subscriptions and drafts
 * stay chunk-only. */
const FACT_MAIL_CLASSES = [
  "self_sent",
  "direct_inbound",
  "system_notification",
];
/** The header lines TeamHub writes into imported mail Markdown. */
const MAIL_CLASS_LINE = "\n- Class: ([a-z_]+)\n";
const MAIL_THREAD_LINE = "\n- Thread ID: `([^`\n]+)`\n";
const MESSAGE_HEADING = /^## (\d{4}-\d{2}-\d{2}T\S+) · (.+)$/gmu;

/** The contract's model-visible Session fact with its Raw read handle. */
export type SessionFactHit = NonNullable<
  PersonalKnowledgeQueryResponse["facts"]
>[number];

export interface FactSyncResult {
  sources: number;
  windows: number;
  extracted: number;
  facts: number;
  failed: number;
}

export interface FactSearchInput extends ChunkSearchInput {
  /** When the asked event happened: a window that votes, never a filter. */
  event_from?: string;
  event_to?: string;
  /** The day a changing value is asked for: its latest mention on or before it votes. */
  as_of?: string;
}

/** One Raw source facts are extracted from, at its active version. */
interface FactSource {
  id: string;
  tenant_id: string;
  owner_id: string;
  agent_id: string;
  active_sha256: string;
  content: string;
  date: string | null;
  origin_kind: string;
  mail_class: string | null;
  replied: boolean;
}

interface PendingWindow {
  readonly source: FactSource;
  readonly item: FactBatchWindow;
}

const present = (value: string | undefined) =>
  value && !/^n\/?a$/iu.test(value.trim()) ? value.trim() : undefined;

/**
 * Hindsight's stored fact text (engine/retain/fact_extraction.py, MIT,
 * Copyright (c) 2025 Vectorize AI, Inc.): what | When: … | Involving: … | why.
 */
export function sessionFactText(
  fact: Pick<ExtractedFact, "what"> & Partial<ExtractedFact>,
): string {
  const when = present(fact.when);
  const who = present(fact.who);
  const why = present(fact.why);
  return [
    fact.what.trim(),
    ...(when ? [`When: ${when}`] : []),
    ...(who ? [`Involving: ${who}`] : []),
    ...(why ? [why] : []),
  ]
    .join(" | ")
    .slice(0, 1000);
}

/**
 * The window chunk that states a fact: the one sharing the most terms with
 * the fact text and entities. Hindsight binds a fact to its chunk the same way
 * it extracts it; a window holds a few consecutive Raw chunks.
 */
export function factChunk(
  fact: Pick<ExtractedFact, "what" | "entities">,
  chunks: readonly SourceChunk[],
): SourceChunk {
  const terms = new Set(
    tokenizeSearchText([fact.what, ...fact.entities].join(" ")),
  );
  let best = chunks[0]!;
  let bestScore = -1;
  for (const chunk of chunks) {
    const score = new Set(
      tokenizeSearchText(chunk.content).filter((term) => terms.has(term)),
    ).size;
    if (score > bestScore) {
      best = chunk;
      bestScore = score;
    }
  }
  return best;
}

/** The Room message heading (`## <ISO time> · <author>`) that contains an offset. */
export function messageAt(
  content: string,
  offset: number,
): { mentionedAt: string; speaker: string } | undefined {
  let found: { mentionedAt: string; speaker: string } | undefined;
  for (const match of content.matchAll(MESSAGE_HEADING)) {
    if (match.index > offset) break;
    if (Number.isFinite(Date.parse(match[1]!)))
      found = { mentionedAt: match[1]!, speaker: match[2]!.trim() };
  }
  return found;
}

/**
 * Extracts Session facts from conversation, transcript, Pocket Note and mail
 * Raw sources, independent of Wiki generation, and serves the fact recall
 * branches. Facts belong to a window of
 * the active Raw version; an unchanged window keeps its facts across versions.
 */
export class SessionFactIndex {
  readonly #sql: postgres.Sql;
  readonly #extract: typeof extractWindowBatch;
  readonly #concurrency: number;
  // One sync per Agent at a time, so repeated triggers never extract twice.
  readonly #agents = new Map<string, Promise<unknown>>();

  constructor(options: {
    /** Memory's shared pool; the role ends it, not the index. */
    sql: postgres.Sql;
    extract?: typeof extractWindowBatch;
    /** Extraction calls in flight per sync. */
    concurrency?: number;
  }) {
    this.#extract = options.extract ?? extractWindowBatch;
    this.#concurrency = options.concurrency ?? DEFAULT_EXTRACTION_CONCURRENCY;
    this.#sql = options.sql;
  }

  /** Extract new windows of an Agent's fact sources and drop changed ones. */
  syncAgent(agentId: string): Promise<FactSyncResult> {
    const run = (this.#agents.get(agentId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#syncAgent(agentId));
    this.#agents.set(agentId, run);
    return run;
  }

  async #syncAgent(agentId: string): Promise<FactSyncResult> {
    const sources = await this.#sql<FactSource[]>`
      WITH candidate AS (
        SELECT source.id, source.tenant_id, source.owner_id, source.agent_id,
          source.active_sha256, version.content,
          version.manifest->>'date' AS date, source.origin_kind,
          CASE WHEN source.origin_kind = 'mail'
            THEN substring(version.content from ${MAIL_CLASS_LINE}) END AS mail_class,
          CASE WHEN source.origin_kind = 'mail'
            THEN substring(version.content from ${MAIL_THREAD_LINE}) END AS mail_thread
        FROM memory_index.sources source
        JOIN memory_index.source_versions version
          ON version.source_id = source.id AND version.sha256 = source.active_sha256
        WHERE source.agent_id = ${agentId}
          AND source.origin_kind = ANY(${FACT_ORIGINS}::text[])
      ), replied AS (
        SELECT DISTINCT mail_thread FROM candidate
        WHERE mail_class = 'self_sent' AND mail_thread IS NOT NULL
      )
      SELECT candidate.id, candidate.tenant_id, candidate.owner_id,
        candidate.agent_id, candidate.active_sha256, candidate.content,
        candidate.date, candidate.origin_kind, candidate.mail_class,
        replied.mail_thread IS NOT NULL AS replied
      FROM candidate
      LEFT JOIN replied ON replied.mail_thread = candidate.mail_thread
      WHERE candidate.origin_kind <> 'mail'
        OR candidate.mail_class = ANY(${FACT_MAIL_CLASSES}::text[])
        OR replied.mail_thread IS NOT NULL
      ORDER BY candidate.id`;
    const result = {
      sources: sources.length,
      windows: 0,
      extracted: 0,
      facts: 0,
      failed: 0,
    };
    // One query each for the Agent's extracted windows and for sources whose
    // facts point at an older version, instead of two per source: mail makes
    // sources number in the thousands.
    const sourceIds = sources.map((source) => source.id);
    const doneBySource = new Map<string, Set<string>>();
    for (const row of await this.#sql<
      { source_id: string; window_sha256: string }[]
    >`
      SELECT source_id, window_sha256 FROM memory_index.session_fact_windows
      WHERE source_id = ANY(${sourceIds}::text[])`) {
      const done = doneBySource.get(row.source_id) ?? new Set<string>();
      done.add(row.window_sha256);
      doneBySource.set(row.source_id, done);
    }
    const outdated = new Set(
      (
        await this.#sql<{ source_id: string }[]>`
          SELECT DISTINCT fact.source_id FROM memory_index.session_facts fact
          JOIN memory_index.sources source ON source.id = fact.source_id
          WHERE fact.source_id = ANY(${sourceIds}::text[])
            AND fact.source_sha256 <> source.active_sha256`
      ).map((row) => row.source_id),
    );
    // Pending windows by owner: a batch runs on one owner's Agent Runtime.
    const pending = new Map<string, PendingWindow[]>();
    for (const source of sources) {
      const chunks = chunkSource(source.content);
      const windows = factWindows(chunks);
      result.windows += windows.length;
      const current = new Set(windows.map((window) => window.sha256));
      const done = doneBySource.get(source.id) ?? new Set<string>();
      // A changed window (new messages in the last one) is extracted again.
      const stale = [...done].filter((sha) => !current.has(sha));
      if (stale.length)
        await this.#sql.begin(async (sql) => {
          await sql`DELETE FROM memory_index.session_facts
            WHERE source_id = ${source.id} AND window_sha256 = ANY(${stale}::text[])`;
          await sql`DELETE FROM memory_index.session_fact_windows
            WHERE source_id = ${source.id} AND window_sha256 = ANY(${stale}::text[])`;
        });
      if (outdated.has(source.id)) await this.#rebind(source, chunks);
      const owner = `${source.tenant_id}\n${source.owner_id}`;
      windows.forEach((window, index) => {
        if (done.has(window.sha256)) return;
        const list = pending.get(owner) ?? [];
        list.push({
          source,
          item: {
            window,
            index,
            total: windows.length,
            eventDate: eventDate(source, window),
            context: factContext(source),
          },
        });
        pending.set(owner, list);
      });
    }
    const batches = [...pending.values()].flatMap((list) =>
      Array.from(
        { length: Math.ceil(list.length / FACT_BATCH_WINDOWS) },
        (_, index) =>
          list.slice(
            index * FACT_BATCH_WINDOWS,
            (index + 1) * FACT_BATCH_WINDOWS,
          ),
      ),
    );
    // An offline Computer fails every later batch too; they wait for the
    // next sync instead.
    let offline = false;
    const runBatch = async (batch: readonly PendingWindow[]) => {
      if (offline) {
        result.failed += batch.length;
        return;
      }
      const { tenant_id: tenantId, owner_id: ownerActorId } = batch[0]!.source;
      let extracted: Map<string, ExtractedFact[]>;
      try {
        extracted = await this.#extract(
          batch.map(({ item }) => item),
          { tenantId, ownerActorId },
        );
      } catch (error) {
        // Not recorded as done, so the next sync retries the windows.
        result.failed += batch.length;
        offline ||= isComputerOffline(error);
        memoryLogger().log("error", "memory.session_fact_extraction_failed", {
          error,
          windows: batch.length,
        });
        return;
      }
      for (const { source, item } of batch) {
        const facts = extracted.get(item.window.sha256);
        if (!facts) {
          result.failed += 1;
          continue;
        }
        await this.#store(source, item.window, facts);
        result.extracted += 1;
        result.facts += facts.length;
      }
    };
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(this.#concurrency, batches.length) },
        async () => {
          while (next < batches.length) await runBatch(batches[next++]!);
        },
      ),
    );
    return result;
  }

  /** Point kept facts at the active Raw version's chunk with the same content. */
  async #rebind(
    source: { id: string; active_sha256: string },
    chunks: readonly SourceChunk[],
  ): Promise<void> {
    const rows = await this.#sql<{ id: string; chunk_sha256: string }[]>`
      SELECT id, chunk_sha256 FROM memory_index.session_facts
      WHERE source_id = ${source.id} AND source_sha256 <> ${source.active_sha256}`;
    if (!rows.length) return;
    const byContent = new Map(
      chunks.map((chunk) => [sha256Hex(chunk.content), chunk.id]),
    );
    for (const row of rows) {
      const chunkId = byContent.get(row.chunk_sha256);
      if (chunkId)
        await this.#sql`UPDATE memory_index.session_facts
          SET source_sha256 = ${source.active_sha256}, chunk_id = ${chunkId}
          WHERE id = ${row.id}`;
      else
        await this
          .#sql`DELETE FROM memory_index.session_facts WHERE id = ${row.id}`;
    }
  }

  async #store(
    source: FactSource,
    window: FactWindow,
    facts: readonly ExtractedFact[],
  ): Promise<void> {
    const texts = facts.map((fact) => sessionFactText(fact));
    const lexical = (value: string) => tokenizeSearchText(value).join(" ");
    await this.#sql.begin(async (sql) => {
      for (const [ordinal, fact] of facts.entries()) {
        const chunk = factChunk(fact, window.chunks);
        const message = roomMessageAt(source, chunk.start);
        const id = `msf_${createHash("sha256")
          .update(`${source.id}:${window.sha256}:${ordinal}`)
          .digest("hex")
          .slice(0, 32)}`;
        await sql`
          INSERT INTO memory_index.session_facts(
            id, tenant_id, owner_id, agent_id, source_id, source_sha256,
            window_sha256, chunk_id, chunk_sha256, ordinal, text, speaker,
            fact_type, occurred_start, occurred_end, mentioned_at, entities,
            search_tsv
          ) VALUES(
            ${id}, ${source.tenant_id}, ${source.owner_id}, ${source.agent_id},
            ${source.id}, ${source.active_sha256}, ${window.sha256}, ${chunk.id},
            ${sha256Hex(chunk.content)}, ${ordinal}, ${texts[ordinal]!},
            ${message?.speaker ?? null}, ${fact.fact_type},
            ${fact.occurred_start ?? null}, ${fact.occurred_end ?? null},
            ${message?.mentionedAt ?? `${source.date ?? "1970-01-01"}T00:00:00Z`},
            ${fact.entities},
            setweight(to_tsvector('simple', ${lexical(texts[ordinal]!)}), 'A') ||
              setweight(to_tsvector('simple', ${lexical(fact.entities.join(" "))}), 'B')
          )`;
      }
      await sql`
        INSERT INTO memory_index.session_fact_windows(
          tenant_id, owner_id, agent_id, source_id, window_sha256, fact_count
        ) VALUES(
          ${source.tenant_id}, ${source.owner_id}, ${source.agent_id},
          ${source.id}, ${window.sha256}, ${facts.length}
        )`;
    });
  }

  /**
   * Keyword matches, with more votes for facts whose event falls in the event
   * window, facts recorded in the recorded window, and the latest facts on or
   * before as_of. No window excludes a fact.
   */
  async search(
    input: FactSearchInput,
    tokens: readonly string[],
  ): Promise<SessionFactHit[]> {
    if (!tokens.length) return [];
    const sourceIds = input.sourceIds
      ? [...new Set(input.sourceIds)]
      : undefined;
    const query = tokens.join(" | ");
    const event = { from: input.event_from, to: input.event_to };
    const recorded = { from: input.date_from, to: input.date_to };
    const eventBounds = windowBounds(event);
    const recordedBounds = windowBounds(recorded);
    const branch = (order: "lexical" | "event" | "recorded" | "as_of") =>
      this.#sql<FactRow[]>`
        SELECT fact.id AS fact_id, chunk.id AS chunk_id,
          source.document_id, fact.source_sha256,
          ts_rank_cd(fact.search_tsv, to_tsquery('simple', ${query}))::float8 AS score,
          fact.text, fact.fact_type, fact.occurred_start::text,
          fact.occurred_end::text, fact.mentioned_at, fact.entities,
          version.manifest->>'date' AS source_date
        FROM memory_index.session_facts fact
        JOIN memory_index.sources source
          ON source.id = fact.source_id AND source.active_sha256 = fact.source_sha256
        JOIN memory_index.source_versions version
          ON version.source_id = source.id AND version.sha256 = source.active_sha256
        JOIN memory_index.chunks chunk
          ON chunk.source_id = fact.source_id AND chunk.id = fact.chunk_id
            AND chunk.source_sha256 = fact.source_sha256
        WHERE fact.tenant_id = ${input.tenant_id}
          AND fact.owner_id = ${input.user_artifact_owner_actor_id}
          AND fact.agent_id = ${input.agent_id}
          AND (${sourceIds === undefined} OR source.document_id = ANY(${sourceIds ?? []}::text[]))
          AND fact.search_tsv @@ to_tsquery('simple', ${query})
          ${
            order === "event"
              ? // Hindsight's window match: event overlap, or an event edge or the mention inside it.
                this
                  .#sql`AND ((fact.occurred_start <= ${eventBounds.to}::date AND fact.occurred_end >= ${eventBounds.from}::date)
                  OR version.manifest->>'date' BETWEEN ${eventBounds.from} AND ${eventBounds.to})`
              : order === "recorded"
                ? // Recorded on its source's day, the Human's local date.
                  this
                    .#sql`AND version.manifest->>'date' BETWEEN ${recordedBounds.from} AND ${recordedBounds.to}`
                : order === "as_of"
                  ? this
                      .#sql`AND version.manifest->>'date' <= ${input.as_of ?? null}`
                  : this.#sql``
          }
        ORDER BY score DESC, fact.id
        LIMIT ${order === "lexical" ? FACT_CANDIDATES : TEMPORAL_POOL_SIZE}`;
    const none = Promise.resolve<FactRow[]>([]);
    const [lexical, inEvent, inRecorded, onOrBefore] = await Promise.all([
      branch("lexical"),
      event.from || event.to ? branch("event") : none,
      recorded.from || recorded.to ? branch("recorded") : none,
      input.as_of ? branch("as_of") : none,
    ]);
    // A fact is mentioned on its source's local day; mentioned_at is UTC.
    const covered = selectWithTemporalCoverage(
      inEvent,
      (row) => row.occurred_start ?? row.source_date,
      event,
    );
    const recordedCovered = selectWithTemporalCoverage(
      inRecorded,
      (row) => row.source_date,
      recorded,
    );
    const latest = selectLatestOnOrBefore(onOrBefore, (row) =>
      new Date(row.mentioned_at).toISOString(),
    );
    // Rank fusion across the fact branches, then one fact per statement.
    const fused = new Map<string, { row: FactRow; score: number }>();
    for (const [rows, weight] of [
      [lexical, 1],
      [covered, 1],
      [recordedCovered, 1],
      [latest, AS_OF_WEIGHT],
    ] as const)
      for (const [index, row] of rows.entries()) {
        const current = fused.get(row.fact_id);
        const vote = weight / (RRF_K + index + 1);
        if (current) current.score += vote;
        else fused.set(row.fact_id, { row, score: vote });
      }
    const seen = new Set<string>();
    return [...fused.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.row.fact_id.localeCompare(right.row.fact_id),
      )
      .filter(({ row }) => !seen.has(row.text) && Boolean(seen.add(row.text)))
      .slice(0, FACT_RESULTS)
      .map(({ row }) => factHit(row));
  }
}

interface FactRow {
  fact_id: string;
  chunk_id: string;
  document_id: string;
  source_sha256: string;
  score: number;
  text: string;
  fact_type: "world" | "assistant";
  occurred_start: string | null;
  occurred_end: string | null;
  mentioned_at: Date;
  entities: string[];
  source_date: string;
}

function factHit(row: FactRow): SessionFactHit {
  return {
    text: row.text,
    factType: row.fact_type,
    // Stored rows predating the entity bound still meet the wire contract.
    ...(row.entities.some((entity) => entity.length <= 80)
      ? {
          entities: row.entities
            .filter((entity) => entity.length <= 80)
            .slice(0, 10),
        }
      : {}),
    ...(row.occurred_start ? { occurredStart: row.occurred_start } : {}),
    ...(row.occurred_end ? { occurredEnd: row.occurred_end } : {}),
    mentionedAt: new Date(row.mentioned_at).toISOString(),
    // Same short handle as rawEvidenceId(source) for the bound Raw version.
    evidenceId: `raw_${row.document_id.slice(0, RAW_EVIDENCE_PREFIX_LENGTH)}_${row.source_sha256.slice(0, RAW_EVIDENCE_PREFIX_LENGTH)}`,
    sectionId: row.chunk_id,
  };
}

/** Session facts need the Raw database and the Memory LLM; they are recalled
 * by keywords. */
export function createSessionFactIndexFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SessionFactIndex {
  return new SessionFactIndex({
    sql: memoryDatabase(environment),
  });
}

/**
 * The window's Context line: what kind of text it is and whose words it holds,
 * so one extraction prompt serves every origin.
 */
export function factContext(
  source: Pick<FactSource, "origin_kind" | "mail_class" | "replied" | "date">,
): string {
  const on = `on ${source.date ?? "an unknown date"}`;
  switch (source.origin_kind) {
    case "recording":
      return `Meeting recording transcript ${on}, recorded by the user. Speakers may be unlabeled and are unknown; attribute a statement, commitment or decision to the user only when the text identifies the user as its speaker.`;
    case "pocket_note":
      return `The user's own Pocket Note ${on}.`;
    case "mail":
      return source.mail_class === "system_notification" && !source.replied
        ? `Automated email ${on}, received by the user. Keep only what concerns the user: a booking, an appointment, a deadline or a changed time. A promotion, digest or plain receipt has no facts; return none.`
        : `Email ${on} in the user's mailbox. The From line names the sender; the user is the mailbox owner. Attribute each fact to the sender or to the user, never confuse them.`;
    default:
      return `Conversation session ${on}`;
  }
}

/** Message headings are trusted only in Room Raw, which escapes them in
 * bodies; mail, notes and transcripts keep their source date. */
function roomMessageAt(
  source: Pick<FactSource, "origin_kind" | "content">,
  offset: number,
) {
  return source.origin_kind === "room"
    ? messageAt(source.content, offset)
    : undefined;
}

/** Hindsight's Event Date: the first message time of the window, else the source date. */
function eventDate(
  source: Pick<FactSource, "origin_kind" | "content" | "date">,
  window: FactWindow,
): Date | undefined {
  const at = roomMessageAt(source, window.chunks[0]!.start + 1)?.mentionedAt;
  if (at) return new Date(at);
  // A source dated by its day, such as mail, starts at that day's local midnight.
  return source.date
    ? new Date(localDateWindow(source.date).startIso)
    : undefined;
}
