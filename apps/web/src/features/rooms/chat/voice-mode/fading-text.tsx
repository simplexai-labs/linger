import { Fragment, useState } from "react";

interface TextPiece {
  id: number;
  text: string;
  fade: boolean;
}

/**
 * A line's words as they arrive: each newly arrived phrase shows whole and
 * fades in, while the words before it stay as they were.
 */
export function FadingText({ text }: { text: string }) {
  const [pieces, setPieces] = useState<TextPiece[]>(() => [
    { id: 0, text, fade: false },
  ]);
  const [seen, setSeen] = useState(text);
  if (text !== seen) {
    setSeen(text);
    setPieces(nextTextPieces(pieces, seen, text));
  }
  return pieces.map((piece) =>
    piece.fade ? (
      <span className="voice-live-fade-in" key={piece.id}>
        {piece.text}
      </span>
    ) : (
      <Fragment key={piece.id}>{piece.text}</Fragment>
    ),
  );
}

/**
 * Keeps the pieces the new text still starts with and adds what changed as
 * one fading piece. A transcription that revised earlier words fades in from
 * the first word it changed.
 */
function nextTextPieces(
  pieces: readonly TextPiece[],
  before: string,
  after: string,
): TextPiece[] {
  let common = 0;
  const limit = Math.min(before.length, after.length);
  while (common < limit && before[common] === after[common]) common++;
  // Never split a character made of two UTF-16 units.
  const previous = after.charCodeAt(common - 1);
  if (common > 0 && previous >= 0xd800 && previous <= 0xdbff) common--;
  const kept: TextPiece[] = [];
  let offset = 0;
  for (const piece of pieces) {
    if (offset >= common) break;
    const take = Math.min(piece.text.length, common - offset);
    kept.push(
      take === piece.text.length
        ? piece
        : { ...piece, text: piece.text.slice(0, take) },
    );
    offset += piece.text.length;
  }
  const added = after.slice(common);
  if (!added) return kept;
  const id = pieces.reduce((largest, piece) => Math.max(largest, piece.id), 0);
  return [...kept, { id: id + 1, text: added, fade: true }];
}
