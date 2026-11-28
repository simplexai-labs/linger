import { describe, expect, it } from "vitest";
import { splitForLimit } from "./text.js";

describe("splitForLimit", () => {
  it("leaves a short message alone", () => {
    // Hangul is an unspaced script, like the messages this splits in
    // production, so the block logic is exercised on realistic text.
    expect(splitForLimit("짧은 메시지", 100)).toEqual(["짧은 메시지"]);
  });

  it("cuts between blocks, never inside one", () => {
    const table = "| contract | lots |\n|---|---:|\n| cu2612 | 1 |";
    const text = [table, "설명 문단", table].join("\n\n");
    const pieces = splitForLimit(text, 40);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(40);
      // A table cut in half would lose its header row and render as garbage.
      if (piece.includes("|---|---:|"))
        expect(piece.split("\n")[0]).toContain("contract");
    }
  });

  it("keeps every character, so nothing is silently dropped", () => {
    const text = "첫 번째 단락\n\n두 번째 단락\n\n세 번째 단락";
    expect(splitForLimit(text, 12).join("\n\n")).toBe(text);
  });

  it("balances a fence across a cut, so both sides render as code", () => {
    const text = [
      "첫 번째 단락",
      "```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```",
      "세 번째 단락",
    ].join("\n\n");
    const pieces = splitForLimit(text, 30);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      const fences = piece
        .split("\n")
        .filter((line) => line.startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
  });

  it("hard-cuts a single line longer than the limit rather than failing", () => {
    const pieces = splitForLimit("x".repeat(25), 10);
    expect(pieces.map((piece) => piece.length)).toEqual([10, 10, 5]);
  });

  it("rejects a non-positive limit instead of looping", () => {
    expect(() => splitForLimit("text", 0)).toThrow(RangeError);
  });
});
