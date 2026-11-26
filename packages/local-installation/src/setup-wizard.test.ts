// The pieces the two-step desktop setup relies on: the planned model's
// library id, subscription runtimes linked beside the chosen one, and the
// owner's password changed on the ready screen.
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readLocalLogin, writeLocalLoginPassword } from "./account.js";
import type { Instance } from "./instance.js";
import {
  inspectLinkedRuntimeDescriptors,
  inspectSelectedRuntimeDescriptors,
  runtimeEnvironmentFromDescriptors,
} from "./managed-runtimes.js";
import { inspectSetup, LIBRARY_MODEL_ID } from "./setup-plan.js";
import {
  readLinkedRuntimes,
  writeLinkedRuntimes,
  writeSetupChoice,
} from "./setup-selection.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function scratch(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const report = (model: Record<string, unknown>) => ({
  schema: "localmodels.setup-report/v1",
  facts: {
    platform: "darwin",
    arch: "arm64",
    ram: { total_bytes: 7 },
    disk: { free_bytes: 9 },
    gpus: [],
  },
  stack: {
    available: true,
    reasons: [],
    plan: {
      llm: { model, placement: { gpus: [] } },
      budget: { download_bytes: 1, disk_needed_bytes: 2, ram_needed_bytes: 3 },
    },
  },
  harness: { schema: "localmodels.harness-status/v1", runtimes: [] },
  recommendation: "local-models",
});
const inspectWith = (model: Record<string, unknown>) =>
  inspectSetup({
    probeRuntimes: async () => null,
    localmodels: vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify(report(model)),
      stderr: "",
    })),
  });

it("names the planned model as a library id only when the plan carries its quantization", async () => {
  expect(
    (await inspectWith({ id: "qwen3.5-35b-a3b", quant: "Q4_K_M" })).localModels
      .libraryModel,
  ).toBe("qwen3.5-35b-a3b:Q4_K_M");
  for (const model of [
    { id: "qwen3.5-35b-a3b" },
    { id: "qwen3.5-35b-a3b", quant: 4 },
    { id: "../escape", quant: "Q4" },
    { id: "model", quant: "Q4 --base-dir /tmp" },
  ])
    expect((await inspectWith(model)).localModels).not.toHaveProperty(
      "libraryModel",
    );
  expect(LIBRARY_MODEL_ID.test("--base-dir:x")).toBe(false);
});

it("keeps linked subscription runtimes private, validated and replaceable", async () => {
  const root = await scratch("linked-runtimes-");
  const instance = { root } as Instance;
  expect(await readLinkedRuntimes(instance)).toEqual([]);
  await writeLinkedRuntimes(instance, ["claude"]);
  expect(await readLinkedRuntimes(instance)).toEqual(["claude"]);
  if (process.platform !== "win32")
    expect(
      (await stat(path.join(root, "linked-runtimes.json"))).mode & 0o777,
    ).toBe(0o600);
  await writeLinkedRuntimes(instance, []);
  expect(await readLinkedRuntimes(instance)).toEqual([]);
  for (const bad of [["pi"], ["codex", "codex"], "codex", ["a", "b", "c"]])
    await expect(writeLinkedRuntimes(instance, bad as never)).rejects.toThrow(
      "Invalid linked runtimes",
    );
  await writeFile(path.join(root, "linked-runtimes.json"), '["pi"]', {
    mode: 0o600,
  });
  await expect(readLinkedRuntimes(instance)).rejects.toThrow();
});

const harness = (runtime: string, installed = true) => ({
  schema: "localmodels.harness-status/v1",
  runtimes: [
    {
      runtime,
      executable: installed ? `/managed/${runtime}` : null,
      argvPrefix: [],
      installed,
      authenticated: installed,
      authMode: installed ? "oauth" : null,
      environment:
        runtime === "codex"
          ? { CODEX_HOME: "/profiles/codex" }
          : { CLAUDE_CONFIG_DIR: "/profiles/claude" },
    },
  ],
});
function localmodelsFor(installed: Record<string, boolean>) {
  return vi.fn(async (_home: string, args: string[]) => {
    const runtime = args[args.indexOf("--runtime") + 1]!;
    return {
      code: 0,
      stdout: JSON.stringify(harness(runtime, installed[runtime] ?? true)),
      stderr: "",
    };
  });
}

