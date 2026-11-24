import { describe, expect, it } from "vitest";
import {
  parseWindowsListeners,
  windowsLeaseTree,
  type WindowsProcess,
} from "./native-process-identity.js";
import { windowsOrphans, windowsTerminationOrder } from "./native-process.js";

const lease = "a".repeat(64);
const row = (pid: number, parent: number, created: number, command = "") => ({
  pid,
  parent,
  created,
  command,
});
const inspection = (pid: number, parent: number, created: number) =>
  row(
    pid,
    parent,
    created,
    `powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'\nGet-CimInstance Win32_Process | ForEach-Object { }"`,
  );

describe("windowsLeaseTree", () => {
  it("starts at the supervisor whose job carries the lease", () => {
    const tree = windowsLeaseTree(
      [
        row(10, 1, 100, `node worker.mjs C:\\x\\postgres.${lease}.job`),
        row(11, 10, 101, "postgres.exe"),
        row(12, 11, 102, "postgres.exe"),
        row(13, 1, 103, "unrelated.exe"),
      ],
      lease,
    );
    expect(tree.map((candidate) => candidate.pid)).toEqual([10, 11, 12]);
  });

  it("rejects a reused PID that is older than its claimed parent", () => {
    const tree = windowsLeaseTree(
      [
        row(10, 1, 100, `worker postgres.${lease}.job`),
        row(11, 10, 50, "stale.exe"),
      ],
      lease,
    );
    expect(tree.map((candidate) => candidate.pid)).toEqual([10]);
  });

  it("finds nothing without the lease", () => {
    expect(
      windowsLeaseTree(
        [row(10, 1, 100, `worker postgres.${"b".repeat(64)}.job`)],
        lease,
      ),
    ).toEqual([]);
  });

  it("does not count the supervisor's own process inspection as its service", () => {
    // The supervisor whose LiveKit died: only the PowerShell of its own
    // check (and that one's console host) runs under it.
    const tree = windowsLeaseTree(
      [
        row(10, 1, 100, `node native-process-worker.mjs livekit.${lease}.job`),
        inspection(20, 10, 200),
        row(
          22,
          10,
          202,
          `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine"`,
        ),
        row(21, 20, 201, "\\??\\C:\\WINDOWS\\system32\\conhost.exe 0xffffffff"),
        // Protected or exiting processes whose CreationDate was null get created=0.
        row(0, 0, 0, ""),
        row(4, 0, 0, ""),
        row(25, 10, 0, "exiting.exe"),
      ],
      lease,
    );
    expect(tree.map((candidate) => candidate.pid)).toEqual([10]);
  });
});

describe("parseWindowsListeners", () => {
  it("finds IPv4 listeners without interpreting localized states", async () => {
    const listeners = await parseWindowsListeners([
      "  TCP    127.0.0.1:55641  0.0.0.0:0  ÉCOUTE  7644",
      "  TCP    [::1]:3000      [::]:0     LISTENING   29644",
      "  TCP    127.0.0.1:3000   0.0.0.0:0  LISTENING   16588",
      "  TCP    0.0.0.0:3000     0.0.0.0:0  LISTENING   31000",
      "  TCP    0.0.0.0:5432     0.0.0.0:0  LISTENING   1632",
      "  TCP    127.0.0.1:55641  127.0.0.1:34500  ESTABLISHED  4600",
      "  TCP    192.0.2.4:2345   0.0.0.0:0  LISTENING   8000",
      "  UDP    0.0.0.0:53      *:*        1000",
      "  TCP    0.0.0.0:65536    0.0.0.0:0  LISTENING   1",
      "  TCP    0.0.0.0:65534    0.0.0.0:0  LISTENING   0",
    ]);
    expect(listeners).toEqual(
      new Map([
        [55641, 7644],
        [3000, 16588],
        [5432, 1632],
      ]),
    );
  });
});

it("ends leaves before the processes that started them", () => {
  expect(
    windowsTerminationOrder([
      row(10, 1, 100),
      row(11, 10, 101),
      row(12, 11, 102),
    ]),
  ).toEqual([12, 11, 10]);
});

