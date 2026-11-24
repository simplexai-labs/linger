import {
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const failure = vi.hoisted(() => ({ file: "" }));
vi.mock("./instance.js", async (original) => {
  const actual = await original<typeof import("./instance.js")>();
  return {
    ...actual,
    atomicPrivate: async (file: string, contents: string) => {
      if (file === failure.file) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new Error("fixture persistence failed");
      }
      return actual.atomicPrivate(file, contents);
    },
  };
});
import { test as base, vi, type TestContext } from "vitest";
import {
  NATIVE_PROCESS_IDENTITY_UNVERIFIED,
  NATIVE_PROCESS_REPLACED,
  foldersInUse,
  nativeConfigurationChanged,
  startNativeProcess,
  inspectNativeProcess,
  reclaimNativeOrphans,
  stopNativeProcess,
} from "./native-process.js";

// Every test owns a separate process tree. Run Windows trees in sequence
// because each inspection reads the same system-wide process inventory.
const windows = process.platform === "win32";
const test = windows ? base : base.concurrent;
const posix = windows ? test.skip : test;
const win32 = windows ? test : test.skip;
vi.setConfig({
  testTimeout: windows ? 60_000 : 30_000,
  hookTimeout: 60_000,
  expect: { poll: { timeout: 15_000 } },
});
async function fixture({ onTestFinished }: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "native-process-"));
  onTestFinished(async () => {
    // Supervisors outlive the test process by design, so a cleanup that gives
    // up leaks them for good: escalate at once instead of the production wait,
    // then end whatever still runs from this root.
    for (const name of ["web", "teamhub"] as const)
      await stopNativeProcess(root, name, 300).catch(() => {});
    if (windows) {
      await reclaimNativeOrphans(root, { ports: [], paths: [] });
    } else {
      try {
        execFileSync("pkill", ["-KILL", "-f", root]);
      } catch {
        // pkill exits 1 when nothing matched.
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });
  return root;
}
/** Gone or a zombie; Linux reads /proc so the check cannot pass when ps is absent. */
function exited(pid: number): boolean {
  try {
    const state =
      process.platform === "linux"
        ? readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")
        : execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
            encoding: "utf8",
          });
    return state.trim().startsWith("Z");
  } catch {
    return true;
  }
}
test("retains an owned service after launch and reuses its identity", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  const options = {
    root,
    name: "web" as const,
    executable: process.execPath,
    args: [
      "-e",
      "console.log('native fixture ready');setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: process.env,
  };
  const first = await startNativeProcess(options);
  expect(first.running).toBe(true);
  const second = await startNativeProcess(options);
  expect(second.pid).toBe(first.pid);
  expect((await inspectNativeProcess(root, "web")).running).toBe(true);
  await expect
    .poll(async () => readFile(path.join(root, "native/logs/web.log"), "utf8"))
    .toContain("native fixture ready");
  await stopNativeProcess(root, "web");
  expect((await inspectNativeProcess(root, "web")).running).toBe(false);
  expect(
    await readFile(path.join(root, "native/logs/web.log"), "utf8"),
  ).toContain("native fixture ready");
});
win32(
  "starts a service from a token with Administrators disabled",
  async (context) => {
    const { expect } = context;
    const root = await fixture(context);
    const args = ["a b", "", 'say "hi"', "C:\\dir with space\\", "trailing\\"];
    // The service reports the arguments it received and whether its token
    // holds Administrators; an elevated test run proves the group is gone.
    const report = [
      "const ps=require('node:path').win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');",
      "const role='([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';",
      "const administrator=require('node:child_process').execFileSync(ps,['-NoProfile','-NonInteractive','-Command',role],{encoding:'utf8'}).trim();",
      "console.log(JSON.stringify({args:process.argv.slice(1),administrator}));",
      "setInterval(()=>{},1000);",
    ].join("");
    await startNativeProcess({
      root,
      name: "web",
      executable: process.execPath,
      args: ["-e", report, ...args],
      cwd: root,
      env: process.env,
      withoutAdministrators: true,
    });
    await expect
      .poll(
        async () => readFile(path.join(root, "native/logs/web.log"), "utf8"),
        { timeout: 45_000 },
      )
      .toContain(JSON.stringify({ args, administrator: "False" }));
    expect((await inspectNativeProcess(root, "web")).running).toBe(true);
    await stopNativeProcess(root, "web");
    expect((await inspectNativeProcess(root, "web")).running).toBe(false);
  },
);
test("refuses to signal a PID whose recorded lease differs", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  const options = {
    root,
    name: "web" as const,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: process.env,
  };
  const processState = await startNativeProcess(options);
  const file = path.join(root, "native/processes/web.json");
  const original = await readFile(file, "utf8");
  const altered = JSON.parse(original);
  altered.lease = "0".repeat(64);
  await writeFile(file, JSON.stringify(altered), { mode: 0o600 });
  expect((await inspectNativeProcess(root, "web")).running).toBe(false);
  await expect(stopNativeProcess(root, "web")).rejects.toMatchObject({
    code:
      process.platform === "win32"
        ? NATIVE_PROCESS_IDENTITY_UNVERIFIED
        : NATIVE_PROCESS_REPLACED,
  });
  await expect(startNativeProcess(options)).rejects.toThrow(/identity/i);
  expect(() => process.kill(processState.pid!, 0)).not.toThrow();
  await writeFile(file, original, { mode: 0o600 });
});
test("rejects changed service configuration instead of leaking a duplicate", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  const options = {
    root,
    name: "teamhub" as const,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: process.env,
  };
  await startNativeProcess(options);
  await expect(
    startNativeProcess({ ...options, args: ["-e", "process.exit(0)"] }),
  ).rejects.toThrow(/configuration/i);
  // Generated settings, such as a changed user.env, count as configuration.
  await expect(
    startNativeProcess({ ...options, settings: '{"XAI_API_KEY":"new"}' }),
  ).rejects.toThrow(/configuration/i);
});

