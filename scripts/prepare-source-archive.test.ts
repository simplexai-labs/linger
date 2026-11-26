import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  SOURCE_SKELETON_FILES,
  parseSourceArchiveArguments,
  prepareSourceArchive,
  sourceArchiveEnvironment,
} from "./prepare-source-archive.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  });

const repository = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "source-archive-"));
  temporary.push(root);
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts/source-native.mjs"), "");
  writeFileSync(path.join(root, "README.md"), "linger\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "--date=2026-01-01T00:00:00Z", "-m", "init");
  git(root, "tag", "v1.0.0");
  return root;
};

const skeletonRepository = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "source-archive-minimal-"));
  temporary.push(root);
  for (const relativePath of SOURCE_SKELETON_FILES) {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      relativePath === "package.json"
        ? '{"name":"linger"}\n'
        : `${relativePath}\n`,
    );
  }
  mkdirSync(path.join(root, "apps/teamhub/cmd/teamhub"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/teamhub/cmd/teamhub/main.go"),
    "package main\n",
  );
  writeFileSync(path.join(root, "README.md"), "linger\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "--date=2026-01-01T00:00:00Z", "-m", "init");
  git(root, "tag", "v1.0.0");
  return root;
};

const paxCommit = (archive: string) => {
  const tar = gunzipSync(readFileSync(archive));
  if (tar[156] !== "g".charCodeAt(0)) return undefined;
  return /comment=([0-9a-f]{40})\n/.exec(
    tar.subarray(512, 1024).toString(),
  )?.[1];
};

describe("source archive", () => {
  it("packs one tag under a single folder with a stable digest", async () => {
    const root = repository();
    const output = path.join(root, "out");
    const args = [
      "--ref",
      "v1.0.0",
      "--output",
      output,
      "--url-base",
      "https://github.com/simplexai-labs/linger/releases/download/v1.0.0",
    ];
    // Uncommitted changes never reach the archive.
    writeFileSync(path.join(root, "README.md"), "dirty\n");
    const first = await prepareSourceArchive(args, { cwd: root });
    const bytes = readFileSync(first.archive);
    expect(path.basename(first.archive)).toBe("linger-v1.0.0.tar.gz");
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(`${first.archive}.sha256`, "utf8")).toBe(
      `${first.sha256}  linger-v1.0.0.tar.gz\n`,
    );
    expect(
      execFileSync("tar", ["-tzf", first.archive], { encoding: "utf8" })
        .trim()
        .split("\n")
        .sort(),
    ).toEqual([
      "linger-v1.0.0/",
      "linger-v1.0.0/README.md",
      "linger-v1.0.0/scripts/",
      "linger-v1.0.0/scripts/source-native.mjs",
    ]);
    expect(
      execFileSync("tar", ["-xzOf", first.archive, "linger-v1.0.0/README.md"], {
        encoding: "utf8",
      }),
    ).toBe("linger\n");

    const second = await prepareSourceArchive(args, { cwd: root });
    expect(second.sha256).toBe(first.sha256);
    expect(await sourceArchiveEnvironment(output)).toEqual({
      LINGER_SOURCE_ARCHIVE_URL:
        "https://github.com/simplexai-labs/linger/releases/download/v1.0.0/linger-v1.0.0.tar.gz",
      LINGER_SOURCE_ARCHIVE_SHA256: first.sha256,
    });
  });

  it("names a non-tag ref after its commit", async () => {
    const root = repository();
    const result = await prepareSourceArchive(
      ["--output", path.join(root, "out")],
      { cwd: root },
    );
    expect(path.basename(result.archive)).toBe(
      `linger-${result.commit.slice(0, 12)}.tar.gz`,
    );
  });

  it("refuses a ref without the native source entry", async () => {
    const root = repository();
    git(root, "rm", "-q", "scripts/source-native.mjs");
    git(root, "commit", "-q", "-m", "drop");
    await expect(
      prepareSourceArchive(["--output", path.join(root, "out")], { cwd: root }),
    ).rejects.toThrow(/no scripts\/source-native\.mjs/);
  });

  it("packs only the runtime skeleton in minimal mode with a stable digest and commit header", async () => {
    const root = skeletonRepository();
    const output = path.join(root, "out-minimal");
    const args = ["--ref", "v1.0.0", "--mode", "minimal", "--output", output];
    // Uncommitted working-tree edits never reach the minimal archive.
    writeFileSync(path.join(root, "package.json"), '{"name":"dirty"}\n');

    const first = await prepareSourceArchive(args, { cwd: root });
    const bytes = readFileSync(first.archive);
    expect(first.mode).toBe("minimal");
    expect(path.basename(first.archive)).toBe("linger-v1.0.0.tar.gz");
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(paxCommit(first.archive)).toBe(first.commit);
    expect(
      execFileSync("tar", ["-tzf", first.archive], { encoding: "utf8" })
        .trim()
        .split("\n")
        .sort(),
    ).toEqual([
      "linger-v1.0.0/",
      "linger-v1.0.0/.env.example",
      "linger-v1.0.0/apps/",
      "linger-v1.0.0/apps/teamhub/",
      "linger-v1.0.0/apps/teamhub/go.mod",
      "linger-v1.0.0/package.json",
      "linger-v1.0.0/scripts/",
      "linger-v1.0.0/scripts/env-inventory.json",
      "linger-v1.0.0/scripts/local-defaults.env",
      "linger-v1.0.0/scripts/replace-process.mjs",
      "linger-v1.0.0/scripts/source-native.mjs",
      "linger-v1.0.0/scripts/with-local-env.mjs",
    ]);
    expect(
      execFileSync(
        "tar",
        ["-xzOf", first.archive, "linger-v1.0.0/package.json"],
        { encoding: "utf8" },
      ),
    ).toBe('{"name":"linger"}\n');

    const second = await prepareSourceArchive(args, { cwd: root });
    expect(second.sha256).toBe(first.sha256);
  });

  it("refuses minimal mode when any required skeleton file is missing", async () => {
    const root = skeletonRepository();
    git(root, "rm", "-q", "scripts/env-inventory.json", "apps/teamhub/go.mod");
    git(root, "commit", "-q", "-m", "drop skeleton files");
    await expect(
      prepareSourceArchive(
        ["--mode", "minimal", "--output", path.join(root, "out-minimal")],
        { cwd: root },
      ),
    ).rejects.toThrow(/apps\/teamhub\/go\.mod.*scripts\/env-inventory\.json/);
  });

  it("validates its arguments", () => {
    expect(parseSourceArchiveArguments([]).mode).toBe("full");
    expect(parseSourceArchiveArguments(["--mode", "minimal"]).mode).toBe(
      "minimal",
    );
    expect(() => parseSourceArchiveArguments(["--mode", "partial"])).toThrow(
      /--mode must be full or minimal/,
    );
    expect(() => parseSourceArchiveArguments(["--mode"])).toThrow(
      /--mode requires a value/,
    );
    expect(() => parseSourceArchiveArguments(["--tag", "x"])).toThrow(
      /Unknown/,
    );
    expect(() =>
      parseSourceArchiveArguments(["--url-base", "http://example.com"]),
    ).toThrow(/https/);
    expect(() => parseSourceArchiveArguments(["--label", "../x"])).toThrow(
      /plain file name/,
    );
  });
});
