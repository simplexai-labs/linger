// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isInkling2MiniModelId } from "@linger/service-kit/featured-models";
import { minNvidiaDriverForCuda } from "@linger/service-kit/nvidia-driver";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Language } from "../i18n/language.js";
import zhCN from "../i18n/locales/zh-CN.json" with { type: "json" };
import { localizePage } from "../i18n/page.js";
import {
  INKLING_2_MINI_ANNOUNCEMENT_URL,
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
  type SetupCommand,
  type SetupLocalAccount,
  type SetupLocalModelsCheck,
  type SetupReason,
  type SetupRuntimeRow,
  type SetupState,
} from "../shared/setup.js";

import { setupMessages } from "./setup.messages.js";

const shellFile = (name: string) =>
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), name),
    "utf8",
  );
const rawPage = shellFile("setup.html");
const messagesRuntime = shellFile("messages.html");
const PASSWORD = "a-private-password";

const state = (
  phase: SetupState["localServer"]["phase"],
  account?: SetupLocalAccount,
): SetupState => ({
  platform: "linux",
  version: "1.0.0",
  serverUrl: "http://localhost:3000",
  signedIn: phase === "ready",
  enrolled: phase === "ready",
  displayName: "Desk",
  preventSleep: false,
  openAtLogin: false,
  folders: [],
  localServer: {
    available: true,
    phase,
    message: "",
    steps: ["prepare", "services", "connect", "agents"],
    step: phase === "ready" ? "agents" : "services",
    progress: phase === "ready" ? 1 : 0.5,
    attempt: 1,
    localModels: { state: "unavailable" },
    location: { path: "~/.simplexai", custom: false },
    keys: { composio: false },
    ownerAccount: "new",
    ...(account ? { account } : {}),
  },
});

// A loaded page keeps its timers, including a once-a-second render while
// installing, so a page from an earlier test would redraw its own state into
// the next test's document. Each test stops the previous page's timers first.
let stopPage = () => {};

// Loads the setup page with a fake main process, mid-install by default.
const openPage = async (
  initial: SetupState = state("installing"),
  step = "installing",
  language: Language = "en",
) => {
  stopPage();
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  stopPage = () => {
    intervals.forEach(clearInterval);
    timeouts.forEach(clearTimeout);
  };
  // The page as setup-window.ts serves it.
  const page = localizePage(rawPage, messagesRuntime, setupMessages, language);
  const [, body] = /<body[^>]*>([\s\S]*)<\/body>/.exec(page)!;
  const [, script] = /<script>([\s\S]*)<\/script>/.exec(body!)!;
  document.body.innerHTML = body!.replace(/<script>[\s\S]*<\/script>/, "");
  let listener: ((next: SetupState) => void) | undefined;
  let current = initial;
  const run = vi.fn(async (command: SetupCommand) => {
    if (command.op === "local.account.show")
      current = state("ready", {
        email: "owner@linger.local",
        ...(command.on ? { password: PASSWORD } : {}),
      });
    return current;
  });
  // jsdom has no layout, so it has no scrollIntoView; a failed install
  // reveals its actions with it on the next frame.
  Element.prototype.scrollIntoView ??= () => {};
  Object.assign(window, {
    matchMedia: () => ({ matches: true }),
    lingerSetup: {
      featuredAnnouncementUrl: INKLING_2_MINI_ANNOUNCEMENT_URL,
      nvidiaDriverDownloadUrl: NVIDIA_DRIVER_DOWNLOAD_URL,
      nvidiaDriverGuideUrl: NVIDIA_DRIVER_GUIDE_URL,
      minDriverForCuda: minNvidiaDriverForCuda,
      getState: async () => current,
      onState: (callback: (next: SetupState) => void) => {
        listener = callback;
        return () => {};
      },
      run,
    },
  });
  new Function("setInterval", "setTimeout", script!)(
    (...args: Parameters<typeof setInterval>) => {
      const id = setInterval(...args);
      intervals.push(id);
      return id;
    },
    (...args: Parameters<typeof setTimeout>) => {
      const id = setTimeout(...args);
      timeouts.push(id);
      return id;
    },
  );
  await vi.waitFor(() =>
    expect(
      document.querySelector(`section[data-step="${step}"].active`),
    ).not.toBeNull(),
  );
  const push = (next: SetupState) => {
    current = next;
    listener!(next);
  };
  return { run, push };
};

const $ = (id: string) => document.getElementById(id)!;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("setup page finish screen", () => {
  it("shows the account email with the password masked", async () => {
    const { push } = await openPage();
    push(state("ready", { email: "owner@linger.local" }));
    expect(
      document.querySelector('section[data-step="ready"].active'),
    ).not.toBeNull();
    expect($("account").hidden).toBe(false);
    expect($("account-email").textContent).toBe("owner@linger.local");
    expect($("account-password").textContent).toBe("•".repeat(12));
    expect($("account").textContent).not.toContain(PASSWORD);
    expect($("account-show").textContent).toBe("Show");
    expect($("account-copy").textContent).toBe("Copy");
    expect($("account-reveal").textContent?.trim()).toBe(
      "Open account file location",
    );
  });

  it("shows the password only after Show and hides it again", async () => {
    const { push, run } = await openPage();
    push(state("ready", { email: "owner@linger.local" }));
    $("account-show").click();
    await vi.waitFor(() =>
      expect($("account-password").textContent).toBe(PASSWORD),
    );
    expect(run).toHaveBeenCalledWith({ op: "local.account.show", on: true });
    expect($("account-show").textContent).toBe("Hide");
    $("account-show").click();
    await vi.waitFor(() =>
      expect($("account-password").textContent).toBe("•".repeat(12)),
    );
    expect(run).toHaveBeenLastCalledWith({
      op: "local.account.show",
      on: false,
    });
  });

  it("asks the main process to copy the password and reveal the file", async () => {
    const { push, run } = await openPage();
    push(state("ready", { email: "owner@linger.local" }));
    $("account-copy").click();
    await vi.waitFor(() =>
      expect($("account-copy").textContent).toBe("Copied"),
    );
    expect(run).toHaveBeenCalledWith({
      op: "local.account.copy",
      what: "password",
    });
    $("account-copy-email").click();
    await vi.waitFor(() =>
      expect($("account-copy-email").textContent).toBe("Copied"),
    );
    expect(run).toHaveBeenCalledWith({
      op: "local.account.copy",
      what: "email",
    });
    $("account-reveal").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "local.account.reveal" }),
    );
  });

  it("says why the account cannot be shown", async () => {
    const { push } = await openPage();
    push(
      state("ready", {
        error:
          "The local account file must be private and owned by the current user (chmod 600).",
      }),
    );
    expect($("account").hidden).toBe(false);
    expect($("account-fields").hidden).toBe(true);
    expect($("account-note").hidden).toBe(true);
    expect($("account-error").textContent).toContain("chmod 600");
  });
});

const GB = 1024 ** 3;
const capable: SetupLocalModelsCheck = {
  state: "checked",
  eligible: true,
  memoryBytes: 64 * GB,
  diskFreeBytes: 400 * GB,
  gpu: "RTX 4090",
  model: {
    name: "qwen3-8b",
    downloadBytes: 6 * GB,
    diskBytes: 8 * GB,
    memoryBytes: 12 * GB,
  },
  recommendation: "local-models",
};
const small: SetupLocalModelsCheck = {
  state: "checked",
  eligible: false,
  memoryBytes: 8 * GB,
  diskFreeBytes: 100 * GB,
  reasons: [{ code: "plan-unavailable" }],
  recommendation: "codex",
};
// The tool's own words, which the page must never show.
const TOOL_WORDS = "GPU service owners unknown; explicit sharing";
const reason = (fields: SetupReason): SetupReason =>
  ({ ...fields, message: TOOL_WORDS }) as SetupReason;
// The model fits the hardware, but other programs hold its memory now.
const held: SetupLocalModelsCheck = {
  state: "checked",
  eligible: false,
  blockedNow: true,
  memoryBytes: 16 * GB,
  diskFreeBytes: 400 * GB,
  model: {
    name: "qwen3-8b",
    downloadBytes: 6 * GB,
    diskBytes: 8 * GB,
    memoryBytes: 12 * GB,
  },
  reasons: [reason({ code: "free-memory-required" })],
  recommendation: "codex",
};
const welcome = (
  localModels: SetupLocalModelsCheck,
  localServer: Partial<SetupState["localServer"]> = {},
): SetupState => {
  const base = state("idle");
  return {
    ...base,
    localServer: { ...base.localServer, localModels, ...localServer },
  };
};
const installed = (run: ReturnType<typeof vi.fn>) =>
  run.mock.calls
    .map(([command]) => command as SetupCommand)
    .filter((command) => command.op === "local.start");
// What the computer has of each subscription runtime.
const row = (
  runtime: SetupRuntimeRow["runtime"],
  fields: Partial<SetupRuntimeRow> = {},
): SetupRuntimeRow => ({
  runtime,
  installed: false,
  signedIn: false,
  state: "idle",
  ...fields,
});
const rows = (
  claude: Partial<SetupRuntimeRow> = {},
  codex: Partial<SetupRuntimeRow> = {},
  pi: Partial<SetupRuntimeRow> = {},
) => [row("claude", claude), row("codex", codex), row("pi", pi)];
const card = (value: string) =>
  document.querySelector<HTMLButtonElement>(
    `.source-card[data-value="${value}"]`,
  )!;
const runtimeRow = (runtime: string) =>
  document.querySelector<HTMLElement>(
    `.choice.runtime[data-runtime="${runtime}"]`,
  )!;
const inRow = (runtime: string, selector: string) =>
  runtimeRow(runtime).querySelector<HTMLElement>(selector)!;
const stage = () =>
  document.querySelector<HTMLElement>('section[data-step="welcome"]')!.dataset
    .stage;
// Picks a source on step 1 and goes on to its settings.
const open = (value: string) => {
  card(value).click();
  $("source-continue").click();
};
const button = (id: string) => $(id) as HTMLButtonElement;
// The password a new installation was given, as Install sends it.
const GENERATED = /^[a-km-zA-HJ-NP-Z2-9]{5}(-[a-km-zA-HJ-NP-Z2-9]{5}){3}$/;

