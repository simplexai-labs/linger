import { expect, it } from "vitest";
import {
  normalizeDocumentContent,
  resolveDocumentSourceKind,
} from "../../src/document-normalizer/document-normalizer-core.js";

it.each(["constructor", "__proto__"])(
  "uses a declared format after an unrecognized .%s extension",
  async (extension) => {
    const input = {
      filename: `notes.${extension}`,
      mediaType: "application/octet-stream",
      representationFormat: "plain_text",
      source: Buffer.from("Saved content"),
    };
    expect(resolveDocumentSourceKind(input)).toBe("plain");
    await expect(
      normalizeDocumentContent(input).then((bytes) =>
        Buffer.from(bytes).toString(),
      ),
    ).resolves.toBe("Saved content\n");
  },
);

it.each(["constructor", "__proto__"])(
  "treats inherited representation %s as unsupported",
  (representationFormat) => {
    expect(
      resolveDocumentSourceKind({
        mediaType: "application/octet-stream",
        representationFormat,
      }),
    ).toBe("unsupported");
  },
);

it("keeps recognized MIME and filename precedence", () => {
  expect(
    resolveDocumentSourceKind({
      mediaType: "text/csv",
      filename: "notes.__proto__",
      representationFormat: "markdown",
    }),
  ).toBe("csv");
  expect(
    resolveDocumentSourceKind({
      mediaType: "application/octet-stream",
      filename: "notes.md",
      representationFormat: "constructor",
    }),
  ).toBe("markdown");
});
