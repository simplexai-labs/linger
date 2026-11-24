// Selects the fast checks a change set needs. `make check` and the CI
// `changes` job both read this table, so local and CI agree on which paths
// select which check. Any error selects every check; it never selects nothing.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

// A change to any of these selects every check. Paths are prefixes from the
// repository root, so `.github/` covers the directory and `package.json` only
// the root file.
export const EVERYTHING_PATHS = [
  "Makefile",
  "scripts/check-plan.mjs",
  ".github/",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".node-version",
  "patches/",
  "eslint.config.mjs",
  "tsconfig.base.json",
  "vitest.config.ts",
  ".golangci.yml",
];

const COMPUTER_GO_PATHS = [
  // The Daemon's Runtime minimums are checked against the Runtime versions
  // the pinned localmodels kit installs.
  "apps/desktop/distribution/",
  "apps/computer/package.json",
  "apps/computer/local-daemon/",
  "apps/computer/run-test.sh",
  "contracts/generated/go/runnergateway/",
  "contracts/runner-gateway/fixtures/",
  "scripts/managed-tools-",
  "scripts/local-computer-node-distributions.mjs",
  "scripts/test-fixtures/managed-tools-fixture.mjs",
];

// Make targets in the order `make check` runs them. `packages` are workspace
// package directories; the plan adds every transitive `workspace:*`
// dependency's directory. `paths` are extra prefixes the target reads.
// `ci` is the CI `changes` output key; `local: false` keeps a CI-only target
// out of `make check`; `always` targets run on every local plan.
export const TARGETS = [
  { target: "check-repository", lane: "fast", always: true },
  { target: "check-docs", lane: "fast", always: true },
  {
    target: "check-contracts",
    lane: "fast",
    ci: "contracts",
    paths: ["contracts/"],
  },
  {
    target: "check-packages",
    lane: "fast",
    ci: "packages",
    paths: [
      "packages/",
      "contracts/generated/typescript/",
      "contracts/fixtures/",
    ],
  },
  {
    target: "check-voice-runtime",
    lane: "fast",
    packages: ["apps/voice-runtime"],
  },
  {
    target: "check-teamhub-cli",
    lane: "fast",
    ci: "teamhub-cli",
    packages: ["apps/teamhub-cli"],
    paths: ["contracts/"],
  },
  {
    target: "check-installer",
    lane: "fast",
    ci: "installer",
    packages: ["apps/linger-installer"],
  },
  {
    target: "check-desktop",
    lane: "fast",
    ci: "desktop",
    packages: ["apps/desktop"],
    paths: ["apps/computer/local-daemon/", "apps/computer/package.json"],
  },
  {
    target: "check-teamhub",
    lane: "fast",
    ci: "teamhub",
    paths: [
      "apps/teamhub/",
      "skills/",
      "contracts/generated/go/",
      "contracts/fixtures/",
    ],
  },
  {
    // apps/teamhub test-scripts: its fixtures build their own repositories.
    target: "check-teamhub-tooling",
    lane: "fast",
    paths: [
      "apps/teamhub/scripts/",
      "apps/teamhub/Makefile",
      "apps/teamhub/deployments/compose/",
    ],
  },
  {
    // Script tests also read these repository files and contracts.
    target: "check-scripts-fast",
    lane: "fast",
    paths: [
      "scripts/",
      "contracts/",
      ".dockerignore",
      ".env.example",
      ".husky/",
      "docker-compose.yml",
      "apps/web/Dockerfile",
      "apps/web/package.json",
      "apps/node-services/Dockerfile",
      "apps/node-services/package.json",
      "apps/node-services/release-lockfiles/",
      "apps/computer/package.json",
      "apps/teamhub/Dockerfile",
      "apps/teamhub/Makefile",
      "apps/teamhub/deployments/compose/",
      "apps/desktop/src/main/",
      "apps/linger-installer/src/server/",
      "packages/local-installation/src/",
    ],
  },
  {
    target: "check-web",
    lane: "heavy",
    ci: "web",
    packages: ["apps/web"],
  },
  {
    // Tests read daemon sources, run daemon Go tests, and read these
    // TeamHub sources and shared fixtures.
    target: "check-node-services",
    lane: "heavy",
    packages: ["apps/node-services"],
    paths: [
      "apps/computer/local-daemon/",
      "apps/teamhub/internal/permissionreview/",
      "apps/teamhub/internal/typedcard/",
      "contracts/runner-gateway/",
      "scripts/test-fixtures/",
    ],
  },
  {
    // Runs check-computer-go, the @linger/computer suite (which bundles the
    // TeamHub CLI and Computer tools) and the Daemon to Node Services process
    // test, which runs nowhere else; the Gateway it starts imports across
    // Node Services, so any change there or in its dependencies selects it.
    target: "check-computer",
    lane: "heavy",
    packages: ["apps/computer", "apps/node-services", "apps/teamhub-cli"],
    paths: [
      ...COMPUTER_GO_PATHS,
      "scripts/computer-tool-bundle.mjs",
      "scripts/prepare-local-computer-release.mjs",
      "scripts/test-fixtures/",
    ],
  },
  {
    target: "check-computer-go",
    lane: "fast",
    ci: "computer-go",
    local: false,
    paths: COMPUTER_GO_PATHS,
  },
];

