import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertNoFreshHarnessPi,
  probeBundledPowerShell,
  probePi,
} from "./windows-pi-smoke.mjs";

const tempDirs: string[] = [];

async function privateCwd() {
  const dir = await mkdtemp(join(tmpdir(), "linger-windows-pi-smoke-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function fixture(commands: unknown[]) {
  return `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const { id, type } = JSON.parse(line);
      console.log(JSON.stringify({
        id, type: "response", command: type, success: true,
        data: type === "get_commands" ? { commands: ${JSON.stringify(commands)} } : {},
      }));
    });
  `;
}

it("passes only after the state reply and MCP extension registration", async () => {
  const cwd = await privateCwd();
  const script = fixture([{ name: "mcp", source: "extension" }]);
  await expect(
    probePi(process.execPath, ["-e", script], { cwd }),
  ).resolves.toBeUndefined();
});

it("rejects state success when the packaged extension did not load", async () => {
  const cwd = await privateCwd();
  const script = fixture([{ name: "mcp", source: "prompt" }]);
  await expect(
    probePi(process.execPath, ["-e", script], { cwd }),
  ).rejects.toThrow("the managed MCP command was not registered");
});

it("retains bounded startup diagnostics on real subprocess exit", async () => {
  const cwd = await privateCwd();
  await expect(
    probePi(
      process.execPath,
      ["-e", 'console.error("Cannot find module jiti"); process.exitCode = 1'],
      { cwd },
    ),
  ).rejects.toThrow(
    /process closed before handshake \(exit 1\)\nCannot find module jiti/,
  );
});

it("kills a silent probe at its deadline", async () => {
  const cwd = await privateCwd();
  await expect(
    probePi(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd },
      200,
    ),
  ).rejects.toThrow("RPC deadline exceeded");
});

it("verifies that bundled Pi was reused without a fresh harness download", async () => {
  const home = await privateCwd();
  await expect(assertNoFreshHarnessPi(home)).resolves.toBeUndefined();

  const piRoot = join(home, "runtime", "harness", "tools", "pi");
  await mkdir(join(piRoot, "1.5.2"), { recursive: true });
  await expect(assertNoFreshHarnessPi(home)).resolves.toBeUndefined();

  await writeFile(join(piRoot, "1.5.2", "pi.exe"), "MZ");
  await expect(assertNoFreshHarnessPi(home)).rejects.toThrow(
    "Expected bundled Pi reuse",
  );
});

async function writeExecutableNodeShim(dir: string, scriptBody: string) {
  const scriptPath = join(dir, "fixture-pwsh.cjs");
  await writeFile(scriptPath, scriptBody);
  if (process.platform === "win32") {
    const cmdPath = join(dir, "fixture-pwsh.cmd");
    await writeFile(
      cmdPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
    return cmdPath;
  }
  const shPath = join(dir, "fixture-pwsh.sh");
  await writeFile(
    shPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
  );
  await chmod(shPath, 0o755);
  return shPath;
}

it("verifies bundled PowerShell version and native JSON argument preservation", async () => {
  const dir = await privateCwd();
  const pwsh = await writeExecutableNodeShim(
    dir,
    `
      const cmd = process.argv[process.argv.length - 1] ?? "";
      if (cmd.includes("$PSVersionTable.PSVersion.ToString()")) {
        process.stdout.write("7.6.10\\n");
      } else {
        process.stdout.write('[{"question":"a b"}]');
      }
    `,
  );
  await expect(
    probeBundledPowerShell(pwsh, { nodeExecutable: process.execPath }),
  ).resolves.toBeUndefined();
});

it("rejects unexpected bundled PowerShell version or stripped JSON quotes", async () => {
  const dir = await privateCwd();
  const wrongVersion = await writeExecutableNodeShim(
    dir,
    'process.stdout.write("5.1.22621\\n");',
  );
  await expect(probeBundledPowerShell(wrongVersion)).rejects.toThrow(
    "expected version 7.6.10, got 5.1.22621",
  );

  const strippedQuotes = await writeExecutableNodeShim(
    dir,
    `
      const cmd = process.argv[process.argv.length - 1] ?? "";
      if (cmd.includes("$PSVersionTable.PSVersion.ToString()")) {
        process.stdout.write("7.6.10\\n");
      } else {
        process.stdout.write('[{question:a');
      }
    `,
  );
  await expect(
    probeBundledPowerShell(strippedQuotes, {
      nodeExecutable: process.execPath,
    }),
  ).rejects.toThrow("native JSON argument mismatch");
});
