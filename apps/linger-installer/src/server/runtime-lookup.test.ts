import { expect, it, vi } from "vitest";
import type { RuntimeDescriptor } from "@linger/local-installation/managed-runtimes";
import { RUNTIME_LOOKUP_RETAIN_MS, RuntimeLookups } from "./runtime-lookup.js";

const pending = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

it("joins a running lookup and answers a late caller from its result", async () => {
  const slow = pending<string>();
  const lookup = vi.fn(() => slow.promise);
  let now = 0;
  const lookups = new RuntimeLookups(lookup, { now: () => now });
  // The desktop's first request gives up while the lookup is still running,
  // then asks again; the second request joins the same work.
  const first = lookups.get("local");
  const second = lookups.get("local");
  expect(lookup).toHaveBeenCalledTimes(1);
  now = 104_000;
  slow.resolve("paths");
  await expect(first).resolves.toBe("paths");
  await expect(second).resolves.toBe("paths");
  // A relaunch a few minutes later picks up the finished result at once.
  now += RUNTIME_LOOKUP_RETAIN_MS - 1;
  await expect(lookups.get("local")).resolves.toBe("paths");
  expect(lookup).toHaveBeenCalledTimes(1);
  now += 1;
  lookup.mockResolvedValueOnce("fresh");
  await expect(lookups.get("local")).resolves.toBe("fresh");
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("asks again after a failed lookup", async () => {
  const lookup = vi
    .fn<(name: string) => Promise<string>>()
    .mockRejectedValueOnce(new Error("probe failed"))
    .mockResolvedValueOnce("paths");
  const lookups = new RuntimeLookups(lookup);
  await expect(lookups.get("local")).rejects.toThrow("probe failed");
  await expect(lookups.get("local")).resolves.toBe("paths");
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("forgets a result and the install's descriptors when an install starts or ends", async () => {
  const descriptor = { runtime: "pi", executable: "/pi" } as RuntimeDescriptor;
  const lookup = vi.fn(
    async (_name: string, descriptors: RuntimeDescriptor[] | undefined) =>
      descriptors,
  );
  const lookups = new RuntimeLookups(lookup);
  await expect(lookups.get("local")).resolves.toBeUndefined();
  lookups.invalidate("local");
  lookups.remember("local", [descriptor]);
  await expect(lookups.get("local")).resolves.toEqual([descriptor]);
  await expect(lookups.get("other")).resolves.toBeUndefined();
  lookups.invalidate("local");
  await expect(lookups.get("local")).resolves.toBeUndefined();
  expect(lookup).toHaveBeenCalledTimes(4);
});

it("does not keep a lookup that was running when an install started", async () => {
  const stale = pending<string>();
  const lookup = vi
    .fn<(name: string) => Promise<string>>()
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValueOnce("after install");
  const lookups = new RuntimeLookups(lookup);
  const before = lookups.get("local");
  lookups.invalidate("local");
  stale.resolve("before install");
  await expect(before).resolves.toBe("before install");
  await expect(lookups.get("local")).resolves.toBe("after install");
});
