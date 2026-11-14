// Keeps a pull request's type label in step with its Conventional Commits
// title, because .github/release.yml groups release notes by label. commitlint
// holds the title grammar, so the type is read from the title's structure.
//
//   GH_TOKEN=... PR_NUMBER=12 PR_TITLE='fix(web): keep the draft' node pr-type-labels.mjs

import { execFileSync } from "node:child_process";

const TYPE_LABELS = {
  feat: "enhancement",
  fix: "bug",
  perf: "performance",
  docs: "documentation",
  build: "maintenance",
  chore: "maintenance",
  ci: "maintenance",
  refactor: "maintenance",
  revert: "maintenance",
  style: "maintenance",
  test: "maintenance",
};
const BREAKING_LABEL = "breaking-change";

// Labels this script owns; any other label on the pull request is left alone.
export const MANAGED_LABELS = [
  ...new Set([...Object.values(TYPE_LABELS), BREAKING_LABEL]),
];

export function labelsForTitle(title) {
  const match = /^(\w+)(?:\([^)]*\))?(!)?:/.exec(title);
  const label =
    match && Object.hasOwn(TYPE_LABELS, match[1])
      ? TYPE_LABELS[match[1]]
      : null;
  if (!label) return [];
  return match[2] ? [label, BREAKING_LABEL] : [label];
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function main() {
  const { PR_NUMBER: number, PR_TITLE: title } = process.env;
  if (!number || title === undefined) {
    console.error("Usage: PR_NUMBER=<n> PR_TITLE=<title> pr-type-labels.mjs");
    process.exit(2);
  }
  const wanted = labelsForTitle(title);
  const present = JSON.parse(
    gh(["pr", "view", number, "--json", "labels"]),
  ).labels.map((label) => label.name);
  const add = wanted.filter((label) => !present.includes(label));
  const remove = MANAGED_LABELS.filter(
    (label) => present.includes(label) && !wanted.includes(label),
  );
  for (const label of add) {
    // Creating an existing label fails; that is the normal case.
    try {
      gh(["label", "create", label]);
    } catch {
      // already exists
    }
  }
  const args = ["pr", "edit", number];
  for (const label of add) args.push("--add-label", label);
  for (const label of remove) args.push("--remove-label", label);
  if (args.length > 3) gh(args);
  console.log(`pr-type-labels: #${number} add=[${add}] remove=[${remove}]`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
