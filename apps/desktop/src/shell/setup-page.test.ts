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
        email: "owner@linger.local",
        ...(command.on ? { password: PASSWORD } : {}),
      });
    return current;
  });
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
    expect(run).toHaveBeenCalledWith({ op: "local.account.copy" });
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
const welcome = (localModels: SetupLocalModelsCheck): SetupState => {
  const base = state("idle");
  return { ...base, localServer: { ...base.localServer, localModels } };
};
const installed = (run: ReturnType<typeof vi.fn>) =>
  run.mock.calls
    .map(([command]) => command as SetupCommand)
    .filter((command) => command.op === "local.start");

describe("setup page Quick Install recommendation", () => {
  it("installs the local model with Pi when the localmodels tool recommends it", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    expect($("plan-summary").textContent).toBe(
      "Recommended for this computer: Local model + Pi",
    );
    expect($("plan-why").hidden).toBe(false);
    expect($("plan-why").textContent).toBe(
      "qwen3-8b · fits RTX 4090 · 64 GB memory · 6 GB download",
    );
    expect($("local-install-label").textContent).toBe("Quick Install");
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)).toEqual([{ op: "local.start", runtime: "local" }]),
    );
  });

  it("installs the tool's runtime and says why there is no local model", async () => {
    const { run } = await openPage(welcome(small), "welcome");
    expect($("plan-summary").textContent).toBe(
      "Recommended for this computer: Codex",
    );
    expect($("plan-why").textContent).toBe(
      "No local model fits this computer.",
    );
    expect($("local-row").hidden).toBe(true);
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)).toEqual([{ op: "local.start", runtime: "codex" }]),
    );
  });

  it("holds a local model that needs free memory and checks again on request", async () => {
    const { run } = await openPage(welcome(held), "welcome");
    expect($("plan-summary").textContent).toBe(
      "Recommended for this computer: Codex",
    );
    expect($("plan-why").textContent).toBe(
      "Local model on hold. Other programs are using the memory it needs. Close other programs. Quick Install sets up Codex now, or choose Check again once memory is free.",
    );
    expect($("local-recheck").hidden).toBe(false);
    $("local-customize").click();
    // Subscription is active by default when the local model is on hold;
    // selecting Local model reveals the held card and disables Install.
    expect($("subscription-row").hidden).toBe(false);
    expect($("local-row").hidden).toBe(true);
    document
      .querySelector<HTMLButtonElement>(
        '[data-plan="source"] [data-value="local"]',
      )!
      .click();
    expect($("local-row").hidden).toBe(false);
    expect($("subscription-row").hidden).toBe(true);
    expect($("byok-row").hidden).toBe(true);
    expect($("local-model-name").textContent).toBe("qwen3-8b");
    expect($("local-sub").textContent).toBe(
      "On hold: close other programs, then Check again.",
    );
    expect(($("local-model") as HTMLButtonElement).disabled).toBe(true);
    expect($("local-model").getAttribute("aria-checked")).toBe("false");
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    $("local-recheck").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "local.recheck" }),
    );
    $("local-customize").click();
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)).toEqual([{ op: "local.start", runtime: "codex" }]),
    );
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
    const customizeLocal = () => {
      $("local-customize").click();
      document
        .querySelector<HTMLButtonElement>(
          '[data-plan="source"] [data-value="local"]',
        )!
        .click();
    };
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
    expect($("plan-summary").textContent).toBe(
      "Recommended for this computer: Codex",
    );
    expect($("plan-why").textContent).toBe(
      "Local model on hold. Other programs are using GPU 1's memory (3.0 GB free, 9.0 GB needed). Close programs that use the GPU, such as games, video or other AI apps. Other programs are using the memory it needs (2.7 GB free, 12.7 GB needed). Close other programs. Quick Install sets up Codex now, or choose Check again once memory is free.",
    );
    expect($("local-recheck").hidden).toBe(false);
    customizeLocal();
    expect($("local-sub").textContent).toBe(
      "On hold: GPU 1 has 3.0 GB free, needs 9.0 GB",
    );
    expect(document.body.textContent).not.toContain(TOOL_WORDS);
    // A tool that counts only the plan's memory: the RAM counts from it.
    await openPage(
      welcome(withCounts([reason({ code: "free-memory-required" })])),
      "welcome",
    );
    expect($("plan-why").textContent).toBe(
      "Local model on hold. Other programs are using the memory it needs (2.7 GB free, 12.7 GB needed). Close other programs. Quick Install sets up Codex now, or choose Check again once memory is free.",
    );
    customizeLocal();
    expect($("local-sub").textContent).toBe(
      "On hold: 2.7 GB of memory free, needs 12.7 GB",
    );
  });

  it("holds local models without a plan for gateway-port-in-use and harness-unavailable and offers Check again", async () => {
    for (const [code, expectWhy, expectSub] of [
      [
        "gateway-port-in-use",
        "Another program is using the port Linger's local model gateway needs. Close the program using that port.",
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
        `Local model on hold. ${expectWhy} Quick Install sets up Codex now, or choose Check again once the issue is resolved.`,
      );
      expect($("plan-why").textContent).not.toContain("memory is free");
      expect($("local-recheck").hidden).toBe(false);
      $("local-customize").click();
      document
        .querySelector<HTMLButtonElement>(
          '[data-plan="source"] [data-value="local"]',
        )!
        .click();
      expect($("local-model").hidden).toBe(false);
      expect($("local-model-name").textContent).toBe("Local model on hold");
      expect($("local-model-needs").textContent).toBe(expectWhy);
      expect($("local-sub").textContent).toBe(expectSub);
      expect(($("local-model") as HTMLButtonElement).disabled).toBe(true);
      $("local-recheck").click();
      await vi.waitFor(() =>
        expect(run).toHaveBeenCalledWith({ op: "local.recheck" }),
      );
      expect(document.body.textContent).not.toContain(TOOL_WORDS);
    }
  });

  it("holds local models without a plan for blocked-now CUDA driver blockers without duplicating Check again", async () => {
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
      "Local model on hold. Your NVIDIA driver supports CUDA 12.1, but local models require NVIDIA driver 550+ (CUDA 12.4). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again. Quick Install sets up Codex now.",
    );
    expect(
      $("plan-why").textContent?.match(/choose Check again/g),
    ).toHaveLength(1);
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
    $("local-customize").click();
    document
      .querySelector<HTMLButtonElement>(
        '[data-plan="source"] [data-value="local"]',
      )!
      .click();
    expect($("local-model").hidden).toBe(false);
    expect($("local-model-name").textContent).toBe("Local model on hold");
    expect($("local-sub").textContent).toBe(
      "On hold: update your NVIDIA driver, then Check again.",
    );
    expect($("local-model-needs").textContent).toBe(
      "Your NVIDIA driver supports CUDA 12.1, but local models require NVIDIA driver 550+ (CUDA 12.4). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
    );
    expect(($("local-model") as HTMLButtonElement).disabled).toBe(true);
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
        "Local model on hold. Other work is running on the GPU. Close it.",
      ],
      [
        { ...held, reasons: [reason({ code: "plan-unavailable" })] },
        "Local model on hold. Another app is holding the memory it needs, such as another AI app. Quit it.",
      ],
      [
        { ...small, reasons: [reason({ code: "gpu-ownership-unknown" })] },
        "Linger couldn't tell which programs are using the GPU, so it can't share it. Close programs that use the GPU.",
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
    await openPage(
      welcome({
        ...small,
        reasons: [reason({ code: "gpu-ownership-unknown" })],
      }),
      "welcome",
    );
    $("local-customize").click();
    document
      .querySelector<HTMLButtonElement>(
        '[data-plan="source"] [data-value="local"]',
      )!
      .click();
    expect($("local-row").hidden).toBe(false);
    expect($("local-model").hidden).toBe(false);
    expect(($("local-model") as HTMLButtonElement).disabled).toBe(true);
    expect($("local-model").getAttribute("aria-checked")).toBe("false");
    expect($("local-model-name").textContent).toBe(
      "Not available on this computer",
    );
    expect($("local-model-needs").textContent).toBe(
      "Linger couldn't tell which programs are using the GPU, so it can't share it. Close programs that use the GPU.",
    );
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain(TOOL_WORDS);
  });

  it("explains an outdated NVIDIA driver and lets the user check again", async () => {
    const { run } = await openPage(
      welcome({
        ...small,
        reasons: [
          reason({
            code: "cuda-driver-update-required",
            detectedCudaVersion: "12.1",
            requiredCudaVersion: "12.4",
            driverVersion: "535.98",
          }),
        ],
      }),
      "welcome",
    );
    expect($("plan-why").textContent).toBe(
      "Your NVIDIA driver supports CUDA 12.1, but local models require NVIDIA driver 550+ (CUDA 12.4). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
    );
    expect($("local-recheck").hidden).toBe(false);
    $("local-customize").click();
    document
      .querySelector<HTMLButtonElement>(
        '[data-plan="source"] [data-value="local"]',
      )!
      .click();
    expect($("local-model-name").textContent).toBe(
      "Not available on this computer",
    );
    expect($("local-model-needs").textContent).toBe(
      "Your NVIDIA driver supports CUDA 12.1, but local models require NVIDIA driver 550+ (CUDA 12.4). Update your NVIDIA graphics driver (no CUDA Toolkit needed), then choose Check again.",
    );
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    $("local-recheck").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({ op: "local.recheck" }),
    );
    expect(document.body.textContent).not.toContain(TOOL_WORDS);
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

  it("says the stack's memory covers the model and its services", async () => {
    await openPage(welcome(capable), "welcome");
    $("local-customize").click();
    expect($("local-model-needs").textContent).toBe(
      "6 GB download · 8 GB disk · 12 GB memory with its services",
    );
  });

  it("lets the installer pick when this computer could not be checked", async () => {
    const { run } = await openPage(
      welcome({ state: "unavailable" }),
      "welcome",
    );
    expect($("plan-summary").textContent).toBe("Best AI runtime");
    expect($("plan-why").textContent).toBe(
      "Couldn't check this computer for a local model.",
    );
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)).toEqual([
        { op: "local.start", runtime: "recommended" },
      ]),
    );
  });

  it("says what Quick Install waits for until the check ends", async () => {
    const { push } = await openPage(welcome({ state: "checking" }), "welcome");
    const button = $("local-install") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect($("local-install-label").textContent).toBe(
      "Checking this computer…",
    );
    expect($("local-install-label").querySelector(".spinner")).not.toBeNull();
    expect($("plan-summary").textContent).toBe(
      "Finding the best setup for this computer",
    );
    // The first run downloads the localmodels tool before checking.
    push(
      welcome({
        state: "checking",
        download: { completed: 12 * 1024 ** 2, total: 69 * 1024 ** 2 },
      }),
    );
    expect($("local-install-label").textContent).toBe(
      "Downloading setup tools…",
    );
    expect($("plan-why").textContent).toBe("12 MB of 69 MB · 57 MB left");
    expect($("plan-why").hidden).toBe(false);
    push(welcome(capable));
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect($("local-install-label").textContent).toBe("Quick Install");
    expect($("plan-summary").textContent).toBe(
      "Recommended for this computer: Local model + Pi",
    );
  });

  it("follows the tool's pick when Auto was chosen during the check", async () => {
    const { run, push } = await openPage(
      welcome({ state: "checking" }),
      "welcome",
    );
    $("local-customize").click();
    const source = (value: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-plan="source"] [data-value="${value}"]`,
      )!;
    const option = (value: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-plan="runtime"] [data-value="${value}"]`,
      )!;
    option("recommended").click();
    push(welcome(capable));
    expect(source("local").getAttribute("aria-checked")).toBe("true");
    expect($("local-row").hidden).toBe(false);
    expect($("subscription-row").hidden).toBe(true);
    expect($("byok-row").hidden).toBe(true);
    expect($("local-model").getAttribute("aria-checked")).toBe("true");
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)).toEqual([{ op: "local.start", runtime: "local" }]),
    );
  });

  it("marks the recommendation under Customize and keeps model sources mutually exclusive", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    $("local-customize").click();
    const source = (value: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-plan="source"] [data-value="${value}"]`,
      )!;
    const option = (value: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-plan="runtime"] [data-value="${value}"]`,
      )!;
    expect(source("local").dataset.recommended).toBe("true");
    expect(source("local").getAttribute("aria-checked")).toBe("true");
    expect(source("subscription").dataset.recommended).toBe("false");
    expect($("local-row").hidden).toBe(false);
    expect($("subscription-row").hidden).toBe(true);
    expect($("byok-row").hidden).toBe(true);
    expect($("local-sub").textContent).toContain(
      "Recommended for this computer",
    );
    expect($("local-model").getAttribute("aria-checked")).toBe("true");
    source("subscription").click();
    expect($("local-row").hidden).toBe(true);
    expect($("subscription-row").hidden).toBe(false);
    expect($("byok-row").hidden).toBe(true);
    option("claude").click();
    expect($("local-install-label").textContent).toBe("Install");
    $("local-install").click();
    await vi.waitFor(() =>
      expect(installed(run)).toEqual([
        { op: "local.start", runtime: "claude" },
      ]),
    );
    $("local-customize").click();
    expect($("local-install-label").textContent).toBe("Quick Install");
    expect($("plan-summary").textContent).toBe(
      "Recommended for this computer: Local model + Pi",
    );
  });

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

  it("builds the request address from base URL, path and endpoint, with tooltip, refresh, Test and secret scrubbing", async () => {
    const { run } = await openPage(welcome(small), "welcome");
    $("local-customize").click();
    const byokSource = document.querySelector<HTMLButtonElement>(
      '[data-plan="source"] [data-value="byok"]',
    )!;
    expect(byokSource.getAttribute("aria-describedby")).toBe("byok-tip-text");
    expect($("byok-tip-text").textContent).toContain("Bring Your Own Key");
    byokSource.click();
    expect($("byok-row").hidden).toBe(false);
    expect($("local-row").hidden).toBe(true);
    expect($("subscription-row").hidden).toBe(true);
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(true);
    // Grey defaults: /v1, and the runtime's own endpoint.
    const path = $("byok-path") as HTMLInputElement;
    const endpoint = $("byok-endpoint") as HTMLInputElement;
    expect(path.value).toBe("/v1");
    expect(endpoint.value).toBe("/messages");
    expect(path.parentElement!.dataset.default).toBe("true");
    expect(endpoint.parentElement!.dataset.default).toBe("true");
    expect($("byok-status").textContent).toBe(
      "Grey values are defaults. Path and endpoint are optional.",
    );

    document
      .querySelector<HTMLButtonElement>(
        '[data-byok="runtime"] [data-value="codex"]',
      )!
      .click();
    expect(endpoint.value).toBe("/responses");
    type("byok-url", "https://open.bigmodel.cn/");
    pick("byok-path", "/api/paas/v4");
    expect(path.value).toBe("/api/paas/v4");
    expect(path.parentElement!.dataset.default).toBe("false");
    pick("byok-endpoint", "/chat/completions");
    expect($("byok-status").textContent).toBe(
      "Sends OpenAI Chat Completions requests to https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
    type("byok-key", "sk-top-secret");

    // Refresh lists the endpoint's models and opens them.
    expect(($("byok-test") as HTMLButtonElement).disabled).toBe(true);
    run.mockImplementationOnce(async () =>
      withLocal(welcome(small), {
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
    expect(($("local-install") as HTMLButtonElement).disabled).toBe(false);
    expect($("plan-summary").textContent).toBe("BYOK · Codex · glm-4.6");

    // Test sends one request and floats the outcome under the button.
    run.mockImplementationOnce(async () =>
      withLocal(welcome(small), {
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
    const config = { ...endpointOf, modelId: "glm-4.6", runtime: "codex" };
    expect(run).toHaveBeenCalledWith({ op: "local.byok.check", byok: config });
    await vi.waitFor(() => expect($("byok-toast").hidden).toBe(false));
    expect($("byok-toast").dataset.tone).toBe("ok");
    expect(words("byok-toast")).toBe(
      "Connected glm-4.6 · 200k context · OpenAI Chat Completionshttps://open.bigmodel.cn/api/paas/v4/chat/completions",
    );

    $("local-install").click();
    await vi.waitFor(() => {
      expect(installed(run)).toEqual([
        { op: "local.start", runtime: "codex", byok: config },
      ]);
      expect(($("byok-key") as HTMLInputElement).value).toBe("");
    });
  });

  it("sends a pasted full address as is, and keeps a failed test until the fields change", async () => {
    const { run } = await openPage(welcome(small), "welcome");
    $("local-customize").click();
    document
      .querySelector<HTMLButtonElement>(
        '[data-plan="source"] [data-value="byok"]',
      )!
      .click();
    type("byok-url", "https://llm.example.com/gateway");
    pick("byok-path", "");
    pick("byok-endpoint", "");
    expect(($("byok-path") as HTMLInputElement).value).toBe("");
    // No known ending: the Claude Code runtime's own format.
    expect($("byok-status").textContent).toBe(
      "Sends Anthropic Messages (the Claude Code format) requests to https://llm.example.com/gateway",
    );
    type("byok-path", "a//b");
    expect($("byok-status").dataset.tone).toBe("err");
    expect(($("byok-list") as HTMLButtonElement).disabled).toBe(true);
    type("byok-path", "");
    type("byok-model", "claude-sonnet-4-6");

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
        protocol: "anthropic",
        modelId: "claude-sonnet-4-6",
        runtime: "claude",
      },
    });
    await vi.waitFor(() => expect($("byok-toast").hidden).toBe(false));
    expect($("byok-toast").dataset.tone).toBe("err");
    expect(words("byok-toast")).toBe(
      "Couldn't connect Nothing answered at https://llm.example.com/gateway (HTTP 404).",
    );
    type("byok-model", "claude-opus-4-1");
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
    expect($("signin-byok-list")).not.toBeNull();
    expect($("signin-byok-test")).not.toBeNull();
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

describe("setup page refused install location", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  const message = (folder: string) =>
    `Windows private path validation failed: ${folder} is inside a folder other accounts on this computer can rename or replace. Use a current-user owned local directory without links or shared access.`;
  const failed = (
    location: string,
    reason?: NonNullable<SetupState["localServer"]["refusal"]>["reason"],
  ): SetupState => {
    const base = state("failed");
    return {
      ...base,
      platform: "win32",
      localServer: {
        ...base.localServer,
        message: message(location),
        location: { path: location, custom: true },
        ...(reason
          ? { refusal: { code: "WINDOWS_PRIVATE_PATH_UNSAFE", reason } }
          : {}),
      },
    };
  };

  const usual = "Your data is kept. Fix the problem and try again.";

  it("says where to install when a nested folder on a drive is refused", async () => {
    const folder = "D:\\Software\\Linger";
    const { push } = await openPage(failed(folder, "UNSAFE_PARENT_ACCESS"));
    expect($("installing-error").textContent).toBe(message(folder));
    expect($("installing-plan").textContent).toBe(
      "Go back and set the install location to the drive itself (Linger installs into D:\\Linger) or an empty folder directly on the drive.",
    );
    // The hint leaves with the failure.
    push(state("installing"));
    expect($("installing-plan").textContent).toBe(
      "This takes a few minutes. You can keep working.",
    );
  });

  it("gives no hint the person has already followed", async () => {
    // Directly on the drive, the drive's own permissions are what refuse it.
    await openPage(failed("E:\\Linger", "UNSAFE_PARENT_ACCESS"));
    expect($("installing-plan").textContent).toBe(usual);
  });

  it("keeps the hint to this refusal, known by its code", async () => {
    await openPage(failed("D:\\Software\\Linger", "UNSAFE_OWNER"));
    expect($("installing-plan").textContent).toBe(usual);
    // The words alone do not bring the hint.
    await openPage(failed("D:\\Software\\Linger"));
    expect($("installing-plan").textContent).toBe(usual);
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
    expect($("plan-summary").textContent).toBe(
      fill(zh.recommendedPlan, { plan: zh.localModelPi }),
    );
    expect($("plan-why").textContent).toBe(
      [
        "qwen3-8b",
        fill(zh.fitsGpu, { gpu: "RTX 4090" }),
        fill(zh.memoryAmount, { size: "64 GB" }),
        fill(zh.downloadAmount, { size: "6 GB" }),
      ].join(" · "),
    );
    expect($("local-install-label").textContent).toBe(zh.quickInstall);
  });

  it("words a held local model from the catalog", async () => {
    await openPage(welcome(held), "welcome", "zh-CN");
    expect($("plan-why").textContent).toBe(
      fill(zh.heldWhy, { reasons: zh.reasonHeld, plan: "Codex" }),
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

  it("localizes the Inkling 2 Mini spotlight in both recommended and library states", async () => {
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
    expect($("plan-featured-badge").hidden).toBe(false);
    expect($("plan-featured-badge").textContent).toBe(zh.featuredPartnerBadge);
    expect($("featured-spotlight").hidden).toBe(false);
    expect($("featured-spotlight-note").textContent).toBe(
      zh.featuredModelSelected,
    );
    expect($("featured-spotlight-link").textContent).toBe(zh.learnMoreLink);
    expect(
      $("featured-spotlight").querySelector(".spotlight-specs")!.textContent,
    ).toBe(zh.featuredModelSpecs);

    $("local-customize").click();
    expect($("local-model-featured").hidden).toBe(false);
    expect($("local-model-featured").textContent).toBe(zh.featuredPartnerBadge);
    expect($("local-spotlight-text").textContent).toBe(zh.featuredModelSpecs);
    expect($("local-spotlight-link").textContent).toBe(zh.learnMoreLink);

    await openPage(welcome(capable), "welcome", "zh-CN");
    expect($("plan-featured-badge").hidden).toBe(true);
    expect($("featured-spotlight").hidden).toBe(false);
    expect($("featured-spotlight-note").textContent).toBe(
      zh.featuredModelLibraryNote,
    );
    expect($("featured-spotlight-link").textContent).toBe(
      zh.thinkingMachinesLink,
    );
    $("local-customize").click();
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

  it("emphasizes Inkling 2 Mini directly in the plan line and local model card when recommended", async () => {
    const { run } = await openPage(welcome(inklingCapable()), "welcome");
    expect($("plan-summary").textContent).toBe(
      "Recommended for this computer: Local model + Pi",
    );
    expect($("plan-featured-badge").hidden).toBe(false);
    expect($("plan-featured-badge").textContent).toBe(
      "Featured · Thinking Machines",
    );
    expect($("featured-spotlight").hidden).toBe(false);
    expect($("featured-spotlight").dataset.recommended).toBe("true");
    expect($("featured-spotlight-note").textContent).toBe(
      "Selected for Quick Install on this computer.",
    );
    expect($("featured-spotlight-link").textContent).toBe("Learn more ↗");

    $("featured-spotlight-link").click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        op: "external.open",
        url: INKLING_2_MINI_ANNOUNCEMENT_URL,
      }),
    );

    $("local-customize").click();
    expect($("featured-spotlight").hidden).toBe(true);
    expect($("plan-featured-badge").hidden).toBe(true);
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
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
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
    expect($("plan-featured-badge").hidden).toBe(false);
    expect($("featured-spotlight").dataset.recommended).toBe("true");
  });

  it("shows the library spotlight strip with Thinking Machines link when another model or subscription is recommended", async () => {
    for (const check of [capable, small, held]) {
      const { run } = await openPage(welcome(check), "welcome");
      expect($("plan-featured-badge").hidden).toBe(true);
      expect($("featured-spotlight").hidden).toBe(false);
      expect($("featured-spotlight").dataset.recommended).toBe("false");
      expect($("featured-spotlight-note").textContent).toContain(
        "Settings → Models",
      );
      expect($("featured-spotlight-link").textContent).toBe(
        "Thinking Machines ↗",
      );

      $("featured-spotlight-link").click();
      await vi.waitFor(() =>
        expect(run).toHaveBeenCalledWith({
          op: "external.open",
          url: INKLING_2_MINI_ANNOUNCEMENT_URL,
        }),
      );

      $("local-customize").click();
      document
        .querySelector<HTMLButtonElement>(
          '[data-plan="source"] [data-value="local"]',
        )!
        .click();
      expect($("local-model-featured").hidden).toBe(true);
      expect($("local-spotlight").dataset.recommended).toBe("false");
      expect($("local-spotlight-text").textContent).toContain(
        "Settings → Models",
      );
      expect($("local-spotlight-link").textContent).toBe("Thinking Machines ↗");
      $("local-spotlight-link").click();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    }
  });

  it("badges a held Inkling 2 Mini card in Customize without claiming Quick Install selected it", async () => {
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
    expect($("plan-featured-badge").hidden).toBe(true);
    expect($("featured-spotlight").dataset.recommended).toBe("false");
    $("local-customize").click();
    document
      .querySelector<HTMLButtonElement>(
        '[data-plan="source"] [data-value="local"]',
      )!
      .click();
    expect($("local-model-name").textContent).toBe("inkling-2-mini:UD-Q4_K_M");
    expect($("local-model-featured").hidden).toBe(false);
    expect($("local-spotlight").dataset.recommended).toBe("true");
    expect($("local-spotlight-link").textContent).toBe("Learn more ↗");
  });

  it("hides the featured spotlight when local installation is unavailable", async () => {
    const base = welcome(small);
    await openPage(
      { ...base, localServer: { ...base.localServer, available: false } },
      "welcome",
    );
    expect($("featured-spotlight").hidden).toBe(true);
    expect($("plan-featured-badge").hidden).toBe(true);
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
