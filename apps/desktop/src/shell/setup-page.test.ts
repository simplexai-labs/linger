// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { minNvidiaDriverForCuda } from "@linger/service-kit/nvidia-driver";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Language } from "../i18n/language.js";
import zhCN from "../i18n/locales/zh-CN.json" with { type: "json" };
import { localizePage } from "../i18n/page.js";
import {
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
        email: "admin@gmail.com",
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
    push(state("ready", { email: "admin@gmail.com" }));
    expect(
      document.querySelector('section[data-step="ready"].active'),
    ).not.toBeNull();
    // Folded away until asked for.
    expect($("account").hidden).toBe(false);
    expect($("account-body").hidden).toBe(true);
    expect($("account-toggle").getAttribute("aria-expanded")).toBe("false");
    expect($("account-toggle").textContent?.trim()).toBe("Sign-in details");
    $("account-toggle").click();
    expect($("account-body").hidden).toBe(false);
    expect($("account-toggle").getAttribute("aria-expanded")).toBe("true");
    expect($("account-email").textContent).toBe("admin@gmail.com");
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
    push(state("ready", { email: "admin@gmail.com" }));
    $("account-toggle").click();
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

  it("folds the details away again with the password hidden", async () => {
    const { push, run } = await openPage();
    push(state("ready", { email: "admin@gmail.com" }));
    $("account-toggle").click();
    $("account-show").click();
    await vi.waitFor(() =>
      expect($("account-password").textContent).toBe(PASSWORD),
    );
    $("account-toggle").click();
    expect($("account-body").hidden).toBe(true);
    await vi.waitFor(() =>
      expect(run).toHaveBeenLastCalledWith({
        op: "local.account.show",
        on: false,
      }),
    );
    $("account-toggle").click();
    expect($("account-password").textContent).toBe("•".repeat(12));
  });

  it("asks the main process to copy the password and reveal the file", async () => {
    const { push, run } = await openPage();
    push(state("ready", { email: "admin@gmail.com" }));
    $("account-toggle").click();
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

describe("setup page two-step welcome", () => {
  it("checks this computer first, then offers the three sources with the advice picked", async () => {
    const { run, push } = await openPage(
      welcome({ state: "checking" }),
      "welcome",
    );
    expect(stage()).toBe("checking");
    // Only a quiet spinner: no words about what the check is doing.
    expect($("welcome-checking").hidden).toBe(false);
    const shown = () =>
      $("welcome-checking")
        .textContent!.replace($("checking-skip").textContent!, "")
        .trim();
    expect(shown()).toBe("");
    expect($("checking-skip").hidden).toBe(true);
    expect($("welcome-checking").getAttribute("aria-label")).toBe(
      "Getting ready",
    );
    expect($("stage-bar").hidden).toBe(true);
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
    expect(shown()).toBe("");
    expect(document.body.textContent).not.toContain("setup tools");
    push(welcome(capable));
    expect(stage()).toBe("choose");
    expect($("step-label").textContent).toBe("Step 1 of 2");
    expect($("welcome-checking").hidden).toBe(true);
    expect($("source-grid").hidden).toBe(false);
    expect($("source-panel").hidden).toBe(true);
    expect(card("local").getAttribute("aria-checked")).toBe("true");
    expect(card("local").tabIndex).toBe(0);
    expect(card("subscription").tabIndex).toBe(-1);
    // A title and one short line per card; no badges, no subtitle.
    expect(document.querySelector(".source-rec, .source-pill")).toBeNull();
    expect(
      document.querySelector(
        '[data-step="welcome"] :is(.eyebrow:not(.behind), .lead)',
      ),
    ).toBeNull();
    expect($("stage-bar").hidden).toBe(true);
    expect($("source-local-about").textContent).toBe("On this computer");
    expect($("source-byok-about").textContent).toBe("Your API key");
    expect($("source-sub-about").textContent).toBe("ChatGPT or Claude plan");
    expect($("source-continue").hidden).toBe(false);
    expect($("local-install").hidden).toBe(true);
    expect($("plan-line").textContent).toBe("");
    expect(installed(run)).toEqual([]);
  });

  it("offers a way on only once the check has run for 20 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await openPage(welcome({ state: "checking" }), "welcome");
      expect($("checking-skip").hidden).toBe(true);
      vi.advanceTimersByTime(19_000);
      expect($("checking-skip").hidden).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect($("checking-skip").hidden).toBe(false);
      expect($("checking-skip").textContent).toBe("Choose now");
    } finally {
      vi.useRealTimers();
    }
    $("checking-skip").click();
    expect(stage()).toBe("choose");
    expect(card("local").disabled).toBe(true);
    expect($("source-local-about").textContent).toBe("Checking…");
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
  });

  it("installs the local model with Pi from its settings", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    expect(stage()).toBe("settings");
    expect($("step-label").textContent).toBe("Step 2 of 2");
    expect($("welcome-title").textContent).toBe("Local model");
    expect($("local-row").hidden).toBe(false);
    expect($("subscription-row").hidden).toBe(true);
    expect($("byok-row").hidden).toBe(true);
    expect($("local-model-name").textContent).toBe("qwen3-8b");
    expect($("local-model-needs").textContent).toBe("6.0 GB");
    // The local model is the source itself, so nothing else downloads.
    expect($("background-row").hidden).toBe(true);
    expect($("plan-line").textContent).toBe("");
    expect(button("local-install").disabled).toBe(false);
    $("local-install").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    const [command] = installed(run);
    expect(command).toMatchObject({ op: "local.start", runtime: "local" });
    expect(command).not.toHaveProperty("background");
    // The installation makes its own sign-in account, as before.
    expect(command).not.toHaveProperty("account");
    expect(command).not.toHaveProperty("keys");
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

  it("picks the subscription when a runtime is signed in already", async () => {
    await openPage(
      welcome(capable, {
        runtimes: rows({}, { installed: true, signedIn: true }),
      }),
      "welcome",
    );
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
    expect($("source-sub-about").textContent).toBe("ChatGPT or Claude plan");
  });

  it("holds a local model that needs free memory and checks again on request", async () => {
    const { run } = await openPage(welcome(held), "welcome");
    expect(card("local").disabled).toBe(true);
    expect($("source-local-about").textContent).toBe("On hold");
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
    expect($("plan-why").textContent).toBe(
      "On hold: Not enough free memory. Close other apps.",
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
      "On hold: Other programs are using GPU 1's memory (3.0 GB free, 9.0 GB needed). Close apps using the GPU. Not enough free memory (2.7 GB free, 12.7 GB needed). Close other apps.",
    );
    expect($("source-local-about").textContent).toBe("On hold");
    expect(document.body.textContent).not.toContain(TOOL_WORDS);
  });

  it("holds local models without a plan for gateway-port-in-use and harness-unavailable and offers Check again", async () => {
    for (const [code, expectWhy] of [
      [
        "gateway-port-in-use",
        "Another program is using the local model gateway port.",
      ],
      [
        "harness-unavailable",
        "The Pi runtime required for local models isn't ready right now. Check your connection or permissions.",
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
      expect($("plan-why").textContent).toBe(`On hold: ${expectWhy}`);
      expect($("source-local-about").textContent).toBe("On hold");
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
      "On hold: Your NVIDIA driver supports CUDA 12.1, but local models require NVIDIA driver 550+ (CUDA 12.4). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
    );
    expect(
      $("plan-why").textContent?.match(/choose Check again/g),
    ).toHaveLength(1);
    expect($("source-local-about").textContent).toBe("On hold");
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
        "On hold: Another app is using the GPU.",
      ],
      [
        { ...held, reasons: [reason({ code: "plan-unavailable" })] },
        "On hold: Another app is using the memory it needs. Quit it.",
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
    expect($("source-local-about").textContent).toBe("Not available here");
    expect($("plan-why").textContent).toBe(
      "No local model fits this computer.",
    );
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
    await openPage(welcome({ state: "unavailable" }), "welcome");
    expect($("plan-why").textContent).toBe("Couldn't check this computer.");
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

  it("keeps step 2 to the source: no More options, location or app keys", async () => {
    await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    expect(document.getElementById("local-customize")).toBeNull();
    expect(document.getElementById("local-options")).toBeNull();
    expect(document.getElementById("key-composio")).toBeNull();
    expect($("location-row").hidden).toBe(true);
    expect(document.body.textContent).not.toContain("More options");
    expect(document.body.textContent).not.toContain("Private to this computer");
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
    // The location shows only when it is what stops Install.
    expect($("location-row").hidden).toBe(false);
    expect($("location-change").hidden).toBe(false);
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
    // Claude Code and Codex only; Pi installs by itself when it is needed.
    expect(
      [...document.querySelectorAll<HTMLElement>(".choice.runtime")].map(
        (el) => el.dataset.runtime,
      ),
    ).toEqual(["claude", "codex"]);
    // A name and one status line each: no plans, versions or roles.
    for (const runtime of ["claude", "codex"])
      expect(inRow(runtime, "[data-runtime-sub]").textContent).toBe(
        "Not installed",
      );
    expect(inRow("claude", "[data-runtime-install]").hidden).toBe(false);
    expect(inRow("claude", "[data-runtime-signin]").hidden).toBe(true);
    expect(button("local-install").disabled).toBe(true);
    expect($("plan-line").textContent).toBe("Sign in to one to continue");
    // Pi alone is not enough, and is not shown.
    push(welcome(small, { runtimes: rows({}, {}, { installed: true }) }));
    expect(button("local-install").disabled).toBe(true);
    // Installed but not signed in: Sign in.
    push(
      welcome(small, {
        runtimes: rows({ installed: true, version: "2.1.0" }, {}, {}),
      }),
    );
    expect(inRow("claude", "[data-runtime-sub]").textContent).toBe(
      "Not signed in",
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
    expect(inRow("claude", "[data-runtime-sub]").hidden).toBe(true);
    expect($("plan-line").textContent).toBe("");
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
    expect(inRow("codex", "[data-runtime-sub]").textContent).toBe("Installing");
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
      "Signing in…",
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
    expect(document.querySelector(".runtime-rec")).toBeNull();
    expect($("plan-line").textContent).toBe("Codex is the default");
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
    expect(document.getElementById("background-model-detail")).toBeNull();
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect($("plan-line").textContent).toBe("");
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
  const withLocal = (
    base: SetupState,
    localServer: Partial<SetupState["localServer"]>,
  ): SetupState => ({
    ...base,
    localServer: { ...base.localServer, ...localServer },
  });

  // Answers Install's quiet test with this, and everything else as before.
  const answering = (
    run: ReturnType<typeof vi.fn>,
    base: SetupState,
    byokCheck: () => Promise<SetupState["localServer"]["byokCheck"]>,
  ) =>
    run.mockImplementation(async (command: SetupCommand) =>
      command.op === "local.byok.check"
        ? withLocal(base, { byokCheck: await byokCheck() })
        : base,
    );
  const ops = (run: ReturnType<typeof vi.fn>) =>
    run.mock.calls.map(([command]) => (command as SetupCommand).op);

  it("asks only for an address, a key and a model, and tests them quietly on Install", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    open("byok");
    expect($("welcome-title").textContent).toBe("BYOK");
    expect($("byok-row").hidden).toBe(false);
    expect($("local-row").hidden).toBe(true);
    expect($("subscription-row").hidden).toBe(true);
    // Three fields, and no path, endpoint, model list, Test or hints.
    expect(
      [...$("byok-fields").querySelectorAll("input")].map((input) => input.id),
    ).toEqual(["byok-url", "byok-key", "byok-model"]);
    for (const id of ["byok-path", "byok-endpoint", "byok-list", "byok-test"])
      expect(document.getElementById(id)).toBeNull();
    expect($("byok-status").hidden).toBe(true);
    expect(button("local-install").disabled).toBe(true);
    type("byok-url", "https://open.bigmodel.cn/api/paas/v4/");
    type("byok-key", " sk-top-secret ");
    expect(button("local-install").disabled).toBe(true);
    type("byok-model", "glm-4.6");
    expect(button("local-install").disabled).toBe(false);
    expect($("plan-line").textContent).toBe("");
    const box = $("background-model") as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect($("plan-line").textContent).toBe("");

    let answer!: (check: SetupState["localServer"]["byokCheck"]) => void;
    answering(
      run,
      welcome(capable),
      () => new Promise((resolve) => (answer = resolve)),
    );
    $("local-install").click();
    // An address with a path is used as typed, with Pi's own format.
    const config = {
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      path: "",
      endpoint: "/chat/completions",
      protocol: "openai-chat",
      apiKey: "sk-top-secret",
      modelId: "glm-4.6",
      runtime: "pi",
    };
    expect(run).toHaveBeenCalledWith({ op: "local.byok.check", byok: config });
    await vi.waitFor(() =>
      expect($("local-install-label").textContent).toBe("Checking…"),
    );
    expect(button("local-install").disabled).toBe(true);
    answer({
      state: "ready",
      protocol: "openai-chat",
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      modelId: "glm-4.6",
      contextWindow: 204_800,
    });
    await vi.waitFor(() => {
      expect(installed(run)).toHaveLength(1);
      expect(($("byok-key") as HTMLInputElement).value).toBe("");
    });
    // A passing test says nothing; Install goes on.
    expect($("byok-status").hidden).toBe(true);
    expect(ops(run).indexOf("local.byok.check")).toBeLessThan(
      ops(run).indexOf("local.start"),
    );
    expect(installed(run)[0]).toEqual({
      op: "local.start",
      runtime: "pi",
      byok: config,
      background: true,
    });
  });

  it("keeps the usual defaults for a bare host or a whole request address, and shows only a failed test", async () => {
    const { run } = await openPage(welcome(small), "welcome");
    open("byok");
    type("byok-url", "https://llm.example.com");
    type("byok-model", "glm-4.6");
    answering(run, welcome(small), async () => ({
      state: "failed",
      message: "Nothing answered at https://llm.example.com/v1 (HTTP 404).",
    }));
    $("local-install").click();
    // A bare host gets /v1 and Pi's format.
    expect(run).toHaveBeenCalledWith({
      op: "local.byok.check",
      byok: {
        baseUrl: "https://llm.example.com",
        path: "/v1",
        endpoint: "/chat/completions",
        protocol: "openai-chat",
        modelId: "glm-4.6",
        runtime: "pi",
      },
    });
    await vi.waitFor(() => expect($("byok-status").hidden).toBe(false));
    expect($("byok-status").textContent).toBe(
      "Nothing answered at https://llm.example.com/v1 (HTTP 404).",
    );
    expect($("byok-status").getAttribute("role")).toBe("alert");
    expect(installed(run)).toEqual([]);
    expect($("local-install-label").textContent).toBe("Install");
    expect(button("local-install").disabled).toBe(false);
    // The error goes once the fields change.
    type("byok-model", "glm-4.5-air");
    expect($("byok-status").hidden).toBe(true);

    // An ending that names a format picks it.
    type("byok-url", "https://api.anthropic.com/v1/messages");
    answering(run, welcome(small), async () => ({
      state: "ready",
      protocol: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      modelId: "glm-4.5-air",
      contextWindow: 131_072,
    }));
    $("local-install").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    expect(installed(run)[0]).toMatchObject({
      runtime: "pi",
      byok: {
        baseUrl: "https://api.anthropic.com/v1",
        path: "",
        endpoint: "/messages",
        protocol: "anthropic",
        modelId: "glm-4.5-air",
      },
    });
  });

  it("says a usual BYOK failure in a few words", async () => {
    const { run } = await openPage(welcome(small), "welcome");
    open("byok");
    type("byok-url", "http://127.0.0.1:8090/v1");
    type("byok-model", "glm-4.6");
    for (const [code, shown] of [
      ["BYOK_UNREACHABLE", "Couldn't reach this URL."],
      ["BYOK_CHECK_TIMEOUT", "Couldn't reach this URL."],
      ["BYOK_AUTH_FAILED", "This API key was refused."],
      ["BYOK_NOT_FOUND", "This model wasn't found at this URL."],
      ["BYOK_UPSTREAM_REJECTED", "The endpoint refused the test request."],
      // Anything else keeps the check's own words.
      ["BYOK_INVALID_CONFIG", "An HTTPS endpoint needs an API key."],
    ]) {
      answering(run, welcome(small), async () => ({
        state: "failed",
        code,
        message:
          code === "BYOK_INVALID_CONFIG"
            ? "An HTTPS endpoint needs an API key."
            : "Could not reach http://127.0.0.1:8090/v1/chat/completions (URLError).",
      }));
      $("local-install").click();
      await vi.waitFor(() => expect($("byok-status").textContent).toBe(shown));
      type("byok-model", "glm-4.6");
    }
    expect(installed(run)).toEqual([]);
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
    expect($("model-behind-text").textContent).toBe("Local model 42%");
    expect($("local-install-label").textContent).toBe("Continue setup");
    expect($("plan-line").textContent).toBe("");
    // The model is not offered again while it downloads.
    expect($("background-row").hidden).toBe(true);
    $("source-back").click();
    expect(card("local").disabled).toBe(true);
    expect($("source-local-about").textContent).toBe("Downloading · 42%");
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

  it("keeps the install line to the install while the model downloads", async () => {
    const base = state("installing");
    const background = {
      model: "qwen3-8b",
      state: "downloading" as const,
      completed: 1,
      total: 2,
    };
    const { push } = await openPage({
      ...base,
      localServer: { ...base.localServer, backgroundModel: background },
    });
    expect($("installing-step").textContent).toBe("Starting services…");
    const ready = state("ready", { email: "admin@gmail.com" });
    push({
      ...ready,
      localServer: { ...ready.localServer, backgroundModel: background },
    });
    expect(document.getElementById("ready-lead")).toBeNull();
  });
});

describe("setup page sign-in account", () => {
  const typeIn = (id: string, value: string) => {
    const input = $(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };
  const submit = () =>
    $("account-change").dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
  const passwordChanges = (run: ReturnType<typeof vi.fn>) =>
    run.mock.calls
      .map(([command]) => command as SetupCommand)
      .filter((command) => command.op === "local.account.password");

  it("never asks for an account before Install", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    $("source-continue").click();
    for (const id of [
      "credentials-row",
      "credentials-sheet",
      "credentials-edit",
    ])
      expect(document.getElementById(id)).toBeNull();
    $("local-install").click();
    await vi.waitFor(() => expect(installed(run)).toHaveLength(1));
    expect(installed(run)[0]).not.toHaveProperty("account");
  });

  it("changes the password on the ready screen, checked like the server checks it", async () => {
    const { run, push } = await openPage();
    push(state("ready", { email: "admin@gmail.com" }));
    $("account-toggle").click();
    expect($("account-change").hidden).toBe(true);
    expect($("account-change-open").textContent).toBe("Change password");
    $("account-change-open").click();
    expect($("account-change").hidden).toBe(false);
    expect($("account-note").hidden).toBe(true);
    const input = $("account-new-password") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.type).toBe("password");
    $("account-new-show").click();
    expect(input.type).toBe("text");
    expect($("account-new-show").textContent).toBe("Hide");
    $("account-new-show").click();
    expect(input.type).toBe("password");

    for (const [value, problem] of [
      ["short", "Use at least 8 characters."],
      ["x".repeat(257), "Use at most 256 characters."],
      ["tab\there-is-bad", "The password can't contain control characters."],
    ] as const) {
      typeIn("account-new-password", value);
      submit();
      expect($("account-new-error").textContent).toBe(problem);
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
    expect(passwordChanges(run)).toEqual([]);
    typeIn("account-new-password", "a-new-long-password");
    // A problem fixed clears as the person types.
    expect($("account-new-error").textContent).toBe("");
    submit();
    await vi.waitFor(() => expect($("account-change").hidden).toBe(true));
    expect(passwordChanges(run)).toEqual([
      { op: "local.account.password", password: "a-new-long-password" },
    ]);
    expect(input.value).toBe("");
    expect($("account-note").hidden).toBe(false);
    // The page never prints the new password.
    expect(document.body.textContent).not.toContain("a-new-long-password");
  });

  it("says why a new password was refused and keeps it to try again", async () => {
    const { run, push } = await openPage();
    push(state("ready", { email: "admin@gmail.com" }));
    $("account-toggle").click();
    $("account-change-open").click();
    typeIn("account-new-password", "a-new-long-password");
    run.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'setup:run': Error: Too many password changes. Try again in a few minutes.",
      ),
    );
    submit();
    await vi.waitFor(() =>
      expect($("account-new-error").textContent).toBe(
        "Too many password changes. Try again in a few minutes.",
      ),
    );
    expect($("account-change").hidden).toBe(false);
    expect(($("account-new-password") as HTMLInputElement).value).toBe(
      "a-new-long-password",
    );
    expect(button("account-new-save").disabled).toBe(false);
    // Escape and Cancel both leave the password as it was.
    $("account-new-password").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect($("account-change").hidden).toBe(true);
    $("account-change-open").click();
    expect(($("account-new-password") as HTMLInputElement).value).toBe("");
    $("account-new-cancel").click();
    expect($("account-change").hidden).toBe(true);
    expect(passwordChanges(run)).toHaveLength(1);
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

describe("setup page installing", () => {
  // A failure scrolls its actions into view, which jsdom lacks.
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });
  const withLocal = (
    phase: SetupState["localServer"]["phase"],
    fields: Partial<SetupState["localServer"]> = {},
  ): SetupState => {
    const base = state(phase);
    return { ...base, localServer: { ...base.localServer, ...fields } };
  };

  it("shows one bar and one line that changes with the step", async () => {
    const { push } = await openPage(withLocal("installing"));
    const section = document.querySelector('[data-step="installing"]')!;
    // No checklist, timings or second line.
    expect(section.querySelectorAll(".progress")).toHaveLength(1);
    for (const id of [
      "installing-checks",
      "installing-transfer",
      "installing-waiting",
      "installing-plan",
    ])
      expect(document.getElementById(id)).toBeNull();
    expect($("installing-step").textContent).toBe("Starting services…");
    expect($("installing-count").textContent).toMatch(/^\d+%$/u);
    push(withLocal("installing", { step: "agents" }));
    expect($("installing-step").textContent).toBe("Preparing your agents…");
    // The runtime lookup says what the bar waits on, in the same line.
    push(withLocal("installing", { waiting: "runtime" }));
    expect($("installing-step").textContent).toBe("Checking the AI runtime…");
    expect($("installing-actions").hidden).toBe(true);
  });

  it("folds a download into the same line, in its own words", async () => {
    // The installer's words name tools and timings; the line does not.
    const { push } = await openPage(
      withLocal("installing", {
        step: "download",
        transfer: {
          label: "Downloading private Go 1.26.5",
          completed: 26 * 1024 ** 2,
          total: 62 * 1024 ** 2,
        },
      }),
    );
    expect($("installing-step").textContent).toBe(
      "Downloading Linger… · 26 MB of 62 MB",
    );
    // The local model downloads while the services start.
    push(
      withLocal("installing", {
        source: "local",
        transfer: {
          label: "Downloading the local model files…",
          completed: 12 * GB,
          total: 31 * GB,
          bytesPerSecond: 50 * 1024 ** 2,
        },
      }),
    );
    expect($("installing-step").textContent).toBe(
      "Downloading the local model… · 12.0 GB of 31.0 GB",
    );
    push(
      withLocal("installing", {
        source: "local",
        transfer: {
          label: "Downloading the local model files…",
          completed: 3 * GB,
          total: 4 * GB,
          partial: true,
        },
      }),
    );
    expect($("installing-step").textContent).toBe(
      "Downloading the local model… · This file: 3.0 GB of 4.0 GB",
    );
    push(withLocal("installing", { source: "local" }));
    expect($("installing-step").textContent).toBe("Starting services…");
  });

  it("says what went wrong, with only Report issue", async () => {
    const { push } = await openPage(
      withLocal("failed", { message: "Services did not start" }),
    );
    expect($("installing-title").textContent).toBe("Installation stopped");
    expect($("installing-error").textContent).toBe("Services did not start");
    expect($("installing-actions").hidden).toBe(false);
    const section = document.querySelector('[data-step="installing"]')!;
    const shown = [...section.querySelectorAll<HTMLButtonElement>("button")]
      .filter((el) => !el.closest("[hidden]"))
      .map((el) => el.id);
    expect(shown).toEqual(["report-issue"]);
    expect($("report-issue").textContent).toBe("Report issue");
    for (const id of ["local-retry", "local-back", "send-diagnostics"])
      expect(document.getElementById(id)).toBeNull();
    // A runtime lookup that did not finish says so briefly.
    push(
      withLocal("failed", {
        message:
          "Checking the AI runtime on this computer did not finish in time.",
        failure: "runtime_lookup_timed_out",
      }),
    );
    expect($("installing-error").textContent).toBe(
      "Checking the AI runtime took too long.",
    );
  });

  it("words both in Chinese", async () => {
    const { push } = await openPage(
      withLocal("installing", { waiting: "runtime" }),
      "installing",
      "zh-CN",
    );
    expect($("installing-step").textContent).toBe(zhCN.setup.waitingRuntime);
    push(
      withLocal("failed", {
        message: "Lost the connection to the installer.",
        failure: "runtime_lookup_unreachable",
      }),
    );
    expect($("installing-error").textContent).toBe(
      zhCN.setup.runtimeLookupUnreachable,
    );
    expect($("report-issue").textContent).toBe(zhCN.setup.reportIssue);
  });
});

describe("setup page Report issue", () => {
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

  it("saves diagnostics to Downloads while no receiver is set up", async () => {
    const { run, push } = await openPage(failed());
    expect($("send-modal").hidden).toBe(true);
    $("report-issue").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "diagnostics.save" }),
    );
    push({
      ...failed(),
      diagnostics: { file: "linger-diagnostics.zip" },
    } as SetupState);
    expect($("diagnostics-note").textContent).toBe(
      "Saved linger-diagnostics.zip. Send it to Linger support.",
    );
  });

  it("asks before sending and lists every file", async () => {
    const { run, push } = await openPage(failed({ phase: "idle" }));
    $("report-issue").click();
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

  it("retries a send that can be retried, else saves it to Downloads", async () => {
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
    expect($("send-primary").textContent).toBe("Save to Downloads");
    expect($("send-close").textContent).toBe("Close");
    $("send-primary").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenLastCalledWith({ op: "diagnostics.save" }),
    );
    expect(run).toHaveBeenCalledWith({
      op: "diagnostics.send",
      action: "cancel",
    });
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
    expect($("source-local-about").textContent).toBe(zh.sourceLocalAbout);
    $("source-continue").click();
    expect($("step-label").textContent).toBe(
      fill(zh.stepOf, { step: "2", total: "2" }),
    );
    expect($("plan-line").textContent).toBe("");
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
      zh.rtInstalledNotSignedIn,
    );
    expect(inRow("codex", "[data-runtime-done]").textContent).toBe(zh.signedIn);
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
          source: "local",
          transfer: {
            label: "Downloading the local model files…",
            completed: 3 * GB,
            total: 4 * GB,
            partial: true,
          },
        },
      },
      "installing",
      "zh-CN",
    );
    expect($("installing-step").textContent).toBe(
      `${zh.stepModel} · ${fill(zh.thisFile, {
        amount: fill(zh.amountOf, { done: "3.0 GB", total: "4.0 GB" }),
      })}`,
    );
  });

  it("words the loader, BYOK and the password change", async () => {
    await openPage(welcome({ state: "checking" }), "welcome", "zh-CN");
    expect($("welcome-checking").getAttribute("aria-label")).toBe(
      zh.gettingReady,
    );
    expect($("checking-skip").textContent).toBe(zh.chooseNow);
    const { push } = await openPage(undefined, undefined, "zh-CN");
    push(state("ready", { email: "admin@gmail.com" }));
    expect($("account-toggle").textContent?.trim()).toBe(zh.accountTitle);
    $("account-toggle").click();
    expect($("account-change-open").textContent).toBe(zh.changePassword);
    $("account-change-open").click();
    expect(($("account-new-password") as HTMLInputElement).placeholder).toBe(
      zh.newPassword,
    );
    expect($("account-new-save-label").textContent).toBe(zh.save);
  });
});

describe("setup page local model plan", () => {
  it("names the model on step 2 with its size, and no badge or link", async () => {
    await openPage(
      welcome({
        ...capable,
        model: {
          name: "inkling-2-mini:Q4_K_M",
          downloadBytes: 15 * GB,
          diskBytes: 18 * GB,
          memoryBytes: 22 * GB,
        },
      }),
      "welcome",
    );
    expect(card("local").getAttribute("aria-checked")).toBe("true");
    expect($("source-local-about").textContent).toBe("On this computer");
    $("source-continue").click();
    expect($("local-model-name").textContent).toBe("inkling-2-mini:Q4_K_M");
    expect($("local-model-needs").textContent).toBe("15.0 GB");
    expect(
      document.querySelector(".featured-pill, .spotlight-link"),
    ).toBeNull();
  });

  it("does not offer a held Inkling 2 Mini", async () => {
    await openPage(
      welcome({
        ...held,
        model: {
          name: "inkling-2-mini:UD-Q4_K_M",
          downloadBytes: 15 * GB,
          diskBytes: 18 * GB,
          memoryBytes: 22 * GB,
        },
      }),
      "welcome",
    );
    expect(card("local").disabled).toBe(true);
    expect(card("subscription").getAttribute("aria-checked")).toBe("true");
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
