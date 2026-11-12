import { describe, expect, it } from "vitest";

import { labelsForTitle, MANAGED_LABELS } from "./pr-type-labels.mjs";

describe("labelsForTitle", () => {
  it.each([
    ["feat(web): add a Room switcher", ["enhancement"]],
    ["fix: keep the draft", ["bug"]],
    ["perf(teamhub): batch the reads", ["performance"]],
    ["docs(contributing): merge through the queue", ["documentation"]],
    ["ci(teamhub): build only the default sqlc", ["maintenance"]],
    ["test(web): cover the composer", ["maintenance"]],
    ["feat(api)!: drop the v1 routes", ["enhancement", "breaking-change"]],
    ["fix!: rename the token field", ["bug", "breaking-change"]],
  ])("labels %j", (title, labels) => {
    expect(labelsForTitle(title)).toEqual(labels);
  });

  it.each([
    "Update the README",
    "feature(web): add a switcher",
    "feat add a switcher",
    "",
  ])("leaves %j unlabeled", (title) => {
    expect(labelsForTitle(title)).toEqual([]);
  });

  it("manages every label it can apply", () => {
    for (const title of [
      "feat: a",
      "fix: a",
      "perf: a",
      "docs: a",
      "chore: a",
      "feat!: a",
    ]) {
      for (const label of labelsForTitle(title))
        expect(MANAGED_LABELS).toContain(label);
    }
  });
});
