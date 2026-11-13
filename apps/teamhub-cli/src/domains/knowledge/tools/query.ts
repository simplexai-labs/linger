import { PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN } from "@linger/wire-contracts/node-services-internal/client";
import { z } from "zod";

export const personalKnowledgeQueryInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(10_000)
      .refine((value) => value.trim() !== "", "Query must not be blank.")
      .describe(
        "The distinctive phrase, entity, or term being asked about, keeping the current request's named project, person, or event. Do not add unrelated topics from earlier turns. When the question names a time, such as last weekend, in 2023, or last month, keep those words in the query and put the resolved dates in the matching time parameter; leave every time parameter unset when the question names no time, even when the request carries a date.",
      ),
    alternates: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("One synonym, translation or related term."),
      )
      .max(6)
      .optional()
      .describe(
        "Up to six synonyms, translations (Chinese and English) or related terms the evidence may use instead of the query's words. Each is searched separately beside the query; always pass some when the query is a single wording.",
      ),
    dateFrom: z.iso
      .date()
      .optional()
      .describe(
        "Optional start of the period the asked records were made in: mail received, messages sent or a meeting held then, such as 2026-01-01 for mail received in January. It ranks sources and facts recorded in that period higher and never excludes other dates.",
      ),
    dateTo: z.iso
      .date()
      .optional()
      .describe(
        "Optional end of the period the asked records were made in; pair with dateFrom. It only ranks results and never excludes other dates.",
      ),
    eventFrom: z.iso
      .date()
      .optional()
      .describe(
        "Inclusive start of when the asked event happened, whenever it was recorded, such as 2026-04-01 for what the Human did last month. It ranks facts and sources from that period higher and never excludes others. Leave unset when the question does not ask about a time.",
      ),
    eventTo: z.iso
      .date()
      .optional()
      .describe(
        "Inclusive end of when the asked event happened; pair with eventFrom. Never a source-date filter.",
      ),
    asOf: z.iso
      .date()
      .optional()
      .describe(
        "The day a changing value or state is asked for: today for the current or latest one, or a past day such as the end of the month two months ago for what it was then. Its latest mentions on or before that day rank higher; later ones remain, so compare dates. Not for what happened in a period (eventFrom) or the earliest mention.",
      ),
    scope: z
      .enum(["summaries", "originals"])
      .optional()
      .describe(
        "Return only one list with the whole result size: summaries (Wiki pages and Daily/Weekly reports) or originals (conversations, recordings, mail, documents, notes, the Profile). Omit to get both lists.",
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe(
        "Result page of the same search; a result with nextPage has more entries on that page.",
      ),
  })
  .strict()
  .refine(
    ({ dateFrom, dateTo }) =>
      dateFrom === undefined || dateTo === undefined || dateFrom <= dateTo,
    { message: "dateFrom must not be after dateTo.", path: ["dateTo"] },
  )
  .refine(
    ({ eventFrom, eventTo }) =>
      eventFrom === undefined || eventTo === undefined || eventFrom <= eventTo,
    { message: "eventFrom must not be after eventTo.", path: ["eventTo"] },
  )
  .describe(
    "Question for one search over every source of the Human's knowledge: Sessions, recordings, My pages, mail, Pocket Notes, the Profile, the published Wiki and Daily and Weekly reports, returned as two separately ranked lists.",
  );

export const evidenceSourceSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Where the source came from: room, recording, my_pages, mail, pocket_note, profile, wiki or period_summary.",
      ),
    ref: z
      .string()
      .min(1)
      .max(1_024)
      .describe("Opaque source reference; not a user-facing label."),
    label: z.string().min(1).max(512).optional().describe("Source label."),
  })
  .strict()
  .describe("Origin of one personal knowledge evidence item.");

export const evidenceIdSchema = z
  .string()
  .regex(PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN)
  .describe(
    "Opaque raw_... candidate ID; pass it unchanged to teamhub knowledge read.",
  );

export const evidenceSectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*$/u)
  .describe("Stable section identifier within one evidence item.");

export const evidenceDirectoryEntrySchema = z
  .object({
    id: evidenceSectionIdSchema,
    title: z.string().min(1).max(512).describe("Markdown section title."),
    level: z.number().int().min(1).max(6).describe("Markdown heading level."),
    purpose: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("Directory guidance, never evidence content."),
  })
  .strict()
  .describe("One available Markdown section for follow-up evidence reading.");

