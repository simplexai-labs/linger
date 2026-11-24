import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const identity = vi.hoisted(() => ({
  observed:
    vi.fn<
      (
        pid: number,
        lease: string,
        requireLeader?: boolean,
      ) => Promise<string | undefined>
    >(),
  leased:
    vi.fn<(lease: string) => Promise<Array<{ pid: number; birth: string }>>>(),
  linuxStates:
    vi.fn<
      (
        ownedOnly?: boolean,
      ) => Promise<Array<{ pid: number; group: number; state: string }>>
    >(),
}));

vi.mock("./native-process-identity.js", async (original) => ({
  ...(await original<typeof import("./native-process-identity.js")>()),
  nativeProcessIdentity: identity.observed,
  nativeLeaseProcesses: identity.leased,
  linuxProcessStates: identity.linuxStates,
}));

vi.mock("./instance.js", async (original) => ({
  ...(await original<typeof import("./instance.js")>()),
  readPrivate: (file: string) => readFile(file, "utf8").catch(() => undefined),
}));

import {
  NATIVE_PROCESS_SIGNAL_DENIED,
  stopNativeProcess,
} from "./native-process.js";

const eperm = (): NodeJS.ErrnoException =>
  Object.assign(new Error("kill EPERM"), { code: "EPERM" });

const linuxTest = process.platform === "linux" ? test : test.skip;

let root = "";
const lease = "d".repeat(64);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "native-eperm-"));
  identity.observed.mockReset();
  identity.leased.mockReset();
  identity.linuxStates.mockReset();
  identity.observed.mockResolvedValue(undefined);
  identity.leased.mockResolvedValue([]);
  identity.linuxStates.mockResolvedValue([]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function writeRecord(
  name: "postgres" | "web",
  pid: number,
  birth: string,
) {
  await mkdir(path.join(root, "native", "processes"), { recursive: true });
  await writeFile(
    path.join(root, "native", "processes", `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      pid,
      birth,
      lease,
      configuration: "e".repeat(64),
    }),
  );
}

linuxTest(
  "ignores EPERM from a stale PID now owned by another UID and cleans the stale record",
  async () => {
    const uid = process.getuid?.();
    if (uid === undefined || uid === 0) return;
    let foreignPid: number | undefined;
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const candidate = Number(entry);
      if (candidate < 2) continue;
      const owner = await stat(`/proc/${candidate}`).then(
        (info) => info.uid,
        () => undefined,
      );
      if (owner !== undefined && owner !== uid) {
        foreignPid = candidate;
        break;
      }
    }
    if (foreignPid === undefined) return;
    await writeRecord("postgres", foreignPid, `linux:${uid}:999999`);
    await expect(stopNativeProcess(root, "postgres")).resolves.toBeUndefined();
    await expect(
      readFile(path.join(root, "native/processes/postgres.json"), "utf8"),
    ).rejects.toThrow();
    expect(identity.linuxStates).toHaveBeenCalledWith(true);
  },
);

linuxTest(
  "treats EPERM during signal as exited when revalidation shows the lease is gone",
  async () => {
    const pid = 424242;
    const birth = "linux:1000:12345";
    await writeRecord("web", pid, birth);
    identity.observed
      .mockResolvedValueOnce(birth)
      .mockResolvedValueOnce(birth)
      .mockResolvedValueOnce(undefined);
    identity.leased
      .mockResolvedValueOnce([{ pid, birth }])
      .mockResolvedValue([]);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw eperm();
    });

    await expect(stopNativeProcess(root, "web", 100)).resolves.toBeUndefined();
    await expect(
      readFile(path.join(root, "native/processes/web.json"), "utf8"),
    ).rejects.toThrow();
  },
);

linuxTest(
  "surfaces a structured error naming service and PID when a still-leased process refuses signals with EPERM",
  async () => {
    const pid = 424243;
    const birth = "linux:1000:54321";
    await writeRecord("web", pid, birth);
    identity.observed.mockResolvedValue(birth);
    identity.leased.mockResolvedValue([{ pid, birth }]);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw eperm();
    });

    await expect(stopNativeProcess(root, "web", 100)).rejects.toMatchObject({
      code: NATIVE_PROCESS_SIGNAL_DENIED,
      pid,
      message: expect.stringMatching(
        /Native web process \(PID 424243\).*EPERM/,
      ),
    });
    // Record is retained while the owned process remains running.
    await expect(
      readFile(path.join(root, "native/processes/web.json"), "utf8"),
    ).resolves.toBeTruthy();
  },
);
