// Messages shows plain text, so Markdown replies lose their markers but keep
// their words, links and code.

export const IMESSAGE_CHUNK_MAX = 3000;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+\s*)?$/;
const BULLET = /^(\s*)[*+-]\s+/;
const QUOTE = /^\s{0,3}>\s?/;
// Sentence ends, including the ideographic full stop and fullwidth marks.
const SENTENCE_END = /[.!?\u3002\uff01\uff1f]\s/g;
const LINK = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, "$1");
}

function inline(line: string): string {
  // Inline code keeps its content verbatim; only the text around it loses
  // emphasis markers.
  return line
    .split(/(`+)([^`]+?)\1/)
    .map((part, index) => {
      if (index % 3 === 1) return "";
      if (index % 3 === 2) return part;
      return stripEmphasis(
        part.replace(LINK, (_match, label: string, url: string) =>
          !label || label === url ? url : `${label} (${url})`,
        ),
      );
    })
    .join("");
}

export function imessagePlainText(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const opener = FENCE.exec(line)?.[1];
    if (fence) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length)
        fence = undefined;
      else out.push(line);
      continue;
    }
    if (opener) {
      fence = opener;
      continue;
    }
    const heading = HEADING.exec(line);
    let text = heading ? heading[1]! : line.replace(QUOTE, "");
    text = text.replace(BULLET, "$1- ");
    out.push(inline(text));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The last grapheme boundary at or before `max`, so no surrogate pair or
// emoji sequence is cut.
function graphemeCut(text: string, max: number): number {
  let cut = 0;
  for (const { index } of segmenter.segment(text.slice(0, max + 1))) {
    if (index > max) break;
    cut = index;
  }
  return cut > 0 ? cut : max;
}

function boundary(window: string): number {
  const half = Math.floor(window.length / 2);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= half) return paragraph;
  const line = window.lastIndexOf("\n");
  if (line >= half) return line;
  let sentence = -1;
  for (const match of window.matchAll(SENTENCE_END)) sentence = match.index;
  if (sentence >= half) return sentence + 1;
  const space = window.lastIndexOf(" ");
  if (space >= half) return space;
  return -1;
}

// Splits plain text into chunks of at most `max` UTF-16 units, preferring
// paragraph, then line, then sentence, then word boundaries.
export function imessageChunks(
  text: string,
  max: number = IMESSAGE_CHUNK_MAX,
): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = boundary(rest.slice(0, max));
    if (cut <= 0) cut = graphemeCut(rest, max);
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function imessageText(
  markdown: string,
  max: number = IMESSAGE_CHUNK_MAX,
): string[] {
  return imessageChunks(imessagePlainText(markdown), max);
}