export const CI_KEYS = TARGETS.filter((entry) => entry.ci).map(
  (entry) => entry.ci,
);

function readJSON(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Reads the workspace package directories and their `workspace:*`
// dependencies from pnpm-workspace.yaml globs of the form `dir` or `dir/*`.
export function readWorkspace(root = repositoryRoot) {
  const manifest = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [];
  let inPackages = false;
  for (const line of manifest.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+["']?([^"']+)["']?\s*$/.exec(line);
    if (item) globs.push(item[1]);
    else if (/^\S/.test(line)) break;
  }
  if (globs.length === 0)
    throw new Error("pnpm-workspace.yaml lists no packages");
  const directories = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2);
      for (const entry of readdirSync(path.join(root, parent), {
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
      }
    } else {
      directories.push(glob);
    }
  }
  const packages = {};
  for (const directory of directories) {
    let manifestJSON;
    try {
      manifestJSON = readJSON(path.join(root, directory, "package.json"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const dependencies = Object.entries({
      ...manifestJSON.dependencies,
      ...manifestJSON.devDependencies,
    })
      .filter(([, version]) => String(version).startsWith("workspace:"))
      .map(([name]) => name);
    packages[manifestJSON.name] = { directory, dependencies };
  }
  return packages;
}

// Directories of the given package directories and all their transitive
// workspace dependencies.
export function workspaceClosure(directories, workspace) {
  const byDirectory = new Map(
    Object.entries(workspace).map(([name, entry]) => [entry.directory, name]),
  );
  const seen = new Set();
  const pending = directories.map((directory) => {
    const name = byDirectory.get(directory);
    if (!name) throw new Error(`${directory} is not a workspace package`);
    return name;
  });
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    const entry = workspace[name];
    if (!entry) throw new Error(`unknown workspace package ${name}`);
    seen.add(name);
    pending.push(...entry.dependencies);
  }
  return [...seen].map((name) => workspace[name].directory).sort();
}

function targetPrefixes(entry, workspace) {
  const packageDirectories = entry.packages
    ? workspaceClosure(entry.packages, workspace)
    : [];
  return [
    ...packageDirectories.map((directory) => `${directory}/`),
    ...(entry.paths ?? []),
  ];
}

// Returns { all, reason, selected: [{ target, ci, lane, match }], skipped }.
// `changed` is a list of repository-relative paths or the string "ALL".
export function planChecks(changed, workspace) {
  const everything = (reason) => ({
    all: true,
    reason,
    selected: TARGETS.map((entry) => ({ ...entry, match: reason })),
    skipped: [],
  });
  if (changed === "ALL") return everything("all checks requested");
  const files = changed.filter((file) => file !== "");
  const global = files.find((file) =>
    EVERYTHING_PATHS.some((prefix) => file.startsWith(prefix)),
  );
  if (global) return everything(global);
  const selected = [];
  const skipped = [];
  for (const entry of TARGETS) {
    if (entry.always) {
      selected.push({ ...entry, match: "always" });
      continue;
    }
    const prefixes = targetPrefixes(entry, workspace);
    const match = files.find((file) =>
      prefixes.some((prefix) => file.startsWith(prefix)),
    );
    if (match) selected.push({ ...entry, match });
    else skipped.push(entry);
  }
  return { all: false, reason: undefined, selected, skipped };
}

// Every path changed since the merge base of BASE and HEAD: commits, staged
// and unstaged edits, deletions, and untracked files that are not ignored.
export function changedSinceBase(base, git) {
  const mergeBase = git(["merge-base", `${base}^{commit}`, "HEAD"]).trim();
  if (!mergeBase) throw new Error(`no merge base for ${base}`);
  const diff = git(["diff", "-z", "--name-only", "--no-renames", mergeBase]);
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]);
  return [...diff.split("\0"), ...untracked.split("\0")].filter(Boolean);
}