describe("setup page two-step welcome", () => {
  it("checks this computer first, then offers the three sources with the advice picked", async () => {
    const { run, push } = await openPage(
      welcome({ state: "checking" }),
      "welcome",
    );
    expect(stage()).toBe("checking");
    expect($("welcome-checking").hidden).toBe(false);
    expect($("checking-now").textContent).toBe("Checking this computer…");
    expect($("checking-why").textContent).toBe(
      "To see whether it can run a local model.",
    );
    expect($("local-setup").hidden).toBe(true);
    expect($("step-label").textContent).toBe("");
    // The runtime rows are read once, for step 2.
    expect(run).toHaveBeenCalledWith({ op: "local.runtimes.check" });
    // The first run downloads the localmodels tool before checking.
    push(
      welcome({
        state: "checking",
        download: { completed: 12 * 1024 ** 2, total: 69 * 1024 ** 2 },
      }),
    );
    expect($("checking-now").textContent).toBe("Downloading setup tools…");
    expect($("checking-why").textContent).toBe("12 MB of 69 MB · 57 MB left");
    push(welcome(capable));
    expect(stage()).toBe("choose");
    expect($("step-label").textContent).toBe("Step 1 of 2");
    expect($("welcome-checking").hidden).toBe(true);
    expect($("source-grid").hidden).toBe(false);
    expect($("source-panel").hidden).toBe(true);
    expect(card("local").getAttribute("aria-checked")).toBe("true");
    expect(card("local").tabIndex).toBe(0);
    expect(card("subscription").tabIndex).toBe(-1);
    expect(
      card("local").querySelector<HTMLElement>(".source-rec")!.hidden,
    ).toBe(false);
    expect(
      card("subscription").querySelector<HTMLElement>(".source-rec")!.hidden,
    ).toBe(true);
    expect($("source-local-meta").textContent).toBe("qwen3-8b · 6.0 GB");
    expect($("source-continue").hidden).toBe(false);
    expect($("local-install").hidden).toBe(true);
    expect($("plan-line").textContent).toBe("Nothing is installed yet.");
    expect(installed(run)).toEqual([]);
  });

  it("lets the person choose without waiting for a long check", async () => {
    await openPage(welcome({ state: "checking" }), "welcome");
    expect($("checking-skip").hidden).toBe(true);
    $("checking-skip").click();
    expect(stage()).toBe("choose");
    expect(card("local").disabled).toBe(true);
    expect($("source-local-pill").textContent).toBe("Checking");
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
  });

  it("installs the local model with Pi from its settings", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    expect(stage()).toBe("settings");
    expect($("step-label").textContent).toBe("Step 2 of 2");
    expect($("welcome-title").textContent).toBe("Local model");
    expect($("welcome-lead").textContent).toBe(
      "Runs your tasks on this computer with Pi · RTX 4090",
    );
    expect($("local-row").hidden).toBe(false);
    expect($("subscription-row").hidden).toBe(true);
    expect($("byok-row").hidden).toBe(true);
    expect($("local-model-name").textContent).toBe("qwen3-8b");
    // The whole stack's memory, so more than the model's own.
    expect($("local-model-needs").textContent).toBe(
      "6 GB download · 8 GB disk · 12 GB memory with its services",
    );
    // The local model is the source itself, so nothing else downloads.
    expect($("background-row").hidden).toBe(true);
    expect($("plan-line").textContent).toBe(
      "Installs Linger with Pi and qwen3-8b (6.0 GB). Setup waits for the model to download.",
    );
    expect(button("local-install").disabled).toBe(false);
    $("local-install").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    const [command] = installed(run);
    expect(command).toMatchObject({ op: "local.start", runtime: "local" });
    expect(command).not.toHaveProperty("background");
    if (command?.op !== "local.start") throw new Error("not local.start");
    expect(command.account?.email).toBe("owner@linger.local");
    expect(command.account?.password).toMatch(GENERATED);
  });

  it("goes back to the sources with Back or Escape, and on with Enter", async () => {
    await openPage(welcome(capable), "welcome");
    open("subscription");
    expect(stage()).toBe("settings");
    expect($("welcome-title").textContent).toBe("Subscription");
    $("source-back").click();
    expect(stage()).toBe("choose");
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
    card("subscription").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(card("local").getAttribute("aria-checked")).toBe("true");
    card("local").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(stage()).toBe("settings");
    expect($("welcome-title").textContent).toBe("Local model");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(stage()).toBe("choose");
  });

  it("recommends the subscription when a runtime is signed in already", async () => {
    await openPage(
      welcome(capable, {
        runtimes: rows({}, { installed: true, signedIn: true }),
      }),
      "welcome",
    );
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
    expect(
      card("subscription").querySelector<HTMLElement>(".source-rec")!.hidden,
    ).toBe(false);
    expect($("source-sub-meta").textContent).toBe("Signed in: Codex");
    // Never BYOK.
    expect(card("byok").querySelector<HTMLElement>(".source-rec")!.hidden).toBe(
      true,
    );
  });

  it("holds a local model that needs free memory and checks again on request", async () => {
    const { run } = await openPage(welcome(held), "welcome");
    expect(card("local").disabled).toBe(true);
    expect($("source-local-pill").textContent).toBe("On hold");
    expect($("source-local-pill").dataset.warn).toBe("true");
    expect($("source-local-meta").textContent).toBe(
      "On hold: close other programs, then Check again.",
    );
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
    expect($("plan-why").textContent).toBe(
      "Local model on hold: Not enough free memory. Close other apps.",
    );
    expect($("local-recheck").hidden).toBe(false);
    $("local-recheck").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "local.recheck" }),
    );
    // The held reason stays on step 1.
    $("source-continue").click();
    expect($("plan-why").hidden).toBe(true);
    expect($("local-recheck").hidden).toBe(true);
  });

  it("says how much memory a held local model needs and how much is free", async () => {
    const withCounts = (reasons: SetupReason[]): SetupLocalModelsCheck => ({
      ...held,
      freeMemory: {
        ramAvailableBytes: 2899102924,
        ramRequiredBytes: 13689304433,
        vramFreeBytes: 3 * GB,
        vramRequiredBytes: 9 * GB,
      },
      reasons,
    });
    // The GPU and the RAM each name what is free and what the install needs.
    await openPage(
      welcome(
        withCounts([
          reason({
            code: "gpu-memory-required",
            gpuIndex: 1,
            freeBytes: 3 * GB,
            requiredBytes: 9 * GB,
          }),
          reason({
            code: "free-memory-required",
            freeBytes: 2899102924,
            requiredBytes: 13689304433,
          }),
        ]),
      ),
      "welcome",
    );
    expect($("plan-why").textContent).toBe(
      "Local model on hold: Other programs are using GPU 1's memory (3.0 GB free, 9.0 GB needed). Close apps using the GPU. Not enough free memory (2.7 GB free, 12.7 GB needed). Close other apps.",
    );
    expect($("source-local-meta").textContent).toBe(
      "On hold: GPU 1 has 3.0 GB free, needs 9.0 GB",
    );
    expect(document.body.textContent).not.toContain(TOOL_WORDS);
    // A tool that counts only the plan's memory: the RAM counts from it.
    await openPage(
      welcome(withCounts([reason({ code: "free-memory-required" })])),
      "welcome",
    );
    expect($("source-local-meta").textContent).toBe(
      "On hold: 2.7 GB of memory free, needs 12.7 GB",
    );
  });

  it("holds local models without a plan for gateway-port-in-use and harness-unavailable and offers Check again", async () => {
    for (const [code, expectWhy, expectMeta] of [
      [
        "gateway-port-in-use",
        "Another program is using the local model gateway port.",
        "On hold: free the gateway port, then Check again.",
      ],
      [
        "harness-unavailable",
        "The Pi runtime required for local models isn't ready right now. Check your connection or permissions.",
        "On hold: prepare the Pi runtime, then Check again.",
      ],
    ] as const) {
      const blockedWithoutPlan: SetupLocalModelsCheck = {
        state: "checked",
        eligible: false,
        blockedNow: true,
        memoryBytes: 64 * GB,
        diskFreeBytes: 400 * GB,
        reasons: [reason({ code })],
        recommendation: "codex",
      };
      const { run } = await openPage(welcome(blockedWithoutPlan), "welcome");
      expect($("plan-why").textContent).toBe(
        `Local model on hold: ${expectWhy}`,
      );
      expect($("source-local-meta").textContent).toBe(expectMeta);
      expect(card("local").disabled).toBe(true);
      $("local-recheck").click();
      await vi.waitFor(() =>
        expect(run).toHaveBeenCalledWith({ op: "local.recheck" }),
      );
      expect(document.body.textContent).not.toContain(TOOL_WORDS);
    }
  });

  it("holds local models for blocked-now CUDA driver blockers without duplicating Check again", async () => {
    const blockedCuda: SetupLocalModelsCheck = {
      state: "checked",
      eligible: false,
      blockedNow: true,
      memoryBytes: 64 * GB,
      diskFreeBytes: 400 * GB,
      reasons: [
        reason({
          code: "cuda-driver-update-required",
          detectedCudaVersion: "12.1",
          requiredCudaVersion: "12.4",
          driverVersion: "535.98",
        }),
      ],
      recommendation: "codex",
    };
    const { run } = await openPage(welcome(blockedCuda), "welcome");
    expect($("plan-why").textContent).toBe(
      "Local model on hold: Your NVIDIA driver supports CUDA 12.1, but local models require NVIDIA driver 550+ (CUDA 12.4). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
    );
    expect(
      $("plan-why").textContent?.match(/choose Check again/g),
    ).toHaveLength(1);
    expect($("source-local-meta").textContent).toBe(
      "On hold: update your NVIDIA driver, then Check again.",
    );
    expect($("local-recheck").hidden).toBe(false);
    expect($("local-driver-action").hidden).toBe(false);
    expect($("local-driver-action").textContent).toBe("Download NVIDIA driver");
    expect($("local-driver-guide").hidden).toBe(false);
    $("local-driver-action").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "external.open",
        url: NVIDIA_DRIVER_DOWNLOAD_URL,
      }),
    );
    $("local-driver-guide").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "external.open",
        url: NVIDIA_DRIVER_GUIDE_URL,
      }),
    );
    $("local-recheck").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "local.recheck" }),
    );
    expect(document.body.textContent).not.toContain(TOOL_WORDS);
  });

  it("words every localmodels reason by its code, never the tool's message", async () => {
    const cases: [SetupLocalModelsCheck, string][] = [
      [
        { ...held, reasons: [reason({ code: "gpu-sharing-required" })] },
        "Local model on hold: Another app is using the GPU.",
      ],
      [
        { ...held, reasons: [reason({ code: "plan-unavailable" })] },
        "Local model on hold: Another app is using the memory it needs. Quit it.",
      ],
      [
        { ...small, reasons: [reason({ code: "gpu-ownership-unknown" })] },
        "Couldn't check which apps are using the GPU. Close GPU apps.",
      ],
      [
        { ...small, reasons: [reason({ code: "facts-unavailable" })] },
        "Linger couldn't read this computer's memory, disk or GPU.",
      ],
      [
        {
          ...small,
          reasons: [
            reason({
              code: "cuda-driver-update-required",
              detectedCudaVersion: "12.1",
              requiredCudaVersion: "12.4",
              driverVersion: "535.98",
            }),
          ],
        },
        "Your NVIDIA driver supports CUDA 12.1, but local models require NVIDIA driver 550+ (CUDA 12.4). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
      ],
      [
        {
          ...small,
          reasons: [
            reason({
              code: "cuda-driver-update-required",
              detectedCudaVersion: "11.4",
              requiredCudaVersion: "11.8",
            }),
          ],
        },
        "Your NVIDIA driver supports CUDA 11.4, but local models require CUDA 11.8 or newer. Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
      ],
      [
        {
          ...small,
          reasons: [
            reason({
              code: "cuda-driver-update-required",
              requiredCudaVersion: "12.4",
            }),
          ],
        },
        "Your NVIDIA driver is too old for local models (requires NVIDIA driver 550+ / CUDA 12.4). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
      ],
      [
        {
          ...small,
          reasons: [
            reason({
              code: "cuda-driver-update-required",
              requiredCudaVersion: "11.8",
            }),
          ],
        },
        "Your NVIDIA driver is too old for local models (requires CUDA 11.8 or newer). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
      ],
      [
        {
          ...small,
          reasons: [
            reason({
              code: "cuda-driver-version-unknown",
              requiredCudaVersion: "12.4",
            }),
          ],
        },
        "Linger couldn't read the CUDA version from your NVIDIA driver (requires CUDA 12.4 or newer). Update or reinstall your NVIDIA driver, then choose Check again.",
      ],
      [
        {
          ...small,
          reasons: [reason({ code: "cuda-driver-version-unknown" })],
        },
        "Linger couldn't read the CUDA version from your NVIDIA driver. Update or reinstall your NVIDIA driver, then choose Check again.",
      ],
      [
        { ...small, reasons: [reason({ code: "unsupported-platform" })] },
        "Local models don't run on this system.",
      ],
      [
        { ...small, reasons: [reason({ code: "a-new-code" })] },
        "This computer can't run a local model now.",
      ],
    ];
    for (const [check, words] of cases) {
      await openPage(welcome(check), "welcome");
      expect($("plan-why").textContent).toContain(words);
      expect(document.body.textContent).not.toContain(TOOL_WORDS);
    }
  });

  it("shows the Local model card disabled with the reason when none can run", async () => {
    await openPage(welcome(small), "welcome");
    expect(card("local").disabled).toBe(true);
    expect($("source-local-pill").textContent).toBe("Unavailable");
    expect($("source-local-meta").textContent).toBe(
      "Not available on this computer",
    );
    expect($("plan-why").textContent).toBe(
      "No local model fits this computer.",
    );
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
    await openPage(welcome({ state: "unavailable" }), "welcome");
    expect($("plan-why").textContent).toBe(
      "Couldn't check this computer for a local model.",
    );
    expect(card("local").disabled).toBe(true);
  });

  it("offers Open NVIDIA App on Windows when detected and names the required driver branch", async () => {
    const winState: SetupState = {
      ...welcome({
        ...small,
        blockedNow: true,
        reasons: [
          reason({
            code: "cuda-driver-update-required",
            detectedCudaVersion: "12.8",
            requiredCudaVersion: "13.0",
            driverVersion: "572.83",
          }),
        ],
        recommendation: "codex",
      }),
      platform: "win32",
      driverUpdate: { nvidiaApp: "nvidia_app" },
    };
    const { run } = await openPage(winState, "welcome");
    expect($("plan-why").textContent).toContain(
      "NVIDIA driver 580+ (CUDA 13.0)",
    );
    expect($("local-driver-action").hidden).toBe(false);
    expect($("local-driver-action").textContent).toBe("Open NVIDIA App");
    $("local-driver-action").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "driver.open-nvidia-app" }),
    );
  });

  it("keeps the location and app keys behind More options", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    expect($("local-customize").hidden).toBe(false);
    expect($("local-options").hidden).toBe(true);
    $("local-customize").click();
    expect($("local-customize").textContent).toBe("Hide options");
    expect($("local-options").hidden).toBe(false);
    expect($("source-panel").hidden).toBe(true);
    expect($("location-sub").textContent).toBe("~/.simplexai");
    const key = $("key-composio") as HTMLInputElement;
    key.value = "cmp-secret";
    key.dispatchEvent(new Event("input"));
    $("local-install").click();
    await vi.waitFor(() => expect(key.value).toBe(""));
    expect(installed(run)[0]).toMatchObject({
      runtime: "local",
      keys: { composio: "cmp-secret" },
    });
  });

  it("holds Install on a location without room and offers the defaults", async () => {
    const base = welcome(capable);
    const { run } = await openPage(
      {
        ...base,
        localServer: {
          ...base.localServer,
          location: {
            path: "D:\\Linger",
            custom: true,
            error: "Not enough free space on this drive.",
          },
        },
      },
      "welcome",
    );
    $("source-continue").click();
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    $("local-customize").click();
    expect($("location-sub").textContent).toBe(
      "Not enough free space on this drive.",
    );
    expect($("location-reset").hidden).toBe(false);
    $("location-reset").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "local.location.reset" }),
    );
  });
});

