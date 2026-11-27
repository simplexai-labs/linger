import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateToolSource } from "@linger/local-installation/localmodels-tool";
import {
  validateNativeSource,
  validateNativeVoiceTools,
} from "@linger/local-installation/native-dependencies";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_LOCALMODELS_KIT_FILENAME,
  stageBundledLocalmodelsKit,
} from "../../scripts/stage-bundled-localmodels-kit.mjs";

// The tracked distribution/<target>.json that build.mjs puts beside the
// bundled installer.
const desktop = fileURLToPath(new URL("../..", import.meta.url));
const read = (target: string) =>
  JSON.parse(
    readFileSync(path.join(desktop, "distribution", `${target}.json`), "utf8"),
  ) as {
    platform: string;
    arch: string;
    localmodelsTool: {
      url: string;
      sha256: string;
      sourceCommit: string;
      runtimeVersions: Record<string, string>;
      runtimeBaselines: Record<string, string>;
    };
    nativeSources: unknown[];
    voiceTools: unknown[];
  };

// The localmodels release scripts/installs/stack.sh pins; the installer pins
// the same one by convention.
const stack = readFileSync(
  path.join(desktop, "../../scripts/installs/stack.sh"),
  "utf8",
);
const pin = (name: string) =>
  new RegExp(`^${name}='([^']+)'$`, "m").exec(stack)?.[1];
// The release pins a Runtime set as `claude=2.1.311 codex=0.171.0 pi=1.5.2`.
const runtimes = (name: string) =>
  Object.fromEntries(
    (pin(name) ?? "").split(" ").map((entry) => entry.split("=")),
  );

describe("desktop distributions", () => {
  // Native installs need PostgreSQL and the voice tools for their target.
  // Every target bundles them beside the installer (build.mjs copies it), so they need no network.
  for (const [target, bundled] of [
    ["darwin-arm64", true],
    ["linux-x64", true],
    ["win32-x64", true],
  ] as const)
    it(`pins ${target}`, () => {
      const value = read(target);
      expect(`${value.platform}-${value.arch}`).toBe(target);
      const sources = value.nativeSources.map((source) =>
        validateNativeSource(source, "/installer"),
      );
      expect(sources.map((source) => source.target)).toEqual([target]);
      expect(sources.map((source) => source.file !== undefined)).toEqual([
        bundled,
      ]);
      // Voice runs LiveKit and ffmpeg from the bundle, offline too.
      const voice = value.voiceTools.map((source) =>
        validateNativeVoiceTools(source, "/installer"),
      );
      expect(
        voice.map((source) => [source.target, source.file !== undefined]),
      ).toEqual([[target, true]]);
      const tool = validateToolSource(value.localmodelsTool);
      expect(tool.url.endsWith(`/${pin("STACK_VERSION")}/${target}.tgz`)).toBe(
        true,
      );
      expect(value.localmodelsTool.sourceCommit).toBe(
        pin("STACK_SOURCE_COMMIT"),
      );
      // The Daemon's Go tests check these against its Runtime minimums, so
      // they must be the pinned release's, not a hand-entered copy.
      expect(value.localmodelsTool.runtimeVersions).toEqual(
        runtimes("STACK_RUNTIMES"),
      );
      expect(value.localmodelsTool.runtimeBaselines).toEqual(
        runtimes("STACK_RUNTIME_BASELINES"),
      );
      const kit = pin(`STACK_KIT_${target.replace("-", "_")}`);
      if (kit) expect(tool.sha256).toBe(kit);
      // The same kit as published on npm (and its China mirror), in the
      // stack's npm version; the pinned sha256 decides either way.
      const name = `localmodels-${target}`;
      const version = pin("STACK_NPM_VERSION");
      expect(tool.mirrors).toEqual([
        `https://registry.npmjs.org/@simplexai/${name}/-/${name}-${version}.tgz`,
        `https://cdn.npmmirror.com/packages/@simplexai/${name}/${version}/${name}-${version}.tgz`,
      ]);
    });
});

