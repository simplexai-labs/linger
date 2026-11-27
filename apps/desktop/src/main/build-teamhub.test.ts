import { execFileSync, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";

import { afterEach, expect, it, vi } from "vitest";

import {
  buildTeamhub,
  sourceCommit,
  verifyTeamhub,
} from "../../scripts/build-teamhub.mjs";

// Keep Git's archive and tar's extraction real. Stub only Go compilation:
// an executable fixture implemented as a Node shebang cannot run on Windows.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      if (command !== "go") return actual.spawn(command, args, options);
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
      };
      child.stdout = new PassThrough();
      if (args[0] === "env" && args[1] === "GOVERSION") {
        process.nextTick(() => {
          child.stdout.end("go1.26.5\n");
          child.emit("close", 0);
        });
      } else {
        const output = args[args.indexOf("-o") + 1];
        if (args[0] !== "build" || !args.includes("-o") || !output)
          throw new Error("Unexpected Go invocation in build fixture");
        writeFileSync(
          output,
          JSON.stringify({
            args,
            goos: options.env?.GOOS,
            goarch: options.env?.GOARCH,
            cgo: options.env?.CGO_ENABLED,
            cwd: options.cwd,
          }),
        );
        process.nextTick(() => child.emit("close", 0));
      }
      return child;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// A source package as scripts/prepare-source-archive.mjs makes it, from a
// one-commit repository.
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "build-teamhub-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "apps/teamhub/cmd/teamhub"), { recursive: true });
  writeFileSync(path.join(repo, "apps/teamhub/go.mod"), "module teamhub\n");
  writeFileSync(
    path.join(repo, "apps/teamhub/cmd/teamhub/main.go"),
    "package main\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "source",
  );
  const packageSource = (output: string, ref: string, paths: string[] = []) => {
    const tar = execFileSync("git", [
      "-C",
      repo,
      "archive",
      "--format=tar",
      "--prefix=linger-test/",
      ref,
      ...(paths.length ? ["--", ...paths] : []),
    ]);
    writeFileSync(output, gzipSync(tar));
  };
  const archive = path.join(root, "linger-test.tar.gz");
  packageSource(archive, "HEAD");
  return {
    root,
    repo,
    archive,
    packageSource,
    git,
    commit: git("rev-parse", "HEAD"),
  };
};

it("reads the commit git archive records in a source package", async () => {
  const f = fixture();
  expect(await sourceCommit(f.archive)).toBe(f.commit);
  const plain = path.join(f.root, "plain.tar.gz");
  // Git only adds the global commit header when given a commit, not a tree.
  f.packageSource(plain, "HEAD^{tree}");
  await expect(sourceCommit(plain)).rejects.toThrow(
    "does not record its commit",
  );
});

it("builds each TeamHub command for Windows from the source package", async () => {
  const f = fixture();
  const output = path.join(f.root, "out");
  const manifest = await buildTeamhub("win32-x64", f.archive, output);
  expect(manifest).toMatchObject({
    target: "win32-x64",
    sourceCommit: f.commit,
    goVersion: "1.26.5",
  });
  expect(Object.keys(manifest.binaries)).toEqual([
    "teamhub",
    "migrate",
    "account",
  ]);
  const built = JSON.parse(
    readFileSync(path.join(output, "migrate.exe"), "utf8"),
  );
  expect(built).toMatchObject({ goos: "windows", goarch: "amd64", cgo: "0" });
  expect(built.args).toEqual([
    "build",
    "-trimpath",
    "-ldflags",
    "-s -w",
    "-o",
    path.join(output, "migrate.exe"),
    "./cmd/migrate",
  ]);
  expect(path.basename(path.dirname(built.cwd))).toBe("apps");
  // The packaging check refuses a changed binary or another source package.
  await expect(
    verifyTeamhub(output, "win32-x64", "0".repeat(64)),
  ).rejects.toThrow("another target or source package");
  writeFileSync(path.join(output, "account.exe"), "changed");
  await expect(
    verifyTeamhub(output, "win32-x64", manifest.sourceArchiveSha256),
  ).rejects.toThrow("account.exe does not match");
}, 30_000);

it("stamps the shipped archive digest when compiling from a separate full archive of the same commit", async () => {
  const f = fixture();
  const shippedArchive = path.join(f.root, "linger-minimal.tar.gz");
  f.packageSource(shippedArchive, "HEAD", ["apps/teamhub/go.mod"]);
  const fullSha256 = createHash("sha256")
    .update(readFileSync(f.archive))
    .digest("hex");
  const shippedSha256 = createHash("sha256")
    .update(readFileSync(shippedArchive))
    .digest("hex");
  expect(shippedSha256).not.toBe(fullSha256);

  const output = path.join(f.root, "out-shipped");
  const manifest = await buildTeamhub("win32-x64", f.archive, output, {
    shippedArchive,
  });

  expect(manifest.sourceCommit).toBe(f.commit);
  expect(manifest.sourceArchiveSha256).toBe(shippedSha256);
  await expect(
    verifyTeamhub(output, "win32-x64", shippedSha256),
  ).resolves.toEqual(manifest);
  await expect(verifyTeamhub(output, "win32-x64", fullSha256)).rejects.toThrow(
    "another target or source package",
  );
}, 30_000);

it("refuses a shipped archive from a different commit before touching output", async () => {
  const f = fixture();
  writeFileSync(path.join(f.repo, "apps/teamhub/go.mod"), "module teamhub2\n");
  f.git("add", ".");
  f.git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "second",
  );
  const otherArchive = path.join(f.root, "linger-other.tar.gz");
  f.packageSource(otherArchive, "HEAD", ["apps/teamhub/go.mod"]);

  const output = path.join(f.root, "existing-out");
  mkdirSync(output, { recursive: true });
  const sentinel = path.join(output, "sentinel.txt");
  writeFileSync(sentinel, "keep");

  await expect(
    buildTeamhub("win32-x64", f.archive, output, {
      shippedArchive: otherArchive,
    }),
  ).rejects.toThrow(
    /Shipped source archive commit .* does not match build source archive/,
  );
  expect(existsSync(sentinel)).toBe(true);
}, 30_000);