describe("setup page subscription runtimes", () => {
  it("enables Install only once Claude Code or Codex is signed in", async () => {
    const { run, push } = await openPage(
      welcome(small, { runtimes: rows({}, {}, {}) }),
      "welcome",
    );
    open("subscription");
    expect($("welcome-lead").textContent).toBe(
      "Sign in to Claude Code or Codex with your plan. One is enough.",
    );
    expect(inRow("claude", "[data-runtime-sub]").textContent).toBe(
      "Not installed · Uses your Claude plan",
    );
    expect(inRow("codex", "[data-runtime-sub]").textContent).toBe(
      "Not installed · Uses your ChatGPT plan",
    );
    expect(inRow("pi", "[data-runtime-sub]").textContent).toBe(
      "Not installed · Optional, runs BYOK and local models",
    );
    expect(inRow("claude", "[data-runtime-install]").hidden).toBe(false);
    expect(inRow("claude", "[data-runtime-signin]").hidden).toBe(true);
    expect(button("local-install").disabled).toBe(true);
    expect($("plan-line").textContent).toBe(
      "Sign in to Claude Code or Codex to install. Pi is optional.",
    );
    // Pi alone is not enough.
    push(welcome(small, { runtimes: rows({}, {}, { installed: true }) }));
    expect(inRow("pi", "[data-runtime-done]").hidden).toBe(false);
    expect(inRow("pi", "[data-runtime-done]").textContent).toBe("Installed");
    expect(button("local-install").disabled).toBe(true);
    // Installed but not signed in: Sign in.
    push(
      welcome(small, {
        runtimes: rows({ installed: true, version: "2.1.0" }, {}, {}),
      }),
    );
    expect(inRow("claude", "[data-runtime-sub]").textContent).toBe(
      "Installed · Sign in with your Claude plan · 2.1.0",
    );
    expect(inRow("claude", "[data-runtime-signin]").hidden).toBe(false);
    expect(button("local-install").disabled).toBe(true);
    push(
      welcome(small, {
        runtimes: rows({ installed: true, signedIn: true }, {}, {}),
      }),
    );
    expect(inRow("claude", "[data-runtime-done]").textContent).toBe(
      "Signed in",
    );
    expect(button("local-install").disabled).toBe(false);
    expect($("plan-line").textContent).toBe(
      "Installs Linger with Claude Code.",
    );
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)[0]).toMatchObject({
        op: "local.start",
        runtime: "subscription",
      }),
    );
  });

  it("installs a runtime with progress and can cancel it", async () => {
    const { run, push } = await openPage(
      welcome(small, { runtimes: rows() }),
      "welcome",
    );
    open("subscription");
    inRow("codex", "[data-runtime-install]").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.runtime.install",
        runtime: "codex",
      }),
    );
    push(
      welcome(small, {
        runtimes: rows(
          {},
          { state: "installing", install: { completed: 40, total: 100 } },
        ),
      }),
    );
    const progress = inRow("codex", ".runtime-progress");
    expect(progress.hidden).toBe(false);
    expect(progress.getAttribute("aria-valuenow")).toBe("40");
    expect(progress.querySelector(".pct")!.textContent).toBe("40%");
    expect(progress.getAttribute("aria-label")).toBe("Installing Codex");
    expect(inRow("codex", "[data-runtime-install]").hidden).toBe(true);
    expect(inRow("codex", "[data-runtime-sub]").textContent).toBe(
      "Installing…",
    );
    // One at a time: Install waits for it.
    expect(button("local-install").disabled).toBe(true);
    expect($("plan-line").textContent).toBe("Waiting for Codex…");
    inRow("codex", "[data-runtime-cancel]").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.runtime.cancel",
        runtime: "codex",
      }),
    );
    // A failed install says so and offers Try again.
    push(
      welcome(small, {
        runtimes: rows({}, { failed: "install", message: "npm exited 1" }),
      }),
    );
    expect(inRow("codex", "[data-runtime-sub]").textContent).toBe(
      "npm exited 1",
    );
    expect(inRow("codex", "[data-runtime-sub]").dataset.warn).toBe("true");
    expect(inRow("codex", "[data-runtime-install]").textContent).toBe(
      "Try Again",
    );
  });

  it("signs in in the browser, with the link, code and cancel at hand", async () => {
    const { run, push } = await openPage(
      welcome(small, {
        runtimes: rows({ installed: true }, { installed: true }),
      }),
      "welcome",
    );
    open("subscription");
    inRow("claude", "[data-runtime-signin]").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.runtime.signin",
        runtime: "claude",
      }),
    );
    push(
      welcome(small, {
        runtimes: rows(
          {
            installed: true,
            state: "signing_in",
            signIn: { url: "https://claude.ai/oauth", acceptsCode: true },
          },
          { installed: true },
        ),
      }),
    );
    expect(inRow("claude", "[data-runtime-sub]").textContent).toBe(
      "Signing in with your Claude plan…",
    );
    expect(inRow("claude", ".runtime-wait").hidden).toBe(false);
    expect(inRow("claude", "[data-runtime-cancel]").hidden).toBe(false);
    expect(inRow("claude", "[data-runtime-extra]").hidden).toBe(false);
    expect(inRow("claude", "[data-runtime-paste]").hidden).toBe(false);
    inRow("claude", "[data-runtime-open]").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.runtime.open",
        runtime: "claude",
      }),
    );
    inRow("claude", '[data-runtime-copy="url"]').click();
    await vi.waitFor(() =>
      expect(inRow("claude", '[data-runtime-copy="url"]').textContent).toBe(
        "Copied",
      ),
    );
    expect(run).toHaveBeenCalledWith({
      op: "local.runtime.copy",
      runtime: "claude",
      what: "url",
    });
    const input = inRow("claude", "[data-runtime-input]") as HTMLInputElement;
    input.value = " code-from-page ";
    inRow("claude", "[data-runtime-paste]").dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.runtime.code",
        runtime: "claude",
        code: "code-from-page",
      }),
    );
    expect(input.value).toBe("");
    // Codex: a device code for another device.
    inRow("codex", "[data-runtime-signin]").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.runtime.signin",
        runtime: "codex",
      }),
    );
    // One command at a time: the next waits for this one's reply.
    await new Promise((resolve) => setTimeout(resolve, 0));
    push(
      welcome(small, {
        runtimes: rows(
          { installed: true },
          {
            installed: true,
            state: "signing_in",
            signIn: { url: "https://auth.openai.com/codex/device" },
          },
        ),
      }),
    );
    inRow("codex", "[data-runtime-device]").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.runtime.signin",
        runtime: "codex",
        device: true,
      }),
    );
    push(
      welcome(small, {
        runtimes: rows(
          { installed: true },
          {
            installed: true,
            state: "signing_in",
            signIn: {
              url: "https://auth.openai.com/codex/device",
              deviceCode: "ABCD-1234",
            },
          },
        ),
      }),
    );
    expect(inRow("codex", "[data-runtime-code]").hidden).toBe(false);
    expect(inRow("codex", "[data-runtime-code-value]").textContent).toBe(
      "ABCD-1234",
    );
    expect(inRow("codex", "[data-runtime-device]").hidden).toBe(true);
    inRow("codex", "[data-runtime-cancel]").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.runtime.cancel",
        runtime: "codex",
      }),
    );
  });

  it("sets up both when both are signed in, Codex first", async () => {
    const { run } = await openPage(
      welcome(small, {
        runtimes: rows(
          { installed: true, signedIn: true },
          { installed: true, signedIn: true },
          {},
        ),
      }),
      "welcome",
    );
    open("subscription");
    expect(inRow("codex", ".runtime-rec").hidden).toBe(false);
    expect(inRow("claude", ".runtime-rec").hidden).toBe(true);
    expect($("plan-line").textContent).toBe(
      "Installs Linger with Codex; Claude Code is set up too.",
    );
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)[0]).toMatchObject({ runtime: "subscription" }),
    );
  });

  it("also downloads the local model in the background when asked", async () => {
    const { run } = await openPage(
      welcome(capable, {
        runtimes: rows({}, { installed: true, signedIn: true }),
      }),
      "welcome",
    );
    open("subscription");
    expect($("background-row").hidden).toBe(false);
    const box = $("background-model") as HTMLInputElement;
    // Off unless chosen.
    expect(box.checked).toBe(false);
    expect($("background-model-detail").textContent).toBe(
      "qwen3-8b · 6.0 GB. Switch to it from Settings when it's done.",
    );
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect($("plan-line").textContent).toBe(
      "Installs Linger with Codex. Also downloads qwen3-8b in the background.",
    );
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)[0]).toMatchObject({
        runtime: "subscription",
        background: true,
      }),
    );
  });
});

