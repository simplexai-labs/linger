import { describe, expect, it } from "vitest";

import {
  nextDesktopVersion,
  parseDesktopTag,
  previousDesktopTag,
} from "./desktop-tags.mjs";

describe("parseDesktopTag", () => {
  it("reads stable and release candidate tags", () => {
    expect(parseDesktopTag("desktop-v1.2.3")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      rc: null,
    });
    expect(parseDesktopTag("desktop-v1.2.3-rc.4")?.rc).toBe(4);
  });

  it.each(["cli-v1.2.3", "v1.2.3", "desktop-v1.2", "desktop-v1.2.3-beta.1"])(
    "ignores %s",
    (tag) => {
      expect(parseDesktopTag(tag)).toBeNull();
    },
  );
});

describe("previousDesktopTag", () => {
  const published = [
    "desktop-v0.9.0",
    "desktop-v0.10.0-rc.1",
    "desktop-v0.10.0-rc.2",
    "desktop-v0.10.0",
    "desktop-v0.10.1-rc.1",
    "cli-v9.9.9",
    "native-deps",
  ];

  it("measures a stable release against the previous stable one", () => {
    expect(previousDesktopTag(published, "desktop-v0.10.1")).toBe(
      "desktop-v0.10.0",
    );
    expect(previousDesktopTag(published, "desktop-v0.10.0")).toBe(
      "desktop-v0.9.0",
    );
  });

  it("measures a release candidate against the closest earlier release", () => {
    expect(previousDesktopTag(published, "desktop-v0.10.0-rc.2")).toBe(
      "desktop-v0.10.0-rc.1",
    );
    expect(previousDesktopTag(published, "desktop-v0.10.1-rc.2")).toBe(
      "desktop-v0.10.1-rc.1",
    );
    expect(previousDesktopTag(published, "desktop-v0.10.0-rc.1")).toBe(
      "desktop-v0.9.0",
    );
  });

  it("compares numbers, not text, and skips later releases", () => {
    expect(
      previousDesktopTag(
        ["desktop-v0.9.0", "desktop-v0.10.0"],
        "desktop-v0.9.1",
      ),
    ).toBe("desktop-v0.9.0");
  });

  it("returns nothing for the first release or a tag it cannot read", () => {
    expect(previousDesktopTag([], "desktop-v1.0.0")).toBe("");
    expect(previousDesktopTag(published, "desktop-v1.0.0-beta.1")).toBe("");
  });
});

describe("nextDesktopVersion", () => {
  const tags = ["desktop-v0.16.9", "desktop-v0.16.10", "cli-v5.0.0"];

  it("bumps the latest stable version", () => {
    expect(nextDesktopVersion(tags, "patch")).toBe("0.16.11");
    expect(nextDesktopVersion(tags, "minor")).toBe("0.17.0");
    expect(nextDesktopVersion(tags, "major")).toBe("1.0.0");
  });

  it("starts the release candidates of the next patch version", () => {
    expect(nextDesktopVersion(tags, "rc")).toBe("0.16.11-rc.1");
  });

  it("continues the highest release candidate series ahead of the stable version", () => {
    expect(
      nextDesktopVersion(
        [
          ...tags,
          "desktop-v0.17.0-rc.1",
          "desktop-v0.17.0-rc.2",
          "desktop-v0.16.11-rc.3",
        ],
        "rc",
      ),
    ).toBe("0.17.0-rc.3");
  });

  it("ignores release candidates of an already released version", () => {
    expect(nextDesktopVersion([...tags, "desktop-v0.16.10-rc.4"], "rc")).toBe(
      "0.16.11-rc.1",
    );
  });

  it("needs a stable tag and a known kind", () => {
    expect(() => nextDesktopVersion(["desktop-v1.0.0-rc.1"], "rc")).toThrow(
      "explicit version",
    );
    expect(() => nextDesktopVersion(tags, "beta")).toThrow(
      "unknown release kind",
    );
  });
});