test("restarts a service whose settings changed, keeps one whose did not", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  const options = {
    root,
    name: "teamhub" as const,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: process.env,
    restartOnConfigurationChange: true,
  };
  const first = await startNativeProcess(options);
  expect((await startNativeProcess(options)).pid).toBe(first.pid);
  const second = await startNativeProcess({ ...options, settings: "voice-1" });
  expect(second.pid).not.toBe(first.pid);
  expect(
    (await startNativeProcess({ ...options, settings: "voice-1" })).pid,
  ).toBe(second.pid);
  expect((await startNativeProcess(options)).pid).not.toBe(second.pid);
});
test("redacts complete lines before persisting split writes and known secrets", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  await startNativeProcess({
    root,
    name: "web",
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write('generated-');setTimeout(()=>console.log('opaque-secret'),40);console.error(process.env.PGPASSWORD);setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: { ...process.env, PGPASSWORD: "bare-private-value" },
    redactions: ["generated-opaque-secret"],
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const log = await readFile(path.join(root, "native/logs/web.log"), "utf8");
  expect(log).not.toContain("generated-");
  expect(log).not.toContain("opaque-secret");
  expect(log).not.toContain("bare-private-value");
  expect(log).toContain("[REDACTED]");
});

posix(
  "stops descendants that ignore SIGINT after the service leader exits",
  async (context) => {
    const { expect } = context;
    const root = await fixture(context);
    const childCode =
      "process.on('SIGINT',()=>{});console.log('descendant-ready');setInterval(()=>{},1000)";
    await startNativeProcess({
      root,
      name: "web",
      executable: process.execPath,
      args: [
        "-e",
        `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});fs.writeFileSync('descendant.pid',String(c.pid));process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)`,
      ],
      cwd: root,
      env: process.env,
    });
    await expect
      .poll(async () =>
        readFile(path.join(root, "native/logs/web.log"), "utf8"),
      )
      .toContain("descendant-ready");
    const pid = Number(
      await readFile(path.join(root, "descendant.pid"), "utf8"),
    );
    // The descendant ignores SIGINT, so only the SIGKILL escalation ends it;
    // a short interrupt window reaches it without the production wait.
    await stopNativeProcess(root, "web", 300);
    await expect.poll(() => exited(pid)).toBe(true);
  },
);

posix(
  "replaces a service whose supervisor was killed with the app",
  async (context) => {
    const { expect } = context;
    const root = await fixture(context);
    const options = {
      root,
      name: "web" as const,
      executable: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('service.pid',String(process.pid));setInterval(()=>{},1000)",
      ],
      cwd: root,
      env: process.env,
    };
    const first = await startNativeProcess(options);
    await expect
      .poll(async () =>
        readFile(path.join(root, "service.pid"), "utf8").catch(() => ""),
      )
      .not.toBe("");
    const orphan = Number(
      await readFile(path.join(root, "service.pid"), "utf8"),
    );
    await rm(path.join(root, "service.pid"));
    process.kill(first.pid!, "SIGKILL");
    await expect.poll(() => exited(first.pid!)).toBe(true);
    expect(exited(orphan)).toBe(false);

    const second = await startNativeProcess(options);
    expect(second.pid).not.toBe(first.pid);
    await expect.poll(() => exited(orphan)).toBe(true);
    expect((await inspectNativeProcess(root, "web")).running).toBe(true);
  },
);

