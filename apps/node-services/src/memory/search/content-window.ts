import { tokenizeSearchText } from "../../bm25.js";

/**
 * Bounded text around the best query match, with its enclosing Room message
 * heading (time and speaker). A chunk without a match keeps its start.
 */
export function contentWindow(
  content: string,
  terms: ReadonlySet<string>,
  maxChars: number,
): string {
  if (content.length <= maxChars) return content;
  const paragraphs = [...content.matchAll(/[^\n]+(?:\n(?!\n)[^\n]*)*/gu)].map(
    (match) => ({ text: match[0], start: match.index }),
  );
  const hits = paragraphs.map(
    ({ text }) =>
      new Set(tokenizeSearchText(text).filter((term) => terms.has(term))).size,
  );
  const best = hits.indexOf(Math.max(0, ...hits));
  if (best < 0 || hits[best] === 0) return shorten(content, maxChars);
  let heading = -1;
  for (let index = best; index >= 0; index -= 1)
    if (paragraphs[index]!.text.startsWith("## ")) {
      heading = index;
      break;
    }
  const parts: string[] = [];
  if (heading >= 0 && heading < best) {
    // A long title must not consume the space reserved for the matched evidence.
    parts.push(shorten(paragraphs[heading]!.text, Math.floor(maxChars / 3)));
    if (heading < best - 1) parts.push("…");
  }
  let index = best;
  let length = parts.join("\n\n").length;
  let lastPartTailCut = false;
  while (index < paragraphs.length && length < maxChars) {
    const remaining =
      maxChars -
      length -
      (parts.length ? 2 : 0) -
      (index < paragraphs.length - 1 ? 3 : 0);
    if (remaining <= 0) break;
    const text = paragraphs[index]!.text;
    const part =
      index === best
        ? matchingPassage(text, terms, remaining)
        : { text: shorten(text, remaining), tailCut: text.length > remaining };
    length += part.text.length + (parts.length ? 2 : 0);
    parts.push(part.text);
    lastPartTailCut = part.tailCut;
    index += 1;
    if (text.length > remaining) break;
  }
  let window = parts.join("\n\n");
  if (index < paragraphs.length && !lastPartTailCut) window += "\n\n…";
  return (heading >= 0 ? paragraphs[heading]! : paragraphs[best]!).start > 0
    ? `…\n\n${window}`
    : window;
}

interface Passage {
  text: string;
  tailCut: boolean;
}

function matchingPassage(
  text: string,
  terms: ReadonlySet<string>,
  maxChars: number,
): Passage {
  if (text.length <= maxChars) return { text, tailCut: false };
  const width = Math.max(1, maxChars - 2);
  const step = Math.max(1, Math.floor(width / 2));
  const starts = new Set<number>();
  for (let start = 0; start < text.length; start += step) {
    starts.add(start);
    if (start + width >= text.length) break;
  }
  // A fitting identifier wider than the overlap may straddle every grid
  // window. Include its source boundary without changing the query analyzer.
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)) {
    if (match[0].length > step && match[0].length <= width)
      starts.add(
        Math.max(0, match.index - Math.floor((width - match[0].length) / 2)),
      );
  }
  let best: Passage = { text: "", tailCut: false };
  let bestHits = -1;
  let bestCenterHits = -1;
  for (const start of starts) {
    const end = Math.min(text.length, start + width);
    const hits = passageHits(text, terms, start, end);
    // For equal coverage, keep the matching words away from a cut edge so
    // their surrounding evidence is more likely to fit beside them.
    const inset = Math.floor((end - start) / 4);
    const centerHits = passageHits(text, terms, start + inset, end - inset);
    if (hits > bestHits || (hits === bestHits && centerHits > bestCenterHits)) {
      best = {
        text: `${start > 0 ? "…" : ""}${sliceText(text, start, end)}${end < text.length ? "…" : ""}`,
        tailCut: end < text.length,
      };
      bestHits = hits;
      bestCenterHits = centerHits;
    }
  }
  return best;
}

function passageHits(
  text: string,
  terms: ReadonlySet<string>,
  start: number,
  end: number,
): number {
  // A cut through a word must not manufacture a query token. Check the same
  // analyzer with neighboring source characters, including Han bigrams and NFKC.
  const context = new Set(
    tokenizeSearchText(text.slice(Math.max(0, start - 2), end + 2)),
  );
  return new Set(
    tokenizeSearchText(sliceText(text, start, end)).filter(
      (term) => terms.has(term) && context.has(term),
    ),
  ).size;
}

function shorten(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${sliceText(text, 0, Math.max(0, maxChars - 1))}…`;
}

function sliceText(text: string, start: number, end: number): string {
  return text
    .slice(start, end)
    .replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/gu, "");
}
