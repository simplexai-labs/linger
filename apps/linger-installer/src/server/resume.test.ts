import { expect, test, vi } from "vitest";
import type { Instance } from "@linger/local-installation/instance";
import type { installNativeSource } from "@linger/local-installation/native-source";
import { resumeSourceInstance, type ResumeEngine } from "./resume.js";

const instance = {
  name: "desktop",
  mode: "source-native",
  origin: "http://localhost:3000",
  root: "/home/instances/desktop",
  source: { repo: "/source" },
} as Instance;
const options = {
  home: "/home",
  sourceRepo: "/source",
  instanceName: "desktop",
  externalComputer: true,
  signal: new AbortController().signal,
  log: () => {},
};

const native = (run: ResumeEngine["run"], ready: boolean) => ({
  "source-native": { run, probe: async () => [{ ready }] },
});

test("starts the saved instance again without new input", async () => {
  const run = vi.fn<typeof installNativeSource>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  const outcome = await resumeSourceInstance(options, {
    load: async () => instance,
    engines: native(run, false),
  });
  expect(outcome).toMatchObject({
    code: 0,
    details: { origin: "http://localhost:3000" },
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "desktop",
      home: "/home",
      repo: "/source",
      externalComputer: true,
      resume: true,
      degradeLocalModels: true,
    }),
  );
  expect(run.mock.calls[0]![0]).not.toHaveProperty("password");
});

test("an app update onto a new checkout starts in full but keeps local models optional", async () => {
  const run = vi.fn<typeof installNativeSource>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  await resumeSourceInstance(
    { ...options, sourceRepo: "/source-next" },
    {
      load: async () => instance,
      engines: native(run, true),
    },
  );
  const started = run.mock.calls[0]![0];
  expect(started).toMatchObject({
    repo: "/source-next",
    degradeLocalModels: true,
  });
  expect(started).not.toHaveProperty("resume");
});

test("forwards runtime descriptors reported during resume", async () => {
  const onRuntimeDescriptors = vi.fn();
  const descriptor = {
    runtime: "pi" as const,
    executable: "/mock/pi",
    argvPrefix: [],
    installed: true,
    authenticated: true,
    authMode: "api_key",
    loginCommand: null,
  };
  const run = vi.fn<typeof installNativeSource>(async (opts) => {
    opts.onRuntimeDescriptors?.([descriptor]);
    return { code: 0, state: "ready", message: "ok" };
  });
  const outcome = await resumeSourceInstance(
    { ...options, onRuntimeDescriptors },
    {
      load: async () => instance,
      engines: native(run, false),
    },
  );
  expect(outcome.code).toBe(0);
  expect(onRuntimeDescriptors).toHaveBeenCalledWith([descriptor]);
});

test("leaves running services alone", async () => {
  const run = vi.fn();
  expect(
    await resumeSourceInstance(options, {
      load: async () => instance,
      engines: native(run, true),
      pending: async () => false,
      restore: async () => undefined,
      restoreByok: async () => undefined,
    }),
  ).toMatchObject({ code: 0, details: { origin: instance.origin } });
  expect(run).not.toHaveBeenCalled();
});

test("brings the local models back while the services keep running", async () => {
  const run = vi.fn();
  const restore = vi.fn(async () => undefined);
  expect(
    await resumeSourceInstance(options, {
      load: async () => instance,
      engines: native(run, true),
      pending: async () => false,
      restore,
      restoreByok: async () => undefined,
    }),
  ).toMatchObject({ code: 0, state: "ready" });
  expect(restore).toHaveBeenCalledWith(
    instance,
    expect.objectContaining({ signal: options.signal }),
  );
  expect(run).not.toHaveBeenCalled();
});