posix(
  "reclaims a service an earlier attempt left under a lease no record holds",
  async (context) => {
    const { expect } = context;
    const root = await fixture(context);
    const service = (name: "web" | "teamhub") => ({
      root,
      name,
      executable: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync('${name}.pid',String(process.pid));setInterval(()=>{},1000)`,
      ],
      cwd: root,
      env: process.env,
    });
    const lost = await startNativeProcess(service("web"));
    const kept = await startNativeProcess(service("teamhub"));
    const pid = async (name: string) =>
      Number(await readFile(path.join(root, `${name}.pid`), "utf8"));
    await expect.poll(() => pid("web").catch(() => 0)).not.toBe(0);
    await expect.poll(() => pid("teamhub").catch(() => 0)).not.toBe(0);
    // The attempt that started it failed before its record was kept.
    await rm(path.join(root, "native/processes/web.json"));
    const ended = await reclaimNativeOrphans(root, { ports: [], paths: [] });
    expect(ended).toContain(lost.pid);
    await expect.poll(async () => exited(await pid("web"))).toBe(true);
    expect(exited(lost.pid!)).toBe(true);
    expect(exited(kept.pid!)).toBe(false);
    expect(exited(await pid("teamhub"))).toBe(false);
  },
);

test("cleans launched owned processes when identity persistence fails", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  failure.file = path.join(root, "native/processes/web.json");
  try {
    await expect(
      startNativeProcess({
        root,
        name: "web",
        executable: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync('launched.pid',String(process.pid));setInterval(()=>{},1000)",
        ],
        cwd: root,
        env: process.env,
      }),
    ).rejects.toThrow("fixture persistence failed");
    const files = await readFile(path.join(root, "launched.pid"), "utf8");
    if (files)
      await expect
        .poll(() => {
          try {
            process.kill(Number(files), 0);
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
  } finally {
    failure.file = "";
  }
});

test("bundled entry resolves its packaged worker and survives caller exit", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  const app = fileURLToPath(
    new URL("../../../apps/linger-installer/", import.meta.url),
  );
  const { build } = createRequire(path.join(app, "package.json"))(
    "esbuild",
  ) as { build: (options: Record<string, unknown>) => Promise<void> };
  const entry = path.join(root, "entry.mjs");
  await writeFile(
    entry,
    `import {startNativeProcess} from ${JSON.stringify(fileURLToPath(new URL("./native-process.ts", import.meta.url)))};await startNativeProcess({root:${JSON.stringify(root)},name:'web',executable:process.execPath,args:['-e',"console.log('packaged-ready');setInterval(()=>{},1000)"],cwd:${JSON.stringify(root)},env:process.env});`,
  );
  for (const [source, outfile] of [
    [entry, path.join(root, "packaged.mjs")],
    [
      fileURLToPath(new URL("./native-process-worker.mjs", import.meta.url)),
      path.join(root, "native-process-worker.mjs"),
    ],
  ])
    await build({
      entryPoints: [source],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
    });
  const caller = spawn(process.execPath, [path.join(root, "packaged.mjs")], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  caller.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  expect(
    await new Promise((resolve) => caller.once("close", resolve)),
    stderr,
  ).toBe(0);
  expect((await inspectNativeProcess(root, "web")).running).toBe(true);
  await expect
    .poll(async () => readFile(path.join(root, "native/logs/web.log"), "utf8"))
    .toContain("packaged-ready");
});

test.for(["ENOSPC", "EIO"])(
  "retains ownership after log writes fail with %s",
  async (code, context) => {
    const { expect } = context;
    const root = await fixture(context);
    const app = fileURLToPath(
      new URL("../../../apps/linger-installer/", import.meta.url),
    );
    const { build } = createRequire(path.join(app, "package.json"))(
      "esbuild",
    ) as {
      build: (options: Record<string, unknown>) => Promise<void>;
    };
    for (const [source, output] of [
      ["native-process.ts", "core.mjs"],
      ["native-process-worker.mjs", "worker-implementation.mjs"],
    ] as const)
      await build({
        entryPoints: [fileURLToPath(new URL(source, import.meta.url))],
        outfile: path.join(root, output),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node26",
      });
    // Inject only the OS write error. The supervisor, service, identity checks,
    // detached process group, and shutdown below all run in real processes.
    await writeFile(
      path.join(root, "native-process-worker.mjs"),
      `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    fs.writeSync = () => { throw Object.assign(new Error('fixture I/O failure'), {code: ${JSON.stringify(code)}}); };
    syncBuiltinESMExports();
    await import('./worker-implementation.mjs');
  `,
    );
    const core = (await import(
      path.join(root, "core.mjs")
    )) as typeof import("./native-process.js");
    try {
      const owner = await core.startNativeProcess({
        root,
        name: "web",
        executable: process.execPath,
        cwd: root,
        env: process.env,
        args: [
          "-e",
          "require('node:fs').writeFileSync('service.pid',String(process.pid));setInterval(()=>console.log('token=private-fixture-value'),20)",
        ],
      });
      await expect
        .poll(async () => readFile(path.join(root, "service.pid"), "utf8"))
        .toMatch(/^\d+$/);
      const service = Number(
        await readFile(path.join(root, "service.pid"), "utf8"),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await core.inspectNativeProcess(root, "web")).running).toBe(true);
      expect(() => process.kill(service, 0)).not.toThrow();
      expect(
        await readFile(path.join(root, "native/logs/web.log"), "utf8"),
      ).toBe("");
      await core.stopNativeProcess(root, "web");
      expect((await core.inspectNativeProcess(root, "web")).running).toBe(
        false,
      );
      expect(() => process.kill(owner.pid!, 0)).toThrow();
      expect(() => process.kill(service, 0)).toThrow();
    } finally {
      // Keep the group escape hatch for POSIX; the fixture cleans Windows by lease.
      const record = await readFile(
        path.join(root, "native/processes/web.json"),
        "utf8",
      ).catch(() => "");
      if (!windows && record) {
        try {
          process.kill(-JSON.parse(record).pid, "SIGKILL");
        } catch {
          /* Gone. */
        }
      }
    }
  },
);

posix.for([false, true])(
  "stops leased orphan descendants across groups (owner killed: %s)",
  async (killOwner, context) => {
    const { expect } = context;
    const root = await fixture(context);
    let orphan: number | undefined;
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { detached: true, stdio: "ignore" },
    );
    unrelated.unref();
    try {
      const owner = await startNativeProcess({
        root,
        name: "web",
        executable: process.execPath,
        cwd: root,
        env: process.env,
        args: [
          "-e",
          `
        const {spawn} = require('node:child_process');
        const child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{});require('node:fs').writeFileSync('orphan.pid',String(process.pid));setInterval(()=>{},1000)"], {detached:true,stdio:'ignore'});
        child.unref();
      `,
        ],
      });
      await expect
        .poll(async () => readFile(path.join(root, "orphan.pid"), "utf8"))
        .toMatch(/^\d+$/);
      orphan = Number(await readFile(path.join(root, "orphan.pid"), "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await inspectNativeProcess(root, "web")).running).toBe(true);
      if (killOwner) {
        process.kill(owner.pid!, "SIGKILL");
        await expect
          .poll(async () => (await inspectNativeProcess(root, "web")).running)
          .toBe(false);
      }
      // The orphan ignores SIGINT; only the SIGKILL escalation ends it.
      await stopNativeProcess(root, "web", 300);
      expect((await inspectNativeProcess(root, "web")).running).toBe(false);
      await expect.poll(() => exited(orphan!)).toBe(true);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      unrelated.kill("SIGKILL");
      if (orphan) {
        try {
          process.kill(orphan, "SIGKILL");
        } catch {
          /* Gone. */
        }
      }
    }
  },
);
test("adopts a running service across executable cache layouts for the same archive", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  const original = {
    root,
    name: "teamhub" as const,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: process.env,
  };
  const running = await startNativeProcess(original);
  const upgraded = {
    ...original,
    executable: path.join(root, "new-cache", path.basename(process.execPath)),
    configurationExecutable: original.executable,
  };
  expect(await nativeConfigurationChanged(upgraded)).toBe(false);
  expect((await startNativeProcess(upgraded)).pid).toBe(running.pid);
  expect(
    await nativeConfigurationChanged({
      ...upgraded,
      configurationExecutable: "another-archive",
    }),
  ).toBe(true);
});
test("reports a configuration change only for a running recorded process", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  const options = {
    root,
    name: "teamhub" as const,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: process.env,
    settings: "first",
  };
  expect(await nativeConfigurationChanged(options)).toBe(false);
  await startNativeProcess(options);
  expect(await nativeConfigurationChanged(options)).toBe(false);
  expect(
    await nativeConfigurationChanged({ ...options, settings: "second" }),
  ).toBe(true);
  await stopNativeProcess(root, "teamhub");
  expect(
    await nativeConfigurationChanged({ ...options, settings: "second" }),
  ).toBe(false);
});

(process.platform === "linux" ? test : test.skip)(
  "detached native supervisor and service do not inherit a parent listening TCP socket FD",
  async (context) => {
    const { expect } = context;
    const root = await fixture(context);
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    const port = address.port;
    const listenFd = (server as unknown as { _handle?: { fd?: number } })
      ._handle?.fd;
    expect(typeof listenFd).toBe("number");
    const socketInode = await readlink(`/proc/self/fd/${listenFd}`);

    const app = fileURLToPath(
      new URL("../../../apps/linger-installer/", import.meta.url),
    );
    const { build } = createRequire(path.join(app, "package.json"))(
      "esbuild",
    ) as { build: (options: Record<string, unknown>) => Promise<void> };
    const entry = path.join(root, "launch-with-socket.entry.mjs");
    const launcher = path.join(root, "launch-with-socket.mjs");
    const nativeProcessModule = fileURLToPath(
      new URL("./native-process.ts", import.meta.url),
    );
    await writeFile(
      entry,
      `
        import { writeFileSync } from "node:fs";
        import { startNativeProcess } from ${JSON.stringify(nativeProcessModule)};
        const state = await startNativeProcess({
          root: ${JSON.stringify(root)},
          name: "web",
          executable: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('service.pid', String(process.pid)); setInterval(() => {}, 1000);"],
          cwd: ${JSON.stringify(root)},
          env: process.env,
        });
        writeFileSync(${JSON.stringify(path.join(root, "supervisor.pid"))}, String(state.pid));
      `,
    );
    for (const [source, outfile] of [
      [entry, launcher],
      [
        fileURLToPath(new URL("./native-process-worker.mjs", import.meta.url)),
        path.join(root, "native-process-worker.mjs"),
      ],
    ])
      await build({
        entryPoints: [source],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node26",
      });

    const stdio: Array<"ignore" | "pipe" | number> = [
      "ignore",
      "ignore",
      "pipe",
    ];
    while (stdio.length < 68) stdio.push("ignore");
    stdio[5] = listenFd!;
    stdio[67] = listenFd!;

    let stderr = "";
    const parent = spawn(process.execPath, [launcher], { stdio });
    parent.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    expect(
      await new Promise<number | null>((resolve) =>
        parent.once("close", resolve),
      ),
      stderr,
    ).toBe(0);

    // Close the original listener in this test process while the detached
    // supervisor and service remain alive.
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect
      .poll(async () =>
        readFile(path.join(root, "service.pid"), "utf8").catch(() => ""),
      )
      .toMatch(/^\d+$/);
    const supervisorPid = Number(
      await readFile(path.join(root, "supervisor.pid"), "utf8"),
    );
    const servicePid = Number(
      await readFile(path.join(root, "service.pid"), "utf8"),
    );
    expect((await inspectNativeProcess(root, "web")).running).toBe(true);

    // Neither the detached supervisor nor the service child may hold the
    // parent's listening socket inode on any FD.
    for (const pid of [supervisorPid, servicePid]) {
      const fds = await readdir(`/proc/${pid}/fd`);
      const targets = await Promise.all(
        fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")),
      );
      expect(targets).not.toContain(socketInode);
    }

    // Rebinding the exact same port immediately proves no detached process
    // kept the listening socket alive.
    const rebound = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        rebound.once("error", reject);
        rebound.listen(port, "127.0.0.1", () => resolve());
      });
    } finally {
      await new Promise<void>((resolve) => rebound.close(() => resolve()));
    }
  },
);

const fastRestart = {
  delaysMs: [100, 200],
  windowMs: 10_000,
  limit: 3,
  armAfterMs: 300,
};
const webLog = (root: string) =>
  readFile(path.join(root, "native/logs/web.log"), "utf8").catch(() => "");
const supervisorLines = async (root: string) =>
  (await webLog(root))
    .split("\n")
    .filter((line) => line.startsWith("[linger-supervisor] web "));
test("restarts a supervised service that exits unasked and logs each exit", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  // The first run kills itself once it has run long enough to count as up;
  // the restarted one stays.
  const state = await startNativeProcess({
    root,
    name: "web",
    executable: process.execPath,
    args: [
      "-e",
      "const fs=require('node:fs');const first=!fs.existsSync('ran');fs.writeFileSync('ran','');console.log('service-up');if(first)setTimeout(()=>process.kill(process.pid,'SIGKILL'),500);setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: process.env,
    restartOnExit: fastRestart,
  });
  await expect
    .poll(() => supervisorLines(root))
    .toEqual([
      expect.stringMatching(/^\[linger-supervisor\] web started pid=\d+$/),
      expect.stringMatching(
        /^\[linger-supervisor\] web exited code=null signal=SIGKILL uptime_ms=\d+ restarting_in_ms=100$/,
      ),
      expect.stringMatching(
        /^\[linger-supervisor\] web restarted pid=\d+ attempt=1$/,
      ),
    ]);
  await expect
    .poll(async () => (await webLog(root)).match(/service-up/g)?.length)
    .toBe(2);
  // The supervisor, and so the record, stays the same.
  expect(await inspectNativeProcess(root, "web")).toEqual({
    running: true,
    pid: state.pid,
  });
  await stopNativeProcess(root, "web");
  expect((await inspectNativeProcess(root, "web")).running).toBe(false);
  expect((await supervisorLines(root)).at(-1)).toMatch(
    /^\[linger-supervisor\] web exited code=\S+ signal=\S+ uptime_ms=\d+ restart=no reason=stop_requested$/,
  );
  expect(await readdir(path.join(root, "native/processes"))).toEqual([]);
});
test("never restarts a service an intended stop ends", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  await startNativeProcess({
    root,
    name: "web",
    executable: process.execPath,
    args: [
      "-e",
      "process.on('SIGINT',()=>process.exit(0));console.log('service-up');setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: process.env,
    restartOnExit: { ...fastRestart, armAfterMs: 0 },
  });
  // Stop only once the service handles SIGINT, so it exits on its own.
  await expect.poll(() => webLog(root)).toContain("service-up");
  await stopNativeProcess(root, "web");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const lines = await supervisorLines(root);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(
    /^\[linger-supervisor\] web exited code=0 signal=null uptime_ms=\d+ restart=no reason=stop_requested$/,
  );
  expect((await inspectNativeProcess(root, "web")).running).toBe(false);
});
test("a stop during the restart delay ends the supervisor without a restart", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  await startNativeProcess({
    root,
    name: "web",
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>process.exit(1),400)"],
    cwd: root,
    env: process.env,
    restartOnExit: { ...fastRestart, delaysMs: [3_000] },
  });
  await expect
    .poll(async () => (await supervisorLines(root)).at(-1))
    .toMatch(/restarting_in_ms=3000$/);
  await stopNativeProcess(root, "web");
  expect((await inspectNativeProcess(root, "web")).running).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  expect((await supervisorLines(root)).join("\n")).not.toContain("restarted");
});
test("gives up after the crash-loop limit and leaves the service stopped", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  await startNativeProcess({
    root,
    name: "web",
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>process.exit(3),400)"],
    cwd: root,
    env: process.env,
    restartOnExit: fastRestart,
  });
  await expect
    .poll(() => inspectNativeProcess(root, "web"))
    .toMatchObject({ running: false });
  const lines = await supervisorLines(root);
  expect(lines.filter((line) => line.includes(" exited "))).toEqual([
    expect.stringMatching(
      /code=3 signal=null uptime_ms=\d+ restarting_in_ms=100$/,
    ),
    expect.stringMatching(
      /code=3 signal=null uptime_ms=\d+ restarting_in_ms=200$/,
    ),
    expect.stringMatching(
      /code=3 signal=null uptime_ms=\d+ restart=no reason=crash_loop$/,
    ),
  ]);
  expect(lines.at(-1)).toBe(
    "[linger-supervisor] web gave up restarting after 3 exits within 10000 ms",
  );
});
test.for([
  ["startup", fastRestart],
  ["not_supervised", undefined],
] as const)(
  "logs an exit it does not restart (%s)",
  async ([reason, restartOnExit], context) => {
    const { expect } = context;
    const root = await fixture(context);
    await startNativeProcess({
      root,
      name: "web",
      executable: process.execPath,
      args: ["-e", "setTimeout(()=>process.exit(2),50)"],
      cwd: root,
      env: process.env,
      ...(restartOnExit ? { restartOnExit } : {}),
    });
    await expect
      .poll(() => inspectNativeProcess(root, "web"))
      .toMatchObject({ running: false });
    expect((await supervisorLines(root)).at(-1)).toMatch(
      new RegExp(
        `^\\[linger-supervisor\\] web exited code=2 signal=null uptime_ms=\\d+ restart=no reason=${reason}$`,
      ),
    );
  },
);
posix("names the folders a running process starts from", async (context) => {
  const { expect } = context;
  const root = await fixture(context);
  const used = path.join(root, "used");
  const unused = path.join(root, "unused");
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)", path.join(used, "server.mjs")],
    { stdio: "ignore" },
  );
  context.onTestFinished(() => {
    child.kill("SIGKILL");
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  expect(await foldersInUse([used, unused, `${used}-other`])).toEqual(
    new Set([used]),
  );
});
