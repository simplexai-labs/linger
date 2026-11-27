import { describe, expect, it } from "vitest";

import { avatarAppearance, initials } from "./avatar-key";

describe("avatarAppearance", () => {
  it("reads figure and image keys", () => {
    expect(avatarAppearance("figure:cat:aabbcc", "x")).toEqual({
      kind: "figure",
      figure: "cat",
      color: "#AABBCC",
    });
    expect(avatarAppearance("image:112233", "x")).toMatchObject({
      kind: "image",
      color: "#112233",
    });
  });

  it("gives an unknown or missing key a stable figure", () => {
    const first = avatarAppearance("figure:not_a_figure:aabbcc", "x");
    expect(first.kind).toBe("figure");
    expect(avatarAppearance("figure:not_a_figure:aabbcc", "y")).toEqual(first);
    expect(avatarAppearance(undefined, "actor_1")).toEqual(
      avatarAppearance(undefined, "actor_1"),
    );
  });
});

describe("initials", () => {
  it("takes the first letters of two words", () => {
    expect(initials("ada lovelace")).toBe("AL");
    expect(initials("Émile")).toBe("É");
    expect(initials("  ")).toBe("?");
  });
});
