import { execFileSync } from "node:child_process";
import { chmodSync, renameSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
  rename,
  stat,
  utimes,
  symlink,
  link,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { withInstanceLock, type Instance } from "./instance.js";
import { REGION_SCHEMA, regionFile } from "./region.js";
import { requestUrlText } from "@linger/service-kit";
import { afterEach, expect, test, vi } from "vitest";
import {
  ensureLocalmodelsTool,
  runLocalmodels,
  stopLocalmodels,
  validateToolSource,
} from "./localmodels-tool.js";
const roots: string[] = [];
async function reopenDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory())
      await reopenDirectories(path.join(directory, entry.name));
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map(async (p) => {
      // Verified kits are sealed read-only; reopen them before cleanup.
      if (process.platform !== "win32") await reopenDirectories(p);
      await rm(p, { recursive: true, force: true });
    }),
  );
});
const hash = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "linger-model-tool-"));
  roots.push(home);
  // A region resolved earlier, so no test probes the registries.
  await mkdir(path.dirname(regionFile(home)), { recursive: true });
  await writeFile(
    regionFile(home),
    JSON.stringify({
      schema: REGION_SCHEMA,
      region: "global",
      resolved_at: new Date().toISOString(),
      method: "probe",
    }),
  );
  const manifest = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    sourceCommit: "a".repeat(40),
    python: "python/python",
    moduleDir: "modules",
    assets: {
      "python/python": hash("python"),
      "modules/localmodels/__init__.py": hash("package"),
    },
  };
  const body = JSON.stringify(manifest);
  const source = {
    url: "https://example.com/tool.tgz",
    sha256: "b".repeat(64),
    bytes: 100,
    manifestSha256: hash(body),
    sourceCommit: "a".repeat(40),
  };
  const directory = path.join(home, "tools", "localmodels", source.sha256);
  await mkdir(path.join(directory, "python"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, "modules/localmodels"), { recursive: true });
  await writeFile(path.join(directory, "tool.json"), body, { mode: 0o600 });
  await writeFile(path.join(directory, "python/python"), "python", {
    mode: 0o700,
  });
  await writeFile(
    path.join(directory, "modules/localmodels/__init__.py"),
    "package",
  );
  return { home, source, directory };
}
// The published archive of the fixture kit: an npm tarball, whose files sit
// under package/. The fixture's own directory is moved into it.
async function packed(f: Awaited<ReturnType<typeof fixture>>) {
  const root = path.join(f.home, "packed");
  await mkdir(root);
  await rename(f.directory, path.join(root, "package"));
  const archive = path.join(f.home, "kit.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return readFile(archive);
}
test("requires a fixed authenticated-free tool source and source identity", () => {
  expect(() =>
    validateToolSource({
      url: "https://example.com/tool",
      sha256: "a".repeat(64),
      bytes: 1,
    }),
  ).toThrow();
  expect(() =>
    validateToolSource({
      url: "https://user:pass@example.com/tool",
      sha256: "a".repeat(64),
      bytes: 1,
      sourceCommit: "b".repeat(40),
      manifestSha256: "c".repeat(64),
    }),
  ).toThrow();
});
test("reuses only a complete checksum-verified private upstream kit", async () => {
  const f = await fixture();
  const tool = await ensureLocalmodelsTool(f.home, {}, { source: f.source });
  expect(tool.python).toBe(path.join(f.directory, "python/python"));
  await chmod(path.join(f.directory, "modules/localmodels"), 0o700);
  await chmod(path.join(f.directory, "modules/localmodels/__init__.py"), 0o600);
  await writeFile(
    path.join(f.directory, "modules/localmodels/__init__.py"),
    "corrupt",
  );
  // The altered kit is replaced from its pinned source, never trusted as is.
  await expect(
    ensureLocalmodelsTool(
      f.home,
      {},
      {
        source: f.source,
        fetcher: async () => new Response("not the kit", { status: 200 }),
      },
    ),
  ).rejects.toThrow(/checksum|size|SHA/i);
});
test("hashes a verified kit again only where an asset's size or time changed", async () => {
  const f = await fixture();
  const file = path.join(f.directory, "modules/localmodels/__init__.py");
  // Whole seconds, which utimes sets exactly.
  const time = 1_800_000_000;
  await utimes(file, time, time);
  await ensureLocalmodelsTool(f.home, {}, { source: f.source });
  const stamps = JSON.parse(
    await readFile(`${f.directory}.verified.json`, "utf8"),
  ) as { manifestSha256: string; stamps: Record<string, unknown> };
  expect(stamps.manifestSha256).toBe(f.source.manifestSha256);
  expect(Object.keys(stamps.stamps).sort()).toEqual([
    "modules/localmodels/__init__.py",
    "python/python",
  ]);
  await chmod(path.dirname(file), 0o700);
  await chmod(file, 0o600);
  // Same size and time: the recorded stamp stands for the checksum.
  await writeFile(file, "PACKAGE");
  await utimes(file, time, time);
  await expect(
    ensureLocalmodelsTool(f.home, {}, { source: f.source }),
  ).resolves.toMatchObject({ moduleDir: path.join(f.directory, "modules") });
  // A new time makes it hash the asset, which no longer matches.
  await utimes(file, time, time + 5);
  await expect(
    ensureLocalmodelsTool(
      f.home,
      {},
      {
        source: f.source,
        fetcher: async () => new Response("not the kit", { status: 200 }),
      },
    ),
  ).rejects.toThrow(/checksum|size|SHA/i);
});
test.skipIf(process.platform === "win32")(
  "seals a verified kit read-only so upstream bytecode writes cannot alter it",
  async () => {
    const f = await fixture();
    await ensureLocalmodelsTool(f.home, {}, { source: f.source });
    const mode = async (file: string) =>
      (await stat(path.join(f.directory, file))).mode & 0o777;
    expect(await mode(".")).toBe(0o500);
    expect(await mode("modules/localmodels")).toBe(0o500);
    expect(await mode("python/python")).toBe(0o500);
    expect(await mode("modules/localmodels/__init__.py")).toBe(0o400);
  },
);
test.skipIf(process.platform !== "win32")(
  "seals verified Windows files against bytecode replacement and republishes a damaged kit",
  async () => {
    const f = await fixture();
    await chmod(path.join(f.directory, "tool.json"), 0o400);
    const bytes = await packed(f);
    const source = { ...f.source, sha256: hash(bytes), bytes: bytes.length };
    const fetcher = vi.fn(async () => new Response(bytes));
    const tool = await ensureLocalmodelsTool(f.home, {}, { source, fetcher });
    const manifest = path.join(tool.moduleDir, "..", "tool.json");
    expect((await stat(manifest)).mode & 0o200).toBe(0);
    const file = path.join(tool.moduleDir, "localmodels/__init__.py");
    const replacement = path.join(path.dirname(file), "__init__.py.tmp");
    await writeFile(replacement, "changed bytecode");
    await expect(rename(replacement, file)).rejects.toHaveProperty(
      "code",
      "EPERM",
    );
    await expect(readFile(file, "utf8")).resolves.toBe("package");

    await chmod(file, 0o600);
    await writeFile(file, "damaged");
    await ensureLocalmodelsTool(f.home, {}, { source, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(readFile(file, "utf8")).resolves.toBe("package");
    expect((await stat(file)).mode & 0o200).toBe(0);
    expect(await readdir(path.dirname(file))).toEqual(["__init__.py"]);
  },
  60_000,
);
test.skipIf(process.platform === "win32")(
  "repairs a kit altered after verification by fetching the same pinned archive",
  async () => {
    const f = await fixture();
    const bytes = await packed(f);
    const source = { ...f.source, sha256: hash(bytes), bytes: bytes.length };
    const directory = path.join(f.home, "tools/localmodels", source.sha256);
    const first = vi.fn(async () => new Response(bytes));
    await ensureLocalmodelsTool(f.home, {}, { source, fetcher: first });
    expect(first).toHaveBeenCalledTimes(1);
    // Simulate a Python child recompiling bytecode inside the kit.
    await chmod(path.join(directory, "modules/localmodels"), 0o700);
    await mkdir(path.join(directory, "modules/localmodels/__pycache__"));
    await chmod(path.join(directory, "modules/localmodels/__init__.py"), 0o600);
    await writeFile(
      path.join(directory, "modules/localmodels/__init__.py"),
      "recompiled",
    );
    const events: string[] = [];
    const repair = vi.fn(async () => new Response(bytes));
    const tool = await ensureLocalmodelsTool(
      f.home,
      { onEvent: (event) => events.push(event.message) },
      { source, fetcher: repair },
    );
    expect(repair).toHaveBeenCalledTimes(1);
    expect(events).toContain(
      "Repairing the model and Harness installation tool…",
    );
    expect(tool.moduleDir).toBe(path.join(directory, "modules"));
    expect(
      await readFile(
        path.join(directory, "modules/localmodels/__init__.py"),
        "utf8",
      ),
    ).toBe("package");
    expect(await readdir(path.join(directory, "modules/localmodels"))).toEqual([
      "__init__.py",
    ]);
    expect((await stat(directory)).mode & 0o777).toBe(0o500);
    expect(
      (await readdir(path.join(f.home, "tools/localmodels"))).filter((name) =>
        /^(?:invalid|pending)-|\.tgz$/.test(name),
      ),
    ).toEqual([]);
  },
);
test.skipIf(process.platform === "win32")(
  "installs the published kit, whose files sit under package/",
  async () => {
    const f = await fixture();
    const bytes = await packed(f);
    const source = { ...f.source, sha256: hash(bytes), bytes: bytes.length };
    const directory = path.join(f.home, "tools/localmodels", source.sha256);
    const tool = await ensureLocalmodelsTool(
      f.home,
      {},
      { source, fetcher: async () => new Response(bytes) },
    );
    expect(tool.python).toBe(path.join(directory, "python/python"));
    expect((await readdir(directory)).sort()).toEqual([
      "modules",
      "python",
      "tool.json",
    ]);
    expect((await stat(directory)).mode & 0o777).toBe(0o500);
  },
);
test.skipIf(process.platform === "win32")(
  "downloads the kit from the publisher's mirror when the primary host fails",
  async () => {
    const f = await fixture();
    const bytes = await packed(f);
    const source = {
      ...f.source,
      mirrors: ["https://mirror.example/tool.tgz"],
      sha256: hash(bytes),
      bytes: bytes.length,
    };
    const hosts: string[] = [];
    const tool = await ensureLocalmodelsTool(
      f.home,
      {},
      {
        source,
        fetcher: async (url) => {
          hosts.push(new URL(url as URL).host);
          return new URL(url as URL).host === "example.com"
            ? new Response("missing", { status: 404 })
            : new Response(bytes);
        },
      },
    );
    expect(hosts).toEqual(["example.com", "mirror.example"]);
    expect(tool.moduleDir).toBe(
      path.join(f.home, "tools/localmodels", source.sha256, "modules"),
    );
  },
);
test.skipIf(process.platform === "win32")(
  "downloads the kit from the npm China mirror first in the cn region",
  async () => {
    const f = await fixture();
    const bytes = await packed(f);
    const npm = "https://registry.npmjs.org/@simplexai/kit/-/kit-1.tgz";
    const mirror =
      "https://cdn.npmmirror.com/packages/@simplexai/kit/1/kit-1.tgz";
    const source = {
      ...f.source,
      mirrors: [npm, mirror],
      sha256: hash(bytes),
      bytes: bytes.length,
    };
    await writeFile(
      regionFile(f.home),
      JSON.stringify({
        schema: REGION_SCHEMA,
        region: "cn",
        resolved_at: new Date().toISOString(),
        method: "probe",
      }),
    );
    const requested: string[] = [];
    await ensureLocalmodelsTool(
      f.home,
      {},
      {
        source,
        fetcher: async (url) => {
          requested.push(requestUrlText(url));
          return new Response(bytes);
        },
      },
    );
    expect(requested).toEqual([mirror]);
  },
);
// A refused member must reject the install, not leave the extraction pending.
for (const [label, add] of [
  [
    "a symlink",
    (kit: string) => symlink("/etc/passwd", path.join(kit, "link")),
  ],
  [
    "a hard link",
    (kit: string) =>
      link(path.join(kit, "tool.json"), path.join(kit, "tool-copy.json")),
  ],
] as const)
  test.skipIf(process.platform === "win32")(
    `rejects a kit archive holding ${label} instead of hanging`,
    async () => {
      const f = await fixture();
      await chmod(f.directory, 0o700);
      await add(f.directory);
      const archive = path.join(f.home, "kit.tgz");
      execFileSync("tar", ["-czf", archive, "-C", f.directory, "."], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      await rm(f.directory, { recursive: true, force: true });
      const bytes = await readFile(archive);
      const source = { ...f.source, sha256: hash(bytes), bytes: bytes.length };
      await expect(
        ensureLocalmodelsTool(
          f.home,
          {},
          { source, fetcher: async () => new Response(bytes) },
        ),
      ).rejects.toThrow("Unsafe upstream tool archive.");
      expect(
        (await readdir(path.join(f.home, "tools/localmodels"))).filter((name) =>
          /^pending-|\.tgz$/.test(name),
        ),
      ).toEqual([]);
    },
    5000,
  );
test("does not silently fall back to a user Python or local implementation", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", "");
  await expect(ensureLocalmodelsTool(f.home)).rejects.toThrow(
    /distribution|metadata/i,
  );
});
test("invokes the verified upstream module with isolated module and state paths", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["setup", "inspect", "--json"],
    {
      input: "private",
      env: { PYTHONPATH: "/untrusted", LOCALMODELS_STATE: "/untrusted" },
    },
    { run },
  );
  expect(run).toHaveBeenCalledWith(
    path.join(f.directory, "python/python"),
    ["-P", "-s", "-m", "localmodels", "setup", "inspect", "--json"],
    expect.objectContaining({
      input: "private",
      env: expect.objectContaining({
        PYTHONPATH: path.join(f.directory, "modules"),
        LOCALMODELS_STATE: path.join(f.home, "runtime/localmodels/state"),
      }),
    }),
  );
  expect(await readFile(path.join(f.directory, "tool.json"), "utf8")).toContain(
    "sourceCommit",
  );
});
test("passes the resolved download region to every localmodels child", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  // The home's saved region decides: an inherited auto is replaced, so the
  // child never probes again.
  vi.stubEnv("SIMPLEX_REGION", "auto");
  await writeFile(
    regionFile(f.home),
    JSON.stringify({
      schema: REGION_SCHEMA,
      region: "cn",
      resolved_at: new Date().toISOString(),
      method: "fallback",
    }),
  );
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  for (const args of [
    ["stack", "apply", "--json"],
    ["foundations", "start", "--json"],
    ["harness", "apply", "plan", "--jsonl"],
  ])
    await runLocalmodels(
      f.home,
      args,
      { env: { SIMPLEX_REGION: "global" } },
      { run },
    );
  expect(run).toHaveBeenCalledTimes(3);
  for (const call of run.mock.calls as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ][])
    expect(call[2].env.SIMPLEX_REGION).toBe("cn");
});
// What `library status` prints, cut to the fields the stop reads.
const libraryStatus = (models: { id: string; state: string }[]) => ({
  code: 0,
  stdout: JSON.stringify({ schema: "localmodels.library-status/v1", models }),
  stderr: "",
});
test("unloads the library's models, then stops the controller and the stack through the installed pinned kit", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const base = path.join(f.home, "runtime/localmodels/models");
  const run = vi.fn<typeof runLocalmodels>(async (_home, args) =>
    args[1] === "status"
      ? libraryStatus([
          { id: "qwen3-8b:Q4_K_M", state: "loaded" },
          { id: "spark-x2.6-4b:Q4_K_M", state: "idle" },
          { id: "gemma4-4b:Q4_K_M", state: "loaded" },
        ])
      : { code: 0, stdout: "{}", stderr: "" },
  );
  await stopLocalmodels(f.home, { signal: AbortSignal.timeout(5000) }, { run });
  expect(run.mock.calls.map(([home, args]) => [home, args])).toEqual([
    [f.home, ["library", "status", "--base-dir", base, "--json"]],
    [
      f.home,
      ["library", "unload", "qwen3-8b:Q4_K_M", "--base-dir", base, "--json"],
    ],
    [
      f.home,
      ["library", "unload", "gemma4-4b:Q4_K_M", "--base-dir", base, "--json"],
    ],
    [
      f.home,
      [
        "foundations",
        "stop",
        "--root",
        path.join(f.home, "runtime/model-services"),
        "--json",
      ],
    ],
    [f.home, ["stack", "down", "--json"]],
  ]);
});
test("a quit keeps the controller and stops only the library's models and the stack", async () => {
  const run = vi.fn<typeof runLocalmodels>(async (_home, args) =>
    args[1] === "status"
      ? libraryStatus([{ id: "qwen3-8b:Q4_K_M", state: "loaded" }])
      : { code: 0, stdout: "{}", stderr: "" },
  );
  await stopLocalmodels(
    "/home",
    { signal: AbortSignal.timeout(5000), keepController: true },
    { run, installed: async () => true },
  );
  expect(run.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
    ["library", "status"],
    ["library", "unload"],
    ["stack", "down"],
  ]);
});
test("stops the stack even when the library could not be read or a model did not unload, and names each failure", async () => {
  const unloadFailed = vi.fn<typeof runLocalmodels>(async (_home, args) =>
    args[1] === "status"
      ? libraryStatus([{ id: "qwen3-8b:Q4_K_M", state: "loaded" }])
      : args[1] === "unload"
        ? {
            code: 1,
            stdout: JSON.stringify({
              schema: "localmodels.library-event/v1",
              event: "error",
              ok: false,
              code: "JOB_RUNNING",
              detail: "a download is running",
            }),
            stderr: "",
          }
        : { code: 0, stdout: "{}", stderr: "" },
  );
  await expect(
    stopLocalmodels(
      "/home",
      { signal: AbortSignal.timeout(5000), keepController: true },
      { run: unloadFailed, installed: async () => true },
    ),
  ).rejects.toThrow("localmodels library unload qwen3-8b:Q4_K_M: JOB_RUNNING");
  expect(unloadFailed.mock.calls.at(-1)?.[1]).toEqual([
    "stack",
    "down",
    "--json",
  ]);
  const statusFailed = vi.fn<typeof runLocalmodels>(async (_home, args) =>
    args[1] === "status"
      ? { code: 1, stdout: "", stderr: "error: library status failed" }
      : { code: 0, stdout: "{}", stderr: "" },
  );
  await expect(
    stopLocalmodels(
      "/home",
      { signal: AbortSignal.timeout(5000), keepController: true },
      { run: statusFailed, installed: async () => true },
    ),
  ).rejects.toThrow("localmodels library status: exit 1");
  expect(statusFailed.mock.calls.map(([, args]) => args[1])).toEqual([
    "status",
    "down",
  ]);
});
test("a home without the pinned kit has nothing to stop and downloads nothing", async () => {
  const f = await fixture();
  vi.stubEnv(
    "LINGER_LOCALMODELS_TOOL_JSON",
    JSON.stringify({ ...f.source, sha256: "c".repeat(64) }),
  );
  const run = vi.fn<typeof runLocalmodels>();
  await stopLocalmodels(f.home, { signal: AbortSignal.timeout(5000) }, { run });
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", "");
  await stopLocalmodels(f.home, { signal: AbortSignal.timeout(5000) }, { run });
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(path.join(f.home, "tools/localmodels"))).toEqual([
    f.source.sha256,
  ]);
});
test.for([false, true])(
  "reports a corrupt installed kit as a stop failure (keepController=%s)",
  { timeout: 15_000 },
  async (keepController) => {
    const f = await fixture();
    const file = path.join(f.directory, "modules/localmodels/__init__.py");
    await writeFile(file, "corrupt");
    vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const run = vi.fn<typeof runLocalmodels>();
    await expect(
      stopLocalmodels(
        f.home,
        { signal: AbortSignal.timeout(5000), keepController },
        { run },
      ),
    ).rejects.toThrow("the installed tool kit could not be verified");
    expect(run).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("corrupt");
  },
);

