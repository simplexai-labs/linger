import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  WindowsProcess,
  WindowsSnapshot,
} from "./native-process-identity.js";

// Windows paths of the native lifecycle on any host: the process snapshot
// is the fixture, and ending a process removes it (with whatever Node's job
// object ends along with it) from the next snapshot.
const host = vi.hoisted(() => ({
  processes: [] as WindowsProcess[],
  exiting: [] as WindowsProcess[],
  snapshots: [] as WindowsProcess[][],
  listeners: new Map<number, number>(),
  listenersAvailable: true,
  ended: [] as number[],
  cascade: new Map<number, number[]>(),
  processScans: 0,
}));
const fsHooks = vi.hoisted(() => ({
  onWriteFile: null as ((file: string) => void | Promise<void>) | null,
  onRm: null as ((file: string) => void | Promise<void>) | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fsHooks.onWriteFile && typeof args[0] === "string")
        await fsHooks.onWriteFile(args[0]);
      return actual.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fsHooks.onRm && typeof args[0] === "string")
        await fsHooks.onRm(args[0]);
      return actual.rm(...args);
    },
  };
});
vi.mock("./native-process-identity.js", async (original) => {
  const actual =
    await original<typeof import("./native-process-identity.js")>();
  const windowsProcesses = async () => {
    host.processScans += 1;
    if (host.snapshots.length) return host.snapshots.shift()!;
    return [...host.processes, ...host.exiting.splice(0)];
  };
  const windowsSnapshot = async (): Promise<WindowsSnapshot> => {
    if (!host.listenersAvailable) throw new Error("Cannot read TCP listeners");
    return {
      processes: await windowsProcesses(),
      listeners: new Map(host.listeners),
    };
  };
  return { ...actual, windowsSnapshot, windowsProcesses };
});
const taskkill = vi.hoisted(() => ({
  calls: [] as string[][],
  ends: true,
  onRun: null as ((args: string[]) => void) | null,
}));
vi.mock("./process.js", async (original) => ({
  ...(await original<typeof import("./process.js")>()),
  runProcess: async (_command: string, args: string[]) => {
    taskkill.calls.push(args);
    if (taskkill.ends) {
      const pid = Number(args[1]);
      const tree = [pid];
      for (let index = 0; index < tree.length; index++)
        for (const entry of host.processes)
          if (entry.parent === tree[index] && !tree.includes(entry.pid))
            tree.push(entry.pid);
      host.processes = host.processes.filter(
        (entry) => !tree.includes(entry.pid),
      );
    }
    taskkill.onRun?.(args);
    return { stdout: "", stderr: "", code: 0 };
  },
}));
vi.mock("./instance.js", async (original) => ({
  ...(await original<typeof import("./instance.js")>()),
  readPrivate: (file: string) => readFile(file, "utf8").catch(() => undefined),
}));
import {
  NATIVE_PROCESS_IDENTITY_UNVERIFIED,
  inspectNativeListeners,
  inspectNativeProcess,
  inspectNativeProcesses,
  reclaimNativeOrphans,
  stopNativeProcess,
  stopNativeProcesses,
  type NativeService,
} from "./native-process.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root = "";
beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  root = await mkdtemp(path.join(tmpdir(), "native-win32-"));
  host.processes = [row(1, 0, 1, "wininit.exe")];
  host.exiting = [];
  host.snapshots = [];
  host.listeners = new Map();
  host.listenersAvailable = true;
  host.ended = [];
  host.cascade = new Map();
  host.processScans = 0;
  fsHooks.onWriteFile = null;
  fsHooks.onRm = null;
  taskkill.calls = [];
  taskkill.ends = true;
  taskkill.onRun = null;
  vi.spyOn(process, "kill").mockImplementation(
    (pid: number, signal?: string | number) => {
      if (signal === 0) {
        if (host.processes.some((entry) => entry.pid === pid)) return true;
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
      const gone = [pid, ...(host.cascade.get(pid) ?? [])];
      host.ended.push(pid);
      host.processes = host.processes.filter(
        (entry) => !gone.includes(entry.pid),
      );
      return true;
    },
  );
});
afterEach(async () => {
  fsHooks.onWriteFile = null;
  fsHooks.onRm = null;
  taskkill.onRun = null;
  host.snapshots = [];
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const row = (pid: number, parent: number, created: number, command = "") => ({
  pid,
  parent,
  created,
  command,
});
const lease = "a".repeat(64);
const worker = (pid: number, name: string, key = lease) =>
  row(
    pid,
    1,
    100,
    `node.exe native-process-worker.mjs ${path.join(root, "native", "processes", `${name}.${key}.job`)}`,
  );
async function record(name: string, pid: number, key = lease) {
  await mkdir(path.join(root, "native", "processes"), { recursive: true });
  await writeFile(
    path.join(root, "native", "processes", `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      pid,
      birth: `win32:${pid}:100`,
      lease: key,
      configuration: "b".repeat(64),
    }),
  );
}

test("a supervisor whose service died is not running even without listener data", async () => {
  host.listenersAvailable = false;
  await record("livekit", 10);
  host.processes.push(
    worker(10, "livekit"),
    row(20, 10, 200, "powershell.exe -Command Get-CimInstance Win32_Process"),
  );
  expect((await inspectNativeProcess(root, "livekit")).running).toBe(false);
  host.processes.push(row(11, 10, 101, "livekit-server.exe"));
  expect((await inspectNativeProcess(root, "livekit")).running).toBe(true);
});

test("stop ends the whole tree leaves first and forgets the record without listener data", async () => {
  host.listenersAvailable = false;
  await record("teamhub", 10);
  host.processes.push(
    worker(10, "teamhub"),
    row(11, 10, 101, "node.exe source-native.mjs teamhub"),
    row(12, 11, 102, 'cmd.exe /d /s /c "teamhub.exe"'),
    row(13, 12, 103, "teamhub.exe"),
  );
  // Node's job object ends its direct child with it; TeamHub under cmd.exe
  // was not, and a stop that ended the parents first lost it.
  host.cascade.set(11, [12]);
  await stopNativeProcess(root, "teamhub");
  expect(host.ended).toEqual([13, 12, 11, 10]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
  await expect(
    readFile(path.join(root, "native/processes/teamhub.json")),
  ).rejects.toThrow();
});

test.each([
  ["a different lease", () => worker(10, "web", "c".repeat(64))],
  ["an unreadable command line", () => row(10, 1, 100)],
])(
  "stop retains the live record with %s, writes no .stop file, and signals nothing",
  async (_, supervisor) => {
    await record("web", 10);
    host.processes.push(supervisor(), row(11, 10, 101, "web.exe"));
    const file = path.join(root, "native/processes/web.json");
    const original = await readFile(file, "utf8");
    const written: string[] = [];
    fsHooks.onWriteFile = (target) => {
      written.push(target);
    };

    await expect(stopNativeProcess(root, "web")).rejects.toMatchObject({
      code: NATIVE_PROCESS_IDENTITY_UNVERIFIED,
      message: expect.stringMatching(
        /identity cannot be verified.*record retained/i,
      ),
    });
    expect(host.ended).toEqual([]);
    expect(taskkill.calls).toEqual([]);
    expect(written).toEqual([]);
    await expect(readFile(file, "utf8")).resolves.toBe(original);
    expect(await readdir(path.join(root, "native", "processes"))).toEqual([
      "web.json",
    ]);
  },
);

test("stopNativeProcess skips PowerShell without a record and skips .stop when already exited", async () => {
  const written: string[] = [];
  fsHooks.onWriteFile = (target) => {
    written.push(target);
  };

  await stopNativeProcess(root, "web");
  expect(host.processScans).toBe(0);
  expect(written).toEqual([]);

  await record("web", 10);
  written.length = 0;
  await stopNativeProcess(root, "web");
  expect(host.processScans).toBe(1);
  expect(written).toEqual([]);
  expect(await readdir(path.join(root, "native", "processes"))).toEqual([]);
});

test("stopNativeProcess uses the shared Windows batch path for supervisor+child and pre-.stop supervisor-only trees", async () => {
  // Case 1: running supervisor + multi-level children where supervisor self-exits after child exits.
  const teamhubLease = "1".repeat(64);
  await record("teamhub", 10, teamhubLease);
  host.processes.push(
    worker(10, "teamhub", teamhubLease),
    row(11, 10, 101, "node.exe source-native.mjs teamhub"),
    row(12, 11, 102, "teamhub.exe"),
  );
  host.cascade.set(11, [10]);
  await stopNativeProcess(root, "teamhub");
  expect(host.processScans).toBe(2);
  expect(host.ended).toEqual([12, 11]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
  expect(await readdir(path.join(root, "native", "processes"))).toEqual([]);

  // Case 2: supervisor-only on Pass 1 spawns a child right before `.stop` lands;
  // Pass 1 must not kill the supervisor before a post-`.stop` snapshot sees the child.
  host.ended = [];
  host.cascade = new Map();
  host.processScans = 0;
  const webLease = "2".repeat(64);
  await record("web", 100, webLease);
  host.processes.push(worker(100, "web", webLease));
  fsHooks.onWriteFile = (target) => {
    if (target.endsWith(`web.${webLease}.stop`)) {
      host.processes.push(row(101, 100, 102, "web.exe"));
    }
  };

  await stopNativeProcess(root, "web");

  expect(host.ended).toEqual([101, 100]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
  expect(await readdir(path.join(root, "native", "processes"))).toEqual([]);
});

test("stop verifies that an exiting supervisor's incomplete CIM row disappears", async () => {
  await record("web", 10);
  const supervisor = worker(10, "web");
  host.processes.push(supervisor);
  vi.mocked(process.kill).mockImplementationOnce((pid) => {
    host.ended.push(pid);
    host.processes = host.processes.filter((entry) => entry.pid !== pid);
    host.exiting.push({ ...supervisor, command: "" });
    return true;
  });

  await stopNativeProcess(root, "web");
  expect(host.ended).toEqual([10]);
  expect(taskkill.calls).toEqual([]);
  expect((await inspectNativeProcess(root, "web")).pid).toBeUndefined();
});

test("stop forgets a record whose PID Windows gave to another program", async () => {
  await record("web", 10);
  host.processes.push(row(10, 1, 900, "notepad.exe"));
  await stopNativeProcess(root, "web");
  expect(host.ended).toEqual([]);
  expect((await inspectNativeProcess(root, "web")).pid).toBeUndefined();
});

test("a port held outside the service's tree is reported as foreign", async () => {
  await record("teamhub", 10);
  host.processes.push(
    worker(10, "teamhub"),
    row(11, 10, 101, "teamhub.exe"),
    row(40, 1, 50, "teamhub.exe from an earlier release"),
  );
  host.listeners.set(55640, 40);
  expect(
    await inspectNativeListeners(root, [{ name: "teamhub", port: 55640 }]),
  ).toEqual([{ running: true, foreign: 40 }]);
  host.listeners.set(55640, 11);
  expect(
    await inspectNativeListeners(root, [{ name: "teamhub", port: 55640 }]),
  ).toEqual([{ running: true }]);
});

test("reclaim ends an earlier release's leftovers on this instance's ports", async () => {
  const home = path.dirname(path.dirname(root));
  await record("postgres", 10);
  host.processes.push(
    worker(10, "postgres"),
    row(11, 10, 101, `${home}\\tools\\postgres.exe -D ${root}`),
    // A LiveKit supervisor whose record a later start replaced.
    worker(30, "livekit", "c".repeat(64)),
    row(41, 99, 120, `cmd.exe /d /s /c "${home}\\source\\teamhub.exe"`),
    row(42, 41, 121, `${home}\\source\\teamhub.exe`),
    row(50, 1, 130, "C:\\other\\server.exe"),
  );
  host.listeners = new Map([
    [55640, 42],
    [55643, 11],
    [8080, 50],
  ]);
  const ended = await reclaimNativeOrphans(root, {
    ports: [55640, 55643, 8080],
    paths: [home],
  });
  expect(ended.sort()).toEqual([30, 41, 42]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1, 10, 11, 50]);
});

// TerminateProcess that leaves a process running (access denied to a
// handle, a process mid-exit) must not end the stop at its deadline.
function stubbornTree() {
  host.processes.push(
    worker(10, "postgres"),
    row(11, 10, 101, "postgres.exe -D data"),
  );
  vi.mocked(process.kill).mockImplementation(() => true);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
}

test("a tree TerminateProcess left alive is ended with taskkill on the recorded supervisor", async () => {
  await record("postgres", 10);
  stubbornTree();
  await stopNativeProcess(root, "postgres");
  expect(taskkill.calls).toEqual([["/PID", "10", "/T", "/F"]]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
  await expect(
    readFile(path.join(root, "native/processes/postgres.json")),
  ).rejects.toThrow();
});

test("a tree taskkill cannot end still fails the stop", async () => {
  await record("postgres", 10);
  stubbornTree();
  taskkill.ends = false;
  await expect(stopNativeProcess(root, "postgres")).rejects.toThrow(
    "Native postgres did not stop; identity record retained.",
  );
  expect(taskkill.calls).toEqual([["/PID", "10", "/T", "/F"]]);
  await expect(
    readFile(path.join(root, "native/processes/postgres.json")),
  ).resolves.toBeTruthy();
});

test("taskkill never targets a supervisor whose identity no longer matches the record", async () => {
  await record("postgres", 10);
  host.processes.push(
    { ...worker(10, "postgres"), created: 500 },
    row(11, 10, 501, "postgres.exe -D data"),
  );
  vi.mocked(process.kill).mockImplementation(() => true);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
  await expect(stopNativeProcess(root, "postgres")).rejects.toThrow(
    "did not stop",
  );
  expect(taskkill.calls).toEqual([]);
});

test("stop tolerates transient Windows EPERM on TerminateProcess while a process exits", async () => {
  await record("web", 10);
  host.processes.push(worker(10, "web"), row(11, 10, 101, "web.exe"));
  vi.mocked(process.kill).mockImplementationOnce(() => {
    host.processes = host.processes.filter((entry) => entry.pid !== 11);
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  });
  await stopNativeProcess(root, "web");
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
});

test("inspectNativeProcesses enumerates zero times without records and once across multiple services", async () => {
  expect(
    await inspectNativeProcesses(root, [
      "teamhub",
      "node-services",
      "web",
      "postgres",
    ]),
  ).toEqual([
    { running: false },
    { running: false },
    { running: false },
    { running: false },
  ]);
  expect(host.processScans).toBe(0);

  const webLease = "1".repeat(64);
  const pgLease = "2".repeat(64);
  await record("web", 10, webLease);
  await record("postgres", 20, pgLease);
  host.processes.push(
    worker(10, "web", webLease),
    row(11, 10, 101, "node.exe web"),
    worker(20, "postgres", pgLease),
  );

  expect(
    await inspectNativeProcesses(root, [
      "teamhub",
      "web",
      "postgres",
      "livekit",
    ]),
  ).toEqual([
    { running: false },
    { running: true, pid: 10 },
    { running: false, pid: 20 },
    { running: false },
  ]);
  expect(host.processScans).toBe(1);
});

const allServices: readonly NativeService[] = [
  "web",
  "node-services",
  "teamhub",
  "livekit",
  "postgres",
];

async function seedAllFiveServices(autoExitSupervisors: boolean) {
  const leases = new Map<NativeService, string>();
  for (const [index, name] of allServices.entries()) {
    const key = String(index + 1).repeat(64);
    leases.set(name, key);
    const base = (index + 1) * 100;
    await record(name, base, key);
    host.processes.push(
      worker(base, name, key),
      row(base + 1, base, 101, `${name}-wrapper.exe`),
      row(base + 2, base + 1, 102, `${name}.exe`),
    );
    if (autoExitSupervisors) {
      // Simulate fast Windows `stop_requested` self-exit once the direct child exits.
      host.cascade.set(base + 1, [base]);
    }
  }
  return leases;
}

test("stopNativeProcesses skips enumeration when no records exist", async () => {
  const reported: Array<{ name: NativeService; error?: unknown }> = [];
  await stopNativeProcesses(root, allServices, {
    onServiceDone: (name, _durationMs, error) => reported.push({ name, error }),
  });
  expect(host.processScans).toBe(0);
  expect(reported).toEqual(allServices.map((name) => ({ name })));
});

test("stopNativeProcesses stops 5 Windows services in 2 snapshots when supervisors self-exit", async () => {
  await seedAllFiveServices(true);
  const reported: Array<{ name: NativeService; error?: unknown }> = [];

  await stopNativeProcesses(root, allServices, {
    onServiceDone: (name, _durationMs, error) => reported.push({ name, error }),
  });

  expect(host.processScans).toBe(2);
  // Strict dependency order (web -> node-services -> teamhub -> livekit -> postgres), leaves first.
  expect(host.ended).toEqual([
    102, 101, 202, 201, 302, 301, 402, 401, 502, 501,
  ]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
  expect(reported).toEqual(allServices.map((name) => ({ name })));
  expect(await readdir(path.join(root, "native", "processes"))).toEqual([]);
});

test("stopNativeProcesses stops 5 Windows services in 3 snapshots when older supervisors do not self-exit", async () => {
  await seedAllFiveServices(false);
  const reported: Array<{ name: NativeService; error?: unknown }> = [];

  await stopNativeProcesses(root, allServices, {
    onServiceDone: (name, _durationMs, error) => reported.push({ name, error }),
  });

  expect(host.processScans).toBe(3);
  // Pass 1 ends children leaves-first in dependency order; pass 2 ends verified supervisors in order.
  expect(host.ended).toEqual([
    102, 101, 202, 201, 302, 301, 402, 401, 502, 501, 100, 200, 300, 400, 500,
  ]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
  expect(reported).toEqual(allServices.map((name) => ({ name })));
  expect(await readdir(path.join(root, "native", "processes"))).toEqual([]);
});

test("stopNativeProcesses stops earlier services, fails on an unverified mid-list service, and leaves downstream services untouched", async () => {
  const leases = await seedAllFiveServices(true);
  // Replace teamhub's supervisor command with a mismatched lease at the same PID and birth.
  host.processes = host.processes.map((entry) =>
    entry.pid === 300 ? worker(300, "teamhub", "f".repeat(64)) : entry,
  );
  const reported: Array<{ name: NativeService; error?: unknown }> = [];

  await expect(
    stopNativeProcesses(root, allServices, {
      onServiceDone: (name, _durationMs, error) =>
        reported.push({ name, error }),
    }),
  ).rejects.toMatchObject({
    code: NATIVE_PROCESS_IDENTITY_UNVERIFIED,
    message: expect.stringMatching(/teamhub.*identity cannot be verified/i),
  });

  expect(host.ended).toEqual([102, 101, 202, 201]);
  expect(reported).toEqual([
    { name: "web", error: undefined },
    { name: "node-services", error: undefined },
    {
      name: "teamhub",
      error: expect.objectContaining({
        code: NATIVE_PROCESS_IDENTITY_UNVERIFIED,
      }),
    },
  ]);
  // Downstream services and teamhub remain alive and untouched (records kept, no `.stop` files).
  expect(host.processes.map((entry) => entry.pid)).toEqual([
    1, 300, 301, 302, 400, 401, 402, 500, 501, 502,
  ]);
  const files = (await readdir(path.join(root, "native", "processes"))).sort();
  expect(files).toEqual(["livekit.json", "postgres.json", "teamhub.json"]);
  expect(files).not.toContain(`livekit.${leases.get("livekit")}.stop`);
  expect(files).not.toContain(`postgres.${leases.get("postgres")}.stop`);
  expect(files).not.toContain(`teamhub.${leases.get("teamhub")}.stop`);
});

test("stopNativeProcesses falls back to taskkill at deadline for a stubborn Windows service", async () => {
  await record("web", 10, "1".repeat(64));
  await record("postgres", 20, "2".repeat(64));
  host.processes.push(
    worker(10, "web", "1".repeat(64)),
    row(11, 10, 101, "web.exe"),
    worker(20, "postgres", "2".repeat(64)),
    row(21, 20, 101, "postgres.exe"),
  );
  vi.mocked(process.kill).mockImplementation((pid, signal) => {
    if (signal === 0) {
      if (host.processes.some((entry) => entry.pid === pid)) return true;
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    if (pid === 11 || pid === 10) {
      host.processes = host.processes.filter((entry) => entry.pid !== pid);
    }
    return true;
  });
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));

  const reported: NativeService[] = [];
  await stopNativeProcesses(root, ["web", "postgres"], {
    onServiceDone: (name) => reported.push(name),
  });
  expect(reported).toEqual(["web", "postgres"]);
  expect(taskkill.calls).toEqual([["/PID", "20", "/T", "/F"]]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
});

test("stopNativeProcesses stops earlier services, fails on a corrupted mid-list record, and leaves downstream services untouched", async () => {
  await seedAllFiveServices(true);
  await writeFile(
    path.join(root, "native", "processes", "teamhub.json"),
    JSON.stringify({ schemaVersion: 1, name: "teamhub", pid: 0 }),
  );
  const reported: Array<{ name: NativeService; error?: unknown }> = [];

  await expect(
    stopNativeProcesses(root, allServices, {
      onServiceDone: (name, _durationMs, error) =>
        reported.push({ name, error }),
    }),
  ).rejects.toThrow(/Invalid native process identity record/i);

  expect(host.ended).toEqual([102, 101, 202, 201]);
  expect(reported).toEqual([
    { name: "web", error: undefined },
    { name: "node-services", error: undefined },
    {
      name: "teamhub",
      error: expect.objectContaining({
        message: expect.stringMatching(
          /Invalid native process identity record/i,
        ),
      }),
    },
  ]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([
    1, 300, 301, 302, 400, 401, 402, 500, 501, 502,
  ]);
  expect(
    (await readdir(path.join(root, "native", "processes"))).sort(),
  ).toEqual(["livekit.json", "postgres.json", "teamhub.json"]);
});

test("stopNativeProcesses respects AbortSignal before start and between deadline taskkill calls", async () => {
  await record("web", 10, "1".repeat(64));
  await record("postgres", 20, "2".repeat(64));
  host.processes.push(
    worker(10, "web", "1".repeat(64)),
    row(11, 10, 101, "web.exe"),
    worker(20, "postgres", "2".repeat(64)),
    row(21, 20, 101, "postgres.exe"),
  );

  const preAborted = new AbortController();
  preAborted.abort(new DOMException("aborted early", "AbortError"));
  const preReported: NativeService[] = [];
  await expect(
    stopNativeProcesses(root, ["web", "postgres"], {
      signal: preAborted.signal,
      onServiceDone: (name) => preReported.push(name),
    }),
  ).rejects.toThrow(/aborted early/);
  expect(host.processScans).toBe(0);
  expect(host.ended).toEqual([]);
  expect(preReported).toEqual([]);

  // Now let both hit the deadline and abort right after web's taskkill runs.
  const midController = new AbortController();
  vi.mocked(process.kill).mockImplementation(() => true);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
  taskkill.onRun = (args) => {
    if (args[1] === "10") {
      midController.abort(
        new DOMException("cancelled mid-deadline", "AbortError"),
      );
    }
  };
  const midReported: Array<{ name: NativeService; error?: unknown }> = [];
  await expect(
    stopNativeProcesses(root, ["web", "postgres"], {
      signal: midController.signal,
      onServiceDone: (name, _durationMs, error) =>
        midReported.push({ name, error }),
    }),
  ).rejects.toThrow(/cancelled mid-deadline/);
  expect(taskkill.calls).toEqual([["/PID", "10", "/T", "/F"]]);
  expect(midReported).toEqual([{ name: "web", error: undefined }]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1, 20, 21]);
});

test("stopNativeProcesses attributes cleared rm failures and requestStop failures to the exact failing service", async () => {
  // Case 1: rm fails on node-services while web is already cleared and teamhub is still running.
  const webLease = "1".repeat(64);
  const nodeLease = "2".repeat(64);
  const teamhubLease = "3".repeat(64);
  await record("web", 100, webLease);
  await record("node-services", 200, nodeLease);
  await record("teamhub", 300, teamhubLease);
  host.processes.push(
    worker(300, "teamhub", teamhubLease),
    row(301, 300, 101, "teamhub.exe"),
  );
  fsHooks.onRm = (file) => {
    if (file.endsWith(`${path.sep}node-services.json`)) {
      throw Object.assign(new Error("rm EACCES node-services"), {
        code: "EACCES",
      });
    }
  };
  const rmReported: Array<{ name: NativeService; error?: unknown }> = [];
  await expect(
    stopNativeProcesses(root, ["web", "node-services", "teamhub"], {
      onServiceDone: (name, _durationMs, error) =>
        rmReported.push({ name, error }),
    }),
  ).rejects.toThrow("rm EACCES node-services");
  expect(rmReported).toEqual([
    { name: "web", error: undefined },
    {
      name: "node-services",
      error: expect.objectContaining({ message: "rm EACCES node-services" }),
    },
  ]);
  expect(host.ended).toEqual([]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1, 300, 301]);

  // Case 2: requestStop fails on node-services while web and teamhub are running.
  fsHooks.onRm = null;
  await rm(path.join(root, "native", "processes"), {
    recursive: true,
    force: true,
  });
  host.processes = [row(1, 0, 1, "wininit.exe")];
  host.ended = [];
  host.cascade = new Map();
  await record("web", 100, webLease);
  await record("node-services", 200, nodeLease);
  await record("teamhub", 300, teamhubLease);
  host.processes.push(
    worker(100, "web", webLease),
    row(101, 100, 101, "web.exe"),
    worker(200, "node-services", nodeLease),
    row(201, 200, 101, "node-services.exe"),
    worker(300, "teamhub", teamhubLease),
    row(301, 300, 101, "teamhub.exe"),
  );
  host.cascade.set(101, [100]);
  fsHooks.onWriteFile = (file) => {
    if (file.endsWith(`node-services.${nodeLease}.stop`)) {
      throw Object.assign(new Error("stop EACCES node-services"), {
        code: "EACCES",
      });
    }
  };
  const stopReported: Array<{ name: NativeService; error?: unknown }> = [];
  await expect(
    stopNativeProcesses(root, ["web", "node-services", "teamhub"], {
      onServiceDone: (name, _durationMs, error) =>
        stopReported.push({ name, error }),
    }),
  ).rejects.toThrow("stop EACCES node-services");
  expect(host.ended).toEqual([101]);
  expect(stopReported).toEqual([
    { name: "web", error: undefined },
    {
      name: "node-services",
      error: expect.objectContaining({ message: "stop EACCES node-services" }),
    },
  ]);
  // Downstream teamhub was neither signalled nor given a `.stop` file.
  expect(host.processes.map((entry) => entry.pid)).toEqual([
    1, 200, 201, 300, 301,
  ]);
  expect(
    (await readdir(path.join(root, "native", "processes"))).sort(),
  ).toEqual(["node-services.json", "teamhub.json"]);
});

test("stopNativeProcesses retries transient empty-command-line CIM rows independently per service", async () => {
  const webLease = "1".repeat(64);
  const nodeLease = "2".repeat(64);
  await record("web", 100, webLease);
  await record("node-services", 200, nodeLease);
  // Snapshot 1: web is exiting with an empty command line while node-services is still running.
  // Snapshot 2: web is gone, while node-services enters exit with its own empty command line.
  // Snapshot 3: both are gone.
  host.snapshots = [
    [
      row(1, 0, 1, "wininit.exe"),
      row(100, 1, 100, ""),
      worker(200, "node-services", nodeLease),
    ],
    [row(1, 0, 1, "wininit.exe"), row(200, 1, 100, "")],
    [row(1, 0, 1, "wininit.exe")],
  ];

  await stopNativeProcesses(root, ["web", "node-services"]);

  expect(host.processScans).toBe(3);
  expect(host.ended).toEqual([]);
  expect(await readdir(path.join(root, "native", "processes"))).toEqual([]);
});

test("stopNativeProcesses never kills a pre-.stop supervisor-only tree before a post-.stop snapshot", async () => {
  const webLease = "1".repeat(64);
  await record("web", 100, webLease);
  // Pass 1 sees only the supervisor (e.g., in restart backoff before `.stop` exists).
  host.processes.push(worker(100, "web", webLease));
  fsHooks.onWriteFile = (file) => {
    if (file.endsWith(`web.${webLease}.stop`)) {
      // Simulate the supervisor spawning a restarted child right before `.stop` landed.
      host.processes.push(row(101, 100, 102, "web.exe"));
    }
  };

  await stopNativeProcesses(root, ["web"]);

  // Supervisor 100 was NOT killed on Pass 1; Pass 2 saw child 101 and ended it leaves-first.
  expect(host.ended).toEqual([101, 100]);
  expect(host.processes.map((entry) => entry.pid)).toEqual([1]);
  expect(await readdir(path.join(root, "native", "processes"))).toEqual([]);
});

test("stopNativeProcesses refreshes each subsequent service snapshot at deadline before invoking taskkill", async () => {
  const webLease = "1".repeat(64);
  const pgLease = "2".repeat(64);
  await record("web", 10, webLease);
  await record("postgres", 20, pgLease);
  host.processes.push(
    worker(10, "web", webLease),
    row(11, 10, 101, "web.exe"),
    worker(20, "postgres", pgLease),
    row(21, 20, 101, "postgres.exe"),
  );
  vi.mocked(process.kill).mockImplementation(() => true);
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
  // While web's taskkill runs, postgres exits and Windows reuses PID 20 for an unrelated program.
  taskkill.onRun = (args) => {
    if (args[1] === "10") {
      host.processes = [
        ...host.processes.filter(
          (entry) => entry.pid !== 20 && entry.pid !== 21,
        ),
        row(20, 1, 999, "notepad.exe"),
      ];
    }
  };

  const reported: NativeService[] = [];
  await stopNativeProcesses(root, ["web", "postgres"], {
    onServiceDone: (name) => reported.push(name),
  });

  expect(reported).toEqual(["web", "postgres"]);
  expect(taskkill.calls).toEqual([["/PID", "10", "/T", "/F"]]);
  // Reused PID 20 (notepad.exe) was never targeted and remains alive.
  expect(host.processes).toEqual([
    row(1, 0, 1, "wininit.exe"),
    row(20, 1, 999, "notepad.exe"),
  ]);
});
