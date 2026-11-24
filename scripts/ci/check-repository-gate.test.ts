import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { planChecks, readWorkspace } from "../check-plan.mjs";

const gate = join(process.cwd(), "scripts/ci/check-repository-gate.sh");
const changedFilesCheck = join(
  process.cwd(),
  "scripts/ci/check-changed-files.sh",
);
const appLintedPaths = readFileSync(
  join(process.cwd(), "scripts/ci/app-linted-paths.txt"),
  "utf8",
)
  .split("\n")
  .filter(Boolean);
// The pnpm stub fails `pnpm exec eslint` when a listed file contains this.
const lintError = "export const LINT_ERROR = 1;\n";
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "BASE"),
);

interface GateOptions {
  changedPath?: string;
  changedContent?: string;
  // Delete this base file in the head commit.
  deletedPath?: string;
  // Pass a target branch that moved past the merge base, as a local run does.
  advancedTarget?: boolean;
  // Run check-changed-files.sh --worktree on an uncommitted change instead.
  worktree?: boolean;
}

// Runs the gate in a temporary repository whose pnpm and make are stubs that
// record every invocation, so the tests observe the sequence of gate steps.
function runGate(options: GateOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "repository-gate-"));
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  try {
    mkdirSync(bin);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    if (options.deletedPath) {
      mkdirSync(join(root, options.deletedPath, ".."), { recursive: true });
      writeFileSync(join(root, options.deletedPath), "retired\n");
      git("add", ".");
    }
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    if (options.deletedPath) git("rm", "-q", options.deletedPath);
    const changed = options.changedPath ?? "apps/web/src/example.ts";
    mkdirSync(join(root, changed, ".."), { recursive: true });
    writeFileSync(
      join(root, changed),
      options.changedContent ?? "export {};\n",
    );
    if (options.worktree) git("add", ".");
    else {
      git("add", ".");
      git("commit", "-q", "-m", "head");
    }
    const head = git("rev-parse", "HEAD");
    let baseInput = base;
    if (options.advancedTarget) {
      git("branch", "team/fat", base);
      git("checkout", "-q", "team/fat");
      writeFileSync(join(root, "upstream.txt"), "upstream\n");
      git("add", ".");
      git("commit", "-q", "-m", "upstream");
      git("checkout", "-q", head);
      baseInput = "team/fat";
    }

    writeFileSync(
      join(bin, "pnpm"),
      `#!/usr/bin/env bash
printf 'pnpm %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$1 $2" == "exec eslint" ]]; then
  shift 2
  ! grep -q LINT_ERROR "$@"
fi
`,
    );
    writeFileSync(
      join(bin, "make"),
      `#!/usr/bin/env bash
printf 'make %s\\n' "$*" >> "$COMMAND_LOG"
printf '%s\\n' "\${BASE:-unset}" >>"$COMMAND_LOG.base"
exit 0
`,
    );
    for (const command of ["pnpm", "make"])
      chmodSync(join(bin, command), 0o755);

    const command = options.worktree
      ? [changedFilesCheck, base, "--worktree"]
      : [gate];
    const result = spawnSync("bash", command, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...cleanEnv,
        PATH: `${bin}:${process.env.PATH}`,
        COMMAND_LOG: log,
        BASE: baseInput,
      },
    });
    // A failing step can exit before any stub runs, so the log may not exist.
    const commands = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const makeBaseEnvironment = existsSync(`${log}.base`)
      ? readFileSync(`${log}.base`, "utf8").trim().split("\n")
      : [];
    return { ...result, commands, base, makeBaseEnvironment };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Each case creates a real git fixture and spawns bash processes, so it gets the