describe("setup page BYOK", () => {
  // Types into a field as a person does.
  const type = (id: string, value: string) => {
    const input = $(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };
  const pick = (comboId: string, value: string) => {
    (
      $(comboId).parentElement!.querySelector(".cb-caret") as HTMLButtonElement
    ).click();
    $(`${comboId}-menu`)
      .querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!
      .click();
  };
  const words = (id: string) => $(id).textContent!.replace(/\s+/g, " ").trim();
  const withLocal = (
    base: SetupState,
    localServer: Partial<SetupState["localServer"]>,
  ): SetupState => ({
    ...base,
    localServer: { ...base.localServer, ...localServer },
  });

  it("runs on Pi, builds the request address and scrubs the key, with the local model in the background", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    open("byok");
    expect($("welcome-title").textContent).toBe("BYOK");
    expect($("welcome-lead").textContent).toBe(
      "Runs your tasks on Pi with your own API key.",
    );
    expect($("byok-row").hidden).toBe(false);
    expect($("local-row").hidden).toBe(true);
    expect($("subscription-row").hidden).toBe(true);
    expect(button("local-install").disabled).toBe(true);
    // Grey defaults: /v1, and Pi's own endpoint.
    const path = $("byok-path") as HTMLInputElement;
    const endpoint = $("byok-endpoint") as HTMLInputElement;
    expect(path.value).toBe("/v1");
    expect(endpoint.value).toBe("/chat/completions");
    expect(path.parentElement!.dataset.default).toBe("true");
    expect($("byok-status").textContent).toBe(
      "Grey values are defaults. Path and endpoint are optional.",
    );
    type("byok-url", "https://open.bigmodel.cn/");
    pick("byok-path", "/api/paas/v4");
    expect(path.value).toBe("/api/paas/v4");
    expect(path.parentElement!.dataset.default).toBe("false");
    expect($("byok-status").textContent).toBe(
      "Sends OpenAI Chat Completions requests to https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
    type("byok-key", "sk-top-secret");

    // Refresh lists the endpoint's models and opens them.
    expect(button("byok-test").disabled).toBe(true);
    run.mockImplementationOnce(async () =>
      withLocal(welcome(capable), {
        byokModels: {
          state: "ready",
          url: "https://open.bigmodel.cn/api/paas/v4/models",
          models: [
            { id: "glm-4.6", contextWindow: 204_800 },
            { id: "glm-4.5-air" },
          ],
        },
      }),
    );
    $("byok-list").click();
    const endpointOf = {
      baseUrl: "https://open.bigmodel.cn",
      path: "/api/paas/v4",
      endpoint: "/chat/completions",
      protocol: "openai-chat",
      apiKey: "sk-top-secret",
    };
    expect(run).toHaveBeenCalledWith({
      op: "local.byok.models",
      byok: endpointOf,
    });
    await vi.waitFor(() => expect($("byok-model-menu").hidden).toBe(false));
    expect(words("byok-model-menu")).toContain(
      "2 models from https://open.bigmodel.cn/api/paas/v4/models",
    );
    expect(words("byok-model-menu")).toContain("glm-4.6 200k context");
    $("byok-model-menu")
      .querySelector<HTMLButtonElement>('[data-value="glm-4.6"]')!
      .click();
    expect(($("byok-model") as HTMLInputElement).value).toBe("glm-4.6");
    expect(button("local-install").disabled).toBe(false);
    expect($("plan-line").textContent).toBe(
      "Installs Linger with Pi on your API key.",
    );

    // Test sends one request and floats the outcome under the button.
    run.mockImplementationOnce(async () =>
      withLocal(welcome(capable), {
        byokCheck: {
          state: "ready",
          protocol: "openai-chat",
          url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
          modelId: "glm-4.6",
          contextWindow: 204_800,
        },
      }),
    );
    $("byok-test").click();
    const config = { ...endpointOf, modelId: "glm-4.6", runtime: "pi" };
    expect(run).toHaveBeenCalledWith({ op: "local.byok.check", byok: config });
    await vi.waitFor(() => expect($("byok-toast").hidden).toBe(false));
    expect($("byok-toast").dataset.tone).toBe("ok");
    expect(words("byok-toast")).toBe(
      "Connected glm-4.6 · 200k context · OpenAI Chat Completionshttps://open.bigmodel.cn/api/paas/v4/chat/completions",
    );

    // The local model comes along when asked.
    const box = $("background-model") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    $("local-install").click();
    await vi.waitFor(() => {
      expect(installed(run)).toHaveLength(1);
      expect(($("byok-key") as HTMLInputElement).value).toBe("");
    });
    expect(installed(run)[0]).toMatchObject({
      op: "local.start",
      runtime: "pi",
      byok: config,
      background: true,
    });
  });

  it("sends a pasted full address as is, and keeps a failed test until the fields change", async () => {
    const { run } = await openPage(welcome(small), "welcome");
    open("byok");
    type("byok-url", "https://llm.example.com/gateway");
    pick("byok-path", "");
    pick("byok-endpoint", "");
    expect(($("byok-path") as HTMLInputElement).value).toBe("");
    // No known ending: Pi's own format.
    expect($("byok-status").textContent).toBe(
      "Sends OpenAI Chat Completions (the Pi format) requests to https://llm.example.com/gateway",
    );
    type("byok-path", "a//b");
    expect($("byok-status").dataset.tone).toBe("err");
    expect(button("byok-list").disabled).toBe(true);
    type("byok-path", "");
    type("byok-model", "glm-4.6");

    run.mockImplementationOnce(async () =>
      withLocal(welcome(small), {
        byokCheck: {
          state: "failed",
          message:
            "Nothing answered at https://llm.example.com/gateway (HTTP 404).",
        },
      }),
    );
    $("byok-test").click();
    expect(run).toHaveBeenCalledWith({
      op: "local.byok.check",
      byok: {
        baseUrl: "https://llm.example.com/gateway",
        path: "",
        endpoint: "",
        protocol: "openai-chat",
        modelId: "glm-4.6",
        runtime: "pi",
      },
    });
    await vi.waitFor(() => expect($("byok-toast").hidden).toBe(false));
    expect($("byok-toast").dataset.tone).toBe("err");
    expect(words("byok-toast")).toBe(
      "Couldn't connect Nothing answered at https://llm.example.com/gateway (HTTP 404).",
    );
    type("byok-model", "glm-4.5-air");
    expect($("byok-toast").hidden).toBe(true);
  });

  it("offers the same BYOK fields inside the runtime sign-in dialog", async () => {
    const base = state("installing");
    const { run } = await openPage({
      ...base,
      localServer: {
        ...base.localServer,
        steps: ["prepare", "services", "signin", "connect", "agents"],
        step: "signin",
        signIn: { runtime: "claude", state: "required" },
      },
    });
    expect($("runtime-signin").hidden).toBe(false);
    expect($("runtime-signin-byok").hidden).toBe(true);
    $("runtime-signin-byok-toggle").click();
    expect($("runtime-signin-byok").hidden).toBe(false);
    expect(($("signin-byok-endpoint") as HTMLInputElement).value).toBe(
      "/messages",
    );
    type("signin-byok-url", "https://api.anthropic.com");
    type("signin-byok-key", "sk-ant-fallback");
    type("signin-byok-model", "claude-sonnet-4-6");
    $("runtime-signin-byok").dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "local.signin.byok",
        byok: {
          runtime: "claude",
          baseUrl: "https://api.anthropic.com",
          path: "/v1",
          endpoint: "/messages",
          protocol: "anthropic",
          apiKey: "sk-ant-fallback",
          modelId: "claude-sonnet-4-6",
        },
      }),
    );
    expect(($("signin-byok-key") as HTMLInputElement).value).toBe("");
  });
});