test("a kit disappearing after verification is not downloaded during stop", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    stopLocalmodels(f.home, {
      signal: AbortSignal.timeout(10_000),
      keepController: true,
      log: (message) => {
        if (message.includes("library status")) {
          if (process.platform !== "win32") chmodSync(f.directory, 0o700);
          renameSync(f.directory, f.directory + ".moved");
        }
      },
    }),
  ).rejects.toThrow("The installed localmodels tool kit is missing");
  expect(fetcher).not.toHaveBeenCalled();
}, 15_000);

test("stops the stack even when the controller did not stop, and names the failure", async () => {
  const run = vi.fn<typeof runLocalmodels>(async (_home, args) =>
    args[0] === "foundations"
      ? {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: "controller still running",
          }),
          stderr: "",
        }
      : { code: 0, stdout: "{}", stderr: "" },
  );
  await expect(
    stopLocalmodels(
      "/home",
      { signal: AbortSignal.timeout(5000) },
      { run, installed: async () => true },
    ),
  ).rejects.toThrow("localmodels foundations stop: controller still running");
  expect(run.mock.calls.map(([, args]) => args[0])).toEqual([
    "library",
    "foundations",
    "stack",
  ]);
});
test("reads a publisher-pinned upstream kit only for this host target", async () => {
  const f = await fixture();
  const file = path.join(f.home, "distribution.json");
  await writeFile(
    file,
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      localmodelsTool: f.source,
    }),
  );
  const { readPublishedTool } = await import("./localmodels-tool.js");
  expect(await readPublishedTool(file)).toEqual(f.source);
  await writeFile(
    file,
    JSON.stringify({
      platform: "unsupported",
      arch: process.arch,
      localmodelsTool: f.source,
    }),
  );
  await expect(readPublishedTool(file)).rejects.toThrow(/target/i);
});
test("deduplicates concurrent first-page tool preparation instead of rejecting one request as busy", async () => {
  const f = await fixture();
  const result = await Promise.all([
    ensureLocalmodelsTool(f.home, {}, { source: f.source }),
    ensureLocalmodelsTool(f.home, {}, { source: f.source }),
  ]);
  expect(result[0]).toEqual(result[1]);
});
test("verified tool reads do not contend with another process holding the publication lock", async () => {
  const f = await fixture();
  const lock = path.join(f.home, "tools", "localmodels", "lock");
  await mkdir(lock, { mode: 0o700 });
  await withInstanceLock({ root: lock } as Instance, async () => {
    const tool = await ensureLocalmodelsTool(f.home, {}, { source: f.source });
    expect(tool.python).toBe(path.join(f.directory, "python/python"));
  });
});
test("forwards real Harness byte progress without forwarding native logs or secret fields", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const onEvent = vi.fn();
  const run = vi.fn<typeof import("./process.js").runProcess>(
    async (_file, _args, options) => {
      options?.onOutput?.(
        'private token=hidden\n{"kind":"progress","stage":"download","completed":4,',
      );
      options?.onOutput?.('"total":10,"unit":"bytes","apiKey":"hidden"}\n');
      return { code: 0, stdout: "{}", stderr: "" };
    },
  );
  await runLocalmodels(
    f.home,
    ["harness", "apply", "plan", "--jsonl"],
    { onEvent },
    { run },
  );
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      progress: { completed: 4, total: 10, unit: "bytes" },
    }),
  );
  expect(JSON.stringify(onEvent.mock.calls)).not.toContain("hidden");
});
test("emits download:retrying stage and byte progress without a total when total is null", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const onEvent = vi.fn();
  const run = vi.fn<typeof import("./process.js").runProcess>(
    async (_file, _args, options) => {
      options?.onOutput?.(
        '{"kind":"stage","stage":"download","state":"retrying"}\n' +
          '{"kind":"progress","stage":"download","completed":2097152,"total":null,"unit":"bytes"}\n',
      );
      return { code: 0, stdout: "{}", stderr: "" };
    },
  );
  await runLocalmodels(
    f.home,
    ["harness", "apply", "plan", "--jsonl"],
    { onEvent },
    { run },
  );
  expect(onEvent).toHaveBeenCalledWith({
    kind: "stage",
    stage: "runtime",
    state: "running",
    message: "Retrying the Harness download…",
  });
  expect(onEvent).toHaveBeenCalledWith({
    kind: "stage",
    stage: "runtime",
    state: "running",
    message: "Downloading the selected Harness (2.0 MB)…",
    progress: { completed: 2097152, unit: "bytes" },
  });
});

