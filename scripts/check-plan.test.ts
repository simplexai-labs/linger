import { describe, expect, it } from "vitest";

import {
  CI_KEYS,
  EVERYTHING_PATHS,
  formatPlan,
  planChecks,
  planFromBase,
  planFromList,
  readWorkspace,
} from "./check-plan.mjs";

const workspace = readWorkspace();
const local = (changed: string[] | "ALL") =>
  formatPlan(planChecks(changed, workspace), "make").split(" ");
const ci = (changed: string[]) =>
  Object.fromEntries(
    formatPlan(planChecks(changed, workspace), "github")
      .split("\n")
      .map((line) => line.split("=")),
  );
const allLocal = formatPlan(planChecks("ALL", {}), "make").split(" ");

describe("CI outputs", () => {
  // One path per alternative of the regexes the CI changes job used before
  // it read this plan; each must still select its key.
  const previousRegexExamples: Record<string, string[]> = {
    web: [
      "apps/web/src/main.tsx",
      "packages/service-kit/src/index.ts",
      "contracts/generated/typescript/src/index.ts",
    ],
    packages: [
      "packages/document-model/src/index.ts",
      "contracts/generated/typescript/src/index.ts",
      "contracts/fixtures/example.json",
    ],
    "teamhub-cli": [
      "apps/teamhub-cli/src/main.ts",
      "packages/service-kit/src/index.ts",
      "contracts/openapi/teamhub-agent-api/openapi.yaml",
    ],
    installer: [
      "apps/linger-installer/src/main.ts",
      "packages/local-installation/src/index.ts",
      "contracts/generated/typescript/src/index.ts",
    ],
    desktop: [
      "apps/desktop/src/main/index.ts",
      "apps/computer/local-daemon/go.mod",
      "apps/computer/package.json",
      "packages/local-installation/src/index.ts",
      "contracts/generated/typescript/src/index.ts",
    ],
    contracts: ["contracts/openapi/components/example.yaml"],
    teamhub: [
      "apps/teamhub/internal/app/app.go",
      "skills/builtin/catalog.yaml",
      "contracts/generated/go/teamhub/types.go",
      "contracts/fixtures/example.json",
      ".golangci.yml",
      "Makefile",
      ".github/workflows/ci.yml",
    ],
    "computer-go": [
      "apps/computer/package.json",
      "pnpm-lock.yaml",
      "apps/computer/local-daemon/internal/daemon/daemon.go",
      "apps/computer/run-test.sh",
      "contracts/generated/go/runnergateway/types.go",
      "contracts/runner-gateway/fixtures/example.json",
      "scripts/managed-tools-install.mjs",
      "scripts/local-computer-node-distributions.mjs",
      "scripts/test-fixtures/managed-tools-fixture.mjs",
      "Makefile",
      ".github/workflows/ci.yml",
    ],
  };
  const nodeEverything = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".node-version",
    "patches/example.patch",
    "eslint.config.mjs",
    "tsconfig.base.json",
    "vitest.config.ts",
    "Makefile",
    ".github/actions/setup/action.yml",
  ];
  const nodeKeys = [
    "web",
    "packages",
    "teamhub-cli",
    "installer",
    "desktop",
    "contracts",
  ];

  it("lists the CI output keys", () => {
    expect([...CI_KEYS].sort()).toEqual(
      [...nodeKeys, "teamhub", "computer-go"].sort(),
    );
  });

  for (const [key, paths] of Object.entries(previousRegexExamples)) {
    for (const file of paths) {
      it(`${file} selects ${key}`, () => {
        expect(ci([file])[key]).toBe("true");
      });
    }
  }

  for (const file of nodeEverything) {
    it(`${file} selects every Node key`, () => {
      const outputs = ci([file]);
      for (const key of nodeKeys) expect(outputs[key]).toBe("true");
    });
  }

  it("selects nothing for an unrelated path", () => {
    expect(Object.values(ci(["README.md"]))).toEqual(
      CI_KEYS.map(() => "false"),
    );
  });

  it("keeps a nested package.json out of the everything set", () => {
    const outputs = ci(["apps/teamhub/package.json"]);
    expect(outputs.teamhub).toBe("true");
    expect(outputs.web).toBe("false");
  });
});