describe("setup page leaving the local model's wait", () => {
  const downloading = (): SetupState => {
    const base = state("installing");
    return {
      ...base,
      localServer: {
        ...base.localServer,
        source: "local",
        localModels: capable,
        transfer: {
          label: "Downloading the local model…",
          completed: 2 * GB,
          total: 6 * GB,
        },
      },
    };
  };

  it("offers another source while the model downloads, and keeps the model coming", async () => {
    const { run, push } = await openPage(downloading());
    expect($("local-model-leave").hidden).toBe(false);
    // Not without a download under way.
    push(state("installing"));
    expect($("local-model-leave").hidden).toBe(true);
    push(downloading());
    const behind = welcome(capable, {
      runtimes: rows({}, { installed: true, signedIn: true }),
      backgroundModel: {
        model: "qwen3-8b",
        state: "downloading",
        completed: 42,
        total: 100,
      },
    });
    run.mockImplementationOnce(async () => behind);
    document
      .querySelector<HTMLButtonElement>('[data-leave="subscription"]')!
      .click();
    await vi.waitFor(() =>
      expect(
        document.querySelector('section[data-step="welcome"].active'),
      ).not.toBeNull(),
    );
    expect(run).toHaveBeenCalledWith({ op: "local.leave-local" });
    expect(stage()).toBe("settings");
    expect($("welcome-title").textContent).toBe("Subscription");
    expect($("model-behind").hidden).toBe(false);
    expect($("model-behind-text").textContent).toBe(
      "Local model 42% · ready when done",
    );
    expect($("welcome-eyebrow").hidden).toBe(true);
    expect($("local-install-label").textContent).toBe("Continue setup");
    expect($("plan-line").textContent).toBe(
      "Installs Linger with Codex. The local model keeps downloading.",
    );
    // The model is not offered again while it downloads.
    expect($("background-row").hidden).toBe(true);
    $("source-back").click();
    expect(card("local").disabled).toBe(true);
    expect($("source-local-pill").textContent).toBe("Downloading");
    expect($("source-local-meta").textContent).toBe("In the background · 42%");
    open("subscription");
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)[0]).toMatchObject({ runtime: "subscription" }),
    );
    expect(installed(run)[0]).not.toHaveProperty("background");
  });

  it("says where a failed switch went wrong", async () => {
    const { run } = await openPage(downloading());
    run.mockRejectedValueOnce(new Error("The installer stopped answering."));
    document.querySelector<HTMLButtonElement>('[data-leave="byok"]')!.click();
    await vi.waitFor(() =>
      expect($("leave-error").textContent).toBe(
        "The installer stopped answering.",
      ),
    );
    expect(
      document.querySelector('section[data-step="installing"].active'),
    ).not.toBeNull();
  });

  it("says the model keeps downloading while installing and when ready", async () => {
    const base = state("installing");
    const { push } = await openPage({
      ...base,
      localServer: {
        ...base.localServer,
        backgroundModel: {
          model: "qwen3-8b",
          state: "downloading",
          completed: 1,
          total: 2,
        },
      },
    });
    expect($("installing-plan").textContent).toBe(
      "This takes a few minutes. The local model keeps downloading in the background.",
    );
    const ready = state("ready", { email: "owner@linger.local" });
    push({
      ...ready,
      localServer: {
        ...ready.localServer,
        backgroundModel: {
          model: "qwen3-8b",
          state: "downloading",
          completed: 1,
          total: 2,
        },
      },
    });
    expect($("ready-lead").textContent).toBe(
      "Running on this computer. The local model is ready when its download finishes.",
    );
  });
});

describe("setup page sign-in account", () => {
  const typeIn = (id: string, value: string) => {
    const input = $(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };
  const submit = () =>
    $("credentials-form").dispatchEvent(
      new Event("submit", { cancelable: true }),
    );

  it("offers a generated sign-in that can be changed, checked like the server checks it", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    expect($("credentials-row").hidden).toBe(false);
    expect($("credentials-sub").textContent).toBe(
      "owner@linger.local · generated password",
    );
    expect($("credentials-sheet").hidden).toBe(true);
    $("credentials-edit").click();
    expect($("credentials-sheet").hidden).toBe(false);
    const email = $("credentials-email") as HTMLInputElement;
    const password = $("credentials-password") as HTMLInputElement;
    const confirm = $("credentials-confirm") as HTMLInputElement;
    expect(email.value).toBe("owner@linger.local");
    expect(password.value).toMatch(GENERATED);
    expect(confirm.value).toBe(password.value);
    expect(password.type).toBe("password");
    $("credentials-show").click();
    expect(password.type).toBe("text");
    expect(confirm.type).toBe("text");
    expect($("credentials-show").textContent).toBe("Hide");
    $("credentials-show").click();
    expect(password.type).toBe("password");

    for (const [field, value, problem, invalid] of [
      [
        "credentials-email",
        "not an email",
        "Enter an email address like name@example.com.",
        "credentials-email",
      ],
      [
        "credentials-email",
        "a".repeat(101) + "@example.com",
        "This email address is too long.",
        "credentials-email",
      ],
      [
        "credentials-email",
        "Me@Example.com ",
        "Use at least 8 characters.",
        "credentials-password",
      ],
    ] as const) {
      typeIn(field, value);
      if (problem === "Use at least 8 characters.") {
        typeIn("credentials-password", "short");
        typeIn("credentials-confirm", "short");
      }
      submit();
      expect($("credentials-error").textContent).toBe(problem);
      expect($(invalid).getAttribute("aria-invalid")).toBe("true");
      expect($("credentials-sheet").hidden).toBe(false);
    }
    typeIn("credentials-password", "x".repeat(257));
    typeIn("credentials-confirm", "x".repeat(257));
    submit();
    expect($("credentials-error").textContent).toBe(
      "Use at most 256 characters.",
    );
    typeIn("credentials-password", "tab\there-is-bad");
    typeIn("credentials-confirm", "tab\there-is-bad");
    submit();
    expect($("credentials-error").textContent).toBe(
      "The password can't contain control characters.",
    );
    typeIn("credentials-password", "a-long-password");
    typeIn("credentials-confirm", "a-long-passw0rd");
    submit();
    expect($("credentials-error").textContent).toBe(
      "The passwords don't match.",
    );
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    typeIn("credentials-confirm", "a-long-password");
    // A problem fixed clears as the person types.
    expect($("credentials-error").textContent).toBe("");
    submit();
    expect($("credentials-sheet").hidden).toBe(true);
    expect($("credentials-sub").textContent).toBe(
      "me@example.com · your password",
    );
    // The page never prints the password.
    expect(document.body.textContent).not.toContain("a-long-password");
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)[0]).toMatchObject({
        runtime: "local",
        account: { email: "me@example.com", password: "a-long-password" },
      }),
    );
  });

  it("generates a new password into both fields, and Cancel keeps the old one", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    $("credentials-edit").click();
    const password = $("credentials-password") as HTMLInputElement;
    const before = password.value;
    $("credentials-generate").click();
    expect(password.value).toMatch(GENERATED);
    expect(password.value).not.toBe(before);
    expect(($("credentials-confirm") as HTMLInputElement).value).toBe(
      password.value,
    );
    // Generated shows, so it can be read off.
    expect(password.type).toBe("text");
    $("credentials-cancel").click();
    expect($("credentials-sheet").hidden).toBe(true);
    $("local-install").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    const [command] = installed(run);
    if (command?.op !== "local.start") throw new Error("not local.start");
    expect(command.account?.password).toBe(before);
  });

  it("still calls a password generated in the sheet generated, until it is changed", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    $("credentials-edit").click();
    typeIn("credentials-password", "a-long-password");
    typeIn("credentials-confirm", "a-long-password");
    $("credentials-generate").click();
    const generated = ($("credentials-password") as HTMLInputElement).value;
    submit();
    expect($("credentials-sub").textContent).toBe(
      "owner@linger.local · generated password",
    );
    $("credentials-edit").click();
    typeIn("credentials-password", `${generated}x`);
    typeIn("credentials-confirm", `${generated}x`);
    submit();
    expect($("credentials-sub").textContent).toBe(
      "owner@linger.local · your password",
    );
    $("local-install").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    const [command] = installed(run);
    if (command?.op !== "local.start") throw new Error("not local.start");
    expect(command.account?.password).toBe(`${generated}x`);
  });

  it("leaves an existing installation's sign-in as it is", async () => {
    const { run } = await openPage(
      welcome(capable, { ownerAccount: "existing" }),
      "welcome",
    );
    $("source-continue").click();
    expect($("credentials-row").hidden).toBe(true);
    $("local-install").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    expect(installed(run)[0]).not.toHaveProperty("account");
  });

  it("sends the sign-in again on Try Again until the installation has it", async () => {
    const { run, push } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    $("local-install").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    const failed = (ownerAccount: "new" | "existing"): SetupState => {
      const base = state("failed");
      return {
        ...base,
        localServer: {
          ...base.localServer,
          localModels: capable,
          source: "local",
          ownerAccount,
        },
      };
    };
    push(failed("new"));
    run.mockClear();
    $("local-retry").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    expect(installed(run)[0]).toMatchObject({
      runtime: "local",
      account: { email: "owner@linger.local" },
    });
    push(failed("existing"));
    run.mockClear();
    $("local-retry").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    expect(installed(run)[0]).not.toHaveProperty("account");
  });
});