// Plans from git; any git or workspace error selects every check.
export function planFromBase(base, { git, workspace }) {
  try {
    return planChecks(changedSinceBase(base, git), workspace());
  } catch (error) {
    return {
      ...planChecks("ALL", {}),
      reason: `could not compute changes (${String(error.message).trim()})`,
    };
  }
}

export function planFromList(text, workspace) {
  const lines = text.split("\n").map((line) => line.trim());
  if (lines.includes("ALL")) return planChecks("ALL", {});
  try {
    return planChecks(lines, workspace());
  } catch (error) {
    return {
      ...planChecks("ALL", {}),
      reason: `could not compute changes (${String(error.message).trim()})`,
    };
  }
}

export function formatPlan(plan, format) {
  const local = (entries) => entries.filter((entry) => entry.local !== false);
  switch (format) {
    case "make":
      return local(plan.selected)
        .map((entry) => entry.target)
        .join(" ");
    case "scope":
      return plan.all ? "all" : "changed";
    case "github": {
      const selected = new Set(plan.selected.map((entry) => entry.ci));
      return CI_KEYS.map((key) => `${key}=${selected.has(key)}`).join("\n");
    }
    case "human": {
      const lines = [];
      if (plan.all) {
        lines.push(`Check plan: every check (${plan.reason})`);
        for (const entry of local(plan.selected)) {
          lines.push(`  run  ${entry.target}`);
        }
        return lines.join("\n");
      }
      lines.push("Check plan:");
      for (const entry of local(plan.selected)) {
        lines.push(`  run  ${entry.target.padEnd(24)} ${entry.match}`);
      }
      for (const entry of local(plan.skipped)) {
        lines.push(`  skip ${entry.target}`);
      }
      lines.push("Run every check with ALL=1.");
      return lines.join("\n");
    }
    default:
      throw new Error(`unknown format ${format}`);
  }
}

function parseArguments(argv) {
  const options = { format: "human" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} needs a value`);
      return argv[index];
    };
    if (argument === "--base") options.base = value();
    else if (argument === "--files-from") options.filesFrom = value();
    else if (argument === "--format") options.format = value();
    else if (argument === "--all") options.all = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (options.filesFrom !== undefined && options.filesFrom !== "-") {
    throw new Error("--files-from supports only - (stdin)");
  }
  if (
    !options.all &&
    (options.base === undefined) === (options.filesFrom === undefined)
  ) {
    throw new Error(
      "pass exactly one of --base <ref>, --files-from - or --all",
    );
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${error.message}\nUsage: node scripts/check-plan.mjs (--base <ref> | --files-from - | --all) [--format human|make|github|scope]`,
    );
    process.exit(2);
  }
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  const workspace = () => readWorkspace(repositoryRoot);
  let plan;
  if (options.all) plan = planChecks("ALL", {});
  else if (options.base !== undefined) {
    plan = planFromBase(options.base, { git, workspace });
  } else {
    plan = planFromList(readFileSync(0, "utf8"), workspace);
  }
  if (plan.all && plan.reason?.startsWith("could not")) {
    console.error(`check-plan: ${plan.reason}; selecting every check`);
  }
  console.log(formatPlan(plan, options.format));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
