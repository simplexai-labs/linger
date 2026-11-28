import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireManagedToolsLock } from "./managed-tools-lock.mjs";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const foreignClaim = async (root: string, pid: number, ticket: number) => {
  const claim = path.join(
    root,
    ".locks",
    `${pid}-11111111-1111-4111-8111-111111111111`,
  );
  await mkdir(claim, { recursive: true });
  await writeFile(path.join(claim, "ticket"), String(ticket));
  return claim;
};

describe("acquireManagedToolsLock", () => {
  it("reclaims a claim whose process is gone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "managed-tools-lock-"));
    roots.push(root);
    await foreignClaim(root, 999999, 2);
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 999999)
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return realKill(pid, 0);
    }) as typeof process.kill);
    const unlock = await acquireManagedToolsLock(root, 30_000);
    expect(typeof unlock).toBe("function");
    await unlock();
    // The stale claim was reclaimed and our own claim released.
    expect(await readdir(path.join(root, ".locks"))).toEqual([]);
  });

  it("waits on a claim whose process exists but belongs to another user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "managed-tools-lock-"));
    roots.push(root);
    const claim = await foreignClaim(root, 999999, 2);
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 999999)
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return realKill(pid, 0);
    }) as typeof process.kill);
    // A foreign-UID holder is alive: wait it out instead of crashing on the
    // unsignallable PID check.
    await expect(acquireManagedToolsLock(root, 200)).rejects.toThrow(
      "Timed out waiting for managed tools installation lock",
    );
    // The timed-out attempt released only our own claim, never the live one.
    expect(await readdir(path.join(root, ".locks"))).toEqual([
      path.basename(claim),
    ]);
  });
});
