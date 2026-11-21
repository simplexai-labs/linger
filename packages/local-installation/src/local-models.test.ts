import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  prepareLocalModels,
  localModelsEnvironment,
  restoreLocalModels,
  stackProgress,
  withLocalModelsLock,
} from "./local-models.js";
import { writeSetupChoice } from "./setup-selection.js";
import { runProcess } from "./process.js";
import { runLocalmodels } from "./localmodels-tool.js";
import { expectPrivate } from "./test-support/private.js";
import type { Instance } from "./instance.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "model-delegation-"));
  roots.push(home);
  const root = path.join(home, "instances/test");
  await mkdir(root, { recursive: true });
  const id = "a".repeat(64);
  const summary = {
    planId: id,
    gpuIndex: 2,
    gpuName: "upstream GPU",
    llm: "upstream-selected",
    contextWindow: 131072,
    downloadBytes: 100,
    diskBytes: 200,
    memoryBytes: 300,
    components: ["upstream-selected", "Pi"],
    warnings: ["upstream license warning"],
  };
  const binding = {
    schema: "localmodels.stack-binding/v1",
    ready: true,
    planId: id,
    pi: {
      executable: "/upstream/pi",
      environment: { PI_CODING_AGENT_DIR: "/upstream/profile" },
      configFingerprint: "b".repeat(64),
    },
    reasons: [],
  };
  const call = vi.fn<typeof runLocalmodels>(async (_home, args) => {
    if (args[0] === "stack" && args[1] === "plan") {
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({ schema: "localmodels.stack-plan/v1", plan_id: id }),
        { mode: 0o600 },
      );
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (args[0] === "setup" && args[1] === "review")
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: "localmodels.stack-review/v1",
          ...summary,
        }),
        stderr: "",
      };
    if (args[0] === "setup" && args[1] === "binding")
      return { code: 0, stdout: JSON.stringify(binding), stderr: "" };
    return { code: 0, stdout: "private token=never-public", stderr: "" };
  });
  return {
    home,
    instance: { root } as Instance,
    id,
    summary,
    binding,
    call,
    options: { signal: new AbortController().signal, onEvent: vi.fn() },
  };
}
test("delegates planning and review without pinning a model, decision or GPU", async () => {
  const f = await fixture();
  const result = await prepareLocalModels(f.instance, f.options, {
    localmodels: f.call,
  });
  expect(result).toMatchObject({
    code: 4,
    details: {
      code: "LOCAL_MODELS_APPROVAL_REQUIRED",
      localModelsPlan: f.summary,
    },
  });
  const plan = f.call.mock.calls.find((c) => c[1][1] === "plan")![1];
  expect(plan[plan.indexOf("--base-dir") + 1]).toBe(
    path.join(f.home, "runtime/localmodels/models"),
  );
  expect(plan).not.toContain("--llm");
  expect(
    plan.slice(plan.indexOf("--decision"), plan.indexOf("--decision") + 2),
  ).toEqual(["--decision", "none"]);
  expect(plan).not.toContain("--gpu");
  expect(f.call.mock.calls.some((c) => c[1][1] === "apply")).toBe(false);
  await expectPrivate(path.join(f.home, "runtime/localmodels/plan.json"));
});
test("asks review and binding for English messages", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  for (const step of ["review", "binding"]) {
    const args = f.call.mock.calls.find(
      ([, args]) => args[0] === "setup" && args[1] === step,
    )![1];
    expect(
      args.slice(args.indexOf("--lang"), args.indexOf("--lang") + 2),
    ).toEqual(["--lang", "en"]);
  }
});
test("a wrong confirmation never applies or replans a saved plan", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  f.call.mockClear();
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: "c".repeat(64) },
    { localmodels: f.call },
  );
  expect(
    f.call.mock.calls.some((c) => ["plan", "apply"].includes(c[1][1]!)),
  ).toBe(false);
});
test("applies exactly the approved saved plan and binds only the upstream verified descriptor", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  f.call.mockClear();
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    ),
  ).toBeUndefined();
  expect(f.call.mock.calls.find((c) => c[1][1] === "apply")![1]).toEqual([
    "stack",
    "apply",
    path.join(f.home, "runtime/localmodels/plan.json"),
    "--approve",
    f.id,
    "--jsonl",
  ]);
  expect(
    JSON.parse(
      await readFile(
        path.join(f.home, "runtime/localmodels/binding.json"),
        "utf8",
      ),
    ),
  ).toEqual(f.binding);
});
test("reports why the planner refused and logs its output", async () => {
  const f = await fixture();
  const events: string[] = [];
  f.call.mockImplementation(async () => ({
    code: 2,
    stdout: "",
    stderr: "stack: no verified LLM fits this computer\n",
  }));
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, onEvent: (event) => events.push(event.message ?? "") },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_UNAVAILABLE" },
    message: expect.stringContaining(
      "stack: no verified LLM fits this computer",
    ),
  });
  expect(events.join("\n")).toContain("localmodels stack plan exited with");
});
test("never records a successful binding when apply fails", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) =>
    a[1][1] === "apply"
      ? { code: 2, stdout: "private", stderr: "" }
      : original(...a),
  );
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    ),
  ).toMatchObject({ code: 4, state: "action_required" });
  await expect(
    stat(path.join(f.home, "runtime/localmodels/binding.json")),
  ).rejects.toThrow();
});
test("reports why a deployment stopped, from output that is not captured", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    if (a[1][1] !== "apply") return original(...a);
    a[2]!.onOutput!(
      '{"event":"progress","component":"llm","phase":"download","done":1,"total":2}\n',
    );
    a[2]!.onOutput!("stack: port 8080 is held by another program\n");
    return { code: 1, stdout: "", stderr: "" };
  });
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
    message:
      "Local model installation or verification did not finish: stack: port 8080 is held by another program Existing resources were preserved.",
  });
});
test("forwards actual split JSONL byte counters but never raw output", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    if (a[1][1] === "apply") {
      a[2]?.onOutput?.(
        'private token=hidden\n{"event":"progress","component":"llm","phase":"download","done":4,',
      );
      a[2]?.onOutput?.('"total":10}\n');
    }
    return original(...a);
  });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(f.options.onEvent.mock.calls.flat()).toContainEqual(
    expect.objectContaining({
      progress: { completed: 4, total: 10, unit: "bytes", partial: true },
    }),
  );
  expect(JSON.stringify(f.options.onEvent.mock.calls)).not.toContain("hidden");
});
test("replanning requires a separate review and never silently approves", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  f.call.mockClear();
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsReplan: true, localModelsApproval: f.id },
      { localmodels: f.call },
    ),
  ).toMatchObject({ code: 4 });
  expect(f.call).not.toHaveBeenCalled();
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsReplan: true },
      { localmodels: f.call },
    ),
  ).toMatchObject({ details: { code: "LOCAL_MODELS_APPROVAL_REQUIRED" } });
  expect(f.call.mock.calls.some((c) => c[1][1] === "apply")).toBe(false);
});
// A deployed stack whose binding is ready, then observed not ready once.
async function deployedThenNotReady(reason: string) {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  const ready = structuredClone(f.binding);
  f.binding.ready = false;
  f.binding.pi = null as never;
  f.binding.reasons = [{ code: reason, message: "upstream text" }] as never;
  f.call.mockClear();
  return { ...f, ready };
}
test.each(["deployment-unavailable", "gateway-unavailable"])(
  "a stopped deployed stack (%s) restarts with stack up without re-planning via stack apply",
  async (reason) => {
    const f = await deployedThenNotReady(reason);
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...a) => {
      // stack up starts the existing deployment and gateway in place, even
      // across a localmodels kit upgrade or retired catalog model where stack
      // apply would fail with STACK_PLAN_CHANGED or STACK_REPLAN_FAILED.
      if (a[1][0] === "stack" && a[1][1] === "up") {
        Object.assign(f.binding, f.ready);
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: "localmodels.stack-up/v1",
            plan_id: f.id,
            ok: true,
            parts: [],
            gateway: "started",
            notes: [],
          }),
          stderr: "",
        };
      }
      return original(...a);
    });
    expect(
      await prepareLocalModels(f.instance, f.options, { localmodels: f.call }),
    ).toBeUndefined();
    const stackCalls = f.call.mock.calls.filter(
      ([, args]) => args[0] === "stack",
    );
    expect(stackCalls.map(([, args]) => args)).toEqual([
      [
        "stack",
        "up",
        path.join(f.home, "runtime/localmodels/plan.json"),
        "--share-gpu",
        "--json",
      ],
    ]);
    // Model startup can take longer than the 120 s metadata command timeout.
    expect(stackCalls[0]![2]?.timeoutMs).toBeUndefined();
    expect(
      JSON.parse(
        await readFile(
          path.join(f.home, "runtime/localmodels/binding.json"),
          "utf8",
        ),
      ),
    ).toEqual(f.ready);
    expect(f.options.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "log",
        stage: "runtime",
        message: expect.stringContaining(reason),
      }),
    );
  },
);
test("stack up omits --share-gpu when the deployed plan was approved without GPU sharing", async () => {
  const f = await fixture();
  await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: false },
    { localmodels: f.call },
  );
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  const ready = structuredClone(f.binding);
  f.binding.ready = false;
  f.binding.pi = null as never;
  f.binding.reasons = [
    { code: "deployment-unavailable", message: "stopped" },
  ] as never;
  f.call.mockClear();
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    if (a[1][0] === "stack" && a[1][1] === "up") {
      Object.assign(f.binding, ready);
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    return original(...a);
  });
  expect(
    await prepareLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toBeUndefined();
  expect(
    f.call.mock.calls
      .map(([, args]) => args)
      .filter((args) => args[0] === "stack"),
  ).toEqual([
    [
      "stack",
      "up",
      path.join(f.home, "runtime/localmodels/plan.json"),
      "--json",
    ],
  ]);
});
test("a saved binding observed not ready (pi-extensions-unavailable) applies the approved plan again", async () => {
  const f = await deployedThenNotReady("pi-extensions-unavailable");
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    // stack apply brings the stack and its Pi back.
    if (a[1][1] === "apply") Object.assign(f.binding, f.ready);
    return original(...a);
  });
  expect(
    await prepareLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toBeUndefined();
  const stack = f.call.mock.calls
    .map(([, args]) => args)
    .filter((args) => args[0] === "stack");
  expect(stack).toEqual([
    [
      "stack",
      "apply",
      path.join(f.home, "runtime/localmodels/plan.json"),
      "--approve",
      f.id,
      "--jsonl",
    ],
  ]);
  expect(
    JSON.parse(
      await readFile(
        path.join(f.home, "runtime/localmodels/binding.json"),
        "utf8",
      ),
    ),
  ).toEqual(f.ready);
  expect(f.options.onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "log",
      stage: "runtime",
      message: expect.stringContaining("pi-extensions-unavailable"),
    }),
  );
});
test("falls back to stack apply when stack up starts services but binding still needs Pi repair", async () => {
  const f = await deployedThenNotReady("deployment-unavailable");
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    if (a[1][0] === "stack" && a[1][1] === "up") {
      f.binding.reasons = [
        { code: "pi-extensions-unavailable", message: "missing jiti" },
      ] as never;
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    if (a[1][0] === "stack" && a[1][1] === "apply")
      Object.assign(f.binding, f.ready);
    return original(...a);
  });
  expect(
    await prepareLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toBeUndefined();
  expect(
    f.call.mock.calls
      .filter(([, args]) => args[0] === "stack")
      .map(([, args]) => `${args[0]} ${args[1]}`),
  ).toEqual(["stack up", "stack apply"]);
});
test("falls back to stack apply when stack up fails due to drift and apply repairs it", async () => {
  const f = await deployedThenNotReady("deployment-unavailable");
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    if (a[1][0] === "stack" && a[1][1] === "up")
      return {
        code: 2,
        stdout: "",
        stderr:
          "stack: the deployments on this computer no longer match this plan\n",
      };
    if (a[1][0] === "stack" && a[1][1] === "apply")
      Object.assign(f.binding, f.ready);
    return original(...a);
  });
  expect(
    await prepareLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toBeUndefined();
  expect(
    f.call.mock.calls
      .filter(([, args]) => args[0] === "stack")
      .map(([, args]) => `${args[0]} ${args[1]}`),
  ).toEqual(["stack up", "stack apply"]);
  expect(f.options.onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "log",
      stage: "runtime",
      message: expect.stringContaining(
        "localmodels stack up exited with code 2",
      ),
    }),
  );
});
test.each([
  [
    "STACK_REPLAN_FAILED",
    {
      schema: "localmodels.stack-error/v1",
      event: "error",
      code: "STACK_APPLY_FAILED",
      category: "guard",
      causeCode: "STACK_REPLAN_FAILED",
    },
    "no longer fits this computer's current memory or model catalog",
  ],
  [
    "STACK_PLAN_CHANGED",
    {
      schema: "localmodels.stack-error/v1",
      event: "error",
      code: "STACK_APPLY_FAILED",
      category: "guard",
      causeCode: "STACK_PLAN_CHANGED",
      changedFields: ["llm"],
    },
    "changed since the plan was approved (llm)",
  ],
])(
  "surfaces structured %s causeCode without raw JSON when upgrade fallback stack apply is rejected",
  async (causeCode, payload, expectedText) => {
    const f = await deployedThenNotReady("deployment-unavailable");
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...a) => {
      if (a[1][0] === "stack" && a[1][1] === "up")
        return {
          code: 2,
          stdout: "",
          stderr: "stack: plan has no stack apply record\n",
        };
      if (a[1][0] === "stack" && a[1][1] === "apply") {
        a[2]!.onOutput!(`${JSON.stringify(payload)}\n`);
        return { code: 2, stdout: "", stderr: "" };
      }
      return original(...a);
    });
    const result = await prepareLocalModels(f.instance, f.options, {
      localmodels: f.call,
    });
    expect(result).toMatchObject({
      state: "action_required",
      details: {
        code: "LOCAL_MODELS_RECOVERY_REQUIRED",
        causeCode,
        reasons: ["deployment-unavailable"],
      },
      message: expect.stringContaining(expectedText),
    });
    expect(result?.message).not.toContain("localmodels.stack-error/v1");
    expect(result?.message).not.toContain("{");
  },
);
test("an incompatible saved plan from an older release asks for recovery instead of throwing", async () => {
  const f = await deployedThenNotReady("deployment-unavailable");
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) =>
    a[1][0] === "setup" && a[1][1] === "review"
      ? { code: 2, stdout: "", stderr: "invalid plan schema\n" }
      : original(...a),
  );
  const result = await prepareLocalModels(f.instance, f.options, {
    localmodels: f.call,
  });
  expect(result).toMatchObject({
    code: 4,
    state: "action_required",
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      causeCode: "STACK_PLAN_INVALID",
    },
  });
});
test("a stack still not ready after applying the approved plan again asks for recovery", async () => {
  const f = await deployedThenNotReady("gateway-unavailable");
  const result = await prepareLocalModels(f.instance, f.options, {
    localmodels: f.call,
  });
  expect(result).toMatchObject({
    state: "action_required",
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      reasons: ["gateway-unavailable"],
    },
  });
  expect(
    f.call.mock.calls.filter(([, args]) => args[1] === "apply"),
  ).toHaveLength(1);
  // The earlier ready binding is never replaced by one not verified.
  expect(
    JSON.parse(
      await readFile(
        path.join(f.home, "runtime/localmodels/binding.json"),
        "utf8",
      ),
    ),
  ).toEqual(f.ready);
});
test("a failed re-apply of the approved plan reports the upstream cause", async () => {
  const f = await deployedThenNotReady("deployment-unavailable");
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    if (a[1][1] !== "apply") return original(...a);
    a[2]!.onOutput!("stack: port 8080 is held by another program\n");
    return { code: 1, stdout: "", stderr: "" };
  });
  expect(
    await prepareLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toMatchObject({
    state: "action_required",
    // What made it apply the plan again.
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      reasons: ["deployment-unavailable"],
    },
    message: expect.stringContaining(
      "stack: port 8080 is held by another program",
    ),
  });
});
test("a not-ready binding is never re-applied once resource choices changed", async () => {
  const f = await deployedThenNotReady("deployment-unavailable");
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: false },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
  });
  expect(
    f.call.mock.calls.some(
      ([, args]) =>
        args[0] === "stack" && ["plan", "up", "apply"].includes(args[1]!),
    ),
  ).toBe(false);
});
test("cancellation propagates without pretending to finish", async () => {
  const f = await fixture();
  const c = new AbortController();
  c.abort();
  await expect(
    prepareLocalModels(
      f.instance,
      { ...f.options, signal: c.signal },
      { localmodels: f.call },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(f.call).not.toHaveBeenCalled();
});
test("Computer environment consumes the authoritative binding without parsing Pi formats", async () => {
  const f = await fixture();
  const { writeSetupChoice } = await import("./setup-selection.js");
  await writeSetupChoice(f.instance, "local-models");
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(await localModelsEnvironment(f.instance)).toEqual({
    LINGER_PI_PATH: "/upstream/pi",
    PI_CODING_AGENT_DIR: "/upstream/profile",
    LINGER_LOCAL_MODELS_REVISION: "b".repeat(64),
  });
});
// A deployed local-models setup that a quit stopped, with the model source
// saved as `mode`, or none saved.
async function stoppedLocalSetup(mode?: string) {
  const f = await deployedThenNotReady("gateway-unavailable");
  await writeSetupChoice(f.instance, "local-models");
  if (mode) {
    const state = path.join(f.home, "runtime/localmodels/state");
    await mkdir(state, { recursive: true });
    await writeFile(
      path.join(state, "model-source.json"),
      JSON.stringify({
        schema: "localmodels.model-source/v1",
        mode,
        runtime: mode === "local" ? "pi" : "claude",
        runtime_model: "",
        model_label: null,
        gateway_url: null,
        environment: {},
      }),
      { mode: 0o600 },
    );
  }
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) => {
    // stack up brings the stopped stack and its gateway back without re-planning.
    if (a[1][0] === "stack" && a[1][1] === "up")
      Object.assign(f.binding, f.ready);
    return original(...a);
  });
  return f;
}
function commands(f: {
  call: { mock: { calls: Parameters<typeof runLocalmodels>[] } };
}) {
  return f.call.mock.calls.map(([, args]) => `${args[0]} ${args[1]}`);
}
test.each([undefined, "local"])(
  "a stopped local stack is restored via stack up while the model source is %s",
  async (mode) => {
    const f = await stoppedLocalSetup(mode);
    expect(
      await restoreLocalModels(f.instance, f.options, { localmodels: f.call }),
    ).toBeUndefined();
    expect(commands(f)).toEqual([
      "setup binding",
      "setup review",
      "setup binding",
      "stack up",
      "setup binding",
      "source apply",
    ]);
    expect(f.call.mock.calls.at(-1)![1].slice(0, 6)).toEqual([
      "source",
      "apply",
      "--mode",
      "local",
      "--runtime",
      "pi",
    ]);
  },
);
test("a ready local stack costs one binding check", async () => {
  const f = await stoppedLocalSetup("local");
  Object.assign(f.binding, f.ready);
  expect(
    await restoreLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toBeUndefined();
  expect(commands(f)).toEqual(["setup binding"]);
});
test.each(["subscription", "byok"])(
  "a model source switched to %s keeps the local stack stopped",
  async (mode) => {
    const f = await stoppedLocalSetup(mode);
    expect(
      await restoreLocalModels(f.instance, f.options, { localmodels: f.call }),
    ).toBeUndefined();
    expect(f.call).not.toHaveBeenCalled();
  },
);
test("another setup choice never restores local models", async () => {
  const f = await stoppedLocalSetup();
  await writeSetupChoice(f.instance, "claude");
  expect(
    await restoreLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toBeUndefined();
  expect(f.call).not.toHaveBeenCalled();
});
test("a restore whose plan fails to apply reports why", async () => {
  const f = await stoppedLocalSetup();
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) =>
    a[1][0] === "stack" ? { code: 1, stdout: "", stderr: "" } : original(...a),
  );
  expect(
    await restoreLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toMatchObject({
    state: "action_required",
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      reasons: ["gateway-unavailable"],
    },
  });
  expect(commands(f)).not.toContain("source apply");
});
test("a restore waits for a quit-time stop and checks the stack it left", async () => {
  const f = await stoppedLocalSetup("local");
  Object.assign(f.binding, f.ready);
  let release!: () => void;
  let acquired!: () => void;
  const locked = new Promise<void>((resolve) => (acquired = resolve));
  const stopping = withLocalModelsLock(
    f.home,
    () =>
      new Promise<void>((resolve) => {
        acquired();
        release = () => {
          // The stop takes the stack down before it lets go.
          Object.assign(f.binding, {
            ready: false,
            pi: null,
            reasons: [{ code: "gateway-unavailable" }],
          });
          resolve();
        };
      }),
  );
  await locked;
  const restoring = restoreLocalModels(f.instance, f.options, {
    localmodels: f.call,
    lockRetryMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.call).not.toHaveBeenCalled();
  release();
  await stopping;
  expect(await restoring).toBeUndefined();
  expect(commands(f)).toContain("stack up");
  expect(commands(f).at(-1)).toBe("source apply");
});
test("a restore gives up when the stack stays locked", async () => {
  const f = await stoppedLocalSetup("local");
  let release!: () => void;
  let acquired!: () => void;
  const locked = new Promise<void>((resolve) => (acquired = resolve));
  const held = withLocalModelsLock(
    f.home,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        acquired();
      }),
  );
  await locked;
  try {
    expect(
      await restoreLocalModels(f.instance, f.options, {
        localmodels: f.call,
        lockWaitMs: 30,
        lockRetryMs: 5,
      }),
    ).toMatchObject({
      state: "action_required",
      details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
    });
    expect(f.call).not.toHaveBeenCalled();
  } finally {
    release();
    await held;
  }
});
test("a restored stack the model source refuses reports why", async () => {
  const f = await stoppedLocalSetup();
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...a) =>
    a[1][0] === "source"
      ? {
          code: 1,
          stdout: JSON.stringify({ code: "GATEWAY_DOWN", message: "Down." }),
          stderr: "",
        }
      : original(...a),
  );
  expect(
    await restoreLocalModels(f.instance, f.options, { localmodels: f.call }),
  ).toMatchObject({ state: "failed", details: { code: "GATEWAY_DOWN" } });
});

