import { describe, expect, it } from "vitest";

import type { TeamHubPersonalProfileDocument } from "@/features/teamhub/teamhub-types";

import { profilePreview } from "./profile-card-content";

function profileWith(overview: string): TeamHubPersonalProfileDocument {
  const empty = { overview: "", points: [] };
  return {
    background: { ...empty, overview },
    communication_style: empty,
    working_style: empty,
    preferences: empty,
    writing_style: empty,
  } as unknown as TeamHubPersonalProfileDocument;
}

describe("profilePreview", () => {
  it("keeps a paragraph that fits, unchanged", () => {
    const overview = "Prefers short written updates before every review.";
    expect(profilePreview(profileWith(overview))).toBe(overview);
  });

  it("adds no ellipsis when a paragraph of emoji is within the bound", () => {
    // 141 emoji are 282 UTF-16 units but 141 code points, so nothing is cut and
    // the card must not claim that something was.
    const overview = "\u{1F600}".repeat(141);
    expect(profilePreview(profileWith(overview))).toBe(overview);
  });

  it("cuts a long paragraph between characters, never inside one", () => {
    // 279 ASCII characters put the 280th code point across a unit cut.
    const overview = `${"a".repeat(279)}\u{1F600}tail`;
    const preview = profilePreview(profileWith(overview));
    expect(preview).toBe(`${"a".repeat(279)}\u{1F600}…`);
    // 280 code points plus the ellipsis, so the emoji kept both halves.
    expect(preview).toHaveLength(282);
  });
});
