/**
 * Splitting text to a surface's limit without breaking what it renders.
 *
 * A limit in characters is not permission to cut at a character. A message is a
 * sequence of blocks, and a table or a fenced code block torn in half renders
 * as broken Markdown rather than as the original content. So cut between
 * blocks first, then between lines, and carry an open fence across the cut so
 * neither side is left unbalanced.
 */

/**
 * Split `text` into pieces of at most `limit` characters, preferring block
 * boundaries (a blank line), then line boundaries, then a hard cut inside one
 * over-long line.
 */
export function splitForLimit(text: string, limit: number): string[] {
  if (limit <= 0) throw new RangeError("limit must be positive");
  if (text.length <= limit) return balanceFences([text]);

  const blocks = text.split(/\n{2,}/u);
  const pieces: string[] = [];
  let current = "";

  const push = () => {
    if (current.length > 0) pieces.push(current);
    current = "";
  };
  for (const block of blocks) {
    if (block.length > limit) {
      push();
      pieces.push(...splitLines(block, limit));
      continue;
    }
    const candidate = current.length === 0 ? block : current + "\n\n" + block;
    if (candidate.length > limit) {
      push();
      current = block;
    } else {
      current = candidate;
    }
  }
  push();
  return balanceFences(pieces);
}

function splitLines(block: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const line of block.split("\n")) {
    let rest = line;
    while (rest.length > limit) {
      if (current.length > 0) {
        pieces.push(current);
        current = "";
      }
      pieces.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const candidate = current.length === 0 ? rest : current + "\n" + rest;
    if (candidate.length > limit) {
      pieces.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/**
 * Close an unterminated fence at the end of a piece and reopen it at the start
 * of the next, so each piece renders as the same code it came from.
 */
function balanceFences(pieces: string[]): string[] {
  const out: string[] = [];
  let open: string | null = null;
  for (const piece of pieces) {
    let body: string = open === null ? piece : open + "\n" + piece;
    const fences: RegExpMatchArray[] = [
      ...body.matchAll(/^```(\S*)[^\n]*$/gmu),
    ];
    if (fences.length % 2 === 1) {
      const last = fences[fences.length - 1];
      if (last !== undefined) {
        open = "```" + (last[1] ?? "");
        body += "\n```";
      }
    } else {
      open = null;
    }
    out.push(body);
  }
  return out;
}
