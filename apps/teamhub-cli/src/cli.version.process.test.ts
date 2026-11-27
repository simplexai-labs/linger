import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import cliPackage from "../package.json" with { type: "json" };

const exec = promisify(execFile);

it("reports the built CLI version and local fingerprint without configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "teamhub-version-"));
  const dist = path.join(directory, "dist");
  try {
    await exec(process.execPath, [
      fileURLToPath(new URL("../scripts/build-cli.mjs", import.meta.url)),
      "--outdir",
      dist,
    ]);
    const manifest = path.join(dist, "teamhub-assets.json");
    const { artifact_sha256: fingerprint } = JSON.parse(
      await readFile(manifest, "utf8"),
    ) as { artifact_sha256: string };
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    await writeFile(
      path.join(directory, "teamhub-assets.json"),
      JSON.stringify({ artifact_sha256: "0".repeat(64) }),
    );
    const version = () =>
      exec(process.execPath, [path.join(dist, "teamhub.js"), "--version"], {
        cwd: directory,
        env: { PATH: process.env.PATH },
        timeout: 10_000,
      });

    const firstLine = `teamhub ${cliPackage.version}\n`;
    expect(await version()).toEqual({
      stdout: `${firstLine}Build fingerprint: ${fingerprint}\n`,
      stderr: "",
    });

    const unavailable = {
      stdout: `${firstLine}Build fingerprint: unavailable\n`,
      stderr: "",
    };
    await writeFile(manifest, "{broken");
    expect(await version()).toEqual(unavailable);
    await writeFile(manifest, JSON.stringify({ artifact_sha256: "invalid" }));
    expect(await version()).toEqual(unavailable);

    await rm(manifest);
    expect(await version()).toEqual(unavailable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
