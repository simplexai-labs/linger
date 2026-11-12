import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/ci/desktop-release.sh");
const temporary: string[] = [];

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "desktop-release-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("desktop-release.sh version", () => {
  it("reads a release tag", () => {
    const result = run(["version", "desktop-v0.16.33"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "tag=desktop-v0.16.33\nversion=0.16.33\nprerelease=false\n",
    );
  });

  it("marks a hyphenated version as a prerelease", () => {
    const result = run(["version", "desktop-v0.16.33-rc.1"]);
    expect(result.stdout).toBe(
      "tag=desktop-v0.16.33-rc.1\nversion=0.16.33-rc.1\nprerelease=true\n",
    );
  });

  it("gives a bare version from a manual run its tag", () => {
    expect(run(["version", "1.2.3"]).stdout).toContain("tag=desktop-v1.2.3\n");
  });

  it.each([
    "v0.16.33",
    "cli-v0.16.33",
    "desktop-v0.16",
    "desktop-v0.16.33-",
    "",
  ])("rejects %j", (tag) => {
    const result = run(["version", tag]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});

describe("desktop-release.sh checksums", () => {
  const version = "0.16.33";
  const required = [
    `Linger-${version}-arm64.dmg`,
    `Linger-${version}-linux-x64.tar.gz`,
    `Linger-${version}-windows-x64-setup.exe`,
  ];

  it("lists every file of the version", () => {
    const dir = folder();
    const files = [...required, `Linger-${version}-windows-x64-portable.zip`];
    for (const name of files) writeFileSync(join(dir, name), name);
    writeFileSync(join(dir, "Linger-0.16.32-arm64.dmg"), "older");

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(0);
    const expected = [...files]
      .sort()
      .map(
        (name) =>
          `${createHash("sha256").update(name).digest("hex")}  ${name}\n`,
      )
      .join("");
    expect(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")).toBe(expected);
  });

  it("refuses a release without one of the installers", () => {
    const dir = folder();
    for (const name of required.slice(0, 2))
      writeFileSync(join(dir, name), name);

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Linger-${version}-windows-x64-setup.exe`);
  });
});

describe("desktop-release.sh build", () => {
  it("needs a known target and a version", () => {
    expect(
      run(["build", "darwin-x64"], { DESKTOP_VERSION: "1.0.0" }).status,
    ).toBe(1);
    expect(run(["compile", "linux-x64"]).stderr).toContain("DESKTOP_VERSION");
  });

  it("stops before building when a pinned archive has no source", () => {
    const result = run(["build", "linux-x64"], {
      DESKTOP_VERSION: "1.0.0",
      RELEASE_OUT: folder(),
      LINGER_NATIVE_POSTGRES_DIR: folder(),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINGER_NATIVE_DEPS_URL");
  });

  it("keeps the archive folder's address out of the log", () => {
    const result = run(["fetch-native", "linux-x64"], {
      LINGER_NATIVE_POSTGRES_DIR: folder(),
      LINGER_NATIVE_DEPS_URL: "http://deps.invalid/private/folder",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot download");
    expect(result.stdout + result.stderr).not.toContain("deps.invalid");
  });
});

describe("desktop-release.sh gitlab-upload", () => {
  it("needs GitLab CI", () => {
    const result = run(["gitlab-upload", ".", "1.0.0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CI_API_V4_URL is not set");
  });

  it.each(["target", "gitlab-release"])(
    "has no %s command: releases publish only on GitHub",
    (command) => {
      expect(run([command]).status).toBe(2);
    },
  );
});

describe("desktop-release.sh github-release", () => {
  const version = "1.0.0-rc.1";
  const tag = `desktop-v${version}`;

  // A gh that records its arguments and has no release until it is created.
  // `files` is how many assets it reports once the release has them; `draft`
  // is whether the release it reports is still a draft.
  function release(
    env: Record<string, string>,
    options: {
      tag?: string;
      version?: string;
      files?: number;
      draft?: boolean;
    } = {},
  ) {
    const dir = folder();
    const bin = folder();
    // Outside dir, which holds only the files to publish.
    const log = join(bin, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        `echo "$*" >>"${log}"`,
        'case "$*" in',
        `  *"--json assets"*) echo ${options.files ?? 1}; exit 0 ;;`,
        `  *"--json isDraft"*) echo ${options.draft ?? true}; exit 0 ;;`,
        '  *"release view"*) exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(dir, "SHA256SUMS.txt"), "");
    const result = run(
      ["github-release", dir, options.tag ?? tag, options.version ?? version],
      { PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
    );
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {
      // gh was not run
    }
    return { ...result, calls };
  }

  it("publishes to simplexai-labs/linger by default", () => {
    const result = release({
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GITHUB_SHA: "abc123",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`release create ${tag} `);
    expect(result.calls).toContain("--repo simplexai-labs/linger");
    expect(result.calls).toContain("--target abc123");
    expect(result.calls).toContain("--prerelease");
    expect(result.calls).not.toContain("--latest");
  });

  it("creates a draft and publishes it once every file is attached", () => {
    const result = release({
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toMatch(/release create \S+ .*--draft/);
    expect(result.calls).toContain(
      `release edit ${tag} --repo simplexai-labs/linger --draft=false --prerelease`,
    );
  });

  it("leaves the draft unpublished when a file is missing", () => {
    const result = release(
      { GITHUB_REPOSITORY: "simplexai-labs/linger", GH_TOKEN: "token" },
      { files: 0 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stays unpublished");
    expect(result.calls).not.toContain("release edit");
  });

  it("keeps the draft when RELEASE_DRAFT is true", () => {
    const result = release({
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GH_TOKEN: "token",
      RELEASE_DRAFT: "true",
    });

    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("release edit");
    expect(result.stdout).toContain("left the");
  });

  it("uses the notes file when it has content", () => {
    const notes = join(folder(), "notes.md");
    writeFileSync(notes, "## Highlights\n");
    const withFile = release({
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GH_TOKEN: "token",
      RELEASE_NOTES_FILE: notes,
    });
    writeFileSync(notes, "");
    const emptyFile = release({
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GH_TOKEN: "token",
      RELEASE_NOTES_FILE: notes,
    });

    expect(withFile.calls).toContain(`--notes-file ${notes}`);
    expect(emptyFile.calls).not.toContain("--notes-file");
    expect(emptyFile.calls).toContain("--notes ");
  });

  it("leaves another repository's commit out of a cross-repository release", () => {
    const result = release({
      GITHUB_REPOSITORY: "example/linger-copy",
      GITHUB_SHA: "abc123",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain("--repo simplexai-labs/linger");
    expect(result.calls).not.toContain("abc123");
  });

  it("marks a stable release as the latest", () => {
    const result = release(
      { GITHUB_REPOSITORY: "simplexai-labs/linger", GH_TOKEN: "token" },
      { tag: "desktop-v1.0.0", version: "1.0.0" },
    );

    expect(result.status).toBe(0);
    expect(result.calls).toContain("--latest");
    expect(result.calls).toContain("--draft=false --latest");
  });

  it("needs LINGER_RELEASE_TOKEN to publish from another repository", () => {
    const result = release({ GITHUB_REPOSITORY: "example/linger-copy" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINGER_RELEASE_TOKEN");
    expect(result.calls).toBe("");
  });

  it("refuses a RELEASE_REPO that is not owner/name", () => {
    const result = release({
      RELEASE_REPO: "https://github.com/simplexai-labs/linger",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("owner/name");
  });
});
