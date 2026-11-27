// Wiki pages and meeting summaries are generated knowledge Markdown: a
// metadata block for the generator (YAML or JSON between `---` lines) ahead
// of the page, a Sources section and `[R1]` citation labels. Readers see none
// of it, as on the web (apps/web/src/components/read-only-markdown-presentation.ts);
// the stored Markdown never changes. "Sources", "Evidence" and "generated" are
// the fixed markers the generators write (@linger/knowledge-format/sections).

export interface KnowledgePage {
  /** The page title from its metadata, when it names one. */
  readonly title?: string;
  readonly body: string;
}

const SOURCES_HEADING = "Sources";
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u;
const GENERATED_LINE = /^\s{0,3}(?:#{1,6}\s+)?generated\s*:/iu;
const EVIDENCE_ONLY =
  /^\s*(?:[-*+]\s+)?Evidence: \\?\[R\d+\\?\](?:[\s,;]*\\?\[R\d+\\?\])*\s*\.?\s*$/u;
/** `[R1]`, `[R1, R3]`, `\[R2\]` and `(R2)`, with the space before them. */
const CITATION =
  /[ \t]*(?:\\?\[R\d+(?:\s*[,;\u2013-]\s*R?\d+)*\\?\](?![(:])|\(R\d+(?:\s*[,;\u2013-]\s*R?\d+)*\))/gu;
/** Keys only generator metadata carries; a page that opens with other JSON keeps it. */
const METADATA_KEYS = new Set([
  "okf_version",
  "type",
  "title",
  "description",
  "tags",
  "generated",
  "schema_version",
  "id",
  "summary",
  "sources",
  "resource",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function metadataJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) &&
      Object.keys(value).some((key) => METADATA_KEYS.has(key))
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function yamlTitle(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /^title:\s*(.+?)\s*$/u.exec(line);
    if (match?.[1]) return match[1].replace(/^(["'])(.*)\1$/u, "$2").trim();
  }
  return undefined;
}

/** Splits off a leading metadata block: YAML or JSON front matter, or a bare JSON object. */
function splitMetadata(lines: string[]): {
  title?: string;
  rest: string[];
} {
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start < 0) return { rest: lines };
  const first = lines[start]!.trim();
  if (first === "---") {
    for (let end = start + 1; end < lines.length; end += 1) {
      if (!/^(?:---|\.\.\.)\s*$/u.test(lines[end]!.trim())) continue;
      const block = lines.slice(start + 1, end);
      const json = metadataJson(block.join("\n"));
      const title = json ? json.title : yamlTitle(block);
      return {
        title:
          typeof title === "string" && title.trim() ? title.trim() : undefined,
        rest: lines.slice(end + 1),
      };
    }
    return { rest: lines };
  }
  if (!first.startsWith("{")) return { rest: lines };
  // A bare JSON object: the shortest prefix that parses, then its closing rule.
  for (let end = start; end < Math.min(lines.length, start + 400); end += 1) {
    const json = metadataJson(lines.slice(start, end + 1).join("\n"));
    if (!json) continue;
    let next = end + 1;
    while (next < lines.length && lines[next]!.trim() === "") next += 1;
    if (/^(?:---|\.\.\.)\s*$/u.test(lines[next]?.trim() ?? "")) end = next;
    return {
      title:
        typeof json.title === "string" && json.title.trim()
          ? json.title.trim()
          : undefined,
      rest: lines.slice(end + 1),
    };
  }
  return { rest: lines };
}

/** Drops the Sources section, generator lines and citation labels outside code. */
function readerLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let fence: string | undefined;
  let hiddenLevel: number | undefined;
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (fence || marker) {
      if (!fence) fence = marker;
      else if (marker && marker[0] === fence[0] && line.trim() === marker)
        fence = undefined;
      if (hiddenLevel === undefined) kept.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (hiddenLevel !== undefined && level <= hiddenLevel)
        hiddenLevel = undefined;
      if (hiddenLevel === undefined && heading[2]!.trim() === SOURCES_HEADING) {
        hiddenLevel = level;
        continue;
      }
    }
    if (hiddenLevel !== undefined) continue;
    if (GENERATED_LINE.test(line) || EVIDENCE_ONLY.test(line)) continue;
    kept.push(
      line
        .split(/(`[^`]*`)/u)
        .map((part, index) =>
          index % 2 === 1 ? part : part.replace(CITATION, ""),
        )
        .join(""),
    );
  }
  return kept;
}

export function readKnowledgeMarkdown(markdown: string): KnowledgePage {
  const lines = markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const { title, rest } = splitMetadata(lines);
  const body = readerLines(rest)
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return title ? { title, body } : { body };
}

/** Removes the first line when it is an H1, which repeats a title shown above. */
export function withoutLeadingHeading(markdown: string): string {
  return markdown.replace(/^\s*# [^\n]*(?:\n+|$)/u, "");
}