describe("setup page permissions", () => {
  it("names the menu bar on macOS and the system tray elsewhere", async () => {
    const permissions = () =>
      document.querySelector('[data-step="permissions"]')!.textContent!;
    for (const [platform, place] of [
      ["darwin", "menu bar"],
      ["win32", "system tray"],
      ["linux", "system tray"],
    ] as const) {
      await openPage({ ...welcome(capable), platform }, "welcome");
      const words = permissions().replace(/\s+/g, " ");
      expect(words).toContain(`Change these later from the ${place} or`);
      expect(words).toContain(`Start in the ${place} when you log in.`);
      if (platform !== "darwin") expect(words).not.toContain("menu bar");
    }
  });
});

describe("setup page download progress", () => {
  const installing = (transfer?: SetupState["localServer"]["transfer"]) => {
    const base = state("installing");
    return {
      ...base,
      localServer: { ...base.localServer, ...(transfer ? { transfer } : {}) },
    };
  };

  it("shows how much of the local model is left, the rate and the time", async () => {
    const { push } = await openPage(installing());
    expect($("installing-transfer").hidden).toBe(true);
    push(
      installing({
        label: "Downloading the local model…",
        completed: 12 * GB,
        total: 31 * GB,
        bytesPerSecond: 50 * 1024 ** 2,
      }),
    );
    expect($("installing-transfer").hidden).toBe(false);
    expect($("installing-transfer-label").textContent).toBe(
      "Downloading the local model…",
    );
    expect($("installing-transfer-bytes").textContent).toBe(
      "12.0 GB of 31.0 GB · 19.0 GB left · 50 MB/s · about 6 min left",
    );
    push(installing());
    expect($("installing-transfer").hidden).toBe(true);
  });

  it("says only the file's bytes when the tool counts one file", async () => {
    await openPage(
      installing({
        label: "Downloading the local model…",
        completed: 3 * GB,
        total: 4 * GB,
        bytesPerSecond: 50 * 1024 ** 2,
        partial: true,
      }),
    );
    expect($("installing-transfer-bytes").textContent).toBe(
      "This file: 3.0 GB of 4.0 GB · 50 MB/s",
    );
  });
});

describe("setup page slow runtime lookup", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });
  const withLocal = (
    phase: SetupState["localServer"]["phase"],
    fields: Partial<SetupState["localServer"]>,
  ): SetupState => {
    const base = state(phase);
    return { ...base, localServer: { ...base.localServer, ...fields } };
  };

  it("says what the bar waits on while the installer checks the runtime", async () => {
    const { push } = await openPage(withLocal("installing", {}));
    expect($("installing-waiting").hidden).toBe(true);
    push(withLocal("installing", { waiting: "runtime" }));
    expect($("installing-waiting").hidden).toBe(false);
    expect($("installing-waiting").textContent).toBe(
      "Checking the AI runtime on this computer. On some computers this takes a few minutes; the bar moves on once it finishes.",
    );
    push(withLocal("installing", {}));
    expect($("installing-waiting").hidden).toBe(true);
  });

  it("words a runtime lookup that did not finish, with Try Again", async () => {
    await openPage(
      withLocal("failed", {
        message:
          "Checking the AI runtime on this computer did not finish in time.",
        failure: "runtime_lookup_timed_out",
      }),
    );
    expect($("installing-waiting").hidden).toBe(true);
    expect($("installing-error").textContent).toBe(
      "Checking the AI runtime did not finish in 10 minutes. Try Again picks up the same check; if it stops again, save diagnostics and send them to Linger support.",
    );
    expect($("installing-actions").hidden).toBe(false);
    expect($("local-retry").hidden).toBe(false);
  });

  it("words both in Chinese", async () => {
    const { push } = await openPage(
      withLocal("installing", { waiting: "runtime" }),
      "installing",
      "zh-CN",
    );
    expect($("installing-waiting").textContent).toBe(zhCN.setup.waitingRuntime);
    push(
      withLocal("failed", {
        message: "Lost the connection to the installer.",
        failure: "runtime_lookup_unreachable",
      }),
    );
    expect($("installing-error").textContent).toBe(
      zhCN.setup.runtimeLookupUnreachable,
    );
  });
});

describe("setup page Send Diagnostics", () => {
  // A failure scrolls its actions into view, which jsdom lacks.
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  const failed = (
    diagnosticsSend?: SetupState["diagnosticsSend"],
  ): SetupState => {
    const base = state("failed");
    return {
      ...base,
      localServer: { ...base.localServer, message: "Services did not start" },
      ...(diagnosticsSend ? { diagnosticsSend } : {}),
    };
  };

  it("hides Send Diagnostics while no receiver is set up", async () => {
    await openPage(failed());
    expect($("installing-diagnostics").hidden).toBe(false);
    expect($("send-diagnostics").hidden).toBe(true);
    expect($("send-modal").hidden).toBe(true);
  });

  it("asks before sending and lists every file", async () => {
    const { run, push } = await openPage(failed({ phase: "idle" }));
    expect($("send-diagnostics").hidden).toBe(false);
    $("send-diagnostics").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "diagnostics.send",
        action: "start",
      }),
    );
    push(failed({ phase: "preparing" }));
    expect($("send-modal").hidden).toBe(false);
    expect($("send-title").textContent).toBe("Preparing diagnostics");
    expect($("send-primary").hidden).toBe(true);
    push(
      failed({
        phase: "confirm",
        host: "diagnostics.example.com",
        files: ["summary.json", "desktop/logs/main.log"],
        bytes: 2048,
      }),
    );
    expect($("send-title").textContent).toBe(
      "Send diagnostics to diagnostics.example.com?",
    );
    expect($("send-lead").textContent).toContain("2 files, 2 KB");
    expect($("send-lead").textContent).toContain("home folder path");
    expect(
      [...$("send-files").querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["summary.json", "desktop/logs/main.log"]);
    expect($("send-primary").textContent).toBe("Send");
    expect($("send-close").textContent).toBe("Cancel");
    $("send-primary").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenLastCalledWith({
        op: "diagnostics.send",
        action: "confirm",
      }),
    );
  });

  it("shows progress, then the report id to copy", async () => {
    const { run, push } = await openPage(failed({ phase: "idle" }));
    push(
      failed({
        phase: "sending",
        host: "diagnostics.example.com",
        sent: 512,
        total: 2048,
      }),
    );
    expect($("send-title").textContent).toBe("Sending diagnostics");
    expect($("send-lead").textContent).toBe(
      "Uploading to diagnostics.example.com… 25%",
    );
    expect($("send-track").hidden).toBe(false);
    expect($("send-fill").style.width).toBe("25%");
    expect($("send-close").hidden).toBe(true);
    push(
      failed({
        phase: "sent",
        host: "diagnostics.example.com",
        reportId: "LD-7K3Q9XPM",
      }),
    );
    expect($("send-report").hidden).toBe(false);
    expect($("send-report-id").textContent).toBe("LD-7K3Q9XPM");
    $("send-primary").click();
    await vi.waitFor(() =>
      expect($("send-primary").textContent).toBe("Copied"),
    );
    expect(run).toHaveBeenCalledWith({
      op: "diagnostics.send",
      action: "copy",
    });
    $("send-close").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenLastCalledWith({
        op: "diagnostics.send",
        action: "cancel",
      }),
    );
  });

  it("offers Try Again only when it can help", async () => {
    const { run, push } = await openPage(failed({ phase: "idle" }));
    push(failed({ phase: "failed", error: "Couldn't reach it", retry: true }));
    expect($("send-error").textContent).toBe("Couldn't reach it");
    expect($("send-primary").textContent).toBe("Try Again");
    $("send-primary").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenLastCalledWith({
        op: "diagnostics.send",
        action: "retry",
      }),
    );
    push(failed({ phase: "failed", error: "Too large", retry: false }));
    expect($("send-primary").hidden).toBe(true);
    expect($("send-lead").textContent).toContain("Save Diagnostics");
    expect($("send-close").textContent).toBe("Close");
  });
});

