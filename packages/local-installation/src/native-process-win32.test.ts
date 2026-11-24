import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  listeners: new Map<number, number>(),
  listenersAvailable: true,
  ended: [] as number[],
  cascade: new Map<number, number[]>(),
}));
vi.mock("./native-process-identity.js", async (original) => {
  const actual =
    await original<typeof import("./native-process-identity.js")>();
  const windowsProcesses = async () => [
    ...host.processes,
    ...host.exiting.splice(0),
  ];
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
    return { stdout: "", stderr: "", code: 0 };
  },
}));
vi.mock("./instance.js", async (original) => ({
  ...(await original<typeof import("./instance.js")>()),
  readPrivate: (file: string) => readFile(file, "utf8").catch(() => undefined),
}));
import {
  inspectNativeListeners,
  inspectNativeProcess,
  reclaimNativeOrphans,
  stopNativeProcess,
} from "./native-process.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root = "";
beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  root = await mkdtemp(path.join(tmpdir(), "native-win32-"));
  host.processes = [row(1, 0, 1, "wininit.exe")];
  host.exiting = [];
  host.listeners = new Map();
  host.listenersAvailable = true;
  host.ended = [];
  host.cascade = new Map();
  taskkill.calls = [];
  taskkill.ends = true;
  vi.spyOn(process, "kill").mockImplementation((pid: number) => {
    const gone = [pid, ...(host.cascade.get(pid) ?? [])];
    host.ended.push(pid);
    host.processes = host.processes.filter(
      (entry) => !gone.includes(entry.pid),
    );
    return true;
  });
});
afterEach(async () => {
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
  "stop retains the live record with %s and signals nothing",
  async (_, supervisor) => {
    await record("web", 10);
    host.processes.push(supervisor(), row(11, 10, 101, "web.exe"));
    const file = path.join(root, "native/processes/web.json");
    const original = await readFile(file, "utf8");

    await expect(stopNativeProcess(root, "web")).rejects.toThrow(
      /identity cannot be verified.*record retained/i,
    );
    expect(host.ended).toEqual([]);
    expect(taskkill.calls).toEqual([]);
    await expect(readFile(file, "utf8")).resolves.toBe(original);
  },
);

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
