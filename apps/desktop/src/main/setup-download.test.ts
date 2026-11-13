// @vitest-environment jsdom
/// <reference lib="dom" />

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NODE_RUNTIME_VERSION } from "../../../../scripts/local-computer-node-distributions.mjs";
import type { LingerSetupApi, SetupState } from "../shared/setup.js";
import { LOCAL_INSTANCE, LocalServerModule } from "./local-server.js";
import { stubModule, tempDirectory, testHost } from "./test-support.js";

const html = readFileSync("src/shell/setup.html", "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
const initial: SetupState = {
  platform: "linux",
  version: "test",
  serverUrl: "",
  signedIn: false,
  enrolled: false,
  displayName: "",
  preventSleep: false,
  openAtLogin: false,
  folders: [],
  localServer: {
    available: true,
    phase: "installing",
    cancellable: true,
    message: "Local model llm: download",
    steps: [
      "prepare",
      "download",
      "services",
      "workspace",
      "connect",
      "agents",
    ],
    step: "services",
    progress: 0.38,
    attempt: 1,
    modelActivity: {
      message: "Local model llm: download",
      progress: { completed: 4 * 1024 ** 3, total: 17 * 1024 ** 3 },
    },
    localModels: { state: "unchecked" },
    location: { path: "/test", custom: false },
    keys: { composio: false, soniox: false, xai: false },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.documentElement.innerHTML = "";
});

async function page(state = initial) {
  vi.useFakeTimers();
  let update: ((next: SetupState) => void) | undefined;
  const api: LingerSetupApi = {
    getState: async () => state,
    onState: (callback) => {
      update = callback;
      return () => undefined;
    },
    run: vi.fn(async () => state),
  };
  vi.stubGlobal("lingerSetup", api);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  document.documentElement.innerHTML = html;
  if (!script) throw new Error("Missing setup script");
  window.eval(script);
  await Promise.resolve();
  await Promise.resolve();
  return { api, update: (next: SetupState) => update?.(next) };
}

it("shows real model file bytes and names active download instead of a synthetic overall percentage", async () => {
  await page();
  expect(document.getElementById("installing-step")?.textContent).toContain(
    "Preparing local model files",
  );
  expect(document.getElementById("installing-activity")?.textContent).toBe(
    "Local model llm: download",
  );
  expect(document.getElementById("installing-transfer")?.textContent).toBe(
    "4.0 GB of 17.0 GB processed · latest reported file",
  );
  expect(
    document.getElementById("installing-bar")?.getAttribute("aria-valuenow"),
  ).toBe("24");
  expect(document.getElementById("installing-count")?.textContent).toBe("24%");
});

it("uses an indeterminate model phase when upstream has no byte totals", async () => {
  await page({
    ...initial,
    localServer: {
      ...initial.localServer,
      modelActivity: { message: "Preparing the local model…" },
    },
  });
  expect(
    document.getElementById("installing-bar")?.hasAttribute("aria-valuenow"),
  ).toBe(false);
  expect(document.getElementById("installing-count")?.textContent).toBe("");
  expect(document.getElementById("installing-transfer")?.hidden).toBe(true);
  expect(document.getElementById("installing-activity")?.textContent).toContain(
    "Preparing",
  );
});

it("offers scoped stop, pending feedback and retry after cancellation settles", async () => {
  const f = await page();
  expect(document.getElementById("installing-stop-row")?.hidden).toBe(false);
  document.getElementById("local-stop")?.click();
  expect(f.api.run).toHaveBeenCalledWith({ op: "local.cancel" });
  await Promise.resolve();
  await Promise.resolve();
  f.update({
    ...initial,
    localServer: {
      ...initial.localServer,
      phase: "stopping",
      cancellable: false,
    },
  });
  expect(document.getElementById("installing-stop-row")?.hidden).toBe(false);
  expect(document.getElementById("local-stop")?.hasAttribute("disabled")).toBe(
    true,
  );
  expect(document.getElementById("installing-title")?.textContent).toBe(
    "Stopping installation",
  );
  expect(document.getElementById("installing-actions")?.hidden).toBe(true);
  f.update({
    ...initial,
    localServer: {
      ...initial.localServer,
      phase: "cancelled",
      cancellable: false,
      modelActivity: undefined,
    },
  });
  expect(document.getElementById("installing-title")?.textContent).toBe(
    "Installation stopped",
  );
  expect(document.getElementById("installing-actions")?.hidden).toBe(false);
  expect(document.getElementById("installing-plan")?.textContent).toContain(
    "kept",
  );
  document.getElementById("local-retry")?.click();
  expect(f.api.run).toHaveBeenLastCalledWith(
    expect.objectContaining({ op: "local.start" }),
  );
});

it.each(["signin", "connect", "agents"] as const)(
  "hides and disables Stop during %s after the installer run has returned",
  async (step) => {
    const f = await page();
    f.update({
      ...initial,
      localServer: {
        ...initial.localServer,
        steps: [...initial.localServer.steps, "signin"],
        step,
        cancellable: false,
        modelActivity: undefined,
      },
    });
    expect(document.getElementById("installing-stop-row")?.hidden).toBe(true);
    expect(
      document.getElementById("local-stop")?.hasAttribute("disabled"),
    ).toBe(true);
    document.getElementById("local-stop")?.click();
    expect(f.api.run).not.toHaveBeenCalled();
    expect(document.getElementById("installing-title")?.textContent).toBe(
      "Installing Linger",
    );
  },
);

it.each(["prepare", "download", "services", "workspace"] as const)(
  "keeps Stop available during cancellable %s work",
  async (step) => {
    const f = await page({
      ...initial,
      localServer: {
        ...initial.localServer,
        step,
        modelActivity: undefined,
      },
    });
    expect(document.getElementById("installing-stop-row")?.hidden).toBe(false);
    expect(
      document.getElementById("local-stop")?.hasAttribute("disabled"),
    ).toBe(false);
    document.getElementById("local-stop")?.click();
    expect(f.api.run).toHaveBeenCalledWith({ op: "local.cancel" });
  },
);

it.each(["waiting_user", "canceled"] as const)(
  "accepts Pi provider settings after pending Stop hands off a completed %s job",
  async (handoffState) => {
    const root = tempDirectory();
    const home = path.join(root, "home");
    const installerDirectory = path.join(root, "installer");
    const repo = path.join(home, "src");
    mkdirSync(installerDirectory, { recursive: true });
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    writeFileSync(path.join(repo, "scripts", "source-native.mjs"), "");
    const nodeDirectory = path.join(
      home,
      "desktop",
      "node",
      `v${NODE_RUNTIME_VERSION}`,
      "bin",
    );
    mkdirSync(nodeDirectory, { recursive: true });
    symlinkSync(process.execPath, path.join(nodeDirectory, "node"));
    writeFileSync(
      path.join(installerDirectory, "distribution.json"),
      JSON.stringify({
        platform: "linux",
        arch: "x64",
        nativeSources: [{ target: "linux-x64" }],
      }),
    );
    writeFileSync(
      path.join(installerDirectory, "installer.js"),
      String.raw`
const fs = require("node:fs");
const path = require("node:path");
const home = process.argv[process.argv.indexOf("--home") + 1];
fs.mkdirSync(path.join(home, "installer"), { recursive: true });
fs.writeFileSync(path.join(home, "installer", "launch.html"), '<meta http-equiv="refresh" content="0;url=http://127.0.0.1:4321/#token=test">');
process.stdout.write("Installer is running at http://127.0.0.1:4321\n");
`,
    );
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let providerReady = false;
    const requests: string[] = [];
    const job = (fields: Record<string, unknown>) => ({
      id: "owned",
      instance: LOCAL_INSTANCE,
      createdAt: "2026-11-11T00:00:00Z",
      stages: [],
      ...fields,
    });
    const identity = {
      origin: "http://localhost:3000",
      teamhub: "http://127.0.0.1:4100",
      key: Buffer.alloc(32, 1),
    };
    const signIn = vi.fn(async () => {});
    const enroll = vi.fn(async () => {});
    const module = new LocalServerModule({
      home,
      installerDirectory,
      checkout: repo,
      platform: "linux",
      arch: "x64",
      pollMs: 1,
      signInPollMs: 5,
      signIn,
      serverIdentity: async () => identity,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (url.pathname === "/api/session")
          return new Response("{}", {
            headers: {
              "set-cookie": "linger_installer_session=test; Path=/api",
            },
          });
        if (url.pathname === "/api/jobs" && init?.method === "GET")
          return Response.json({ items: [] });
        if (url.pathname === "/api/jobs")
          return Response.json(job({ state: "running" }));
        if (url.pathname === "/api/jobs/owned") {
          enter();
          await released;
          return Response.json(job({ state: "running" }));
        }
        if (url.pathname === "/api/jobs/owned/cancel")
          return Response.json(
            job({
              state: handoffState,
              origin: "http://localhost:3000",
              errorCode: "RUNTIME_AUTH_REQUIRED",
            }),
          );
        if (url.pathname === `/api/instances/${LOCAL_INSTANCE}/runtime`)
          return Response.json({ setupChoice: "pi", environment: {} });
        if (url.pathname === "/api/runtime-login") {
          if (init?.method === "POST") providerReady = true;
          return Response.json({ state: providerReady ? "ready" : "idle" });
        }
        if (url.pathname === `/api/instances/${LOCAL_INSTANCE}/login`)
          return Response.json({ email: "owner@linger.local", password: "pw" });
        throw new Error("Unexpected test request");
      },
    });
    const host = testHost([
      Object.assign(stubModule("WindowManager"), {
        setServer: vi.fn(() => true),
      }),
      Object.assign(stubModule("Enrollment"), { enroll }),
      module,
    ]);
    await host.start();
    const state = (): SetupState => ({
      ...initial,
      localServer: module.status(),
    });
    let setupSettled = false;
    const running = module.begin({ runtime: "pi" }).then(() => {
      setupSettled = true;
    });
    await entered;
    const f = await page(state());
    const off = host.ctx.bus.on("local-server.changed", () =>
      f.update(state()),
    );
    let stopSettled = false;
    vi.mocked(f.api.run).mockImplementation(async (command) => {
      if (command.op === "local.cancel") {
        await module.cancelInstallation();
        stopSettled = true;
      } else if (command.op === "local.signin.configure")
        await module.configurePiProvider(command.credentials);
      else throw new Error("Unexpected setup command");
      return state();
    });
    try {
      document.getElementById("local-stop")?.click();
      expect(f.api.run).toHaveBeenCalledExactlyOnceWith({ op: "local.cancel" });
      expect(document.getElementById("installing-title")?.textContent).toBe(
        "Stopping installation",
      );
      expect(stopSettled).toBe(false);
      release();
      await vi.waitFor(() =>
        expect(module.status().signIn).toEqual({
          runtime: "pi",
          state: "required",
        }),
      );
      expect(setupSettled).toBe(false);
      expect(signIn).not.toHaveBeenCalled();
      expect(enroll).not.toHaveBeenCalled();
      const fields = document.getElementById("runtime-provider-fields");
      const key = document.getElementById("runtime-provider-key");
      const form = document.getElementById("runtime-provider-form");
      if (
        !(fields instanceof HTMLFieldSetElement) ||
        !(key instanceof HTMLInputElement) ||
        !(form instanceof HTMLFormElement)
      )
        throw new Error("The Pi provider form is missing");
      expect(form.hidden).toBe(false);
      await vi.waitFor(() => expect(fields.disabled).toBe(false));
      expect(stopSettled).toBe(true);
      key.value = "synthetic-provider-key";
      form.requestSubmit();
      expect(key.value).toBe("");
      await running;
      expect(module.status().phase).toBe("ready");
      expect(providerReady).toBe(true);
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(signIn).toHaveBeenCalledWith(identity, "owner@linger.local", "pw");
      expect(enroll).toHaveBeenCalledTimes(1);
      expect(requests.filter((request) => request.endsWith("/cancel"))).toEqual(
        ["POST /api/jobs/owned/cancel"],
      );
      expect(f.api.run).toHaveBeenCalledTimes(2);
      expect(
        document
          .querySelector('section[data-step="ready"]')
          ?.classList.contains("active"),
      ).toBe(true);
    } finally {
      release();
      await host.stop("quit");
      await running;
      off();
    }
  },
);