test("streams more than the process capture limit during an approved stack apply", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => {
    if (args[1][1] !== "apply") return original(...args);
    const record =
      JSON.stringify({
        event: "progress",
        component: "llm",
        phase: "download",
        done: 1,
        total: 2,
      }) + "\n";
    const final =
      JSON.stringify({
        event: "progress",
        component: "llm",
        phase: "download",
        done: 2,
        total: 2,
      }) + "\n";
    return runProcess(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(record)}.repeat(30000));process.stdout.write(${JSON.stringify(final)});`,
      ],
      args[2],
    );
  });
  expect(
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    ),
  ).toBeUndefined();
  expect(f.options.onEvent.mock.calls.flat()).toContainEqual(
    expect.objectContaining({
      progress: { completed: 2, total: 2, unit: "bytes", partial: true },
    }),
  );
  expect(
    f.call.mock.calls.find((call) => call[1][1] === "apply")?.[2]?.capture,
  ).toBe(false);
});

test("creates the shared private model root before the main model executor can populate it", async () => {
  const f = await fixture();
  const invoke = vi.fn<typeof runLocalmodels>(async (home, args, options) => {
    const root = path.join(f.home, "runtime/localmodels/models");
    await expectPrivate(root, "directory");
    return f.call(home, args, options);
  });
  await prepareLocalModels(f.instance, f.options, { localmodels: invoke });
  expect(invoke).toHaveBeenCalled();
});

test("a new main-model plan reserves no decision model", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  const args = f.call.mock.calls.find((call) => call[1][1] === "plan")![1];
  expect(
    args.slice(args.indexOf("--decision"), args.indexOf("--decision") + 2),
  ).toEqual(["--decision", "none"]);
});

test("explicit shared-GPU consent is persisted and bound into the saved main plan command", async () => {
  const f = await fixture();
  await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: true },
    { localmodels: f.call },
  );
  const args = f.call.mock.calls.find((call) => call[1][1] === "plan")![1];
  expect(args).toContain("--share-gpu");
  expect(
    JSON.parse(
      await readFile(path.join(f.instance.root, "gpu-sharing.json"), "utf8"),
    ),
  ).toBe(true);
});

test("changed resource consent cannot approve an earlier saved plan", async () => {
  const f = await fixture();
  await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: true },
    { localmodels: f.call },
  );
  f.call.mockClear();
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: false, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    state: "action_required",
    details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
  });
  expect(
    f.call.mock.calls.some(
      ([, args]) =>
        args[0] === "stack" && ["plan", "up", "apply"].includes(args[1]!),
    ),
  ).toBe(false);
});

test.each(["missing", "damaged", "different-plan"])(
  "%s plan input binding cannot authorize apply",
  async (state) => {
    const f = await fixture();
    await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
    const file = path.join(f.home, "runtime/localmodels/plan-inputs.json");
    if (state === "missing") await rm(file);
    else
      await writeFile(
        file,
        state === "damaged"
          ? "not-json"
          : JSON.stringify({
              planId: "c".repeat(64),
              shareGpu: false,
              decision: false,
            }),
      );
    f.call.mockClear();
    const result = await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    );
    expect(result).toMatchObject({
      details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
    });
    expect(f.call.mock.calls.some(([, args]) => args[1] === "apply")).toBe(
      false,
    );
  },
);

test("revocation requires a separate reviewed plan before any later apply", async () => {
  const f = await fixture();
  await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: true },
    { localmodels: f.call },
  );
  f.call.mockClear();
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: false, localModelsReplan: true },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_APPROVAL_REQUIRED" },
  });
  const plan = f.call.mock.calls.find(([, args]) => args[1] === "plan")![1];
  expect(plan).not.toContain("--share-gpu");
  expect(f.call.mock.calls.some(([, args]) => args[1] === "apply")).toBe(false);
  f.call.mockClear();
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(f.call.mock.calls.some(([, args]) => args[1] === "apply")).toBe(true);
});

test.each([false, true])(
  "revokes an existing queued controller before old-plan early return (failure=%s)",
  async (failure) => {
    const f = await fixture();
    await prepareLocalModels(
      f.instance,
      { ...f.options, shareGpu: true },
      { localmodels: f.call },
    );
    const control = path.join(f.home, "runtime/model-services");
    const descriptor = {
      schema: "localmodels.service-controller-binding/v1",
      baseUrl: "http://127.0.0.1:18300",
      keyFile: path.join(control, "control.key"),
      bridgeRoot: path.join(control, "bridge"),
    };
    await writeFile(
      path.join(f.instance.root, "model-services.json"),
      JSON.stringify(descriptor),
      { mode: 0o600 },
    );
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) =>
      args[1][0] === "foundations"
        ? {
            code: failure ? 1 : 0,
            stdout: JSON.stringify(descriptor),
            stderr: "private-provider-secret",
          }
        : original(...args),
    );
    f.call.mockClear();
    const result = await prepareLocalModels(
      f.instance,
      {
        ...f.options,
        shareGpu: false,
        localModelsApproval: f.id,
      },
      { localmodels: f.call },
    );
    expect(f.call.mock.calls[0]![1].slice(0, 2)).toEqual([
      "foundations",
      "ensure",
    ]);
    const args = f.call.mock.calls[0]![1];
    expect(args).not.toContain("--share-gpu");
    expect(args).not.toContain("--component");
    expect(args[args.indexOf("--main-plan") + 1]).toBe(
      path.join(f.home, "runtime/localmodels/plan.json"),
    );
    expect(f.call.mock.calls[0]![2]).toMatchObject({ timeoutMs: 30_000 });
    expect(result).toMatchObject({
      details: {
        code: failure
          ? "GPU_SHARING_REVOCATION_FAILED"
          : "LOCAL_MODELS_RECOVERY_REQUIRED",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-provider-secret");
    expect(f.call.mock.calls.some(([, args]) => args[1] === "apply")).toBe(
      false,
    );
  },
);

test("first installation with sharing declined never starts a revocation controller", async () => {
  const f = await fixture();
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, shareGpu: false },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_APPROVAL_REQUIRED" },
  });
  expect(f.call.mock.calls[0]![1].slice(0, 2)).toEqual(["stack", "plan"]);
  expect(f.call.mock.calls.some(([, args]) => args[0] === "foundations")).toBe(
    false,
  );
});

test.each([false, true])(
  "reuses only a live verified binding without approving a saved plan (revoke=%s)",
  async (revoke) => {
    const f = await fixture();
    await prepareLocalModels(
      f.instance,
      { ...f.options, shareGpu: true },
      { localmodels: f.call },
    );
    await prepareLocalModels(
      f.instance,
      { ...f.options, localModelsApproval: f.id },
      { localmodels: f.call },
    );
    if (!revoke)
      await rm(path.join(f.home, "runtime/localmodels/plan-inputs.json"));
    if (revoke) {
      const control = path.join(f.home, "runtime/model-services");
      const descriptor = {
        schema: "localmodels.service-controller-binding/v1",
        baseUrl: "http://127.0.0.1:18300",
        keyFile: path.join(control, "control.key"),
        bridgeRoot: path.join(control, "bridge"),
      };
      await writeFile(
        path.join(f.instance.root, "model-services.json"),
        JSON.stringify(descriptor),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(f.instance.root, "foundation-selection.json"),
        JSON.stringify(["embedding"]),
        { mode: 0o600 },
      );
      const original = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (...args) =>
        args[1][0] === "foundations"
          ? { code: 0, stdout: JSON.stringify(descriptor), stderr: "" }
          : original(...args),
      );
    }
    f.call.mockClear();
    expect(
      await prepareLocalModels(
        f.instance,
        { ...f.options, ...(revoke ? { shareGpu: false } : {}) },
        { localmodels: f.call },
      ),
    ).toBeUndefined();
    expect(f.call.mock.calls.some(([, args]) => args[0] === "stack")).toBe(
      false,
    );
    expect(
      f.call.mock.calls.some(
        ([, args]) => args[0] === "setup" && args[1] === "binding",
      ),
    ).toBe(true);
    if (revoke)
      expect(f.call.mock.calls[0]![1].slice(0, 2)).toEqual([
        "foundations",
        "ensure",
      ]);
    if (revoke)
      expect(
        JSON.parse(
          await readFile(
            path.join(f.home, "runtime/localmodels/plan-inputs.json"),
            "utf8",
          ),
        ).shareGpu,
      ).toBe(true);
    else
      await expect(
        stat(path.join(f.home, "runtime/localmodels/plan-inputs.json")),
      ).rejects.toThrow();
  },
);

test("a stale stored binding with missing approval inputs cannot authorize deployment", async () => {
  const f = await fixture();
  await prepareLocalModels(f.instance, f.options, { localmodels: f.call });
  await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  await rm(path.join(f.home, "runtime/localmodels/plan-inputs.json"));
  f.binding.ready = false;
  f.call.mockClear();
  const result = await prepareLocalModels(
    f.instance,
    { ...f.options, localModelsApproval: f.id },
    { localmodels: f.call },
  );
  expect(result).toMatchObject({
    details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
  });
  expect(f.call.mock.calls.some(([, args]) => args[0] === "stack")).toBe(false);
});

test("names what downloads and keeps the tool's counters", () => {
  const progress = {
    event: "progress",
    component: "llm",
    step: "download",
    phase: "download",
    done: 4,
    total: 10,
  };
  // Today's tool counts one file at a time.
  expect(stackProgress({ ...progress, bytes_per_second: 3 })).toEqual({
    kind: "stage",
    stage: "runtime",
    state: "running",
    message: "Downloading the local model…",
    progress: {
      completed: 4,
      total: 10,
      unit: "bytes",
      bytesPerSecond: 3,
      partial: true,
    },
  });
  // Whole-component counters, once the tool sends them, replace the file's.
  expect(
    stackProgress({ ...progress, component_done: 40, component_total: 100 })
      ?.progress,
  ).toEqual({ completed: 40, total: 100, unit: "bytes" });
  expect(stackProgress({ ...progress, step: "engine" })?.message).toBe(
    "Downloading the inference engine…",
  );
  expect(
    stackProgress({ ...progress, component: "embedding", phase: "verify" })
      ?.message,
  ).toBe("Checking the embedding model…");
  // A rate is bytes over elapsed time, so the tool may send a fraction.
  expect(
    stackProgress({ ...progress, bytes_per_second: 42123456.7 })?.progress
      ?.bytesPerSecond,
  ).toBe(42123457);
  for (const rate of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3"])
    expect(
      stackProgress({ ...progress, bytes_per_second: rate })?.progress,
    ).not.toHaveProperty("bytesPerSecond");
  for (const other of [
    { ...progress, phase: "loading", done: null, total: null },
    { ...progress, done: 11 },
    { ...progress, event: "log" },
  ])
    expect(stackProgress(other)).toBeUndefined();
});
