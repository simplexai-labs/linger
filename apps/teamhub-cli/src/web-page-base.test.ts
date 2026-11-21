import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./web-page.js";

describe("direct web page base URLs", () => {
  it.each([
    ["/docs/", "https://site.example/docs/"],
    ["https://cdn.example/manual/", "https://cdn.example/manual/"],
  ])(
    "resolves links and images against the document base %s",
    async (base, expected) => {
      const result = await htmlToMarkdown(
        `<html><head><base href="${base}"></head><body><main><a href="next.html">Next</a><img src="plot.png" alt="Plot"></main></body></html>`,
        "https://site.example/article/page.html",
      );
      expect(result.markdown).toContain(`[Next](${expected}next.html)`);
      expect(result.markdown).toContain(`![Plot](${expected}plot.png)`);
    },
  );

  it("uses the first base with an href and ignores later bases", async () => {
    const result = await htmlToMarkdown(
      '<html><head><base target="_blank"><base href="/first/"><base href="/second/"></head><main><a href="next">Next</a></main></html>',
      "https://site.example/page",
    );
    expect(result.markdown).toBe("[Next](https://site.example/first/next)");
  });

  it("retains the page URL when the base is not an HTTP address", async () => {
    const result = await htmlToMarkdown(
      '<html><head><base href="javascript:alert(1)"></head><main><a href="next">Next</a></main></html>',
      "https://site.example/article/page",
    );
    expect(result.markdown).toBe("[Next](https://site.example/article/next)");
  });
});