export const sessionFactSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(1000)
      .describe("The fact: what | When: ... | Involving: ... | why."),
    factType: z
      .enum(["world", "assistant"])
      .describe(
        "assistant marks what the agent did or suggested, not the Human.",
      ),
    entities: z
      .array(z.string().min(1).max(80).describe("Entity name."))
      .max(10)
      .optional()
      .describe("People, places and things the fact names."),
    occurredStart: z.iso.date().optional().describe("When the event began."),
    occurredEnd: z.iso.date().optional().describe("When the event ended."),
    mentionedAt: z
      .string()
      .min(1)
      .max(64)
      .describe("When the source message said it."),
    evidenceId: evidenceIdSchema,
    sectionId: evidenceSectionIdSchema.describe(
      "Source section stating the fact; read it with evidenceId for the original wording.",
    ),
  })
  .strict()
  .describe(
    "A fact extracted from a conversation, recording, Pocket Note or email, located in one source section.",
  );

const SOURCE_KINDS = [
  "room",
  "recording",
  "mail",
  "my_pages",
  "pocket_note",
  "profile",
  "wiki",
  "period_summary",
] as const;

const searchEntrySchema = z
  .object({
    citeAs: z
      .string()
      .regex(/^[SW][1-9][0-9]*$/u)
      .describe("Citation label: S<n> for items, W<n> for summaries."),
    evidenceId: evidenceIdSchema,
    kind: z.enum(SOURCE_KINDS).describe("Where the source came from."),
    title: z.string().min(1).max(512).describe("Source title."),
    timeHint: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Date of the source when available."),
    content: z
      .string()
      .max(3000)
      .optional()
      .describe(
        "Text around the entry's best match, for the top entries of a list. It is a window, not the whole source; read its sections for more.",
      ),
    snippet: z
      .string()
      .max(400)
      .optional()
      .describe(
        "A short window around the best match, for entries without content.",
      ),
    sections: z
      .array(
        z
          .object({
            sectionId: evidenceSectionIdSchema,
            title: z.string().max(512).describe("Section heading."),
          })
          .strict()
          .describe("One matched or neighboring section to read."),
      )
      .max(4)
      .describe("Sections to read next with teamhub knowledge read."),
    roomId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("The Room a room entry's conversation belongs to."),
  })
  .strict()
  .describe("One source in a result list.");

const evidenceGapSchema = z
  .object({
    code: z.string().min(1).max(64).describe("Extensible stable gap code."),
    detail: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("Optional safe detail about the evidence gap."),
  })
  .strict()
  .describe("One reason the retrieved evidence does not cover the query.");

export const personalKnowledgeQueryOutputSchema = z
  .object({
    schemaVersion: z.literal(2).describe("Evidence contract version."),
    status: z
      .enum(["grounded", "partial", "empty"])
      .describe(
        "grounded has entries and no gaps, partial has entries and a gap, empty has no entries.",
      ),
    items: z
      .array(searchEntrySchema)
      .max(20)
      .describe(
        "Original sources (conversations, recordings, mail, documents, notes, the Profile), ranked; cite them for exact claims.",
      ),
    summaries: z
      .array(searchEntrySchema)
      .max(10)
      .describe(
        "Derived Wiki pages and Daily/Weekly reports, ranked separately; good for overviews, not for exact wording.",
      ),
    gaps: z
      .array(evidenceGapSchema)
      .max(20)
      .describe(
        "results_trimmed means more entries exist: use nextPage, --scope or a read.",
      ),
    indexedAt: z
      .union([
        z
          .string()
          .datetime({ offset: true })
          .describe("Newest shown source date."),
        z.null().describe("No source is shown."),
      ])
      .describe("Date of the newest shown source, when available."),
    facts: z
      .array(sessionFactSchema)
      .max(30)
      .optional()
      .describe(
        "Matched Session facts, ranked apart from the lists. They pinpoint details and event times; read the named source section when the answer depends on exact wording.",
      ),
    scope: z
      .enum(["summaries", "originals"])
      .optional()
      .describe("The one list this search returned."),
    page: z.number().int().min(1).max(10).describe("This result page."),
    nextPage: z
      .number()
      .int()
      .min(2)
      .max(11)
      .optional()
      .describe("Pass as page to see more entries of the same search."),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Optional query trace identifier."),
  })
  .strict()
  .describe(
    "Two ranked lists of sources plus facts; read the sections an answer depends on.",
  );
export const queryPersonalKnowledgeSchema = {
  input: personalKnowledgeQueryInputSchema,
  output: personalKnowledgeQueryOutputSchema,
};