test("forwards safe extraction and verification stages after Harness downloads finish", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const onEvent = vi.fn();
  const run = vi.fn<typeof import("./process.js").runProcess>(
    async (_file, _args, options) => {
      for (const stage of [
        "extract",
        "verify",
        "install",
        "private-secret-stage",
      ])
        options?.onOutput?.(
          JSON.stringify({
            kind: "stage",
            stage,
            state: stage === "install" ? "succeeded" : "running",
            message: "private-secret-message",
          }) + "\n",
        );
      return { code: 0, stdout: "{}", stderr: "" };
    },
  );
  await runLocalmodels(
    f.home,
    ["harness", "apply", "plan", "--jsonl"],
    { onEvent },
    { run },
  );
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Extracting Harness files and applying private permissions…",
    }),
  );
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Verifying the installed Harness executable…",
    }),
  );
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Harness files installed; checking runtime status…",
    }),
  );
  // The three stages, then how long the tool check and the run took.
  expect(onEvent).toHaveBeenCalledTimes(4);
  expect(onEvent).toHaveBeenLastCalledWith({
    kind: "log",
    message: expect.stringMatching(
      /^localmodels harness apply: tool checked in [\d.]+s, ran in [\d.]+s\.\n$/,
    ),
  });
  expect(JSON.stringify(onEvent.mock.calls)).not.toContain("private-secret");
});
test("uses a configured development localmodels checkout without downloading a kit", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", "");
  vi.stubEnv(
    "LINGER_LOCALMODELS_DEV_PYTHON",
    path.join(f.directory, "python/python"),
  );
  vi.stubEnv(
    "LINGER_LOCALMODELS_DEV_MODULE_DIR",
    path.join(f.directory, "modules"),
  );
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(f.home, ["debug", "status", "--json"], {}, { run });
  expect(run).toHaveBeenCalledWith(
    path.join(f.directory, "python/python"),
    ["-P", "-s", "-m", "localmodels", "debug", "status", "--json"],
    expect.objectContaining({
      cwd: path.join(f.directory, "modules"),
    }),
  );
});
test.skipIf(process.platform === "win32")(
  "rejects a symlinked ancestor directory inside a kit during verification",
  async () => {
    const f = await fixture();
    const external = path.join(f.home, "external-modules");
    await mkdir(path.join(external, "localmodels"), { recursive: true });
    await writeFile(path.join(external, "localmodels/__init__.py"), "package");
    await rm(path.join(f.directory, "modules"), {
      recursive: true,
      force: true,
    });
    await symlink(external, path.join(f.directory, "modules"));
    await expect(
      ensureLocalmodelsTool(
        f.home,
        {},
        {
          source: f.source,
          fetcher: async () => new Response("not the kit", { status: 200 }),
        },
      ),
    ).rejects.toThrow(/checksum|size|SHA|link/i);
  },
);