describe("setup page installation failure plan", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  it("shows data-kept guidance on installation failure and restores progress text on retry", async () => {
    const folder = "D:\\Software\\Linger";
    const errorMessage = `Windows private path validation failed: ${folder} is inside a linked folder. Use a current-user owned local directory without links or shared access.`;
    const base = state("failed");
    const failedState: SetupState = {
      ...base,
      platform: "win32",
      localServer: {
        ...base.localServer,
        message: errorMessage,
        location: { path: folder, custom: true },
        refusal: {
          code: "WINDOWS_PRIVATE_PATH_UNSAFE",
          reason: "UNSAFE_PARENT_LINK",
        },
      },
    };
    const { push } = await openPage(failedState);
    expect($("installing-error").textContent).toBe(errorMessage);
    expect($("installing-plan").textContent).toBe(
      "Your data is kept. Fix the problem and try again.",
    );
    push(state("installing"));
    expect($("installing-plan").textContent).toBe(
      "This takes a few minutes. You can keep working.",
    );
  });
});

describe("setup page in Chinese", () => {
  const zh = zhCN.setup;
  const fill = (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/gu, (_, name: string) => values[name]!);

  it("speaks the language it was served in", async () => {
    await openPage(welcome(capable), "welcome", "zh-CN");
    // The harness loads the body only; static text comes from data-t.
    expect(document.querySelector('[data-t="welcomeTitle"]')!.textContent).toBe(
      zh.welcomeTitle,
    );
    expect($("step-label").textContent).toBe(
      fill(zh.stepOf, { step: "1", total: "2" }),
    );
    expect(
      card("local").querySelector<HTMLElement>(".source-rec")!.textContent,
    ).toBe(zh.recommended);
    $("source-continue").click();
    expect($("step-label").textContent).toBe(
      fill(zh.stepOf, { step: "2", total: "2" }),
    );
    expect($("welcome-lead").textContent).toBe(
      fill(zh.leadLocalGpu, { gpu: "RTX 4090" }),
    );
    expect($("plan-line").textContent).toBe(
      fill(zh.planLocal, { model: "qwen3-8b", size: "6.0 GB" }),
    );
    expect($("credentials-sub").textContent).toBe(
      fill(zh.credentialsGenerated, { email: "owner@linger.local" }),
    );
    expect($("local-install-label").textContent).toBe(zh.install);
  });

  it("words the subscription runtimes from the catalog", async () => {
    await openPage(
      welcome(small, {
        runtimes: rows(
          { installed: true },
          { installed: true, signedIn: true },
        ),
      }),
      "welcome",
      "zh-CN",
    );
    open("subscription");
    expect(inRow("claude", "[data-runtime-sub]").textContent).toBe(
      fill(zh.rtSignInWith, { plan: zh.planClaude }),
    );
    expect(inRow("codex", "[data-runtime-sub]").textContent).toBe(
      fill(zh.rtSignedInWith, { plan: zh.planCodex }),
    );
    expect($("plan-line").textContent).toBe(
      fill(zh.planRuntime, { runtime: "Codex" }),
    );
  });

  it("words a held local model from the catalog", async () => {
    await openPage(welcome(held), "welcome", "zh-CN");
    expect($("plan-why").textContent).toBe(
      fill(zh.heldWhy, { reasons: zh.reasonHeld }),
    );
  });

  it("counts the download its way", async () => {
    const base = state("installing");
    await openPage(
      {
        ...base,
        localServer: {
          ...base.localServer,
          transfer: {
            label: "Downloading the local model…",
            completed: 3 * GB,
            total: 4 * GB,
            bytesPerSecond: 50 * 1024 ** 2,
            partial: true,
          },
        },
      },
      "installing",
      "zh-CN",
    );
    expect($("installing-transfer-bytes").textContent).toBe(
      `${fill(zh.thisFile, {
        amount: fill(zh.amountOf, { done: "3.0 GB", total: "4.0 GB" }),
      })} · 50 MB/s`,
    );
  });

  it("localizes the Inkling 2 Mini spotlight on both steps", async () => {
    const inklingCapable: SetupLocalModelsCheck = {
      ...capable,
      model: {
        name: "inkling-2-mini:Q4_K_M",
        downloadBytes: 15 * GB,
        diskBytes: 18 * GB,
        memoryBytes: 22 * GB,
        featuredInkling: true,
      },
    };
    await openPage(welcome(inklingCapable), "welcome", "zh-CN");
    expect($("featured-spotlight").hidden).toBe(false);
    expect($("featured-spotlight-note").textContent).toBe(
      zh.featuredModelSelected,
    );
    expect($("featured-spotlight-link").textContent).toBe(zh.learnMoreLink);
    expect(
      $("featured-spotlight").querySelector(".spotlight-specs")!.textContent,
    ).toBe(zh.featuredModelSpecs);

    $("source-continue").click();
    expect($("local-model-featured").hidden).toBe(false);
    expect($("local-model-featured").textContent).toBe(zh.featuredPartnerBadge);
    expect($("local-spotlight-text").textContent).toBe(zh.featuredModelSpecs);
    expect($("local-spotlight-link").textContent).toBe(zh.learnMoreLink);

    await openPage(welcome(capable), "welcome", "zh-CN");
    expect($("featured-spotlight").hidden).toBe(true);
    $("source-continue").click();
    expect($("local-model-featured").hidden).toBe(true);
    expect($("local-spotlight-text").textContent).toBe(
      zh.featuredModelCustomizeNote,
    );
    expect($("local-spotlight-link").textContent).toBe(zh.thinkingMachinesLink);
  });
});

describe("setup page Inkling 2 Mini featured spotlight", () => {
  const inklingCapable = (
    name = "inkling-2-mini:Q4_K_M",
  ): SetupLocalModelsCheck => ({
    ...capable,
    model: {
      name,
      downloadBytes: 15 * GB,
      diskBytes: 18 * GB,
      memoryBytes: 22 * GB,
      ...(isInkling2MiniModelId(name)
        ? { featuredInkling: true as const }
        : {}),
    },
  });
  const opened = (run: ReturnType<typeof vi.fn>) =>
    run.mock.calls.filter(([command]) => command.op === "external.open");

  it("features Inkling 2 Mini on step 1 and in the local model's settings when this computer runs it", async () => {
    const { run } = await openPage(welcome(inklingCapable()), "welcome");
    expect(card("local").getAttribute("aria-checked")).toBe("true");
    expect($("source-local-meta").textContent).toBe(
      "inkling-2-mini:Q4_K_M · 15.0 GB",
    );
    expect($("featured-spotlight").hidden).toBe(false);
    expect($("featured-spotlight").dataset.recommended).toBe("true");
    expect($("featured-spotlight-note").textContent).toBe(
      "Recommended for this computer: the Local model card.",
    );
    expect($("featured-spotlight-link").textContent).toBe("Learn more ↗");

    $("featured-spotlight-link").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "external.open",
        url: INKLING_2_MINI_ANNOUNCEMENT_URL,
      }),
    );

    $("source-continue").click();
    expect($("featured-spotlight").hidden).toBe(true);
    expect($("local-model-name").textContent).toBe("inkling-2-mini:Q4_K_M");
    expect($("local-model-featured").hidden).toBe(false);
    expect($("local-model-featured").textContent).toBe(
      "Featured · Thinking Machines",
    );
    expect($("local-spotlight").dataset.recommended).toBe("true");
    expect($("local-spotlight-text").textContent).toBe(
      "26.4B Looped MoE · 3.4B active · Vision & Agentic Coding · Apache 2.0",
    );
    expect($("local-spotlight-link").textContent).toBe("Learn more ↗");

    $("local-spotlight-link").click();
    await vi.waitFor(() => expect(opened(run)).toHaveLength(2));
    expect(run).toHaveBeenLastCalledWith({
      op: "external.open",
      url: INKLING_2_MINI_ANNOUNCEMENT_URL,
    });
  });

  it("matches org-prefixed Inkling 2 Mini model IDs", async () => {
    await openPage(
      welcome(inklingCapable("thinkingmachines/Inkling-2-Mini")),
      "welcome",
    );
    expect($("featured-spotlight").hidden).toBe(false);
    expect($("featured-spotlight").dataset.recommended).toBe("true");
  });

  it("keeps step 1 to the sources when another model or no model is advised", async () => {
    for (const check of [capable, small, held]) {
      await openPage(welcome(check), "welcome");
      expect($("featured-spotlight").hidden).toBe(true);
    }
    // The library note stays with the local model's settings.
    const { run } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    expect($("local-model-featured").hidden).toBe(true);
    expect($("local-spotlight").dataset.recommended).toBe("false");
    expect($("local-spotlight-text").textContent).toContain(
      "Settings → Models",
    );
    expect($("local-spotlight-link").textContent).toBe("Thinking Machines ↗");
    $("local-spotlight-link").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "external.open",
        url: INKLING_2_MINI_ANNOUNCEMENT_URL,
      }),
    );
  });

  it("does not feature a held Inkling 2 Mini as this computer's pick", async () => {
    await openPage(
      welcome({
        ...held,
        model: {
          name: "inkling-2-mini:UD-Q4_K_M",
          downloadBytes: 15 * GB,
          diskBytes: 18 * GB,
          memoryBytes: 22 * GB,
          featuredInkling: true,
        },
      }),
      "welcome",
    );
    expect($("featured-spotlight").hidden).toBe(true);
    expect(card("local").disabled).toBe(true);
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
  });

  it("hides the featured spotlight when local installation is unavailable", async () => {
    const base = welcome(inklingCapable());
    await openPage(
      { ...base, localServer: { ...base.localServer, available: false } },
      "welcome",
    );
    expect($("featured-spotlight").hidden).toBe(true);
  });

  it("offers one-click driver installation and renders live progress on Windows Setup", async () => {
    const driverBlocked: SetupLocalModelsCheck = {
      state: "checked",
      eligible: false,
      blockedNow: true,
      memoryBytes: 32 * GB,
      diskFreeBytes: 200 * GB,
      gpu: "NVIDIA GeForce RTX 5060",
      recommendation: "codex",
      reasons: [
        {
          code: "cuda-driver-update-required",
          detectedCudaVersion: "12.8",
          requiredCudaVersion: "13.0",
          driverVersion: "572.83",
        },
      ],
    };
    const base = {
      ...welcome(driverBlocked),
      platform: "win32" as const,
      driverUpdate: {
        nvidiaApp: "nvidia_app" as const,
        directInstallSupported: true,
        installState: { phase: "idle" as const },
      },
    };
    const { run, push } = await openPage(base, "welcome");

    expect($("local-driver-install").hidden).toBe(false);
    expect($("local-driver-install").textContent).toBe("Install driver update");
    $("local-driver-install").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "driver.start-install",
        requiredCuda: "13.0",
      }),
    );

    push({
      ...base,
      driverUpdate: {
        ...base.driverUpdate,
        installState: {
          phase: "downloading",
          version: "621.24",
          completedBytes: 512 * 1024 ** 2,
          totalBytes: 1024 * 1024 ** 2,
        },
      },
    });
    expect($("local-driver-status").hidden).toBe(false);
    expect($("local-driver-status").textContent).toContain(
      "Downloading NVIDIA driver 621.24",
    );
    expect(($("local-driver-install") as HTMLButtonElement).disabled).toBe(
      true,
    );

    push({
      ...base,
      driverUpdate: {
        ...base.driverUpdate,
        installState: {
          phase: "reboot_required",
          version: "621.24",
        },
      },
    });
    expect($("local-driver-status").textContent).toContain(
      "NVIDIA driver 621.24 installed. Restart Windows to finish",
    );
  });
});

