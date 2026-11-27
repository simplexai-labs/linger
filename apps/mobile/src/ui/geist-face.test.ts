import { describe, expect, it } from "vitest";

import { geistFace } from "./geist-face";

describe("geistFace", () => {
  it("maps style weights to the design system's four faces", () => {
    expect(geistFace(undefined)).toBe("Geist-Regular");
    expect(geistFace("normal")).toBe("Geist-Regular");
    expect(geistFace("500")).toBe("Geist-Medium");
    expect(geistFace("600")).toBe("Geist-SemiBold");
    expect(geistFace("bold")).toBe("Geist-Bold");
    expect(geistFace(800)).toBe("Geist-Bold");
  });
});