test("maps source apply download stages to model gateway messages", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const onEvent = vi.fn();
  const lines = [
    {
      kind: "stage",
      stage: "download",
      state: "connecting",
      host: "registry.npmmirror.com",
      attempt: 1,
      attempts: 3,
    },
    {
      kind: "stage",
      stage: "download",
      state: "connecting",
      host: "evil.example/path?x=<b>",
    },
    {
      kind: "stage",
      stage: "download",
      state: "switching",
      from: "registry.npmmirror.com",
      to: "registry.npmjs.org",
      reason: "slow",
      completed: 10,
    },
    { kind: "stage", stage: "download", state: "switching", to: 42 },
    {
      kind: "stage",
      stage: "download",
      state: "retrying",
      attempt: 2,
      attempts: 3,
      reason: "private-secret-reason",
      completed: 5,
      waitSeconds: 2,
    },
    { kind: "stage", stage: "download", state: "teleporting" },
    {
      kind: "stage",
      stage: "download",
      state: "connecting",
      host: "a".repeat(254),
    },
    {
      kind: "progress",
      stage: "download",
      completed: 4,
      total: 10,
      unit: "bytes",
    },
  ];
  const run = vi.fn<typeof import("./process.js").runProcess>(
    async (_file, _args, options) => {
      options?.onOutput?.(
        lines.map((line) => JSON.stringify(line)).join("\n") +
          '\nnot json\n{"kind":"stage","stage":null}\n',
      );
      return { code: 0, stdout: "{}", stderr: "" };
    },
  );
  await runLocalmodels(
    f.home,
    ["source", "apply", "--mode", "byok", "--json"],
    { onEvent },
    { run },
  );
  const messages = onEvent.mock.calls
    .map(([event]) => event as { kind: string; message: string })
    .filter((event) => event.kind === "stage")
    .map((event) => event.message);
  expect(messages).toEqual([
    "Downloading the model gateway: connecting to registry.npmmirror.com…",
    "Downloading the model gateway: connecting…",
    "Downloading the model gateway: switching to registry.npmjs.org…",
    "Downloading the model gateway: switching…",
    "Downloading the model gateway: retrying…",
    "Downloading the model gateway: connecting…",
    "Downloading the model gateway…",
  ]);
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      progress: { completed: 4, total: 10, unit: "bytes" },
    }),
  );
  expect(JSON.stringify(onEvent.mock.calls)).not.toContain("private-secret");
});

