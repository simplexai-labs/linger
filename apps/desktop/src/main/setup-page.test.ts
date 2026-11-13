// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { SetupState, LingerSetupApi } from "../shared/setup.js";

const html = readFileSync("src/shell/setup.html", "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];

const initial: SetupState = {
  platform: "win32",
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
    phase: "idle",
    cancellable: false,
    message: "",
    steps: ["prepare", "download", "services", "workspace", "signin"],
    step: "prepare",
    progress: 0,
    attempt: 0,
    localModels: {
      state: "checked",
      eligible: false,
      memoryBytes: 32 * 1024 ** 3,
      diskFreeBytes: 200 * 1024 ** 3,
      reasons: [
        "Local model installation is supported on Linux and Apple Silicon Macs.",
      ],
    },
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

async function page(state: SetupState = initial) {
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
  if (!script) throw new Error("The setup page script is missing");
  window.eval(script);
  await Promise.resolve();
  await Promise.resolve();
  const customize = document.getElementById("local-customize");
  if (!(customize instanceof HTMLButtonElement))
    throw new Error("The customize control is missing");
  customize.click();
  return { api, update: (next: SetupState) => update?.(next) };
}

it("keeps an unavailable local model visible with its reason and another runtime path", async () => {
  const f = await page();
  const row = document.getElementById("local-row");
  const model = document.getElementById("local-model");
  expect(row?.hidden).toBe(false);
  expect(model).toBeInstanceOf(HTMLButtonElement);
  expect(model?.hasAttribute("disabled")).toBe(true);
  expect(row?.textContent).toContain(
    "Local model installation is supported on Linux and Apple Silicon Macs.",
  );
  const alternative = document.getElementById("local-model-alternative");
  expect(alternative?.hidden).toBe(false);
  alternative?.click();
  document.getElementById("local-install")?.click();
  await Promise.resolve();
  expect(f.api.run).toHaveBeenCalledWith({
    op: "local.start",
    runtime: "pi",
  });
});

it.each(["unchecked", "checking", "unavailable"] as const)(
  "explains the %s inspection state without hiding the local model row",
  async (state) => {
    await page({
      ...initial,
      localServer: {
        ...initial.localServer,
        localModels: { state },
      },
    });
    expect(document.getElementById("local-row")?.hidden).toBe(false);
    expect(document.getElementById("local-sub")?.textContent).toMatch(
      state === "unavailable" ? /couldn't check/i : /checking/i,
    );
  },
);

it("drops a local model selection if a later check makes it unavailable", async () => {
  const f = await page({
    ...initial,
    localServer: {
      ...initial.localServer,
      localModels: {
        state: "checked",
        eligible: true,
        memoryBytes: 64 * 1024 ** 3,
        diskFreeBytes: 200 * 1024 ** 3,
        model: {
          name: "Test model",
          downloadBytes: 10,
          diskBytes: 20,
          memoryBytes: 30,
        },
      },
    },
  });
  document.getElementById("local-model")?.click();
  f.update(initial);
  expect(
    document.getElementById("local-model")?.getAttribute("aria-checked"),
  ).toBe("false");
  document.getElementById("local-install")?.click();
  await Promise.resolve();
  expect(f.api.run).toHaveBeenCalledWith(
    expect.objectContaining({ runtime: "pi" }),
  );
});

it.each(["openai", "anthropic", "openai-compatible"] as const)(
  "submits the masked %s provider key once and retains nonsecret retry fields",
  async (provider) => {
    const state: SetupState = {
      ...initial,
      localServer: {
        ...initial.localServer,
        phase: "installing",
        step: "signin",
        signIn: { runtime: "pi", state: "required" },
      },
    };
    const f = await page(state);
    const select = document.getElementById("runtime-provider");
    const key = document.getElementById("runtime-provider-key");
    const url = document.getElementById("runtime-provider-url");
    const model = document.getElementById("runtime-provider-model");
    const form = document.getElementById("runtime-provider-form");
    const fields = document.getElementById("runtime-provider-fields");
    if (
      !(select instanceof HTMLSelectElement) ||
      !(key instanceof HTMLInputElement) ||
      !(url instanceof HTMLInputElement) ||
      !(model instanceof HTMLInputElement) ||
      !(form instanceof HTMLFormElement) ||
      !(fields instanceof HTMLFieldSetElement)
    )
      throw new Error("The Pi provider form is missing");
    expect(form.hidden).toBe(false);
    expect(key.type).toBe("password");
    select.value = provider;
    select.dispatchEvent(new Event("change"));
    key.value = "synthetic-provider-key";
    url.value = "http://127.0.0.1:18100/v1";
    model.value = "local/model";
    let reject!: (reason: Error) => void;
    vi.mocked(f.api.run).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(key.value).toBe("");
    expect(fields.disabled).toBe(true);
    const command = {
      op: "local.signin.configure",
      credentials: {
        provider,
        apiKey: "synthetic-provider-key",
        ...(provider === "openai-compatible"
          ? { baseUrl: url.value, model: model.value }
          : {}),
      },
    };
    expect(f.api.run).toHaveBeenCalledExactlyOnceWith(command);
    reject(new Error("Check the provider settings."));
    await Promise.resolve();
    await Promise.resolve();
    expect(fields.disabled).toBe(false);
    expect(key.value).toBe("");
    expect(select.value).toBe(provider);
    expect(url.value).toBe("http://127.0.0.1:18100/v1");
    expect(model.value).toBe("local/model");
    expect(document.getElementById("runtime-signin-error")?.textContent).toBe(
      "Check the provider settings.",
    );
    key.value = "synthetic-provider-key";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.api.run).toHaveBeenNthCalledWith(2, command);
    expect(key.value).toBe("");
  },
);