describe("local plan", () => {
  it("runs only TeamHub for a TeamHub change", () => {
    expect(local(["apps/teamhub/internal/app/app.go"])).toEqual([
      "check-repository",
      "check-docs",
      "check-teamhub",
    ]);
  });

  it("follows workspace dependencies from packages/service-kit", () => {
    expect(local(["packages/service-kit/src/index.ts"])).toEqual([
      "check-repository",
      "check-docs",
      "check-packages",
      "check-voice-runtime",
      "check-teamhub-cli",
      "check-installer",
      "check-desktop",
      "check-web",
      "check-node-services",
      "check-computer",
    ]);
  });

  it("runs the Daemon process test for any Node Services change", () => {
    expect(
      local(["apps/node-services/src/agent/agent-features/compose.ts"]),
    ).toEqual([
      "check-repository",
      "check-docs",
      "check-node-services",
      "check-computer",
    ]);
  });

  it("runs check-packages and its dependents for packages/local-installation", () => {
    expect(local(["packages/local-installation/src/index.ts"])).toEqual([
      "check-repository",
      "check-docs",
      "check-packages",
      "check-installer",
      "check-desktop",
      "check-scripts-fast",
    ]);
    expect(ci(["packages/local-installation/src/index.ts"])).toMatchObject({
      packages: "true",
      installer: "true",
      desktop: "true",
      web: "false",
      "teamhub-cli": "false",
    });
  });

  it("scopes packages/document-model to the apps that actually depend on it", () => {
    expect(ci(["packages/document-model/src/index.ts"])).toMatchObject({
      packages: "true",
      web: "true",
      installer: "false",
      desktop: "false",
      "teamhub-cli": "false",
    });
  });

  it("includes the TeamHub CLI that Node Services depends on", () => {
    expect(local(["apps/teamhub-cli/src/main.ts"])).toContain(
      "check-node-services",
    );
  });

  it("runs every check for each everything-set path", () => {
    for (const prefix of EVERYTHING_PATHS) {
      const file = prefix.endsWith("/") ? `${prefix}x` : prefix;
      expect(local([file])).toEqual(allLocal);
      expect(planChecks([file], workspace).all).toBe(true);
    }
  });

  it("never runs the CI-only computer Go target locally", () => {
    expect(allLocal).not.toContain("check-computer-go");
    expect(local(["apps/computer/local-daemon/go.mod"])).toContain(
      "check-computer",
    );
  });

  it("plans a mixed change set", () => {
    expect(
      local([
        "apps/web/src/x.ts",
        "apps/node-services/src/agent/runner-gateway/y.ts",
        "apps/computer/local-daemon/internal/daemon/z.go",
        "apps/desktop/src/main/a.ts",
        "packages/local-installation/src/b.ts",
      ]),
    ).toEqual([
      "check-repository",
      "check-docs",
      "check-packages",
      "check-installer",
      "check-desktop",
      "check-scripts-fast",
      "check-web",
      "check-node-services",
      "check-computer",
    ]);
  });

  it("runs only the always-on checks for a docs change", () => {
    expect(local(["docs/index.md"])).toEqual([
      "check-repository",
      "check-docs",
    ]);
  });
});

describe("failures select every check", () => {
  const failingGit = () => {
    throw new Error("fatal: Not a valid object name nope");
  };

  it("on a git failure or unresolvable base", () => {
    const plan = planFromBase("nope", {
      git: failingGit,
      workspace: () => workspace,
    });
    expect(plan.all).toBe(true);
    expect(formatPlan(plan, "make").split(" ")).toEqual(allLocal);
    expect(formatPlan(plan, "scope")).toBe("all");
  });

  it("on an empty merge base", () => {
    const plan = planFromBase("main", {
      git: () => "",
      workspace: () => workspace,
    });
    expect(plan.all).toBe(true);
  });

  it("on an unreadable workspace", () => {
    const plan = planFromList("apps/web/x.ts\n", () => {
      throw new Error("ENOENT");
    });
    expect(plan.all).toBe(true);
  });

  it("for the literal ALL", () => {
    expect(planFromList("ALL\n", () => workspace).all).toBe(true);
  });

  it("reads committed, uncommitted, deleted and untracked paths", () => {
    const calls: string[][] = [];
    const git = (args: string[]) => {
      calls.push(args);
      if (args[0] === "merge-base") return "abc\n";
      if (args[0] === "diff")
        return "apps/teamhub/a.go\0apps/teamhub/gone.go\0";
      return "skills/new.md\0";
    };
    const plan = planFromBase("main", { git, workspace: () => workspace });
    expect(calls[1]).toEqual([
      "diff",
      "-z",
      "--name-only",
      "--no-renames",
      "abc",
    ]);
    expect(formatPlan(plan, "make")).toBe(
      "check-repository check-docs check-teamhub",
    );
  });
});
