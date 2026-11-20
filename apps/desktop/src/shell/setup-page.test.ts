// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SetupCommand,
  SetupLocalAccount,
  SetupLocalModelsCheck,
  SetupReason,
  SetupState,
} from "../shared/setup.js";

const page = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "setup.html"),
  "utf8",
);
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
) => {
  stopPage();
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  stopPage = () => {
    intervals.forEach(clearInterval);
    timeouts.forEach(clearTimeout);
  };
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
    // Subscription is active by default when the local model is on hold;
    // selecting Local model directly reveals the held card and disables Install.
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
    document
      .querySelector<HTMLButtonElement>(
        '[data-plan="source"] [data-value="subscription"]',
      )!
      .click();
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

  it("shows model sources directly on first launch and keeps them mutually exclusive", async () => {
    const { run } = await openPage(welcome(capable), "welcome");
    const source = (value: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-plan="source"] [data-value="${value}"]`,
      )!;
    const option = (value: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-plan="runtime"] [data-value="${value}"]`,
      )!;
    expect($("local-setup").hidden).toBe(false);
    expect($("local-options").dataset.open).toBe("false");
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
    source("local").click();
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

  it("lets first-time users skip local models with BYOK directly, even while checking hardware", async () => {
    const { run, push } = await openPage(
      welcome({ state: "checking" }),
      "welcome",
    );
    const installButton = $("local-install") as HTMLButtonElement;
    expect(installButton.disabled).toBe(true);
    expect(installButton.getAttribute("aria-busy")).toBe("true");
    expect($("local-skip-hint").hidden).toBe(false);

    // Clicking "Use BYOK instead" immediately skips waiting for the local model probe.
    $("local-skip-to-byok").click();
    expect($("byok-row").hidden).toBe(false);
    expect(installButton.getAttribute("aria-busy")).toBe("false");
    expect($("local-install-label").textContent).toBe("Install with BYOK");
    expect(installButton.disabled).toBe(true);

    type("byok-url", "https://api.anthropic.com");
    type("byok-key", "sk-ant-demo");
    type("byok-model", "claude-sonnet-4-6");

    // Install is enabled even while hardware check is still running.
    expect(installButton.disabled).toBe(false);

    // Toggling More options does not discard BYOK inputs.
    $("local-customize").click();
    expect($("local-options").dataset.open).toBe("true");
    $("local-customize").click();
    expect($("local-options").dataset.open).toBe("false");
    expect($("byok-row").hidden).toBe(false);
    expect(($("byok-url") as HTMLInputElement).value).toBe(
      "https://api.anthropic.com",
    );

    // When the background hardware check finishes recommending a local model,
    // the user's BYOK selection stays intact.
    push(welcome(capable));
    expect($("byok-row").hidden).toBe(false);
    expect($("local-install-label").textContent).toBe("Install with BYOK");

    installButton.click();
    await vi.waitFor(() =>
      expect(installed(run)).toEqual([
        {
          op: "local.start",
          runtime: "claude",
          byok: {
            runtime: "claude",
            baseUrl: "https://api.anthropic.com",
            path: "/v1",
            endpoint: "/messages",
            protocol: "anthropic",
            apiKey: "sk-ant-demo",
            modelId: "claude-sonnet-4-6",
          },
        },
      ]),
    );
  });

  it("builds the request address from base URL, path and endpoint, with tooltip, refresh, Test and secret scrubbing", async () => {
    const { run } = await openPage(welcome(small), "welcome");
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
    expect($("local-install-label").textContent).toBe("Install with BYOK");
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