test("mounts a saved BYOK source again after the local models", async () => {
  const order: string[] = [];
  const restore = vi.fn(async () => {
    order.push("restore");
    return undefined;
  });
  const restoreByok = vi.fn(async () => {
    order.push("byok");
    return undefined;
  });
  expect(
    await resumeSourceInstance(options, {
      load: async () => instance,
      engines: native(vi.fn(), true),
      pending: async () => false,
      restore,
      restoreByok,
    }),
  ).toMatchObject({ code: 0, message: "Services are already running." });
  expect(order).toEqual(["restore", "byok"]);
  expect(restoreByok).toHaveBeenCalledWith(
    "/home",
    expect.objectContaining({ signal: options.signal }),
  );
});

test("reports a BYOK gateway that did not come back on a ready resume", async () => {
  const byokGateway = {
    code: "BYOK_UNREACHABLE",
    message: "Endpoint did not answer.",
  };
  expect(
    await resumeSourceInstance(options, {
      load: async () => instance,
      engines: native(vi.fn(), true),
      pending: async () => false,
      restore: async () => undefined,
      restoreByok: async () => byokGateway,
    }),
  ).toMatchObject({ code: 0, state: "ready", details: { byokGateway } });
});

test("reports a local model library reload failure as localModelsDegraded without blocking resume", async () => {
  const failed = {
    code: 1,
    state: "failed" as const,
    message: "Could not reload local model qwen3.8-27b:UD-Q4_K_M: Out of VRAM.",
    details: { code: "LOAD_NO_ROOM" },
  };
  const logs: string[] = [];
  const restoreByok = vi.fn(async () => undefined);
  expect(
    await resumeSourceInstance(
      { ...options, log: (message) => logs.push(message) },
      {
        load: async () => instance,
        engines: native(vi.fn(), true),
        pending: async () => false,
        restore: async () => failed,
        restoreByok,
      },
    ),
  ).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      origin: "http://localhost:3000",
      source: "/source",
      localModelsDegraded: {
        code: "LOAD_NO_ROOM",
        message:
          "Could not reload local model qwen3.8-27b:UD-Q4_K_M: Out of VRAM.",
      },
    },
  });
  expect(restoreByok).not.toHaveBeenCalled();
  expect(logs.join("")).toContain("LOAD_NO_ROOM");
});

test("reports a local model restore that failed without blocking resume", async () => {
  const failed = {
    code: 4,
    state: "action_required" as const,
    message: "The local model stack is not ready.",
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      reasons: ["binding-unavailable"],
    },
  };
  const logs: string[] = [];
  const restoreByok = vi.fn(async () => undefined);
  expect(
    await resumeSourceInstance(
      { ...options, log: (message) => logs.push(message) },
      {
        load: async () => instance,
        engines: native(vi.fn(), true),
        pending: async () => false,
        restore: async () => failed,
        restoreByok,
      },
    ),
  ).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      origin: "http://localhost:3000",
      source: "/source",
      localModelsDegraded: {
        code: "LOCAL_MODELS_RECOVERY_REQUIRED",
        message: "The local model stack is not ready.",
        reasons: ["binding-unavailable"],
      },
    },
  });
  expect(restoreByok).not.toHaveBeenCalled();
  expect(logs.join("")).toContain("LOCAL_MODELS_RECOVERY_REQUIRED");
});

test("reports a local model restore that throws without blocking resume", async () => {
  const logs: string[] = [];
  const restoreByok = vi.fn(async () => undefined);
  expect(
    await resumeSourceInstance(
      { ...options, log: (message) => logs.push(message) },
      {
        load: async () => instance,
        engines: native(vi.fn(), true),
        pending: async () => false,
        restore: async () => {
          throw new Error("Invalid upstream local model binding.");
        },
        restoreByok,
      },
    ),
  ).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      origin: "http://localhost:3000",
      source: "/source",
      localModelsDegraded: {
        code: "LOCAL_MODELS_RECOVERY_REQUIRED",
        message: "Invalid upstream local model binding.",
      },
    },
  });
  expect(restoreByok).not.toHaveBeenCalled();
  expect(logs.join("")).toContain("Invalid upstream local model binding.");
});