describe("setup page install location and customizing layout", () => {
  const fill = (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/gu, (_, name: string) => values[name]!);
  const withLocation = (
    localModels: SetupLocalModelsCheck,
    location: SetupState["localServer"]["location"],
  ): SetupState => {
    const base = welcome(localModels);
    return {
      ...base,
      localServer: {
        ...base.localServer,
        location,
      },
    };
  };
  const type = (id: string, value: string) => {
    const input = $(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };

  it("renders a quiet install-location bar and shows Reset only for custom folders (EN and zh-CN)", async () => {
    const { run, push } = await openPage(
      withLocation(small, {
        path: "~/.linger",
        custom: false,
        freeBytes: 80 * GB,
        minFreeBytes: 20 * GB,
      }),
      "welcome",
    );
    expect($("install-location").hidden).toBe(false);
    expect($("install-location").dataset.warn).toBe("false");
    expect($("location-path").textContent).toBe("~/.linger");
    expect($("location-path").title).toBe("~/.linger");
    expect($("location-sub").hidden).toBe(true);
    expect($("location-sub").textContent).toBe("");
    expect($("location-reset").hidden).toBe(true);
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(false);

    $("location-change").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "local.location.pick" }),
    );

    push(
      withLocation(small, {
        path: "/Volumes/Data/Linger",
        custom: true,
        freeBytes: 120 * GB,
        minFreeBytes: 20 * GB,
      }),
    );
    expect($("install-location").dataset.warn).toBe("false");
    expect($("location-path").textContent).toBe("/Volumes/Data/Linger");
    expect($("location-reset").hidden).toBe(false);
    expect($("location-reset").textContent).toBe("Reset");
    $("location-reset").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "local.location.reset" }),
    );

    await openPage(
      withLocation(small, {
        path: "/Volumes/Data/Linger",
        custom: true,
        freeBytes: 120 * GB,
        minFreeBytes: 20 * GB,
      }),
      "welcome",
      "zh-CN",
    );
    expect($("location-reset").hidden).toBe(false);
    expect($("location-reset").textContent).toBe(zhCN.setup.resetLocation);
  });

  it("warns and disables Quick Install when default disk space is below minFreeBytes in EN and zh-CN", async () => {
    await openPage(
      withLocation(small, {
        path: "C:\\Users\\demo\\.linger",
        custom: false,
        freeBytes: 10 * GB,
        minFreeBytes: 20 * GB,
      }),
      "welcome",
    );
    expect($("install-location").dataset.warn).toBe("true");
    expect($("location-sub").hidden).toBe(false);
    expect($("location-sub").dataset.warn).toBe("true");
    expect($("location-sub").textContent).toBe(
      "Needs 20 GB free; this disk has 10 GB.",
    );
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    expect($("location-reset").hidden).toBe(true);

    await openPage(
      withLocation(small, {
        path: "C:\\Users\\demo\\.linger",
        custom: false,
        freeBytes: 10 * GB,
        minFreeBytes: 20 * GB,
      }),
      "welcome",
      "zh-CN",
    );
    expect($("install-location").dataset.warn).toBe("true");
    expect($("location-sub").hidden).toBe(false);
    expect($("location-sub").textContent).toBe(
      fill(zhCN.setup.locationSpaceLow, { needed: "20", free: "10" }),
    );
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    expect($("location-reset").hidden).toBe(true);
  });

  it("includes the planned local model disk budget dynamically and clears the warning for Subscription or valid BYOK", async () => {
    const bigModel: SetupLocalModelsCheck = {
      ...capable,
      model: {
        name: "inkling-2-mini:Q4_K_M",
        downloadBytes: 15 * GB,
        diskBytes: 18 * GB,
        memoryBytes: 22 * GB,
        featuredInkling: true,
      },
    };
    await openPage(
      withLocation(bigModel, {
        path: "~/.linger",
        custom: false,
        freeBytes: 28 * GB,
        minFreeBytes: 20 * GB,
      }),
      "welcome",
    );
    // 28 GB free covers the 20 GB base requirement, but not 20 + 18 = 38 GB for the local model.
    expect($("install-location").dataset.warn).toBe("true");
    expect($("location-sub").hidden).toBe(false);
    expect($("location-sub").textContent).toBe(
      "Needs 38 GB free; this disk has 28 GB.",
    );
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    expect($("location-reset").hidden).toBe(true);

    $("local-customize").click();
    const source = (value: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-plan="source"] [data-value="${value}"]`,
      )!;
    source("subscription").click();
    expect($("install-location").dataset.warn).toBe("false");
    expect($("location-sub").hidden).toBe(true);
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(false);

    source("byok").click();
    expect($("install-location").dataset.warn).toBe("false");
    expect($("location-sub").hidden).toBe(true);
    // Disabled only because BYOK fields are incomplete.
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    type("byok-url", "https://api.example.com");
    type("byok-model", "claude-sonnet-4-6");
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(false);
  });

  it("gives location.error precedence over spaceLow and shows full error text with Reset", async () => {
    const errorMessage =
      "Linger can't write to this folder. Choose another one.";
    await openPage(
      withLocation(small, {
        path: "~/.linger",
        custom: false,
        freeBytes: 5 * GB,
        minFreeBytes: 20 * GB,
        error: errorMessage,
      }),
      "welcome",
    );
    expect($("install-location").dataset.warn).toBe("true");
    expect($("location-sub").hidden).toBe(false);
    expect($("location-sub").textContent).toBe(errorMessage);
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    expect($("location-reset").hidden).toBe(false);
  });

  it("syncs document.body.dataset.customizing when toggling Customize and leaving welcome", async () => {
    await openPage(welcome(capable), "welcome");
    expect(document.body.dataset.customizing).toBe("false");

    $("local-customize").click();
    expect(document.body.dataset.customizing).toBe("true");

    $("local-customize").click();
    expect(document.body.dataset.customizing).toBe("false");

    // Enter customizing, then leave welcome via a step transition: body flag resets to false.
    $("local-customize").click();
    expect(document.body.dataset.customizing).toBe("true");
    document
      .querySelector<HTMLButtonElement>('#team [data-go="server"]')!
      .click();
    expect(document.body.dataset.customizing).toBe("false");
  });

  it("handles legacy snapshots without freeBytes/minFreeBytes cleanly", async () => {
    await openPage(
      withLocation(small, {
        path: "~/.linger",
        custom: false,
      }),
      "welcome",
    );
    expect($("install-location").hidden).toBe(false);
    expect($("install-location").dataset.warn).toBe("false");
    expect($("location-path").textContent).toBe("~/.linger");
    expect($("location-sub").hidden).toBe(true);
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(false);
  });

  it("warns and disables Quick Install when freeBytes is 0", async () => {
    await openPage(
      withLocation(small, {
        path: "~/.linger",
        custom: false,
        freeBytes: 0,
        minFreeBytes: 20 * GB,
      }),
      "welcome",
    );
    expect($("install-location").dataset.warn).toBe("true");
    expect($("location-sub").hidden).toBe(false);
    expect($("location-sub").textContent).toBe(
      "Needs 20 GB free; this disk has 0 GB.",
    );
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    expect($("location-reset").hidden).toBe(true);
  });

  it("shows rejectedPath while location.error is active and restores location.path once cleared", async () => {
    const errorMessage =
      "Linger can't write to this folder. Choose another one.";
    const { push } = await openPage(
      withLocation(small, {
        path: "~/.linger",
        custom: false,
        freeBytes: 80 * GB,
        minFreeBytes: 20 * GB,
        error: errorMessage,
        rejectedPath: "/Volumes/ReadOnly/Linger",
      }),
      "welcome",
    );
    expect($("install-location").dataset.warn).toBe("true");
    expect($("location-path").textContent).toBe("/Volumes/ReadOnly/Linger");
    expect($("location-path").title).toBe("/Volumes/ReadOnly/Linger");
    expect($("location-sub").hidden).toBe(false);
    expect($("location-sub").textContent).toBe(errorMessage);
    expect($("location-reset").hidden).toBe(false);
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);

    push(
      withLocation(small, {
        path: "~/.linger",
        custom: false,
        freeBytes: 80 * GB,
        minFreeBytes: 20 * GB,
      }),
    );
    expect($("install-location").dataset.warn).toBe("false");
    expect($("location-path").textContent).toBe("~/.linger");
    expect($("location-path").title).toBe("~/.linger");
    expect($("location-sub").hidden).toBe(true);
    expect($("location-reset").hidden).toBe(true);
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(false);
  });
});