test("labels gateway download stages as the application model gateway", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const onEvent = vi.fn();
  const run = vi.fn<typeof import("./process.js").runProcess>(
    async (_file, _args, options) => {
      options?.onOutput?.(
        '{"kind":"stage","stage":"download","state":"connecting","host":"github.com"}\n',
      );
      return { code: 0, stdout: "{}", stderr: "" };
    },
  );
  await runLocalmodels(f.home, ["gateway", "install"], { onEvent }, { run });
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message:
        "Downloading the application model gateway: connecting to github.com…",
    }),
  );
});

test("reads source apply events from stderr while stdout stays the final document", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const onEvent = vi.fn();
  const { runProcess } = await import("./process.js");
  const run = vi.fn<typeof runProcess>((_file, _args, options) =>
    runProcess(
      process.execPath,
      [
        "-e",
        `process.stderr.write(JSON.stringify({kind:"stage",stage:"download",state:"connecting",host:"registry.npmmirror.com"})+"\\n");
process.stdout.write(JSON.stringify({code:"BYOK_PROBE_FAILED",message:"Endpoint refused."}));`,
      ],
      { ...options, cwd: undefined, env: process.env },
    ),
  );
  const result = await runLocalmodels(
    f.home,
    ["source", "apply", "--json"],
    { onEvent },
    { run },
  );
  expect(JSON.parse(result.stdout)).toEqual({
    code: "BYOK_PROBE_FAILED",
    message: "Endpoint refused.",
  });
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message:
        "Downloading the model gateway: connecting to registry.npmmirror.com…",
    }),
  );
});
