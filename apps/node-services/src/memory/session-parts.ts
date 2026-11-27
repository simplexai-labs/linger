// Sessions one model call reads; a larger day is read in parts.
interface SessionText {
  path: string;
  content: string;
}

/** Session text one model call reads; larger days are read in parts. */
export const MAX_PART_CHARS = 100_000;

/** Groups Sessions into parts of at most MAX_PART_CHARS, splitting a larger
 * Session at line breaks; every piece keeps its Session path. */
export function sessionParts<T extends SessionText>(
  sessions: readonly T[],
): SessionText[][] {
  const pieces = sessions.flatMap((session) => {
    if (session.content.length <= MAX_PART_CHARS) return [session];
    const split: SessionText[] = [];
    let text = "";
    for (const line of session.content.split(/(?<=\n)/u)) {
      if (text && text.length + line.length > MAX_PART_CHARS) {
        split.push({ path: session.path, content: text });
        text = "";
      }
      // A single overlong line is cut so no piece exceeds the limit.
      for (let start = 0; start < line.length; ) {
        let end = Math.min(start + MAX_PART_CHARS, line.length);
        if (
          end < line.length &&
          line.charCodeAt(end - 1) >= 0xd800 &&
          line.charCodeAt(end - 1) <= 0xdbff &&
          line.charCodeAt(end) >= 0xdc00 &&
          line.charCodeAt(end) <= 0xdfff
        ) {
          end -= 1;
        }
        const slice = line.slice(start, end);
        if (text.length + slice.length > MAX_PART_CHARS) {
          split.push({ path: session.path, content: text });
          text = "";
        }
        text += slice;
        start = end;
      }
    }
    if (text) split.push({ path: session.path, content: text });
    return split;
  });
  const parts: SessionText[][] = [];
  let size = 0;
  for (const piece of pieces) {
    const last = parts.at(-1);
    if (last && size + piece.content.length <= MAX_PART_CHARS) {
      last.push(piece);
      size += piece.content.length;
    } else {
      parts.push([piece]);
      size = piece.content.length;
    }
  }
  return parts;
}
