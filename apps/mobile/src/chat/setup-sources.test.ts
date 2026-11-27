import { describe, expect, it } from "vitest";

import {
  formatFileSize,
  isSourceLink,
  linkLabel,
  linkProblem,
} from "./setup-sources";

describe("source links", () => {
  it("accepts absolute http and https links only", () => {
    expect(isSourceLink("https://example.com")).toBe(true);
    expect(isSourceLink("http://example.com/a?b=c#d")).toBe(true);
    expect(isSourceLink("HTTPS://Example.com/café")).toBe(true);
    expect(isSourceLink("example.com")).toBe(false);
    expect(isSourceLink("ftp://example.com")).toBe(false);
    expect(isSourceLink("https://")).toBe(false);
    expect(isSourceLink("https://exa mple.com")).toBe(false);
    expect(isSourceLink(`https://example.com/${"a".repeat(2048)}`)).toBe(false);
  });

  it("says why a link cannot be added", () => {
    const five = [1, 2, 3, 4, 5].map((n) => `https://example.com/${n}`);
    expect(linkProblem("nope", [])).toBe("invalid");
    expect(linkProblem("https://example.com/1", five)).toBe("duplicate");
    expect(linkProblem("https://example.com/6", five)).toBe("limit");
    expect(linkProblem("https://example.com/6", five.slice(1))).toBeUndefined();
  });

  it("labels a link by its host, then any path and query", () => {
    expect(linkLabel("https://example.com")).toBe("example.com");
    expect(linkLabel("https://example.com/")).toBe("example.com");
    expect(linkLabel("https://example.com/docs?page=2#top")).toBe(
      "example.com/docs?page=2",
    );
  });

  it("formats file sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