test("leaves the local models to a full start", async () => {
  const restore = vi.fn(async () => undefined);
  const restoreByok = vi.fn(async () => undefined);
  await resumeSourceInstance(options, {
    load: async () => instance,
    engines: native(
      vi.fn<ResumeEngine["run"]>(async () => ({
        code: 0,
        state: "ready",
        message: "ok",
      })),
      false,
    ),
    restore,
    restoreByok,
  });
  expect(restore).not.toHaveBeenCalled();
  expect(restoreByok).not.toHaveBeenCalled();
});

test("restarts running services for a changed user.env", async () => {
  const run = vi.fn<ResumeEngine["run"]>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  await resumeSourceInstance(options, {
    load: async () => instance,
    engines: native(run, true),
    pending: async () => true,
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ repo: "/source" }),
  );
});

test("moves running services to a new source tree", async () => {
  const run = vi.fn<ResumeEngine["run"]>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  await resumeSourceInstance(options, {
    load: async () =>
      ({ ...instance, source: { repo: "/old-source" } }) as Instance,
    engines: native(run, true),
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ repo: "/source" }),
  );
});

test("prepares the runtime in full when resuming onto another checkout", async () => {
  const onRuntimeDescriptors = vi.fn();
  const run = vi.fn<ResumeEngine["run"]>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  await resumeSourceInstance(
    { ...options, onRuntimeDescriptors },
    {
      load: async () =>
        ({ ...instance, source: { repo: "/old-source" } }) as Instance,
      engines: native(run, false),
    },
  );
  expect(run.mock.calls[0]![0]).not.toHaveProperty("resume");
  expect(run.mock.calls[0]![0]).toMatchObject({
    repo: "/source",
    onRuntimeDescriptors,
  });
});

test("preserves structured local-model upgrade failure details when moving to a new source tree", async () => {
  const failed = {
    code: 4,
    state: "action_required" as const,
    message:
      "Local model installation or verification did not finish: The saved local model plan no longer fits this computer's current memory or model catalog. Existing resources were preserved.",
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      causeCode: "STACK_REPLAN_FAILED",
      reasons: ["deployment-unavailable"],
    },
  };
  const run = vi.fn<ResumeEngine["run"]>(async () => failed);
  expect(
    await resumeSourceInstance(options, {
      load: async () =>
        ({ ...instance, source: { repo: "/old-source" } }) as Instance,
      engines: native(run, true),
    }),
  ).toEqual(failed);
});

test("reports the source the services serve from", async () => {
  expect(
    await resumeSourceInstance(options, {
      load: async () => instance,
      engines: native(vi.fn(), true),
      pending: async () => false,
      restore: async () => undefined,
      restoreByok: async () => undefined,
    }),
  ).toMatchObject({ code: 0, details: { source: "/source" } });
  // The instance names a new checkout only once its services became ready
  // on it, so a run that never restarted them reports the old one.
  const run = vi.fn<ResumeEngine["run"]>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
  }));
  const old = { ...instance, source: { repo: "/old-source" } } as Instance;
  expect(
    await resumeSourceInstance(options, {
      load: async () => old,
      engines: native(run, true),
    }),
  ).toMatchObject({ code: 0, details: { source: "/old-source" } });
});

test("reports the origin the services moved to", async () => {
  const moved = { ...instance, origin: "http://localhost:3001" } as Instance;
  const load = vi
    .fn<() => Promise<Instance>>()
    .mockResolvedValueOnce(instance)
    .mockResolvedValue(moved);
  const run = vi.fn<ResumeEngine["run"]>(async () => ({
    code: 0,
    state: "ready",
    message: "ok",
    details: { origin: moved.origin },
  }));
  expect(
    await resumeSourceInstance(options, {
      load,
      engines: native(run, false),
    }),
  ).toMatchObject({ code: 0, details: { origin: "http://localhost:3001" } });
});

test("needs an installed source instance", async () => {
  expect(
    await resumeSourceInstance(options, {
      load: async () => ({ ...instance, source: undefined }),
    }),
  ).toMatchObject({ code: 4 });
  expect(
    await resumeSourceInstance(options, { load: async () => undefined }),
  ).toMatchObject({ code: 4 });
});
