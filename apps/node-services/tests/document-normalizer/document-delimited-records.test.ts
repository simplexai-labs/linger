import { expect, it } from "vitest";
import { normalizeDocumentContent } from "../../src/document-normalizer/document-normalizer-core.js";

for (const [extension, separator] of [
  ["csv", ","],
  ["tsv", "\t"],
] as const) {
  it.each(["\r", "\r\n", "\n"])(
    `preserves ${extension} records delimited by %j`,
    async (newline) => {
      const text =
        [
          ["Name", "Count"],
          ["Ada", "2"],
          ["Grace", "3"],
        ]
          .map((row) => row.join(separator))
          .join(newline) + newline;
      const result = await normalizeDocumentContent({
        filename: `records.${extension}`,
        mediaType: "application/octet-stream",
        source: Buffer.from(text),
      });
      expect(Buffer.from(result).toString()).toBe(
        "| Name | Count |\n| --- | --- |\n| Ada | 2 |\n| Grace | 3 |\n",
      );
    },
  );
  it(`keeps quoted carriage returns inside ${extension} cells`, async () => {
    const text = `Name${separator}Notes\rAda${separator}"first\rsecond\r\nthird"\rGrace${separator}done\r`;
    const result = await normalizeDocumentContent({
      filename: `records.${extension}`,
      mediaType: "application/octet-stream",
      source: Buffer.from(text),
    });
    expect(Buffer.from(result).toString()).toBe(
      "| Name | Notes |\n| --- | --- |\n| Ada | first second third |\n| Grace | done |\n",
    );
  });
}
