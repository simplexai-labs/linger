import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuntimeLoginManager } from "./runtime-login.js";
vi.mock("@linger/local-installation/managed-codex", () => ({
  managedRuntimeEnvironment: async () => ({}),
}));
// Fixture logins run their script through Node: Windows cannot execute a
// shebang script.
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
const oauthUrl =
  "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fixture";

// A fake Codex: `login` prints the browser link (and records whether it was
// told not to open a browser), `login --device-auth` the device page and code.
async function codex(script = "") {
  const home = await mkdtemp(path.join(tmpdir(), "runtime-method-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const exe = path.join(home, "codex");
  await writeFile(
    exe,
    `const args = process.argv.slice(2).join(' ');
${script}
if (args === 'login') console.log(${JSON.stringify(oauthUrl)} + (process.env.BROWSER === 'true' ? '&quiet=1' : ''));
else if (args === 'login --device-auth') { console.log('https://auth.openai.com/codex/device'); console.log('ABCD-EFGH'); }
else process.exit(2);
setTimeout(() => {}, 5000);`,
  );
  const inspect = async () => ({
    runtime: "codex" as const,
    executable: exe,
    installed: true,
    ready: false,
    loginCommand: "unused",
    descriptor: {
      runtime: "codex" as const,
      executable: exe,
      argvPrefix: [],
      installed: true,
      authenticated: false,
      authMode: null,
      loginCommand: {
        executable: process.execPath,
        args: [exe, "login"],
        env: {},
      },
      deviceLoginCommand: {
        executable: process.execPath,
        args: [exe, "login", "--device-auth"],
        env: {},
      },
    },
  });
  const input = {
    instance: "default",
    home,
    root: home,
    runtime: "codex" as const,
  };
  return { inspect, input };
}

it("runs the browser login on Linux when asked and tells Codex not to open a browser", async () => {
  const { inspect, input } = await codex();
  const manager = new RuntimeLoginManager(inspect, "linux");
  clean.push(async () => manager.close());
  await manager.start(input, undefined, "browser");
  await expect
    .poll(async () => (await manager.status(input)).url, { timeout: 5000 })
    .toBe(oauthUrl + "&quiet=1");
  expect((await manager.status(input)).deviceCode).toBeUndefined();
}, 10000);

it("keeps Codex opening its own page when no method is asked for", async () => {
  const { inspect, input } = await codex();
  const manager = new RuntimeLoginManager(inspect, "darwin");
  clean.push(async () => manager.close());
  await manager.start(input);
  await expect
    .poll(async () => (await manager.status(input)).url, { timeout: 5000 })
    .toBe(oauthUrl);
}, 10000);

it("leaves BROWSER alone for a browser login off Linux, where Codex ignores it", async () => {
  const { inspect, input } = await codex();
  const manager = new RuntimeLoginManager(inspect, "darwin");
  clean.push(async () => manager.close());
  await manager.start(input, undefined, "browser");
  await expect
    .poll(async () => (await manager.status(input)).url, { timeout: 5000 })
    .toBe(oauthUrl);
}, 10000);

it("switches a running browser login to a device code", async () => {
  const { inspect, input } = await codex();
  const manager = new RuntimeLoginManager(inspect, "darwin");
  clean.push(async () => manager.close());
  await manager.start(input, undefined, "browser");
  await expect
    .poll(async () => (await manager.status(input)).url, { timeout: 5000 })
    .toContain("/oauth/authorize");
  await manager.start(input, undefined, "device");
  await expect
    .poll(async () => (await manager.status(input)).deviceCode, {
      timeout: 5000,
    })
    .toBe("ABCD-EFGH");
  expect((await manager.status(input)).url).toBe(
    "https://auth.openai.com/codex/device",
  );
}, 10000);

it("says a login timed out after its process is stopped", async () => {
  const { inspect, input } = await codex();
  const manager = new RuntimeLoginManager(inspect, "linux", 300);
  clean.push(async () => manager.close());
  await manager.start(input, undefined, "browser");
  await expect
    .poll(async () => (await manager.status(input)).reason, { timeout: 5000 })
    .toBe("timed_out");
  // The stopped process closes after the timeout; that keeps the reason.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await manager.status(input)).toEqual({
    state: "failed",
    reason: "timed_out",
    message: "Sign-in timed out. Retry or sign in later.",
  });
}, 10000);

it("says a login ended when its process exits without a sign-in", async () => {
  const { inspect, input } = await codex("process.exit(1);");
  const manager = new RuntimeLoginManager(inspect, "linux");
  clean.push(async () => manager.close());
  await manager.start(input, undefined, "browser");
  await expect
    .poll(async () => (await manager.status(input)).reason, { timeout: 5000 })
    .toBe("ended");
  expect((await manager.status(input)).state).toBe("failed");
}, 10000);

it("says Pi has no native sign-in", async () => {
  const { inspect, input } = await codex();
  const manager = new RuntimeLoginManager(async () => ({
    ...(await inspect()),
    runtime: "pi" as const,
  }));
  clean.push(async () => manager.close());
  expect(await manager.start({ ...input, runtime: "pi" })).toMatchObject({
    state: "failed",
    reason: "unavailable",
  });
});
