import { describe, expect, it } from "vitest";

import { WorkerDocumentNormalizer } from "../../src/document-normalizer/document-normalizer.js";

describe("document character references", () => {
  for (const kind of ["html", "svg"] as const) {
    it.each([
      ["&#38;lt;item&#38;gt;", "&lt;item&gt;", "&amp;lt;item&amp;gt;"],
      ["&#x26;#65;", "&#65;", "&amp;#65;"],
      ["&#38;amp;", "&amp;", "&amp;amp;"],
      ["&#x26;quot;", "&quot;", "&amp;quot;"],
      ["&amp;lt;item&amp;gt;", "&lt;item&gt;", "&amp;lt;item&amp;gt;"],
      [
        "&#65; &amp; &#x1F680; &quot;ok&quot;",
        'A & \u{1f680} "ok"',
        'A & \u{1f680} "ok"',
      ],
    ])(
      `preserves ${kind} literal character-reference text: %s`,
      async (source, expectedText, expectedHtmlMarkdown) => {
        const input =
          kind === "html"
            ? `<p>${source}</p>`
            : `<svg xmlns="http://www.w3.org/2000/svg"><text>${source}</text></svg>`;
        const bytes = await new WorkerDocumentNormalizer().normalizeDocument({
          filename: `entities.${kind}`,
          mediaType: kind === "html" ? "text/html" : "image/svg+xml",
          source: new TextEncoder().encode(input),
        });
        // The HTML formatter escapes literal reference syntax; SVG extraction keeps its decoded text.
        expect(new TextDecoder().decode(bytes)).toBe(
          kind === "svg"
            ? `# entities.svg\n\n${expectedText}\n`
            : `${expectedHtmlMarkdown}\n`,
        );
      },
    );
  }
});