// process-test budget rather than the unit default.
describe("local repository gate", { timeout: 60_000 }, () => {
  it("requires BASE and prints a usage message", () => {
    const result = spawnSync("bash", [gate], {
      encoding: "utf8",
      env: { ...cleanEnv, BASE: "" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: BASE=<target-ref>");
  });

  it("runs commitlint, the env inventory, changed-file format and lint, and skips script tests when scripts are untouched", () => {
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.commands).toEqual([
      expect.stringMatching(/^pnpm exec commitlint --from \S+ --to \S+/),
      "pnpm env:inventory:check",
      "pnpm exec prettier --check apps/web/src/example.ts",
      "make check-docs",
    ]);
  });

  it("runs check-scripts-fast when a script or script-tested path changes", () => {
    const result = runGate({ changedPath: "scripts/new.mjs" });
    expect(result.status).toBe(0);
    expect(result.commands).toEqual([
      expect.stringMatching(/^pnpm exec commitlint --from \S+ --to \S+/),
      "pnpm env:inventory:check",
      "pnpm exec prettier --check scripts/new.mjs",
      "pnpm exec eslint scripts/new.mjs",
      "make check-scripts-fast check-docs",
    ]);
  });

  it("rejects changed files with CJK ideographs and allows kana", () => {
    const ideographs = runGate({
      changedContent: 'export const greeting = "\u4f60\u597d";\n',
    });
    expect(ideographs.status).not.toBe(0);
    expect(ideographs.stderr).toContain("English-only");
    expect(ideographs.commands).not.toContain("make check-docs");
    expect(ideographs.commands).not.toContain(
      "make check-scripts-fast check-docs",
    );

    const kana = runGate({
      changedContent:
        'export const sample = "\u3072\u3089\u304c\u306a\u3002";\n',
    });
    expect(kana.status).toBe(0);
  });

  it("allows CJK ideographs only in the translation catalogs", () => {
    const changedContent = '{ "greeting": "\u4f60\u597d" }\n';
    for (const changedPath of [
      "apps/web/src/i18n/locales/zh-CN.json",
      "apps/desktop/src/i18n/locales/zh-CN.json",
    ]) {
      const catalog = runGate({ changedPath, changedContent });
      expect(catalog.status).toBe(0);
      expect(catalog.commands).toContain(
        `pnpm exec prettier --check ${changedPath}`,
      );
    }

    for (const changedPath of [
      "apps/web/src/i18n/zh-CN.json",
      "apps/web/src/i18n/locales.json",
      "apps/desktop/src/i18n/zh-CN.json",
      "apps/desktop/src/i18n/locales.json",
      "apps/desktop/src/shell/setup.html",
      "apps/desktop/locales/zh-CN.json",
    ]) {
      const elsewhere = runGate({ changedPath, changedContent });
      expect(elsewhere.status).not.toBe(0);
      expect(elsewhere.stderr).toContain("English-only");
    }

    const worktree = runGate({
      worktree: true,
      changedPath: "apps/web/src/i18n/locales/zh-CN.json",
      changedContent,
    });
    expect(worktree.status).toBe(0);
  });

  it("formats and lints only existing changed files outside published Skill versions", () => {
    const skill = runGate({
      changedPath: "skills/builtin/example/1.0.0/scripts/run.js",
    });
    expect(skill.status).toBe(0);
    expect(skill.commands.some((line) => line.includes("prettier"))).toBe(
      false,
    );

    const deleted = runGate({
      deletedPath: "retired/old.ts",
      changedPath: "docs/note.md",
    });
    expect(deleted.status).toBe(0);
    expect(deleted.commands).toContain(
      "pnpm exec prettier --check docs/note.md",
    );
    expect(deleted.commands.some((line) => line.includes("eslint"))).toBe(
      false,
    );
  });

  it("leaves ESLint under app-linted prefixes to the app checks", () => {
    const appLinted = runGate({
      changedPath: "apps/web/src/example.ts",
      changedContent: lintError,
    });
    expect(appLinted.status).toBe(0);
    expect(appLinted.commands).toContain(
      "pnpm exec prettier --check apps/web/src/example.ts",
    );
    expect(appLinted.commands.some((line) => line.includes("eslint"))).toBe(
      false,
    );

    for (const changedPath of ["apps/web/vite.config.ts", "scripts/new.mjs"]) {
      const gateLinted = runGate({ changedPath, changedContent: lintError });
      expect(gateLinted.status).not.toBe(0);
      expect(gateLinted.commands).toContain(`pnpm exec eslint ${changedPath}`);
    }
  });

  it("lints every changed file in the local worktree mode", () => {
    const result = runGate({ worktree: true, changedContent: lintError });
    expect(result.status).not.toBe(0);
    expect(result.commands).toEqual([
      "pnpm exec prettier --check apps/web/src/example.ts",
      "pnpm exec eslint apps/web/src/example.ts",
    ]);
  });

  it("checks migration history only when migration SQL changed", () => {
    const unchanged = runGate();
    expect(unchanged.stderr).not.toContain("migration");

    // The fixture repository has no migration checker, so the step fails.
    const changed = runGate({
      changedPath: "apps/teamhub/migrations/00999_example.sql",
    });
    expect(changed.status).not.toBe(0);
    expect(changed.commands).toEqual([]);
  });

  it("keeps BASE out of the make environment", () => {
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.makeBaseEnvironment.length).toBeGreaterThan(0);
    expect(result.makeBaseEnvironment).toEqual(
      result.makeBaseEnvironment.map(() => "unset"),
    );
  });

  it("diffs from the merge base when the target ref moved ahead", () => {
    const result = runGate({ advancedTarget: true });
    expect(result.status).toBe(0);
    expect(result.commands.at(-1)).toBe("make check-docs");
    expect(result.commands[0]).toContain(`--from ${result.base} `);
  });
});

// The gate skips ESLint under a prefix only because an app check lints it.
describe("app-linted paths", () => {
  const workspace = readWorkspace();

  it.each(appLintedPaths)("CI selects an app check for %s", (prefix) => {
    const plan = planChecks([`${prefix}example.ts`], workspace);
    expect(plan.all).toBe(false);
    expect(plan.selected.filter((entry) => entry.ci).length).toBeGreaterThan(0);
  });

  it.each(appLintedPaths)(
    "the owning package lints all of %s with no warnings",
    (prefix) => {
      const directory = prefix.replace(/\/$/, "");
      let packageDirectory = directory;
      while (!existsSync(join(process.cwd(), packageDirectory, "package.json")))
        packageDirectory = packageDirectory.split("/").slice(0, -1).join("/");
      const relative =
        directory === packageDirectory
          ? "."
          : directory.slice(packageDirectory.length + 1);
      const manifest = JSON.parse(
        readFileSync(
          join(process.cwd(), packageDirectory, "package.json"),
          "utf8",
        ),
      ) as { scripts?: { lint?: string } };
      const lint = (manifest.scripts?.lint ?? "").split(/\s+/);
      expect(lint[0]).toBe("eslint");
      expect(lint).toContain("--max-warnings=0");
      expect(lint.includes(relative) || lint.includes(".")).toBe(true);
    },
  );
});
