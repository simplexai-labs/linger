import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

// A Node child on Windows keeps its inherited stdin pipe open after closing fd 0
// or destroying process.stdin, so the fixture cannot make the write fail there.
it.skipIf(process.platform === "win32")(
  "a closed native login stdin reports failure without crashing the manager and permits retry",
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "runtime-stdin-"));
    try {
      const native = path.join(home, "native.cjs");
      const codes = path.join(home, "codes.txt");
      const repeat = path.join(home, "repeat-url");
      const repeated = path.join(home, "repeated-url");
      await writeFile(
        native,
        `
const fs = require('node:fs');
if (process.argv[2] === 'closed') fs.closeSync(0);
else process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(codes)}, chunk));
console.log('https://claude.com/cai/oauth/authorize?state=fixture');
if (process.argv[2] === 'closed') {
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(repeat)})) return;
    clearInterval(timer);
    process.stdout.write('https://claude.com/cai/oauth/authorize?state=after-error\\n', () => fs.writeFileSync(${JSON.stringify(repeated)}, 'done'));
  }, 10);
}
setTimeout(() => process.exit(0), 5000);
`,
      );
      const program = path.join(home, "manager.mts");
      await writeFile(
        program,
        `
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeLoginManager } from ${JSON.stringify(new URL("./runtime-login.ts", import.meta.url).href)};
let mode = 'closed';
const manager = new RuntimeLoginManager(async () => ({
  runtime: 'claude', executable: process.execPath, installed: true, ready: false, loginCommand: 'unused',
  descriptor: {
    runtime: 'claude', executable: process.execPath, argvPrefix: [], installed: true, authenticated: false, authMode: null,
    loginCommand: { executable: process.execPath, args: [${JSON.stringify(native)}, mode], env: {} },
  },
}), 'linux');
const input = { instance: 'default', home: ${JSON.stringify(home)}, root: ${JSON.stringify(home)}, runtime: 'claude' };
async function waitFor(check) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await delay(10); }
  throw new Error('fixture did not become ready');
}
try {
  await manager.start(input);
  await waitFor(async () => (await manager.status(input)).acceptsCode);
  let failure;
  try { await manager.start(input, 'fixture-code'); } catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /Native sign-in could not accept the authorization code/);
  await waitFor(async () => (await manager.status(input)).state === 'failed');
  await writeFile(${JSON.stringify(repeat)}, 'repeat');
  await waitFor(async () => (await readFile(${JSON.stringify(repeated)}, 'utf8').catch(() => '')) === 'done');
  await delay(0);
  assert.equal((await manager.status(input)).state, 'failed', 'later output must not revive a login whose stdin failed');
  mode = 'open';
  await manager.start(input);
  await waitFor(async () => (await manager.status(input)).acceptsCode);
  await manager.start(input, 'retry-code');
  await waitFor(async () => (await readFile(${JSON.stringify(codes)}, 'utf8').catch(() => '')) === 'retry-code\\n');
  console.log('manager survived and retried');
} finally { manager.close(); }
`,
      );
      const result = await execute(
        process.execPath,
        [
          "--import",
          pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
          program,
        ],
        { timeout: 12000, windowsHide: true },
      );
      expect(result.stdout.trim()).toBe("manager survived and retried");
      expect(result.stderr).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
