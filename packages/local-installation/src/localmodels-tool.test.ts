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
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { INSTANCE_BUSY, withInstanceLock, type Instance } from "./instance.js";
import { REGION_SCHEMA, regionFile } from "./region.js";
import { requestUrlText } from "@linger/service-kit";
import { afterEach, expect, test, vi } from "vitest";
import {
  ensureLocalmodelsTool,
  localmodelsBifrostAddrFile,
  localmodelsBifrostDirectory,
  localmodelsLegacyToolsMarkerFile,
  localmodelsStateDirectory,
  localmodelsToolsDirectory,
  resolveLocalmodelsBifrostAddr,
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
  "installing a newer pinned kit preserves the previous release's kit for existing stack deployments",
  async () => {
    const older = await fixture();
    const olderPython = path.join(older.directory, "python/python");
    const newer = await fixture();
    const newerBytes = await packed(newer);
    const newerSource = {
      ...newer.source,
      sha256: hash(newerBytes),
      bytes: newerBytes.length,
    };
    const installed = await ensureLocalmodelsTool(
      older.home,
      {},
      { source: newerSource, fetcher: async () => new Response(newerBytes) },
    );
    expect(installed.python).toBe(
      path.join(
        older.home,
        "tools/localmodels",
        newerSource.sha256,
        "python/python",
      ),
    );
    // Existing deployments created by the earlier release (for example
    // slot_cache.py on macOS/Linux) reference the previous kit's Python binary
    // in argv[0]; `stack up` requires it to remain on disk across upgrades.
    expect((await stat(olderPython)).isFile()).toBe(true);
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
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      }),
    }),
  );
  expect(await readFile(path.join(f.directory, "tool.json"), "utf8")).toContain(
    "sourceCommit",
  );
});
test("forces Python UTF-8 mode and strips conflicting case variants from the environment", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  vi.stubEnv("PYTHONUTF8", "0");
  vi.stubEnv("pythonutf8", "0");
  vi.stubEnv("PYTHONIOENCODING", "gbk");
  vi.stubEnv("PythonIOEncoding", "cp936");
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["foundations", "stop", "--json"],
    {
      env: {
        PYTHONUTF8: "0",
        PythonUtf8: "0",
        PYTHONIOENCODING: "cp932",
        pythonioencoding: "cp949",
      },
    },
    { run },
  );
  expect(run).toHaveBeenCalledTimes(1);
  const env = (
    run.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ]
  )[2].env;
  expect(env.PYTHONUTF8).toBe("1");
  expect(env.PYTHONIOENCODING).toBe("utf-8");
  expect(
    Object.keys(env).filter((key) => key.toUpperCase() === "PYTHONUTF8"),
  ).toEqual(["PYTHONUTF8"]);
  expect(
    Object.keys(env).filter((key) => key.toUpperCase() === "PYTHONIOENCODING"),
  ).toEqual(["PYTHONIOENCODING"]);
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
const libraryStatus = (
  models: {
    id: string;
    state: string;
    error?: { code?: string; detail?: string };
  }[],
) => ({
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
// A library whose reads follow `reads` in turn, repeating the last.
function libraryReads(
  reads: { id: string; state: string }[][],
  failCancel?: string,
) {
  let index = 0;
  return vi.fn<typeof runLocalmodels>(async (_home, args) => {
    if (args[1] === "status")
      return libraryStatus(reads[Math.min(index++, reads.length - 1)] ?? []);
    if (args[1] === "cancel" && args[2] === failCancel)
      return {
        code: 1,
        stdout: JSON.stringify({ ok: false, code: "JOB_NOT_FOUND" }),
        stderr: "",
      };
    return { code: 0, stdout: "{}", stderr: "" };
  });
}
const quickCancel = { cancelPollMs: 1, cancelWaitMs: 200 };
test("cancels a running load, waits until it is no longer loading, then unloads what the last read shows loaded", async () => {
  const run = libraryReads([
    [
      { id: "qwen3-8b:Q4_K_M", state: "loading" },
      { id: "gemma4-4b:Q4_K_M", state: "loaded" },
    ],
    [
      { id: "qwen3-8b:Q4_K_M", state: "loading" },
      { id: "gemma4-4b:Q4_K_M", state: "loaded" },
    ],
    [
      { id: "qwen3-8b:Q4_K_M", state: "idle" },
      { id: "gemma4-4b:Q4_K_M", state: "loaded" },
    ],
  ]);
  await stopLocalmodels(
    "/home",
    { signal: AbortSignal.timeout(5000), keepController: true },
    { run, installed: async () => true, ...quickCancel },
  );
  expect(run.mock.calls.map(([, args]) => args.slice(0, 3))).toEqual([
    ["library", "status", "--base-dir"],
    ["library", "cancel", "qwen3-8b:Q4_K_M"],
    ["library", "status", "--base-dir"],
    ["library", "status", "--base-dir"],
    ["library", "unload", "gemma4-4b:Q4_K_M"],
    ["stack", "down", "--json"],
  ]);
});
test("unloads a load that finished before its cancel, without reporting the cancel", async () => {
  const run = libraryReads(
    [
      [{ id: "qwen3-8b:Q4_K_M", state: "loading" }],
      [{ id: "qwen3-8b:Q4_K_M", state: "loaded" }],
    ],
    "qwen3-8b:Q4_K_M",
  );
  await stopLocalmodels(
    "/home",
    { signal: AbortSignal.timeout(5000), keepController: true },
    { run, installed: async () => true, ...quickCancel },
  );
  expect(run.mock.calls.map(([, args]) => args.slice(0, 3))).toEqual([
    ["library", "status", "--base-dir"],
    ["library", "cancel", "qwen3-8b:Q4_K_M"],
    ["library", "status", "--base-dir"],
    ["library", "unload", "qwen3-8b:Q4_K_M"],
    ["stack", "down", "--json"],
  ]);
});
test("reports a model still loading after the wait, with its cancel failure, and still stops the stack", async () => {
  const run = libraryReads(
    [
      [
        { id: "qwen3-8b:Q4_K_M", state: "loading" },
        { id: "gemma4-4b:Q4_K_M", state: "loaded" },
      ],
    ],
    "qwen3-8b:Q4_K_M",
  );
  await expect(
    stopLocalmodels(
      "/home",
      { signal: AbortSignal.timeout(5000), keepController: true },
      { run, installed: async () => true, ...quickCancel },
    ),
  ).rejects.toThrow(
    "localmodels library cancel qwen3-8b:Q4_K_M: JOB_NOT_FOUND",
  );
  const verbs = run.mock.calls.map(([, args]) => args[1]);
  expect(verbs.filter((verb) => verb === "status").length).toBeGreaterThan(2);
  expect(verbs.slice(-2)).toEqual(["unload", "down"]);
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
test("unloads failed server models on quit while skipping stopped downloads", async () => {
  const run = vi.fn<typeof runLocalmodels>(async (_home, args) =>
    args[1] === "status"
      ? libraryStatus([
          { id: "qwen3-8b:Q4_K_M", state: "loaded" },
          {
            id: "inkling-2-mini-q4-poly:UD-Q4_K_XL",
            state: "failed",
            error: {
              code: "HEALTH_CHECK_FAILED",
              detail: "the model server does not answer; load it again",
            },
          },
          {
            id: "gemma4-4b:Q4_K_M",
            state: "failed",
            error: { code: "ENGINE_START_FAILED", detail: "exited" },
          },
          {
            id: "stopped-net:Q4_K_M",
            state: "failed",
            error: { code: "NETWORK_UNAVAILABLE", detail: "offline" },
          },
          {
            id: "stopped-dl:Q4_K_M",
            state: "failed",
            error: { code: "DOWNLOAD_FAILED", detail: "interrupted" },
          },
          {
            id: "stopped-disk:Q4_K_M",
            state: "failed",
            error: { code: "DISK_INSUFFICIENT", detail: "disk full" },
          },
          { id: "idle-model:Q4_K_M", state: "idle" },
        ])
      : { code: 0, stdout: "{}", stderr: "" },
  );
  await stopLocalmodels(
    "/home",
    { signal: AbortSignal.timeout(5000), keepController: true },
    { run, installed: async () => true },
  );
  expect(run.mock.calls.map(([, args]) => args.slice(0, 3))).toEqual([
    ["library", "status", "--base-dir"],
    ["library", "unload", "qwen3-8b:Q4_K_M"],
    ["library", "unload", "inkling-2-mini-q4-poly:UD-Q4_K_XL"],
    ["library", "unload", "gemma4-4b:Q4_K_M"],
    ["stack", "down", "--json"],
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
  let moved = false;
  await expect(
    stopLocalmodels(f.home, {
      signal: AbortSignal.timeout(10_000),
      keepController: true,
      log: (message) => {
        if (!moved && message.includes("library status")) {
          moved = true;
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
  // The three stages, then the phase breakdown and summary logs.
  expect(
    onEvent.mock.calls.filter(
      ([event]) => (event as { kind: string }).kind === "stage",
    ),
  ).toHaveLength(3);
  expect(onEvent).toHaveBeenCalledTimes(5);
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

async function listenLoopback(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("isolates tools dir, bifrost dir, and bifrost addr per home and overrides ambient env", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  vi.stubEnv("LOCALMODELS_TOOLS_DIR", "/ambient/tools");
  vi.stubEnv("LOCALMODELS_BIFROST_DIR", "/ambient/bifrost");
  vi.stubEnv("LOCALMODELS_BIFROST_ADDR", "127.0.0.1:19999");
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["source", "apply", "--mode", "byok", "--json"],
    {
      env: {
        localmodels_tools_dir: "/lower/tools",
        LOCALMODELS_BIFROST_DIR: "/override/bifrost",
        localmodels_bifrost_addr: "127.0.0.1:20000",
        localmodels_state: "/lower/state",
      },
    },
    {
      run,
      portFree: async () => true,
      freePort: async () => 18480,
    },
  );
  const passedEnv = (
    run.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ]
  )[2].env;
  expect(passedEnv.LOCALMODELS_STATE).toBe(localmodelsStateDirectory(f.home));
  expect(passedEnv.LOCALMODELS_TOOLS_DIR).toBe(
    localmodelsToolsDirectory(f.home),
  );
  expect(passedEnv.LOCALMODELS_BIFROST_DIR).toBe(
    localmodelsBifrostDirectory(f.home),
  );
  expect(passedEnv.LOCALMODELS_BIFROST_ADDR).toBe("127.0.0.1:18480");
  expect(passedEnv.localmodels_tools_dir).toBeUndefined();
  expect(passedEnv.localmodels_bifrost_addr).toBeUndefined();
  expect(passedEnv.localmodels_state).toBeUndefined();
  if (process.platform !== "win32") {
    expect((await stat(localmodelsToolsDirectory(f.home))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(localmodelsBifrostDirectory(f.home))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(localmodelsBifrostAddrFile(f.home))).mode & 0o777).toBe(
      0o600,
    );
  }
  expect(
    (await readFile(localmodelsBifrostAddrFile(f.home), "utf8")).trim(),
  ).toBe("127.0.0.1:18480");
});

test("allocates and persists a fallback loopback port when 18480 is held by another process", async () => {
  const f = await fixture();
  const occupied = await listenLoopback();
  try {
    // First allocate when 18480 is occupied: falls back to a free port and persists it.
    const allocated = await resolveLocalmodelsBifrostAddr(
      f.home,
      { allocate: true },
      {
        portFree: async (port) => port !== 18480,
        freePort: async (_reserved, opts) => {
          expect(opts?.preferred).toBe(18480);
          return 49152;
        },
      },
    );
    expect(allocated).toBe("127.0.0.1:49152");
    expect(
      (await readFile(localmodelsBifrostAddrFile(f.home), "utf8")).trim(),
    ).toBe("127.0.0.1:49152");

    // Subsequent calls reuse the persisted port while it remains free.
    const freeProbe = vi.fn(async () => 49999);
    const reused = await resolveLocalmodelsBifrostAddr(
      f.home,
      { allocate: true },
      { portFree: async () => true, freePort: freeProbe },
    );
    expect(reused).toBe("127.0.0.1:49152");
    expect(freeProbe).not.toHaveBeenCalled();

    // If the persisted port is later taken by a real foreign listener (and no owned.json exists),
    // real port probing detects the collision and persists a fresh free port.
    await writeFile(
      localmodelsBifrostAddrFile(f.home),
      `127.0.0.1:${occupied.port}\n`,
      { mode: 0o600 },
    );
    const moved = await resolveLocalmodelsBifrostAddr(f.home, {
      allocate: true,
    });
    expect(moved).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(moved).not.toBe(`127.0.0.1:${occupied.port}`);
    expect(
      (await readFile(localmodelsBifrostAddrFile(f.home), "utf8")).trim(),
    ).toBe(moved);
  } finally {
    await occupied.close();
  }
});

test("prefers this home's owned.json gateway.bifrost.addr even while its port is listening", async () => {
  const f = await fixture();
  const live = await listenLoopback();
  try {
    const toolsDir = localmodelsToolsDirectory(f.home);
    await mkdir(toolsDir, { recursive: true, mode: 0o700 });
    // localmodels writes owned.json with default umask (0644), not 0600.
    await writeFile(
      path.join(toolsDir, "owned.json"),
      JSON.stringify({
        schema: "localmodels.owned/v1",
        gateway: { bifrost: { addr: `127.0.0.1:${live.port}` } },
      }),
      { mode: 0o644 },
    );
    await writeFile(localmodelsBifrostAddrFile(f.home), "127.0.0.1:49321\n", {
      mode: 0o600,
    });
    const resolved = await resolveLocalmodelsBifrostAddr(f.home, {
      allocate: true,
    });
    expect(resolved).toBe(`127.0.0.1:${live.port}`);

    // Non-loopback or malformed owned.json entries are ignored.
    await writeFile(
      path.join(toolsDir, "owned.json"),
      JSON.stringify({
        schema: "localmodels.owned/v1",
        gateway: { bifrost: { addr: "0.0.0.0:18480" } },
      }),
      { mode: 0o644 },
    );
    const fallback = await resolveLocalmodelsBifrostAddr(f.home, {
      allocate: false,
    });
    expect(fallback).toBe("127.0.0.1:49321");
  } finally {
    await live.close();
  }
});

test("stopLocalmodels and read-only commands isolate paths without allocating or persisting a port", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  vi.stubEnv("LOCALMODELS_TOOLS_DIR", "/foreign/tools");
  vi.stubEnv("LOCALMODELS_BIFROST_DIR", "/foreign/bifrost");
  vi.stubEnv("LOCALMODELS_BIFROST_ADDR", "127.0.0.1:19876");
  const invokedEnvs: NodeJS.ProcessEnv[] = [];
  const runProc = vi.fn<typeof import("./process.js").runProcess>(
    async (_file, args, options) => {
      invokedEnvs.push(options?.env ?? {});
      if (args.includes("status"))
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: "localmodels.library-status/v1",
            models: [],
          }),
          stderr: "",
        };
      return { code: 0, stdout: "{}", stderr: "" };
    },
  );
  await stopLocalmodels(
    f.home,
    { signal: AbortSignal.timeout(5000) },
    { runProcess: runProc },
  );
  expect(invokedEnvs).toHaveLength(3);
  for (const env of invokedEnvs) {
    expect(env.LOCALMODELS_TOOLS_DIR).toBe(localmodelsToolsDirectory(f.home));
    expect(env.LOCALMODELS_BIFROST_DIR).toBe(
      localmodelsBifrostDirectory(f.home),
    );
    expect(env.LOCALMODELS_BIFROST_ADDR).toBe("127.0.0.1:18480");
  }
  await expect(stat(localmodelsBifrostAddrFile(f.home))).rejects.toMatchObject({
    code: "ENOENT",
  });

  // Read-only setup inspect also stays isolated without allocating or persisting a port.
  const inspectRun = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["setup", "inspect", "--json"],
    {},
    { run: inspectRun },
  );
  const inspectEnv = (
    inspectRun.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ]
  )[2].env;
  expect(inspectEnv.LOCALMODELS_TOOLS_DIR).toBe(
    localmodelsToolsDirectory(f.home),
  );
  expect(inspectEnv.LOCALMODELS_BIFROST_ADDR).toBe("127.0.0.1:18480");
  await expect(stat(localmodelsBifrostAddrFile(f.home))).rejects.toMatchObject({
    code: "ENOENT",
  });

  // When this home already persisted an address, stopLocalmodels passes it cleanly.
  await writeFile(localmodelsBifrostAddrFile(f.home), "127.0.0.1:49555\n", {
    mode: 0o600,
  });
  invokedEnvs.length = 0;
  await stopLocalmodels(
    f.home,
    { signal: AbortSignal.timeout(5000), keepController: true },
    { runProcess: runProc },
  );
  expect(invokedEnvs).toHaveLength(2);
  for (const env of invokedEnvs)
    expect(env.LOCALMODELS_BIFROST_ADDR).toBe("127.0.0.1:49555");
});

async function legacyLayout(
  home: string,
  deployment: string,
  deploymentOwner?: string,
  removed = false,
) {
  const userHome = await mkdtemp(path.join(os.tmpdir(), "linger-legacy-home-"));
  roots.push(userHome);
  vi.stubEnv("HOME", userHome);
  vi.stubEnv("USERPROFILE", userHome);
  const legacyTools = path.join(
    userHome,
    ".local",
    "share",
    "localmodels",
    "tools",
  );
  const legacyBifrost = path.join(
    userHome,
    ".local",
    "share",
    "localmodels",
    "bifrost",
  );
  await mkdir(path.join(legacyTools, "gateway-home", ".pi", "agent"), {
    recursive: true,
    mode: 0o700,
  });
  // The layout a 0.1.6 Quick Install leaves: ownership in the shared tools
  // directory, the approved plan in the home.
  await writeFile(
    path.join(legacyTools, "owned.json"),
    JSON.stringify({
      schema: "localmodels.owned/v1",
      deployments: {
        "qwen3.8-27b-18100": {
          deploy_dir: path.join(
            deploymentOwner ?? home,
            "runtime",
            "localmodels",
            "models",
            "deployments",
            "qwen3.8-27b-18100",
          ),
          removed,
        },
      },
      gateway: { bifrost: { addr: "127.0.0.1:18480", app_dir: legacyBifrost } },
    }),
    { mode: 0o644 },
  );
  await mkdir(path.join(home, "runtime", "localmodels"), { recursive: true });
  await writeFile(
    path.join(home, "runtime", "localmodels", "plan.json"),
    JSON.stringify({ llm: { name: deployment }, decision: null, aux: [] }),
    { mode: 0o644 },
  );
  return { legacyTools, legacyBifrost };
}
function passedEnvironment(run: ReturnType<typeof vi.fn>, call = 0) {
  return (
    run.mock.calls[call] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ]
  )[2].env;
}

test("keeps a home whose plan was applied in the shared tools directory on that directory", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const { legacyTools, legacyBifrost } = await legacyLayout(
    f.home,
    "qwen3.8-27b-18100",
  );
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  const freePortProbe = vi.fn(async () => 49152);
  await runLocalmodels(
    f.home,
    ["stack", "up", "--json"],
    {},
    {
      run,
      portFree: async () => true,
      freePort: freePortProbe,
    },
  );
  const env = passedEnvironment(run);
  expect(env.LOCALMODELS_TOOLS_DIR).toBe(legacyTools);
  expect(env.LOCALMODELS_BIFROST_DIR).toBe(legacyBifrost);
  expect(env.LOCALMODELS_BIFROST_ADDR).toBe("127.0.0.1:18480");
  expect(freePortProbe).not.toHaveBeenCalled();
  await expect(stat(localmodelsToolsDirectory(f.home))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (await readFile(localmodelsLegacyToolsMarkerFile(f.home), "utf8")).trim(),
  ).toBe(legacyTools);

  // The recorded choice holds after the plan is replaced.
  await rm(path.join(f.home, "runtime", "localmodels", "plan.json"));
  await runLocalmodels(f.home, ["setup", "binding", "--json"], {}, { run });
  expect(passedEnvironment(run, 1).LOCALMODELS_TOOLS_DIR).toBe(legacyTools);
});

test("isolates a home whose plan the shared tools directory does not own", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  await legacyLayout(f.home, "inkling-2-mini-q4-poly-18100");
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["stack", "apply", "--json"],
    {},
    {
      run,
      portFree: async () => true,
      freePort: async () => 18480,
    },
  );
  expect(passedEnvironment(run).LOCALMODELS_TOOLS_DIR).toBe(
    localmodelsToolsDirectory(f.home),
  );
  await expect(
    stat(localmodelsLegacyToolsMarkerFile(f.home)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("keeps a home that owns its per-home tools directory isolated", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  await legacyLayout(f.home, "qwen3.8-27b-18100");
  const toolsDir = localmodelsToolsDirectory(f.home);
  await mkdir(toolsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(toolsDir, "owned.json"),
    JSON.stringify({ schema: "localmodels.owned/v1", deployments: {} }),
    { mode: 0o644 },
  );
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["stack", "up", "--json"],
    {},
    {
      run,
      portFree: async () => true,
      freePort: async () => 18480,
    },
  );
  expect(passedEnvironment(run).LOCALMODELS_TOOLS_DIR).toBe(toolsDir);
  await expect(
    stat(localmodelsLegacyToolsMarkerFile(f.home)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("isolates a new home whose plan reuses a deployment name another home owns", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const otherHome = await mkdtemp(path.join(os.tmpdir(), "linger-other-home-"));
  roots.push(otherHome);
  await legacyLayout(f.home, "qwen3.8-27b-18100", otherHome);
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["stack", "apply", "--json"],
    {},
    {
      run,
      portFree: async () => true,
      freePort: async () => 18480,
    },
  );
  expect(passedEnvironment(run).LOCALMODELS_TOOLS_DIR).toBe(
    localmodelsToolsDirectory(f.home),
  );
  await expect(
    stat(localmodelsLegacyToolsMarkerFile(f.home)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("isolates a home whose shared deployment localmodels marked removed", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  await legacyLayout(f.home, "qwen3.8-27b-18100", undefined, true);
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["stack", "apply", "--json"],
    {},
    {
      run,
      portFree: async () => true,
      freePort: async () => 18480,
    },
  );
  expect(passedEnvironment(run).LOCALMODELS_TOOLS_DIR).toBe(
    localmodelsToolsDirectory(f.home),
  );
  await expect(
    stat(localmodelsLegacyToolsMarkerFile(f.home)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(process.platform === "win32")(
  "logs region resolution, mirror switch, fallback, and kit preparation timings when downloading the kit",
  async () => {
    const f = await fixture();
    const bytes = await packed(f);
    const npm = "https://registry.npmjs.org/@simplexai/kit/-/kit-1.tgz";
    const mirror =
      "https://cdn.npmmirror.com/packages/@simplexai/kit/1/kit-1.tgz";
    const source = {
      ...f.source,
      url: npm,
      mirrors: [mirror],
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
    const logs: { stage?: string; message: string }[] = [];
    await ensureLocalmodelsTool(
      f.home,
      {
        onEvent: (event) => {
          if (event.kind === "log")
            logs.push({ stage: event.stage, message: event.message });
        },
      },
      {
        source,
        fetcher: async (url) => {
          if (requestUrlText(url).includes("npmmirror"))
            return new Response("missing", { status: 404 });
          return new Response(bytes);
        },
      },
    );
    expect(logs.every((entry) => entry.stage === "preflight")).toBe(true);
    const joined = logs.map((entry) => entry.message).join("");
    expect(joined).toMatch(/Download region: cn \(cache, \d+ms\)\./);
    expect(joined).toContain(
      "Download failed on cdn.npmmirror.com (HTTP 404); switching to registry.npmjs.org.",
    );
    expect(joined).toContain(
      "Download region fallback: cn -> global (registry.npmjs.org).",
    );
    expect(joined).toMatch(
      /localmodels kit prepared \(s\): download [\d.]+, unpack [\d.]+, verify [\d.]+\./,
    );
  },
);

test("logs phase breakdowns for harness apply and source apply alongside the command timing line", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const harnessEvents: { kind: string; stage?: string; message: string }[] =
      [];
    await runLocalmodels(
      f.home,
      ["harness", "apply", "plan", "--jsonl"],
      { onEvent: (event) => harnessEvents.push(event) },
      {
        run: async (_file, _args, options) => {
          options?.onOutput?.(
            '{"kind":"stage","stage":"download","state":"connecting","host":"registry.npmjs.org"}\n',
          );
          vi.advanceTimersByTime(1_200);
          options?.onOutput?.(
            '{"kind":"stage","stage":"download","state":"switching","to":"cdn.npmmirror.com"}\n',
          );
          vi.advanceTimersByTime(300);
          options?.onOutput?.(
            '{"kind":"stage","stage":"download","state":"retrying"}\n',
          );
          vi.advanceTimersByTime(500);
          options?.onOutput?.(
            '{"kind":"stage","stage":"extract","state":"running"}\n',
          );
          vi.advanceTimersByTime(400);
          options?.onOutput?.(
            '{"kind":"stage","stage":"verify","state":"running"}\n',
          );
          vi.advanceTimersByTime(200);
          options?.onOutput?.(
            '{"kind":"stage","stage":"install","state":"running"}\n',
          );
          vi.advanceTimersByTime(600);
          options?.onOutput?.(
            '{"kind":"stage","stage":"install","state":"succeeded"}\n',
          );
          return { code: 0, stdout: "{}", stderr: "" };
        },
      },
    );
    const harnessLogs = harnessEvents
      .filter((event) => event.kind === "log")
      .map((event) => event.message);
    expect(harnessLogs).toEqual([
      "localmodels harness apply phases: download 2.0s, retries 1, switches 1, extract 0.4s, verify 0.2s, install 0.6s.\n",
      expect.stringMatching(
        /^localmodels harness apply: tool checked in [\d.]+s, ran in [\d.]+s\.\n$/,
      ),
    ]);

    const sourceEvents: { kind: string; stage?: string; message: string }[] =
      [];
    await runLocalmodels(
      f.home,
      ["source", "apply", "--mode", "byok", "--json"],
      { onEvent: (event) => sourceEvents.push(event) },
      {
        run: async (_file, _args, options) => {
          options?.onOutput?.(
            '{"kind":"stage","stage":"download","state":"connecting","host":"registry.npmjs.org"}\n',
          );
          vi.advanceTimersByTime(1_500);
          options?.onOutput?.(
            '{"kind":"progress","stage":"download","completed":100,"total":100,"unit":"bytes"}\n',
          );
          // Gateway start + health wait after the last download event.
          vi.advanceTimersByTime(2_500);
          return { code: 0, stdout: "{}", stderr: "" };
        },
      },
    );
    const sourceLogs = sourceEvents
      .filter((event) => event.kind === "log")
      .map((event) => event.message);
    expect(sourceLogs).toEqual([
      "localmodels source apply phases: download 1.5s, post-download 2.5s.\n",
      expect.stringMatching(
        /^localmodels source apply: tool checked in [\d.]+s, ran in [\d.]+s\.\n$/,
      ),
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("logs per-step durations when stopping localmodels", async () => {
  const logs: string[] = [];
  const run = vi.fn<typeof runLocalmodels>(async (_home, args) =>
    args[1] === "status"
      ? libraryStatus([{ id: "qwen3-8b:Q4_K_M", state: "loaded" }])
      : { code: 0, stdout: "{}", stderr: "" },
  );
  await stopLocalmodels(
    "/home",
    {
      signal: AbortSignal.timeout(5000),
      log: (message) => logs.push(message),
    },
    { run, installed: async () => true },
  );
  expect(logs).toEqual([
    "Stopping the local models (localmodels library status).",
    expect.stringMatching(/^Stopped localmodels library status in [\d.]+s\.$/),
    "Stopping the local models (localmodels library unload qwen3-8b:Q4_K_M).",
    expect.stringMatching(
      /^Stopped localmodels library unload qwen3-8b:Q4_K_M in [\d.]+s\.$/,
    ),
    "Stopping the local models (localmodels foundations stop).",
    expect.stringMatching(
      /^Stopped localmodels foundations stop in [\d.]+s\.$/,
    ),
    "Stopping the local models (localmodels stack down).",
    expect.stringMatching(/^Stopped localmodels stack down in [\d.]+s\.$/),
  ]);
});

test("waits for an in-progress cross-process kit download and reuses the published kit without re-fetching", async () => {
  const f = await fixture();
  const staged = path.join(f.home, "staged-kit");
  await rename(f.directory, staged);
  const lock = path.join(f.home, "tools", "localmodels", "lock");
  await mkdir(lock, { recursive: true, mode: 0o700 });
  let releaseLock!: () => void;
  let lockHeld!: () => void;
  const holding = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  const holder = withInstanceLock({ root: lock } as Instance, async () => {
    lockHeld();
    await new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
  });
  await holding;
  const events: { kind: string; stage?: string; message: string }[] = [];
  const fetcher = vi.fn<typeof fetch>();
  try {
    const waiting = ensureLocalmodelsTool(
      f.home,
      { onEvent: (event) => events.push(event) },
      { source: f.source, fetcher, lockPollMs: 10, lockWaitMs: 5_000 },
    );
    await vi.waitFor(() =>
      expect(
        events.some((event) =>
          event.message.includes("download already in progress"),
        ),
      ).toBe(true),
    );
    await rename(staged, f.directory);
    releaseLock();
    await holder;
    const tool = await waiting;
    expect(tool.python).toBe(path.join(f.directory, "python/python"));
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      events.filter((event) =>
        event.message.includes("download already in progress"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) =>
        event.message.includes("Waiting for another process preparing"),
      ),
    ).toHaveLength(1);
  } finally {
    releaseLock?.();
    await holder.catch(() => {});
  }
});

test.skipIf(process.platform === "win32")(
  "takes over downloading the kit when the previous lock holder releases without publishing",
  async () => {
    const f = await fixture();
    const bytes = await packed(f);
    const source = { ...f.source, sha256: hash(bytes), bytes: bytes.length };
    const lock = path.join(f.home, "tools", "localmodels", "lock");
    await mkdir(lock, { recursive: true, mode: 0o700 });
    let releaseLock!: () => void;
    let lockHeld!: () => void;
    const holding = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const holder = withInstanceLock({ root: lock } as Instance, async () => {
      lockHeld();
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
    await holding;
    const events: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes));
    try {
      const waiting = ensureLocalmodelsTool(
        f.home,
        { onEvent: (event) => events.push(event.message) },
        { source, fetcher, lockPollMs: 10, lockWaitMs: 5_000 },
      );
      await vi.waitFor(() =>
        expect(
          events.some((message) =>
            message.includes("download already in progress"),
          ),
        ).toBe(true),
      );
      releaseLock();
      await holder;
      const tool = await waiting;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(tool.python).toBe(
        path.join(f.home, "tools/localmodels", source.sha256, "python/python"),
      );
    } finally {
      releaseLock?.();
      await holder.catch(() => {});
    }
  },
);

test("aborts immediately while waiting for another process preparing the kit", async () => {
  const f = await fixture();
  await rm(f.directory, { recursive: true, force: true });
  const lock = path.join(f.home, "tools", "localmodels", "lock");
  await mkdir(lock, { recursive: true, mode: 0o700 });
  let releaseLock!: () => void;
  let lockHeld!: () => void;
  const holding = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  const holder = withInstanceLock({ root: lock } as Instance, async () => {
    lockHeld();
    await new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
  });
  await holding;
  const controller = new AbortController();
  const events: string[] = [];
  const fetcher = vi.fn<typeof fetch>();
  try {
    const waiting = ensureLocalmodelsTool(
      f.home,
      {
        signal: controller.signal,
        onEvent: (event) => events.push(event.message),
      },
      { source: f.source, fetcher, lockPollMs: 500, lockWaitMs: 10_000 },
    );
    await vi.waitFor(() =>
      expect(
        events.some((message) =>
          message.includes("download already in progress"),
        ),
      ).toBe(true),
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    releaseLock?.();
    await holder.catch(() => {});
  }
});

test("rejects with INSTANCE_BUSY when the kit lock stays held past lockWaitMs", async () => {
  const f = await fixture();
  await rm(f.directory, { recursive: true, force: true });
  const lock = path.join(f.home, "tools", "localmodels", "lock");
  await mkdir(lock, { recursive: true, mode: 0o700 });
  let releaseLock!: () => void;
  let lockHeld!: () => void;
  const holding = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  const holder = withInstanceLock({ root: lock } as Instance, async () => {
    lockHeld();
    await new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
  });
  await holding;
  const fetcher = vi.fn<typeof fetch>();
  try {
    await expect(
      ensureLocalmodelsTool(
        f.home,
        {},
        { source: f.source, fetcher, lockPollMs: 10, lockWaitMs: 40 },
      ),
    ).rejects.toMatchObject({ code: INSTANCE_BUSY });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    releaseLock?.();
    await holder.catch(() => {});
  }
});

test("skips bundled Pi PATH injection for setup inspect while keeping it for harness commands", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const bundledBin = path.join(f.home, "app-bundled-pi", "bin");
  await mkdir(bundledBin, { recursive: true });
  const bundledExecutable = path.join(
    bundledBin,
    process.platform === "win32" ? "pi.exe" : "pi",
  );
  await writeFile(
    bundledExecutable,
    process.platform === "win32" ? "MZ" : "#!/bin/sh\n",
    { mode: 0o755 },
  );
  const resolveBundled = vi.fn(async () => ({
    binDir: bundledBin,
    executable: bundledExecutable,
    version: "1.5.2",
  }));
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  const basePath = path.join(f.home, "empty-path");

  await runLocalmodels(
    f.home,
    ["setup", "inspect", "--json"],
    { env: { PATH: basePath } },
    { run, resolveBundledPi: resolveBundled },
  );
  expect(resolveBundled).not.toHaveBeenCalled();
  const inspectEnv = (
    run.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ]
  )[2].env;
  const inspectPathKey = Object.keys(inspectEnv).find(
    (key) => key.toUpperCase() === "PATH",
  );
  const inspectEntries = inspectEnv[inspectPathKey!]!.split(path.delimiter);
  const stableBin = path.join(
    path.resolve(f.home),
    "runtime",
    "bundled-pi",
    "bin",
  );
  expect(inspectEntries).not.toContain(bundledBin);
  expect(inspectEntries).not.toContain(stableBin);

  for (const args of [
    ["harness", "status", "--json"],
    ["harness", "apply", "plan", "--jsonl"],
  ]) {
    run.mockClear();
    resolveBundled.mockClear();
    await runLocalmodels(
      f.home,
      args,
      { env: { PATH: basePath } },
      { run, resolveBundledPi: resolveBundled },
    );
    expect(resolveBundled).toHaveBeenCalledTimes(1);
    const passedEnv = (
      run.mock.calls[0] as unknown as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ]
    )[2].env;
    const pathKey = Object.keys(passedEnv).find(
      (key) => key.toUpperCase() === "PATH",
    );
    const entries = passedEnv[pathKey!]!.split(path.delimiter);
    expect(entries.at(-1)).toBe(
      process.platform === "win32" ? bundledBin : stableBin,
    );
  }
});