it("binds linked runtimes beside the chosen one, chosen runtime first", async () => {
  const home = await scratch("linked-descriptors-");
  const root = path.join(home, "instances", "default");
  const instance = { root } as Instance;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeSetupChoice(instance, "codex");
  await writeLinkedRuntimes(instance, ["claude"]);
  const localmodels = localmodelsFor({});
  const rows = await inspectSelectedRuntimeDescriptors(home, root, {
    localmodels,
  });
  expect(rows.map((row) => row.runtime)).toEqual(["codex", "claude"]);
  expect(runtimeEnvironmentFromDescriptors(rows)).toMatchObject({
    CODEX_HOME: "/profiles/codex",
    CLAUDE_CONFIG_DIR: "/profiles/claude",
    LINGER_CODEX_PATH: "/managed/codex",
    LINGER_CLAUDE_PATH: "/managed/claude",
  });

  // A linked runtime that is no longer installed is left out.
  expect(
    await inspectLinkedRuntimeDescriptors(home, root, {
      localmodels: localmodelsFor({ claude: false }),
    }),
  ).toEqual([]);

  // Links only apply to a subscription choice.
  await writeSetupChoice(instance, "pi");
  expect(
    await inspectLinkedRuntimeDescriptors(home, root, { localmodels }),
  ).toEqual([]);
});

it("replaces the owner password privately and keeps the email", async () => {
  const root = path.join(await scratch("owner-password-"), "desktop");
  await mkdir(root, { recursive: true });
  const file = path.join(root, "local-account.json");
  const account = {
    email: "owner@linger.local",
    password: "generated pass 1",
    provisioned: true,
  };
  await writeFile(file, JSON.stringify(account), { mode: 0o600 });

  await writeLocalLoginPassword({ root }, "my new pass 2");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    ...account,
    password: "my new pass 2",
  });
  expect(await readLocalLogin({ root })).toMatchObject({
    email: "owner@linger.local",
    password: "my new pass 2",
  });
  if (process.platform !== "win32")
    expect((await stat(file)).mode & 0o777).toBe(0o600);

  // The server's rules, checked before anything is written.
  for (const password of ["short", "has\nnewline", "x".repeat(257)])
    await expect(writeLocalLoginPassword({ root }, password)).rejects.toThrow(
      "8–256",
    );
  expect(JSON.parse(await readFile(file, "utf8")).password).toBe(
    "my new pass 2",
  );
});

it.skipIf(process.platform === "win32")(
  "refuses to replace an account file that is not private or not a file",
  async () => {
    const home = await scratch("owner-password-");
    const open = path.join(home, "open");
    await mkdir(open);
    const account = JSON.stringify({
      email: "owner@linger.local",
      password: "generated pass 1",
      provisioned: true,
    });
    await writeFile(path.join(open, "local-account.json"), account, {
      mode: 0o644,
    });
    await expect(
      writeLocalLoginPassword({ root: open }, "my new pass 2"),
    ).rejects.toThrow(/private/);
    expect(
      JSON.parse(await readFile(path.join(open, "local-account.json"), "utf8"))
        .password,
    ).toBe("generated pass 1");

    const linked = path.join(home, "linked");
    await mkdir(linked);
    const target = path.join(home, "target.json");
    await writeFile(target, account, { mode: 0o600 });
    await symlink(target, path.join(linked, "local-account.json"));
    await expect(
      writeLocalLoginPassword({ root: linked }, "my new pass 2"),
    ).rejects.toThrow(/private/);
    expect(JSON.parse(await readFile(target, "utf8")).password).toBe(
      "generated pass 1",
    );

    // Nothing to replace before the installer created the owner.
    await expect(
      writeLocalLoginPassword(
        { root: path.join(home, "none") },
        "my new pass 2",
      ),
    ).rejects.toThrow();
  },
);