describe("windowsOrphans", () => {
  const home = "C:\\Users\\Ada\\.simplexai";
  const root = `${home}\\instances\\desktop`;
  const node = `${home}\\desktop\\node\\v26.5.0\\node.exe`;
  const oldSource = `${home}\\desktop\\source\\f1e089bacd8b0bd7`;
  const newSource = `${home}\\desktop\\source\\e91b1008ba80087b`;
  const worker = (name: string, key: string) =>
    `${node} C:\\Users\\Ada\\AppData\\Local\\Programs\\Linger\\resources\\app\\dist\\installer\\native-process-worker.mjs ${root}\\native\\processes\\${name}.${key}.job`;
  const ports = { teamhub: 55640, nodeServices: 55641, web: 3000, pg: 55643 };
  const postgresLease = "c".repeat(64);
  const liveKitLease = "d".repeat(64);
  const strayLease = "e".repeat(64);
  // What WIN-10 left after the 0.1.3 setup stopped 0.1.2: its TeamHub, web
  // and node-services without their supervisors, a LiveKit supervisor whose
  // LiveKit is gone, and a PostgreSQL its supervisor still owns.
  const processes: WindowsProcess[] = [
    row(1, 0, 1, "wininit.exe"),
    row(
      500,
      1,
      50,
      `"C:\\Users\\Ada\\AppData\\Local\\Programs\\Linger\\Linger.exe"`,
    ),
    row(600, 500, 60, `${node} installer.js --home ${home} --resume`),
    row(27876, 1, 100, worker("postgres", postgresLease)),
    row(
      9324,
      27876,
      101,
      `${home}\\tools\\native\\bin\\postgres.exe -D ${root}\\native\\postgres-data`,
    ),
    row(
      9330,
      9324,
      102,
      `"${home}/tools/native/bin/postgres.exe" --forkchild="backend" 5604`,
    ),
    row(31196, 1, 110, worker("livekit", liveKitLease)),
    inspection(38584, 31196, 900),
    row(
      18248,
      42964,
      120,
      `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "${oldSource}\\.simplexai-runtime\\prebuilt\\teamhub.exe"`,
    ),
    row(
      26340,
      18248,
      121,
      `${oldSource}\\.simplexai-runtime\\prebuilt\\teamhub.exe`,
    ),
    row(
      16588,
      33136,
      130,
      `${node} ${oldSource}\\.simplexai-runtime\\offline\\web\\static-host.mjs`,
    ),
    row(
      41828,
      38688,
      140,
      `${node} --conditions=linger-production ${oldSource}\\.simplexai-runtime\\offline\\node-services\\dist\\supervisor.js --compiled`,
    ),
    row(
      7644,
      41828,
      141,
      `${node} --conditions=linger-production ${oldSource}\\.simplexai-runtime\\offline\\node-services\\dist\\main.js`,
    ),
    row(7700, 1, 150, worker("web", strayLease)),
    row(42372, 13172, 160, "C:\\bench\\llama-server.exe --port 18910"),
    row(44444, 1, 170, `${newSource}\\scripts\\source-native.mjs web`),
  ];
  const listeners = new Map([
    [ports.teamhub, 26340],
    [ports.nodeServices, 7644],
    [ports.web, 16588],
    [ports.pg, 9324],
    [18910, 42372],
  ]);
  const records = [
    {
      pid: 27876,
      birth: "win32:27876:100",
      lease: postgresLease,
    },
    { pid: 31196, birth: "win32:31196:110", lease: liveKitLease },
  ];
  const options = {
    root,
    ports: Object.values(ports),
    paths: [home, root, newSource],
    self: 600,
  };

  it("finds what an earlier release left running, deepest first", () => {
    const order = windowsOrphans({ processes, listeners }, records, options);
    // LiveKit's supervisor without LiveKit; a supervisor no record holds.
    expect(order).toEqual(
      expect.arrayContaining([31196, 7700, 26340, 18248, 16588, 7644, 41828]),
    );
    expect(order.indexOf(26340)).toBeLessThan(order.indexOf(18248));
    expect(order.indexOf(7644)).toBeLessThan(order.indexOf(41828));
    // The stale supervisor's inspection ends with it.
    expect(order.indexOf(38584)).toBeLessThan(order.indexOf(31196));
    // The serving PostgreSQL tree, another program on its own port, a
    // process on no port, and the running installer stay.
    for (const kept of [27876, 9324, 9330, 42372, 44444, 600, 500])
      expect(order).not.toContain(kept);
  });

  it("leaves a program outside this installation alone, even on its port", () => {
    const order = windowsOrphans(
      {
        processes: [...processes, row(8080, 1, 180, "C:\\tools\\other.exe")],
        listeners: new Map([[ports.web, 8080]]),
      },
      records,
      options,
    );
    expect(order).not.toContain(8080);
  });

  it("never ends this process or what started it", () => {
    // The installer itself runs from the home and could hold a port.
    const order = windowsOrphans(
      { processes, listeners: new Map([[ports.web, 600]]) },
      [],
      options,
    );
    expect(order).not.toContain(600);
    expect(order).not.toContain(500);
  });

  it("leaves a serving supervisor's tree to its own stop", () => {
    const order = windowsOrphans(
      {
        processes: [
          row(31196, 1, 110, worker("livekit", liveKitLease)),
          row(
            31668,
            31196,
            111,
            `${home}\\tools\\native\\bin\\livekit-server.exe`,
          ),
        ],
        listeners: new Map([[7880, 31668]]),
      },
      [records[1]!],
      { ...options, ports: [7880] },
    );
    expect(order).toEqual([]);
  });
});
