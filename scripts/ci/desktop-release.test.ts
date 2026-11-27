import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { SOURCE_SKELETON_FILES } from "../prepare-source-archive.mjs";

const script = join(process.cwd(), "scripts/ci/desktop-release.sh");
const temporary: string[] = [];

function run(args: string[], env: Record<string, string> = {}, file = script) {
  const result = spawnSync("bash", [file, ...args], {
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
    `Linger-${version}-macos-arm64.dmg`,
    `Linger-${version}-linux-x64.tar.gz`,
    `Linger-${version}-windows-x64-setup.exe`,
  ];

  it("lists every file of the version", () => {
    const dir = folder();
    const files = [...required, `Linger-${version}-windows-x64-portable.zip`];
    for (const name of files) writeFileSync(join(dir, name), name);
    writeFileSync(join(dir, "Linger-0.16.32-macos-arm64.dmg"), "older");
    writeFileSync(join(dir, "install.sh"), "#!/bin/sh\n");
    writeFileSync(join(dir, "install.ps1"), "# ps1\n");

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

  // The DMG names its platform like the other packages.
  it("refuses a DMG without macos in its name", () => {
    const dir = folder();
    for (const name of [`Linger-${version}-arm64.dmg`, ...required.slice(1)])
      writeFileSync(join(dir, name), name);

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Linger-${version}-macos-arm64.dmg`);
  });
});

describe("desktop-release.sh manifest", () => {
  const version = "0.16.33";
  const packages = {
    "darwin-arm64": `Linger-${version}-macos-arm64.app.tar.gz`,
    "linux-x64": `Linger-${version}-linux-x64.tar.gz`,
    "win32-x64": `Linger-${version}-windows-x64-setup.exe`,
  };
  const release = () => {
    const dir = folder();
    for (const name of Object.values(packages))
      writeFileSync(join(dir, name), name);
    writeFileSync(join(dir, `Linger-${version}-macos-arm64.dmg`), "dmg");
    return dir;
  };
  // A copy of the script beside an update-manifest.ts holding a throwaway
  // key's public half, so the test never needs the release key.
  const checkout = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const root = folder();
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/src/main"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ci/desktop-release.sh"));
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    writeFileSync(
      join(root, "apps/desktop/src/main/update-manifest.ts"),
      `export const UPDATE_PUBLIC_KEY = \`${publicPem.toString().trim()}\`;\n`,
    );
    const key = join(folder(), "update.pem");
    writeFileSync(
      key,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    return {
      script: join(root, "scripts/ci/desktop-release.sh"),
      key,
      publicKey,
    };
  };

  it("signs a manifest of every platform's package", () => {
    const dir = release();
    const repo = checkout();

    const result = run(
      ["manifest", dir, version],
      { DESKTOP_UPDATE_KEY: repo.key },
      repo.script,
    );

    expect(result.status).toBe(0);
    const bytes = readFileSync(join(dir, "manifest.json"));
    const signature = readFileSync(join(dir, "manifest.json.sig"), "utf8");
    expect(
      verify(null, bytes, repo.publicKey, Buffer.from(signature, "base64")),
    ).toBe(true);
    expect(JSON.parse(bytes.toString())).toEqual({
      schema: 2,
      version,
      packages: Object.fromEntries(
        Object.entries(packages).map(([target, file]) => [
          target,
          {
            file,
            sha256: createHash("sha256").update(file).digest("hex"),
            size: file.length,
          },
        ]),
      ),
    });

    run(["checksums", dir, version]);
    const sums = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8");
    expect(sums).toContain("  manifest.json\n");
    expect(sums).toContain("  manifest.json.sig\n");
  });

  it("warns and writes nothing without the key", () => {
    const dir = release();

    const result = run(["manifest", dir, version]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::DESKTOP_UPDATE_KEY_PEM");
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("refuses a missing key when DESKTOP_REQUIRE_UPDATE_KEY=true", () => {
    const dir = release();

    const result = run(["manifest", dir, version], {
      DESKTOP_REQUIRE_UPDATE_KEY: "true",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DESKTOP_UPDATE_KEY_PEM is required");
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("refuses a key installed apps would not accept", () => {
    const dir = release();
    // The throwaway key against this checkout's UPDATE_PUBLIC_KEY.
    const other = checkout();

    const result = run(["manifest", dir, version], {
      DESKTOP_UPDATE_KEY: other.key,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("UPDATE_PUBLIC_KEY");
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("refuses a release without a platform's package", () => {
    const dir = release();
    rmSync(join(dir, packages["darwin-arm64"]));
    const repo = checkout();

    const result = run(
      ["manifest", dir, version],
      { DESKTOP_UPDATE_KEY: repo.key },
      repo.script,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(packages["darwin-arm64"]);
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
    // A missing file:// folder fails at once; an unresolvable host would wait
    // out curl's retry backoff.
    const result = run(["fetch-native", "linux-x64"], {
      LINGER_NATIVE_POSTGRES_DIR: folder(),
      LINGER_NATIVE_DEPS_URL: `file://${folder()}/private-deps-folder`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot download");
    expect(result.stdout + result.stderr).not.toContain("private-deps-folder");
  });

  it("refuses unsigned darwin-arm64 packaging when DESKTOP_REQUIRE_MACOS_SIGNING=true", () => {
    const root = folder();
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/dist/installer"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ci/desktop-release.sh"));
    writeFileSync(
      join(root, "apps/desktop/package.json"),
      `${JSON.stringify({ name: "@linger/desktop", version: "0.0.0" }, null, 2)}\n`,
    );

    const result = run(
      ["package", "darwin-arm64"],
      {
        DESKTOP_VERSION: "1.0.0",
        DESKTOP_REQUIRE_MACOS_SIGNING: "true",
        RELEASE_OUT: folder(),
      },
      join(root, "scripts/ci/desktop-release.sh"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DESKTOP_REQUIRE_MACOS_SIGNING");
  });

  it("prepares minimal shipped and full build archives from one commit for compile", () => {
    const root = folder();
    const out = folder();
    const record = join(root, "build-env.json");
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "apps/desktop"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ci/desktop-release.sh"));
    copyFileSync(
      join(process.cwd(), "scripts/prepare-source-archive.mjs"),
      join(root, "scripts/prepare-source-archive.mjs"),
    );
    for (const relativePath of SOURCE_SKELETON_FILES) {
      const target = join(root, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        relativePath === "package.json"
          ? '{"name":"linger"}\n'
          : `${relativePath}\n`,
      );
    }
    writeFileSync(join(root, "README.md"), "full-only\n");
    writeFileSync(
      join(root, "apps/desktop/package.json"),
      `${JSON.stringify({ name: "@linger/desktop", version: "0.0.0" }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, "apps/desktop/build.mjs"),
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'const pkg = JSON.parse(readFileSync("package.json", "utf8"));',
        "writeFileSync(process.env.RECORD_FILE, JSON.stringify({",
        "  shipped: process.env.LINGER_SOURCE_ARCHIVE_FILE,",
        "  full: process.env.LINGER_BUILD_SOURCE_ARCHIVE_FILE,",
        "  target: process.env.LINGER_DESKTOP_DAEMON_TARGETS,",
        "  version: pkg.version,",
        "}));",
        "",
      ].join("\n"),
    );
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { encoding: "utf8" },
      ).trim();
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const head = git("rev-parse", "HEAD");

    const result = run(
      ["compile", "linux-x64"],
      {
        DESKTOP_VERSION: "1.2.3",
        RELEASE_OUT: out,
        RECORD_FILE: record,
      },
      join(root, "scripts/ci/desktop-release.sh"),
    );

    expect(result.status).toBe(0);
    const recorded = JSON.parse(readFileSync(record, "utf8")) as {
      shipped: string;
      full: string;
      target: string;
      version: string;
    };
    expect(recorded.target).toBe("linux-x64");
    expect(recorded.version).toBe("1.2.3");
    expect(recorded.shipped.startsWith(join(out, "source/shipped/"))).toBe(
      true,
    );
    expect(recorded.full.startsWith(join(out, "source/full/"))).toBe(true);

    const paxCommit = (archive: string) => {
      const tar = gunzipSync(readFileSync(archive));
      return /comment=([0-9a-f]{40})\n/.exec(
        tar.subarray(512, 1024).toString(),
      )?.[1];
    };
    expect(paxCommit(recorded.shipped)).toBe(head);
    expect(paxCommit(recorded.full)).toBe(head);

    const listEntries = (archive: string) =>
      execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
        .trim()
        .split("\n");
    const shippedFiles = listEntries(recorded.shipped).filter(
      (entry) => !entry.endsWith("/"),
    );
    const fullEntries = listEntries(recorded.full);
    expect(shippedFiles).toHaveLength(SOURCE_SKELETON_FILES.length);
    expect(shippedFiles.some((entry) => entry.endsWith("/README.md"))).toBe(
      false,
    );
    expect(fullEntries.some((entry) => entry.endsWith("/README.md"))).toBe(
      true,
    );
    expect(
      JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8"))
        .version,
    ).toBe("0.0.0");
  });

  function setupCompileFixture(options: {
    target?: string;
    kitBytes?: Buffer;
    writeStaleBundledKit?: boolean;
  }) {
    const target = options.target ?? "linux-x64";
    const [platform, arch] = target.split("-");
    const kitBytes = options.kitBytes ?? Buffer.from("bundled-localmodels-kit");
    const kitSha = createHash("sha256").update(kitBytes).digest("hex");
    const root = folder();
    const out = folder();
    const kitDir = folder();
    const record = join(root, "build-env.json");
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/distribution"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ci/desktop-release.sh"));
    copyFileSync(
      join(process.cwd(), "scripts/prepare-source-archive.mjs"),
      join(root, "scripts/prepare-source-archive.mjs"),
    );
    for (const relativePath of SOURCE_SKELETON_FILES) {
      const targetFile = join(root, relativePath);
      mkdirSync(dirname(targetFile), { recursive: true });
      writeFileSync(
        targetFile,
        relativePath === "package.json"
          ? '{"name":"linger"}\n'
          : `${relativePath}\n`,
      );
    }
    writeFileSync(
      join(root, "apps/desktop/package.json"),
      `${JSON.stringify({ name: "@linger/desktop", version: "0.0.0" }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, `apps/desktop/distribution/${target}.json`),
      `${JSON.stringify(
        {
          platform,
          arch,
          localmodelsTool: {
            url: `https://example.com/${target}.tgz`,
            sha256: kitSha,
            bytes: kitBytes.length,
            sourceCommit: "a".repeat(40),
            manifestSha256: "b".repeat(64),
          },
          nativeSources: [],
          voiceTools: [],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, "apps/desktop/build.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'mkdirSync("dist/installer", { recursive: true });',
        'writeFileSync("dist/installer/distribution.json", "{}");',
        ...(options.writeStaleBundledKit
          ? [
              'writeFileSync("dist/installer/bundled-localmodels-kit.tgz", "stale");',
            ]
          : []),
        "writeFileSync(process.env.RECORD_FILE, JSON.stringify({",
        "  kitDir: process.env.LINGER_BUNDLED_LOCALMODELS_KIT_DIR ?? '',",
        "}));",
        "",
      ].join("\n"),
    );
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { encoding: "utf8" },
      ).trim();
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    return {
      root,
      out,
      kitDir,
      record,
      kitBytes,
      script: join(root, "scripts/ci/desktop-release.sh"),
    };
  }

  it("stages matching <target>.tgz as bundled-localmodels-kit.tgz when LINGER_BUNDLED_LOCALMODELS_KIT_DIR is set", () => {
    const fixture = setupCompileFixture({});
    writeFileSync(join(fixture.kitDir, "linux-x64.tgz"), fixture.kitBytes);

    const result = run(
      ["compile", "linux-x64"],
      {
        DESKTOP_VERSION: "1.2.3",
        RELEASE_OUT: fixture.out,
        RECORD_FILE: fixture.record,
        LINGER_BUNDLED_LOCALMODELS_KIT_DIR: fixture.kitDir,
      },
      fixture.script,
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(fixture.record, "utf8"))).toEqual({
      kitDir: fixture.kitDir,
    });
    const staged = join(
      fixture.root,
      "apps/desktop/dist/installer/bundled-localmodels-kit.tgz",
    );
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(staged)).toEqual(fixture.kitBytes);
  });

  it("fails closed when LINGER_BUNDLED_LOCALMODELS_KIT_DIR has a missing, symlink, or mismatched archive", () => {
    const fixture = setupCompileFixture({});

    // Missing file.
    const missing = run(
      ["compile", "linux-x64"],
      {
        DESKTOP_VERSION: "1.2.3",
        RELEASE_OUT: fixture.out,
        RECORD_FILE: fixture.record,
        LINGER_BUNDLED_LOCALMODELS_KIT_DIR: fixture.kitDir,
      },
      fixture.script,
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("regular non-symlink file");
    expect(existsSync(fixture.record)).toBe(false);

    // Wrong size.
    writeFileSync(join(fixture.kitDir, "linux-x64.tgz"), "wrong");
    const wrongSize = run(
      ["compile", "linux-x64"],
      {
        DESKTOP_VERSION: "1.2.3",
        RELEASE_OUT: fixture.out,
        RECORD_FILE: fixture.record,
        LINGER_BUNDLED_LOCALMODELS_KIT_DIR: fixture.kitDir,
      },
      fixture.script,
    );
    expect(wrongSize.status).toBe(1);
    expect(wrongSize.stderr).toContain("size mismatch");
    expect(existsSync(fixture.record)).toBe(false);

    // Same size, wrong sha256.
    const tampered = Buffer.from(fixture.kitBytes);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    writeFileSync(join(fixture.kitDir, "linux-x64.tgz"), tampered);
    const wrongSha = run(
      ["compile", "linux-x64"],
      {
        DESKTOP_VERSION: "1.2.3",
        RELEASE_OUT: fixture.out,
        RECORD_FILE: fixture.record,
        LINGER_BUNDLED_LOCALMODELS_KIT_DIR: fixture.kitDir,
      },
      fixture.script,
    );
    expect(wrongSha.status).toBe(1);
    expect(wrongSha.stderr).toContain("sha256 mismatch");
    expect(existsSync(fixture.record)).toBe(false);

    // Symlink to valid file.
    const realFile = join(folder(), "real.tgz");
    writeFileSync(realFile, fixture.kitBytes);
    rmSync(join(fixture.kitDir, "linux-x64.tgz"));
    symlinkSync(realFile, join(fixture.kitDir, "linux-x64.tgz"));
    const linked = run(
      ["compile", "linux-x64"],
      {
        DESKTOP_VERSION: "1.2.3",
        RELEASE_OUT: fixture.out,
        RECORD_FILE: fixture.record,
        LINGER_BUNDLED_LOCALMODELS_KIT_DIR: fixture.kitDir,
      },
      fixture.script,
    );
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain("regular non-symlink file");
    expect(existsSync(fixture.record)).toBe(false);
  });

  it("removes any stale bundled-localmodels-kit.tgz when LINGER_BUNDLED_LOCALMODELS_KIT_DIR is unset", () => {
    const fixture = setupCompileFixture({ writeStaleBundledKit: true });

    const result = run(
      ["compile", "linux-x64"],
      {
        DESKTOP_VERSION: "1.2.3",
        RELEASE_OUT: fixture.out,
        RECORD_FILE: fixture.record,
      },
      fixture.script,
    );

    expect(result.status).toBe(0);
    expect(
      existsSync(
        join(
          fixture.root,
          "apps/desktop/dist/installer/bundled-localmodels-kit.tgz",
        ),
      ),
    ).toBe(false);
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

  // A gh that records its arguments and has no release yet.
  function release(env: Record<string, string>) {
    const dir = folder();
    const bin = folder();
    const log = join(dir, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >>"${log}"\n[ "$2" != view ]\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(dir, "SHA256SUMS.txt"), "");
    const result = run(["github-release", dir, tag, version], {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      ...env,
    });
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

  it("creates a stable release as a draft without marking it latest", () => {
    const dir = folder();
    const bin = folder();
    const log = join(dir, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >>"${log}"\n[ "$2" != view ]\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(dir, "SHA256SUMS.txt"), "");

    const result = run(["github-release", dir, "desktop-v1.0.0", "1.0.0"], {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("--title Linger Desktop 1.0.0 (Beta)");
    expect(calls).toContain("--draft");
    expect(calls).not.toContain("--latest");
    expect(calls).not.toContain("--prerelease");
    expect(result.stdout).toContain("publish desktop-v1.0.0 --notes-file");
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

describe("desktop-release.sh publish", () => {
  function setupPublish(assets: string[], rcTags: string[] = []) {
    const dir = folder();
    const bin = folder();
    const log = join(dir, "gh.log");
    const assetsFile = join(dir, "assets.txt");
    const rcFile = join(dir, "rc-tags.txt");
    writeFileSync(assetsFile, assets.length ? `${assets.join("\n")}\n` : "");
    writeFileSync(rcFile, rcTags.length ? `${rcTags.join("\n")}\n` : "");
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        `echo "$*" >>"${log}"`,
        'if [ "$2" = view ]; then',
        `  cat "${assetsFile}"`,
        "  exit 0",
        "fi",
        'if [ "$2" = list ]; then',
        `  cat "${rcFile}"`,
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    const notes = join(dir, "notes.md");
    writeFileSync(notes, "Linger Desktop 1.0.0\n\n## Highlights\n\n- Works.\n");
    return { bin, log, notes };
  }

  it("publishes a stable draft with notes as latest and removes matching RC prereleases", () => {
    const { bin, log, notes } = setupPublish(
      [
        "Linger-1.0.0-macos-arm64.dmg",
        "Linger-1.0.0-linux-x64.tar.gz",
        "Linger-1.0.0-windows-x64-setup.exe",
        "SHA256SUMS.txt",
      ],
      ["desktop-v1.0.0-rc.0", "desktop-v1.0.0-rc.1"],
    );

    const result = run(["publish", "desktop-v1.0.0", "--notes-file", notes], {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(
      "release view desktop-v1.0.0 --repo simplexai-labs/linger --json assets --jq .assets[].name",
    );
    expect(calls).toContain(
      `release edit desktop-v1.0.0 --repo simplexai-labs/linger --notes-file ${notes} --draft=false --latest`,
    );
    expect(calls).toContain(
      'release list --repo simplexai-labs/linger --limit 100 --json tagName,isPrerelease,isDraft --jq .[] | select(.isPrerelease and (.isDraft | not) and (.tagName | startswith("desktop-v1.0.0-rc."))) | .tagName',
    );
    expect(calls).toContain(
      "release delete desktop-v1.0.0-rc.0 --repo simplexai-labs/linger --cleanup-tag --yes",
    );
    expect(calls).toContain(
      "release delete desktop-v1.0.0-rc.1 --repo simplexai-labs/linger --cleanup-tag --yes",
    );
  });

  it("refuses to publish when a required release asset is missing", () => {
    const { bin, log, notes } = setupPublish([
      "Linger-1.0.0-macos-arm64.dmg",
      "Linger-1.0.0-linux-x64.tar.gz",
      "SHA256SUMS.txt",
    ]);

    const result = run(["publish", "desktop-v1.0.0", "--notes-file", notes], {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Linger-1.0.0-windows-x64-setup.exe");
    expect(readFileSync(log, "utf8")).not.toContain("release edit");
  });

  it("refuses prerelease tags and empty notes files", () => {
    const { bin, notes } = setupPublish([]);
    const emptyNotes = join(folder(), "empty.md");
    writeFileSync(emptyNotes, "   \n");

    const pre = run(["publish", "desktop-v1.0.0-rc.1", "--notes-file", notes], {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    });
    expect(pre.status).toBe(1);
    expect(pre.stderr).toContain("not prereleases");

    const empty = run(
      ["publish", "desktop-v1.0.0", "--notes-file", emptyNotes],
      {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
    );
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("empty");
  });
});

describe("desktop-release.sh package Docker images", () => {
  const version = "1.2.3";
  const dockerfile = "FROM ubuntu:24.04\n";
  const dockerfileSha = createHash("sha256").update(dockerfile).digest("hex");

  function setupPackage(dockerScript: string) {
    const root = folder();
    const bin = folder();
    const out = folder();
    const log = join(root, "docker.log");
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/dist/installer"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/packaging/mac"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ci/desktop-release.sh"));
    writeFileSync(
      join(root, "apps/desktop/package.json"),
      `${JSON.stringify({ name: "@linger/desktop", version: "0.0.0" }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, "apps/desktop/packaging/mac/Dockerfile"),
      dockerfile,
    );
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\necho "$*" >>"${log}"\n${dockerScript}\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(
      join(bin, "python3"),
      [
        "#!/bin/sh",
        'out=""',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = --out ]; then out="$2"; shift 2; continue; fi',
        "  shift",
        "done",
        'mkdir -p "$out"',
        `: >"$out/Linger-${version}-arm64.dmg"`,
        `: >"$out/Linger-${version}-arm64.app.tar.gz"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "python3"), 0o755);
    return {
      script: join(root, "scripts/ci/desktop-release.sh"),
      bin,
      out,
      log,
    };
  }

  it("reuses a locally cached packaging image when its Dockerfile sha matches", () => {
    const fixture = setupPackage(
      `if [ "$1" = image ] && [ "$2" = inspect ]; then echo "${dockerfileSha}"; exit 0; fi\nexit 1`,
    );

    const result = run(
      ["package", "darwin-arm64"],
      {
        PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
        DESKTOP_VERSION: version,
        RELEASE_OUT: fixture.out,
        DESKTOP_PACKAGING_IMAGE_PREFIX: "ghcr.io/simplexai-labs/linger/desktop",
      },
      fixture.script,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reusing cached Docker image dmgtool");
    const calls = readFileSync(fixture.log, "utf8");
    expect(calls).not.toContain("pull ");
    expect(calls).not.toContain("build ");
  });

  it("pulls and tags the prebuilt GHCR image before building locally", () => {
    const fixture = setupPackage(
      [
        'if [ "$1" = image ] && [ "$2" = inspect ]; then exit 1; fi',
        'if [ "$1" = pull ] || [ "$1" = tag ]; then exit 0; fi',
        "exit 1",
      ].join("\n"),
    );
    const remote = `ghcr.io/simplexai-labs/linger/desktop-dmgtool:${dockerfileSha}`;

    const result = run(
      ["package", "darwin-arm64"],
      {
        PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
        DESKTOP_VERSION: version,
        RELEASE_OUT: fixture.out,
        DESKTOP_PACKAGING_IMAGE_PREFIX:
          "ghcr.io/simplexai-labs/linger/desktop/",
      },
      fixture.script,
    );

    expect(result.status).toBe(0);
    const calls = readFileSync(fixture.log, "utf8");
    expect(calls).toContain(`pull ${remote}`);
    expect(calls).toContain(`tag ${remote} dmgtool`);
    expect(calls).not.toContain("build ");
  });

  it("falls back to a visible docker build when pulling the prebuilt image fails", () => {
    const fixture = setupPackage(
      [
        'if [ "$1" = image ] && [ "$2" = inspect ]; then exit 1; fi',
        'if [ "$1" = pull ]; then exit 1; fi',
        'if [ "$1" = build ]; then exit 0; fi',
        "exit 1",
      ].join("\n"),
    );

    const result = run(
      ["package", "darwin-arm64"],
      {
        PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
        DESKTOP_VERSION: version,
        RELEASE_OUT: fixture.out,
        DESKTOP_PACKAGING_IMAGE_PREFIX: "ghcr.io/simplexai-labs/linger/desktop",
      },
      fixture.script,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("building dmgtool locally");
    const calls = readFileSync(fixture.log, "utf8");
    expect(calls).toContain(
      `build --label linger.dockerfile.sha256=${dockerfileSha} -t dmgtool`,
    );
    expect(calls).not.toContain("build -q");
  });
});
