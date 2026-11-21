import { expect, it } from "vitest";
import { normalizeDocumentContent } from "../../src/document-normalizer/document-normalizer-core.js";

it.each([",", "\t"])(
  "rejects sparse tables that expand beyond the output budget (%s)",
  async (delimiter) => {
    const source = Buffer.from(
      [
        "head" + delimiter.repeat(999),
        ...Array<string>(999).fill("value"),
      ].join("\n"),
    );
    await expect(
      normalizeDocumentContent(
        {
          filename: delimiter === "," ? "data.csv" : "data.tsv",
          source,
          mediaType: "application/octet-stream",
        },
        32 * 1024,
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_MARKDOWN_TOO_LARGE" });
  },
);

it("counts canonical UTF-8 bytes, including the final newline, at an exact budget", async () => {
  const input = {
    filename: "data.csv",
    mediaType: "text/csv",
    source: Buffer.from("e\u0301,name\nx,\u{1f600}"),
  };
  const expected = "| \u00e9 | name |\n| --- | --- |\n| x | \u{1f600} |\n";
  const budget = Buffer.byteLength(expected);
  await expect(normalizeDocumentContent(input, budget)).resolves.toEqual(
    new TextEncoder().encode(expected),
  );
  await expect(
    normalizeDocumentContent(input, budget - 1),
  ).rejects.toMatchObject({ code: "DOCUMENT_MARKDOWN_TOO_LARGE" });
});

it("preserves escaped cells and padding for tables within their budget", async () => {
  const bytes = await normalizeDocumentContent({
    filename: "data.csv",
    mediaType: "text/csv",
    source: Buffer.from("one,two,three\nleft|right\nlast,**bold**"),
  });
  expect(new TextDecoder().decode(bytes)).toBe(
    "| one | two | three |\n| --- | --- | --- |\n| left\\|right |  |  |\n| last | \\*\\*bold\\*\\* |  |\n",
  );
});
