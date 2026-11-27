import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import { OFFLINE_COMPUTER_HINT } from "./agent-move-target";
import { agentRuntimeMessages } from "./agent-runtime.messages";
import {
  type AgentRuntimeField,
  EditAgentRuntimeDialog,
  type AgentRuntimeUpdateInput,
} from "./edit-agent-runtime-dialog";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

describe("EditAgentRuntimeDialog", () => {
  it("shows the saved model as it is while the computers load", () => {
    renderDialog({ onSave: vi.fn(), computersPending: true });
    expect(setting("Model")).toHaveTextContent("codex-default");
    expect(setting("Model")).not.toHaveTextContent(/Unavailable/);
  });

  it("preserves a removed model and requires an explicit selection", async () => {
    const registration = localCodexAgent();
    registration.runtime.model = "removed-model";
    const onSave = vi.fn();
    renderDialog({ registration, onSave });
    await screen.findByText(
      "The current model is unavailable. Choose another model.",
    );
    expect(setting("Model")).toHaveTextContent("removed-model · Unavailable");
    const list = await openSetting("Model");
    const removed = within(list).getByRole("option", {
      name: "removed-model · Unavailable",
    });
    expect(removed).toHaveAttribute("aria-selected", "true");
    expect(removed).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("keeps the saved Reasoning beside an unavailable model", async () => {
    const registration = localCodexAgent();
    registration.runtime.model = "removed-model";
    registration.runtime.reasoning_effort = "medium";
    renderDialog({ registration, onSave: vi.fn(), field: "model" });
    await screen.findByText(
      "The current model is unavailable. Choose another model.",
    );
    const reasoning = setting("Reasoning");
    expect(reasoning).toHaveTextContent("Medium · Unavailable");
    expect(reasoning).toBeDisabled();
    fireEvent.click(reasoning);
    expect(reasoning).toHaveAttribute("aria-expanded", "false");
  });
  it("shows a known empty catalog without restoring defaults", async () => {
    const computer = localComputer("computer-old", "Old Mac", "online");
    computer.runtimes = computer.runtimes.map((runtime) => ({
      ...runtime,
      models: [],
    }));
    renderDialog({ onSave: vi.fn(), computersOverride: { items: [computer] } });
    await screen.findByText("No models are available for this runtime.");
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
  });
  it.each([
    ["model", false],
    ["reasoning", true],
  ] as const)(
    "locks the placement when opened from %s",
    async (field, modelLocked) => {
      renderDialog({ onSave: vi.fn(), field });
      await waitFor(() =>
        expect(setting("Model")).toHaveTextContent("Codex default"),
      );
      expect(setting("Computer")).toBeDisabled();
      expect(setting("Runtime")).toBeDisabled();
      expect(setting("Model")).toHaveProperty("disabled", modelLocked);
    },
  );
  it("edits the model and reasoning without changing the bound Computer or workspace", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    renderDialog({ onSave });
    await waitFor(() =>
      expect(setting("Model")).toHaveTextContent("Codex default"),
    );
    const computer = setting("Computer");
    expect(computer).toHaveTextContent("Old Mac");
    // The composer opens the full Runtime settings, so the Computer stays
    // selectable there; leaving it alone keeps the bound placement.
    expect(computer).toBeEnabled();
    await choose("Model", "Codex fast");
    await choose("Reasoning", "High");
    fireEvent.click(screen.getByRole("button", { name: "Save Runtime" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: {
        model: "codex-fast",
        reasoning_effort: "high",
        placement: localCodexAgent().runtime.placement,
      },
    });
  });

  it("opens a setting's choices in a list that closes once one is chosen", async () => {
    renderDialog({ onSave: vi.fn() });
    const model = await screen.findByRole("combobox", { name: "Agent model" });
    await waitFor(() => expect(model).toHaveTextContent("Codex default"));
    // No setting starts open.
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(model).toHaveAttribute("aria-expanded", "false");

    const list = await openSetting("Model");
    expect(model).toHaveAttribute("aria-expanded", "true");
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Codex default", "Codex fast"]);
    fireEvent.click(within(list).getByRole("option", { name: "Codex fast" }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(model).toHaveAttribute("aria-expanded", "false");
    expect(model).toHaveTextContent("Codex fast");
  });

  it.each(["computer", "workspace"])(
    "never falls back to a different %s if the configured binding is missing",
    async (missing) => {
      const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
      const registration = localCodexAgent();
      if (registration.runtime.placement?.type === "local") {
        if (missing === "computer")
          registration.runtime.placement.computer_id = "computer-removed";
        else
          registration.runtime.placement.workspace_grant_id = "grant-removed";
      }
      renderDialog({ onSave, registration });
      await screen.findByText("Runtime options are unavailable.");
      expect(
        screen.getByRole("button", { name: "Save Runtime" }),
      ).toBeDisabled();
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it("keeps the form usable when a background computer refetch fails with cached data", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const listTenantLocalComputers = vi
      .fn()
      .mockResolvedValueOnce({
        items: [localComputer("computer-old", "Old Mac", "online")],
      })
      .mockRejectedValueOnce(new Error("transient network error"));
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <EditAgentRuntimeDialog
            client={{ listTenantLocalComputers }}
            isPending={false}
            onClose={vi.fn()}
            onSave={onSave}
            registration={localCodexAgent()}
            tenantId="tenant-northstar"
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const save = await screen.findByRole("button", { name: "Save Runtime" });
    await waitFor(() => expect(save).toBeEnabled());
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: localComputersQueryKey("tenant-northstar"),
      });
    });
    expect(listTenantLocalComputers).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("Runtime options are unavailable."),
    ).not.toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it("renders dynamic model-advertised reasoning efforts like minimal and future tokens", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const computer = localComputer("computer-old", "Old Mac", "online");
    computer.runtimes[1] = {
      type: "codex",
      status: "ready",
      models: [
        {
          id: "codex-default",
          label: "Codex default",
          allowed_reasoning_effort: ["minimal", "low", "custom_tier"],
          default_reasoning_effort: "minimal",
        },
      ],
    };
    renderDialog({ onSave, computersOverride: { items: [computer] } });
    await waitFor(() =>
      expect(setting("Reasoning")).toHaveTextContent("Minimal"),
    );
    await choose("Reasoning", "Custom tier");
    fireEvent.click(screen.getByRole("button", { name: "Save Runtime" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: {
        model: "codex-default",
        reasoning_effort: "custom_tier",
        placement: localCodexAgent().runtime.placement,
      },
    });
  });

  it.each(["claude", "pi"] as const)(
    "switches local runtime to %s while retaining the Computer and transport",
    async (type) => {
      const onSave = vi.fn();
      const computer = localComputer("computer-old", "Old Mac", "online");
      computer.runtimes = [
        ...computer.runtimes.filter((item) => item.type !== type),
        {
          type,
          status: "ready",
          models: [{ id: "custom-model", label: "Custom model" }],
        },
      ];
      renderDialog({ onSave, computersOverride: { items: [computer] } });
      await waitFor(() =>
        expect(setting("Runtime")).toHaveTextContent("Codex"),
      );
      await choose("Runtime", type === "pi" ? "Pi" : "Claude Code", "Ready");
      await waitFor(() =>
        expect(setting("Model")).toHaveTextContent("Custom model"),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save Runtime" }));
      expect(onSave).toHaveBeenCalledWith({
        runtime: {
          model: "custom-model",
          placement: {
            ...localCodexAgent().runtime.placement,
            runtime_type: type,
          },
        },
      });
    },
  );

  it("names a missing runtime and gives its install command", async () => {
    const computer = localComputer("computer-old", "Old Mac", "online", {
      platform: "darwin",
    });
    computer.runtimes = [
      ...computer.runtimes,
      {
        error_code: "RUNTIME_NOT_INSTALLED",
        message: "Runtime executable not found",
        models: [],
        status: "not_installed",
        type: "pi",
      },
    ];
    renderDialog({ computersOverride: { items: [computer] }, onSave: vi.fn() });
    await choose("Runtime", "Pi", "Not installed");
    expect(
      screen.getByText("npm install -g @earendil-works/pi-coding-agent"),
    ).toBeVisible();
    expect(
      screen.queryByText("Runtime executable not found"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
  });

  it("tells the owner to update an incompatible Antigravity CLI with agy update", async () => {
    const computer = localComputer("computer-old", "Old Mac", "online", {
      platform: "darwin",
    });
    computer.runtimes = [
      ...computer.runtimes,
      {
        error_code: "RUNTIME_INCOMPATIBLE",
        message: "antigravity version 1.5.9 is below minimum 1.5.12",
        models: [],
        status: "incompatible",
        type: "antigravity",
        version: "1.5.9",
      },
    ];
    renderDialog({ computersOverride: { items: [computer] }, onSave: vi.fn() });
    await choose("Runtime", "Antigravity", "Update needed");
    expect(screen.getByText("Antigravity update required")).toBeVisible();
    expect(
      screen.getByText("antigravity version 1.5.9 is below minimum 1.5.12"),
    ).toBeVisible();
    expect(screen.getByText("agy update")).toBeVisible();
    expect(
      screen.queryByText("The npm commands need Node.js."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
  });

  it("reports a Linger Computer upgrade instead of an AI app update when upgrade_required is set", async () => {
    const computer = localComputer("computer-old", "Old Mac", "online", {
      platform: "darwin",
      upgrade_required: true,
    });
    renderDialog({ computersOverride: { items: [computer] }, onSave: vi.fn() });
    const link = await screen.findByRole("link", {
      name: "Settings › Computers",
    });
    expect(link.closest("div")).toHaveTextContent(
      "Old Mac needs a Linger update.",
    );
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
  });

  it("picks a model once the chosen runtime turns ready while open", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const computer = localComputer("computer-old", "Old Mac", "online");
    // A signed-out runtime reports no models until it is ready.
    const claudeModels = computer.runtimes[0]!.models;
    computer.runtimes[0] = { ...computer.runtimes[0]!, models: [] };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderDialog({
      computersOverride: { items: [computer] },
      onSave,
      queryClient,
    });
    await choose("Runtime", "Claude Code", "Sign-in required");
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();

    await act(async () => {
      queryClient.setQueryData(localComputersQueryKey("tenant-northstar"), {
        items: [
          {
            ...computer,
            runtimes: computer.runtimes.map((item) =>
              item.type === "claude"
                ? {
                    models: claudeModels,
                    status: "ready" as const,
                    type: item.type,
                  }
                : item,
            ),
          },
        ],
      });
    });
    await waitFor(() =>
      expect(setting("Model")).toHaveTextContent("Claude default"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Runtime" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: {
        model: "claude-default",
        placement: {
          computer_id: "computer-old",
          runtime_type: "claude",
          type: "local",
          workspace_grant_id: "grant-workspace",
        },
      },
    });
  });

  it("blocks an unauthenticated target and allows choosing a ready runtime again", async () => {
    const onSave = vi.fn();
    renderDialog({ onSave });
    await waitFor(() => expect(setting("Runtime")).toHaveTextContent("Codex"));
    await choose("Runtime", "Claude Code", "Sign-in required");
    expect(screen.getByText("Claude Code sign-in required")).toBeVisible();
    expect(screen.getByText("claude auth login")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
    await choose("Runtime", "Codex", "Ready");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save Runtime" }),
      ).toBeEnabled(),
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves on an offline Computer from its last reported Runtimes", async () => {
    renderDialog({
      onSave: vi.fn(),
      computersOverride: {
        items: [localComputer("computer-old", "Old Mac", "offline")],
      },
    });
    await screen.findByText(OFFLINE_COMPUTER_HINT);
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeEnabled();
  });

  it("moves to another computer keeping the ready runtime, model, and reasoning", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const registration = localCodexAgent();
    registration.runtime.model = "codex-fast";
    registration.runtime.reasoning_effort = "high";
    const target = localComputer("computer-new", "New Mac", "online", {
      workspace_grants: [
        { grant_id: "grant-read", label: "Read only", mode: "read-only" },
        {
          grant_id: "grant-new-workspace",
          label: "New workspace",
          mode: "workspace-write",
        },
      ],
    });
    renderDialog({
      computersOverride: {
        items: [localComputer("computer-old", "Old Mac", "online"), target],
      },
      field: "computer",
      onSave,
      registration,
    });
    await waitFor(() =>
      expect(setting("Computer")).toHaveTextContent("Old Mac"),
    );
    expect(screen.queryByText(agentRuntimeMessages.moveHint.source)).toBeNull();
    await choose("Computer", "New Mac", "Online");
    expect(setting("Runtime")).toHaveTextContent("Codex");
    expect(setting("Model")).toHaveTextContent("Codex fast");
    expect(setting("Reasoning")).toHaveTextContent("High");
    expect(
      screen.getByText(agentRuntimeMessages.moveHint.source),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Move Agent" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: {
        model: "codex-fast",
        reasoning_effort: "high",
        placement: {
          computer_id: "computer-new",
          runtime_type: "codex",
          type: "local",
          workspace_grant_id: "grant-new-workspace",
        },
      },
    });
  });

  it("falls back to the target's first model and its default reasoning", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const registration = localCodexAgent();
    registration.runtime.model = "codex-fast";
    registration.runtime.reasoning_effort = "high";
    const target = localComputer("computer-new", "New Mac", "online");
    target.runtimes = [
      {
        models: [
          {
            id: "codex-next",
            label: "Codex next",
            allowed_reasoning_effort: ["low", "medium"],
            default_reasoning_effort: "medium",
          },
        ],
        status: "ready",
        type: "codex",
      },
    ];
    renderDialog({
      computersOverride: {
        items: [localComputer("computer-old", "Old Mac", "online"), target],
      },
      field: "computer",
      onSave,
      registration,
    });
    await waitFor(() =>
      expect(setting("Computer")).toHaveTextContent("Old Mac"),
    );
    await choose("Computer", "New Mac", "Online");
    expect(setting("Model")).toHaveTextContent("Codex next");
    expect(setting("Reasoning")).toHaveTextContent("Medium");
    fireEvent.click(screen.getByRole("button", { name: "Move Agent" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: expect.objectContaining({
        model: "codex-next",
        reasoning_effort: "medium",
      }),
    });
  });

  it("leaves the runtime empty when the current runtime isn't ready on the target", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const target = localComputer("computer-new", "New Mac", "online");
    target.runtimes = [
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "Codex authentication is required",
        models: [{ id: "codex-default", label: "Codex default" }],
        status: "authentication_required",
        type: "codex",
      },
      {
        models: [{ id: "claude-default", label: "Claude default" }],
        status: "ready",
        type: "claude",
      },
    ];
    renderDialog({
      computersOverride: {
        items: [localComputer("computer-old", "Old Mac", "online"), target],
      },
      field: "computer",
      onSave,
    });
    await waitFor(() =>
      expect(setting("Computer")).toHaveTextContent("Old Mac"),
    );
    await choose("Computer", "New Mac", "Online");
    expect(setting("Runtime")).toHaveTextContent("Choose a runtime");
    expect(
      screen.getByText("Codex isn't ready on New Mac. Choose another Runtime."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Move Agent" })).toBeDisabled();
    await choose("Runtime", "Claude Code", "Ready");
    expect(setting("Model")).toHaveTextContent("Claude default");
    fireEvent.click(screen.getByRole("button", { name: "Move Agent" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: {
        model: "claude-default",
        placement: {
          computer_id: "computer-new",
          runtime_type: "claude",
          type: "local",
          workspace_grant_id: "grant-workspace",
        },
      },
    });
  });

  it("offers offline computers and disables upgrade-required ones as move targets", async () => {
    renderDialog({
      computersOverride: {
        items: [
          localComputer("computer-old", "Old Mac", "online"),
          localComputer("computer-offline", "Offline Mac", "offline"),
          localComputer("computer-legacy", "Legacy Mac", "online", {
            upgrade_required: true,
          }),
        ],
      },
      field: "computer",
      onSave: vi.fn(),
    });
    await waitFor(() =>
      expect(setting("Computer")).toHaveTextContent("Old Mac"),
    );
    const list = await openSetting("Computer");
    const offline = within(list).getByRole("option", {
      name: optionName("Offline Mac", "Offline"),
    });
    expect(offline).toBeEnabled();
    const legacy = within(list).getByRole("option", {
      name: optionName("Legacy Mac", "Online · Upgrade required"),
    });
    expect(legacy).toBeDisabled();
    const current = within(list).getByRole("option", {
      name: optionName("Old Mac", "Online"),
    });
    expect(current).toBeEnabled();
    expect(current).toHaveAttribute("aria-selected", "true");
  });

  it("cannot move to a computer without a writable workspace", async () => {
    const onSave = vi.fn();
    renderDialog({
      computersOverride: {
        items: [
          localComputer("computer-old", "Old Mac", "online"),
          localComputer("computer-new", "New Mac", "online", {
            workspace_grants: [
              { grant_id: "grant-read", label: "Read only", mode: "read-only" },
            ],
          }),
        ],
      },
      field: "computer",
      onSave,
    });
    await waitFor(() =>
      expect(setting("Computer")).toHaveTextContent("Old Mac"),
    );
    await choose("Computer", "New Mac", "Online");
    expect(
      screen.getByText(
        "This computer has no writable workspace. Choose another computer.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Move Agent" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("links Pi runtime settings to Local models when ready with models", async () => {
    const onClose = vi.fn();
    const computer = localComputer("computer-old", "Old Mac", "online");
    computer.runtimes = [
      ...computer.runtimes,
      {
        models: [
          {
            id: "localmodels-library/qwen3-coder-30b",
            label: "Qwen3 Coder 30B",
          },
        ],
        status: "ready",
        type: "pi",
      },
    ];
    renderDialog({
      computersOverride: { items: [computer] },
      onClose,
      onSave: vi.fn(),
    });
    await choose("Runtime", "Pi", "Ready");

    const link = await screen.findByRole("link", { name: "Settings › Models" });
    expect(link).toHaveAttribute(
      "href",
      "/t/tenant-northstar/settings/models?computer=computer-old",
    );
    expect(link.closest("p")).toHaveTextContent(
      "Manage downloaded models in Settings › Models.",
    );
    fireEvent.click(link);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["ready-empty", "not-installed"] as const)(
    "guides Pi setup in Local models when %s",
    async (mode) => {
      const onClose = vi.fn();
      const computer = localComputer("computer-old", "Old Mac", "online");
      computer.runtimes = [
        ...computer.runtimes,
        mode === "ready-empty"
          ? {
              models: [],
              status: "ready",
              type: "pi",
            }
          : {
              message: "Install Pi on this computer.",
              models: [],
              status: "not_installed",
              type: "pi",
            },
      ];
      renderDialog({
        computersOverride: { items: [computer] },
        onClose,
        onSave: vi.fn(),
      });
      await choose(
        "Runtime",
        "Pi",
        mode === "ready-empty" ? "Ready" : "Not installed",
      );

      if (mode === "ready-empty") {
        expect(
          await screen.findByText("No models are available for this runtime."),
        ).toBeVisible();
      }
      const link = await screen.findByRole("link", {
        name: "Settings › Models",
      });
      expect(link).toHaveAttribute(
        "href",
        "/t/tenant-northstar/settings/models?computer=computer-old",
      );
      expect(link.closest("p")).toHaveTextContent(
        "Download and load a local model in Settings › Models to run Agents with Pi on this computer.",
      );
      fireEvent.click(link);
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it("resolves an unloaded local model name in the unavailable Model option", async () => {
    const computer = localComputer("computer-old", "Old Mac", "online");
    computer.runtimes = [
      ...computer.runtimes,
      { models: [], status: "ready", type: "pi" },
    ];
    const registration = localCodexAgent();
    registration.runtime = {
      model: "localmodels-library/qwen3-coder-30b",
      placement: {
        computer_id: "computer-old",
        runtime_type: "pi",
        type: "local",
        workspace_grant_id: "grant-workspace",
      },
    };
    const api = {
      GET: vi.fn().mockResolvedValue({
        data: {
          available: true,
          computer: {
            computer_id: "computer-old",
            display_name: "Old Mac",
            status: "online",
          },
          models: [
            {
              model: {
                id: "qwen3-coder-30b:Q4_K_M",
                name: "Qwen3 Coder 30B",
                pi_model: "localmodels-library/qwen3-coder-30b",
                state: "idle",
              },
              used_by: [],
            },
          ],
          pools: [],
          viewer_is_owner: true,
        },
        response: new Response(null, { status: 200 }),
      }),
    };
    renderDialog({
      api,
      computersOverride: { items: [computer] },
      onSave: vi.fn(),
      registration,
    });

    await waitFor(() =>
      expect(setting("Model")).toHaveTextContent(
        "Qwen3 Coder 30B · Unavailable",
      ),
    );
  });

  it("explains an incompatible Codex runtime with version, diagnostic detail, and update command", async () => {
    const computer = localComputer("computer-old", "Studio Mac", "online", {
      platform: "darwin",
      runtimes: [
        {
          error_code: "RUNTIME_INCOMPATIBLE",
          message: "codex version 0.150.1 is below minimum 0.166.0",
          models: [],
          status: "incompatible",
          type: "codex",
          version: "codex-cli 0.150.1",
        },
      ],
    });
    renderDialog({
      computersOverride: { items: [computer] },
      onSave: vi.fn(),
    });

    expect(await screen.findByText("Codex update required")).toBeVisible();
    expect(
      screen.getByText("codex version 0.150.1 is below minimum 0.166.0"),
    ).toBeVisible();
    expect(screen.getByText("npm install -g @openai/codex")).toBeVisible();
    expect(
      screen.getByText(
        "If you installed Codex from Homebrew or its macOS app, update it there instead.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Studio Mac needs an update to run Codex."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
  });

  it("distinguishes a Computer daemon upgrade requirement from a Runtime update", async () => {
    const computer = localComputer("computer-old", "Studio Mac", "online", {
      upgrade_required: true,
    });
    renderDialog({
      computersOverride: { items: [computer] },
      onSave: vi.fn(),
    });

    const link = await screen.findByRole("link", {
      name: "Settings › Computers",
    });
    expect(link).toHaveAttribute(
      "href",
      "/t/tenant-northstar/settings/computers",
    );
    expect(link.closest("div")).toHaveTextContent(
      "Studio Mac needs a Linger update.",
    );
    expect(
      screen.queryByText(
        "Install and sign in to this runtime on the computer, then wait for it to become ready.",
      ),
    ).not.toBeInTheDocument();
  });

  it("guides Pi to Settings › Models when local models are available and none is downloaded", async () => {
    const onClose = vi.fn();
    const computer = localComputer("computer-old", "Studio Mac", "online", {
      platform: "darwin",
    });
    computer.runtimes = [
      ...computer.runtimes,
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message:
          "Configure a Pi API key or open pi and enter /login as the Computer user",
        models: [],
        status: "authentication_required",
        type: "pi",
        version: "1.5.2",
      },
    ];
    const api = mockLocalModelsApi({
      available: true,
      models: [
        {
          model: {
            availability: { downloadable: true },
            id: "qwen3-coder-30b:Q4_K_M",
            name: "Qwen3 Coder 30B",
            pi_model: "localmodels-library/qwen3-coder-30b",
            state: "absent",
          },
          used_by: [],
        },
      ],
    });
    renderDialog({
      api,
      computersOverride: { items: [computer] },
      onClose,
      onSave: vi.fn(),
    });

    await choose("Runtime", "Pi", "Model needed");

    expect(await screen.findByText("Pi needs a model")).toBeVisible();
    const links = screen.getAllByRole("link", { name: "Settings › Models" });
    expect(links).toHaveLength(1);
    expect(links[0]!.closest("p")).toHaveTextContent(
      "No local model on Studio Mac yet.",
    );
    expect(links[0]).toHaveAttribute(
      "href",
      "/t/tenant-northstar/settings/models?computer=computer-old",
    );
    expect(
      screen.getByText("Using the standalone Pi CLI instead?"),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "Download and load a local model in Settings › Models to run Agents with Pi on this computer.",
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(links[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows download progress instead of Pi sign-in while a local model is downloading", async () => {
    const computer = localComputer("computer-old", "Studio Mac", "online", {
      platform: "darwin",
    });
    computer.runtimes = [
      ...computer.runtimes,
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "sign in",
        models: [],
        status: "authentication_required",
        type: "pi",
      },
    ];
    const api = mockLocalModelsApi({
      available: true,
      models: [
        {
          model: {
            download: {
              bytes_per_second: 50_000_000,
              done_bytes: 420,
              step: "download",
              total_bytes: 1_000,
            },
            id: "qwen3-coder-30b:Q4_K_M",
            name: "Qwen3 Coder 30B",
            pi_model: "localmodels-library/qwen3-coder-30b",
            state: "downloading",
          },
          used_by: [],
        },
      ],
    });
    renderDialog({
      api,
      computersOverride: { items: [computer] },
      onSave: vi.fn(),
    });

    await choose("Runtime", "Pi", "Downloading model");

    expect(await screen.findByText("Downloading local model")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Settings › Models" }).closest("p"),
    ).toHaveTextContent("Qwen3 Coder 30B is downloading on Studio Mac (42%).");
    expect(screen.queryByText("Pi sign-in required")).not.toBeInTheDocument();
  });

  it("shows stopped download guidance when a local model download failed", async () => {
    const computer = localComputer("computer-old", "Studio Mac", "online");
    computer.runtimes = [
      ...computer.runtimes,
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "sign in",
        models: [],
        status: "authentication_required",
        type: "pi",
      },
    ];
    const api = mockLocalModelsApi({
      available: true,
      models: [
        {
          model: {
            error: { code: "NETWORK_UNAVAILABLE" },
            id: "qwen3-coder-30b:Q4_K_M",
            name: "Qwen3 Coder 30B",
            pi_model: "localmodels-library/qwen3-coder-30b",
            state: "failed",
          },
          used_by: [],
        },
      ],
    });
    renderDialog({
      api,
      computersOverride: { items: [computer] },
      onSave: vi.fn(),
    });

    await choose("Runtime", "Pi", "Model needed");

    expect(
      await screen.findByText("Local model download stopped"),
    ).toBeVisible();
  });

  it("shows Pi CLI sign-in without a local models footnote when local models are unavailable", async () => {
    const computer = localComputer("computer-old", "Linux Server", "online", {
      platform: "linux",
    });
    computer.runtimes = [
      ...computer.runtimes,
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "sign in",
        models: [],
        status: "authentication_required",
        type: "pi",
      },
    ];
    const api = mockLocalModelsApi({
      available: false,
      models: [],
      reason: { code: "TOOL_NOT_INSTALLED" },
    });
    renderDialog({
      api,
      computersOverride: { items: [computer] },
      onSave: vi.fn(),
    });

    await choose("Runtime", "Pi", "Sign-in required");

    expect(await screen.findByText("Pi sign-in required")).toBeVisible();
    expect(screen.getByText("Or enter /login in Pi.")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Settings › Models" }),
    ).not.toBeInTheDocument();
  });

  it("shows checking and check-failed states clearly instead of install fallback", async () => {
    const computer = localComputer("computer-old", "Studio Mac", "online", {
      runtimes: [
        {
          models: [],
          status: "unknown",
          type: "codex",
        },
        {
          error_code: "RUNTIME_DIAGNOSTIC_FAILED",
          message: "Claude authentication status probe failed",
          models: [],
          status: "error",
          type: "claude",
        },
      ],
    });
    renderDialog({
      computersOverride: { items: [computer] },
      onSave: vi.fn(),
    });

    expect(await screen.findByText("Checking Codex")).toBeVisible();
    expect(
      screen.queryByText(
        "Install and sign in to this runtime on the computer, then wait for it to become ready.",
      ),
    ).not.toBeInTheDocument();

    await choose("Runtime", "Claude Code", "Could not check");

    expect(await screen.findByText("Couldn't check Claude Code")).toBeVisible();
    expect(
      screen.getByText("Claude authentication status probe failed"),
    ).toBeVisible();
  });
});

const settingNames = {
  Computer: "Agent computer",
  Model: "Agent model",
  Reasoning: "Agent reasoning effort",
  Runtime: "Agent runtime",
} as const;

type Setting = keyof typeof settingNames;

/** A setting's Select trigger. */
function setting(label: Setting) {
  return screen.getByRole("combobox", { name: settingNames[label] });
}

/** Opens a setting's Select once the dialog has loaded and returns its
 * floating list. */
async function openSetting(label: Setting) {
  await waitFor(() => expect(setting(label)).toBeEnabled());
  fireEvent.click(setting(label));
  return screen.findByRole("listbox");
}

/** A choice's name: its label, followed by its status when it has one. */
function optionName(name: string, status?: string) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escape(name)}${status ? `\\s*${escape(status)}` : ""}$`,
  );
}

/** Picks a choice and checks its list closes. A Computer or Runtime status
 * is checked before choosing; a Pi status settles once the Computer's local
 * models load. */
async function choose(label: Setting, name: string, status?: string) {
  const list = await openSetting(label);
  fireEvent.click(
    await within(list).findByRole("option", { name: optionName(name, status) }),
  );
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

function mockLocalModelsApi(overrides: Record<string, unknown>) {
  return {
    GET: vi.fn().mockResolvedValue({
      data: {
        available: true,
        computer: {
          computer_id: "computer-old",
          display_name: "Studio Mac",
          status: "online",
        },
        models: [],
        pools: [],
        viewer_is_owner: true,
        ...overrides,
      },
      response: new Response(null, { status: 200 }),
    }),
  };
}

function renderDialog({
  api,
  field = "runtime",
  onClose = vi.fn(),
  onSave,
  registration = localCodexAgent(),
  computersOverride,
  computersPending = false,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
}: {
  api?: { GET: ReturnType<typeof vi.fn> };
  queryClient?: QueryClient;
  field?: AgentRuntimeField;
  onClose?: () => void;
  onSave: (input: AgentRuntimeUpdateInput) => void;
  registration?: TeamHubTenantAgent;
  computersOverride?: TeamHubLocalComputerPage;
  /** Leaves the computers request unanswered, as while it is in flight. */
  computersPending?: boolean;
}) {
  const computers: TeamHubLocalComputerPage = computersOverride ?? {
    items: [
      localComputer("computer-old", "Old Mac", "online"),
      localComputer("computer-new", "New Mac", "online"),
    ],
  };
  const client = {
    ...(api ? { api: api as never } : {}),
    listTenantLocalComputers: computersPending
      ? vi.fn(() => new Promise<TeamHubLocalComputerPage>(() => {}))
      : vi.fn().mockResolvedValue(computers),
  };

  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <EditAgentRuntimeDialog
          field={field}
          client={client}
          isPending={false}
          onClose={onClose}
          onSave={onSave}
          registration={registration}
          tenantId="tenant-northstar"
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function localComputer(
  computerId: string,
  displayName: string,
  status: "online" | "offline",
  overrides: Partial<LocalComputer> = {},
): LocalComputer {
  return {
    active_operations: 0,
    computer_id: computerId,
    display_name: displayName,
    runtimes: [
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "Claude authentication is required",
        models: [{ id: "claude-default", label: "Claude default" }],
        status: "authentication_required",
        type: "claude",
      },
      {
        models: [
          { id: "codex-default", label: "Codex default" },
          {
            id: "codex-fast",
            label: "Codex fast",
            allowed_reasoning_effort: ["low", "high"],
          },
        ],
        status: "ready" as const,
        type: "codex" as const,
      },
    ],
    status,
    upgrade_required: false,
    workspace_grants: [
      {
        grant_id: "grant-workspace",
        label: "Workspace",
        mode: "workspace-write",
      },
    ],
    ...overrides,
  };
}

function localCodexAgent(): TeamHubTenantAgent {
  const timestamp = "2026-09-01T15:40:00Z";
  return {
    actor: {
      created_at: timestamp,
      display_name: "Local Codex",
      handle: "@local_codex",
      id: "actor-local-codex",
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
    agent_management_id: "agent-local-codex",
    agent_type: "general",
    configuration_revision: 1,
    created_at: timestamp,
    created_by: {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-northstar",
    },
    description: "",
    instructions: "Work locally.",
    runtime: {
      model: "codex-default",
      placement: {
        computer_id: "computer-old",
        runtime_type: "codex",
        type: "local",
        workspace_grant_id: "grant-workspace",
      },
    },
    skill_bindings: [],
    updated_at: timestamp,
    visibility_scope: "sponsor",
  };
}