describe("stageBundledLocalmodelsKit", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function workspace() {
    const root = await mkdtemp(path.join(os.tmpdir(), "linger-bundled-kit-"));
    dirs.push(root);
    const kitDir = path.join(root, "kits");
    const installerDir = path.join(root, "dist", "installer");
    await mkdir(kitDir, { recursive: true });
    await mkdir(installerDir, { recursive: true });
    return { root, kitDir, installerDir };
  }

  it("stages a verified <target>.tgz as bundled-localmodels-kit.tgz", async () => {
    const { kitDir, installerDir } = await workspace();
    const payload = Buffer.from("fake-localmodels-kit-archive");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await writeFile(path.join(kitDir, "linux-x64.tgz"), payload);

    const staged = await stageBundledLocalmodelsKit({
      kitDir,
      distribution: {
        platform: "linux",
        arch: "x64",
        localmodelsTool: { sha256, bytes: payload.length },
      },
      installerDir,
    });

    const destination = path.join(
      installerDir,
      BUNDLED_LOCALMODELS_KIT_FILENAME,
    );
    expect(staged).toEqual({
      source: path.join(kitDir, "linux-x64.tgz"),
      destination,
      target: "linux-x64",
      bytes: payload.length,
      sha256,
    });
    expect(await readFile(destination)).toEqual(payload);
  });

  it("removes any stale bundled-localmodels-kit.tgz when LINGER_BUNDLED_LOCALMODELS_KIT_DIR is unset or empty", async () => {
    const { installerDir } = await workspace();
    const stale = path.join(installerDir, BUNDLED_LOCALMODELS_KIT_FILENAME);
    await writeFile(stale, "stale");

    expect(
      await stageBundledLocalmodelsKit({
        kitDir: undefined,
        distribution: undefined,
        installerDir,
      }),
    ).toBeNull();
    expect(existsSync(stale)).toBe(false);

    await writeFile(stale, "stale-2");
    expect(
      await stageBundledLocalmodelsKit({
        kitDir: "   ",
        distribution: undefined,
        installerDir,
      }),
    ).toBeNull();
    expect(existsSync(stale)).toBe(false);
  });

  it("fails closed when <target>.tgz is missing, mismatched, or a symlink", async () => {
    const { root, kitDir, installerDir } = await workspace();
    const payload = Buffer.from("expected-kit-bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const dist = {
      platform: "darwin",
      arch: "arm64",
      localmodelsTool: { sha256, bytes: payload.length },
    };
    const destination = path.join(
      installerDir,
      BUNDLED_LOCALMODELS_KIT_FILENAME,
    );

    await expect(
      stageBundledLocalmodelsKit({
        kitDir,
        distribution: dist,
        installerDir,
      }),
    ).rejects.toThrow(/does not exist/i);
    expect(existsSync(destination)).toBe(false);

    // Wrong size.
    await writeFile(
      path.join(kitDir, "darwin-arm64.tgz"),
      Buffer.from("short"),
    );
    await expect(
      stageBundledLocalmodelsKit({
        kitDir,
        distribution: dist,
        installerDir,
      }),
    ).rejects.toThrow(/size mismatch/i);
    expect(existsSync(destination)).toBe(false);

    // Same size, wrong sha256.
    const tampered = Buffer.from(payload);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await writeFile(path.join(kitDir, "darwin-arm64.tgz"), tampered);
    await expect(
      stageBundledLocalmodelsKit({
        kitDir,
        distribution: dist,
        installerDir,
      }),
    ).rejects.toThrow(/sha256 mismatch/i);
    expect(existsSync(destination)).toBe(false);

    // Symlink to valid file.
    if (process.platform !== "win32") {
      const real = path.join(root, "real.tgz");
      await writeFile(real, payload);
      await rm(path.join(kitDir, "darwin-arm64.tgz"));
      await symlink(real, path.join(kitDir, "darwin-arm64.tgz"));
      await expect(
        stageBundledLocalmodelsKit({
          kitDir,
          distribution: dist,
          installerDir,
        }),
      ).rejects.toThrow(/regular non-symlink/i);
      expect(existsSync(destination)).toBe(false);
    }

    // Missing resolved distribution when kitDir is set.
    await expect(
      stageBundledLocalmodelsKit({
        kitDir,
        distribution: undefined,
        installerDir,
      }),
    ).rejects.toThrow(/distribution\.json/i);
  });
});
