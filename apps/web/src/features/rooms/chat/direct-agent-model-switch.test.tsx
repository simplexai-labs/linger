import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { labView } from "@/features/local-models/local-models-test-support";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import type {
  TeamHubTenantAgent,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";

import { DirectAgentModelSwitch } from "./direct-agent-model-switch";

const runtimeModels = [
  {
    allowed_reasoning_effort: ["low", "medium", "high"],
    id: "gpt-5.4",
    label: "5.4 Sol",
  },
  {
    allowed_reasoning_effort: ["low", "high"],
    id: "gpt-5.4-luna",
    label: "5.4 Luna",
  },
];

describe("Direct Agent runtime settings", () => {
  it("hides the entry from another Agent sponsor", () => {
    renderSwitch({ currentActorId: "someone-else" });
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps one summary entry and saves only after confirming the full dialog", async () => {
    const updateTenantAgent = vi.fn(({ body }: { body: unknown }) => ({
      ...localAgent(),
      runtime: (body as TeamHubTenantAgentUpdateInput).runtime!,
      configuration_revision: 5,
    }));
    renderSwitch({ updateTenantAgent });
    fireEvent.click(
      await screen.findByRole("button", { name: "5.4 Sol Medium" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Runtime settings" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Agent runtime" }),
      ).toHaveTextContent("Codex"),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Agent model" }));
    fireEvent.click(await screen.findByRole("option", { name: "5.4 Luna" }));
    fireEvent.click(
      screen.getByRole("combobox", { name: "Agent reasoning effort" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "High" }));
    expect(updateTenantAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save Runtime" }));
    await waitFor(() =>
      expect(updateTenantAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { tenantId: "tenant-northstar", agentId: "actor-sol" },
          body: {
            expected_configuration_revision: 4,
            runtime: {
              model: "gpt-5.4-luna",
              reasoning_effort: "high",
              placement: {
                type: "local",
                computer_id: "computer-1",
                workspace_grant_id: "grant-1",
                runtime_type: "codex",
              },
            },
          },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("keeps the effort outside the model label that shortens", async () => {
    renderSwitch({});
    const trigger = await screen.findByRole("button", {
      name: "5.4 Sol Medium",
    });
    const label = within(trigger).getByText("5.4 Sol");
    expect(label).toHaveClass("agent-model-switch-trigger-label");
    expect(label).not.toHaveTextContent("Medium");
    expect(within(trigger).getByText("Medium")).toHaveClass(
      "agent-model-switch-trigger-effort",
    );
  });
  it("allows inspecting while busy but disables saving", async () => {
    const updateTenantAgent = vi.fn();
    renderSwitch({ updateTenantAgent, busy: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "5.4 Sol Medium" }),
    );
    // The settings dialog is a lazy chunk on its first open.
    expect(
      await screen.findByRole("button", { name: "Save Runtime" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(updateTenantAgent).not.toHaveBeenCalled();
  });

  it("resolves Bifrost localmodels-library model names from local-models before Pi lists them", async () => {
    const base = localAgent();
    const piAgent: TeamHubTenantAgent = {
      ...base,
      runtime: {
        model: "localmodels-library/qwen3-coder-30b",
        placement: {
          computer_id: "computer-1",
          runtime_type: "pi",
          type: "local",
          workspace_grant_id: "grant-1",
        },
      },
    };
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/local-computers", () => ({
      items: [
        {
          computer_id: "computer-1",
          display_name: "Computer",
          runtimes: [{ models: [], status: "ready", type: "pi" }],
          status: "online",
          workspace_grants: [
            {
              grant_id: "grant-1",
              label: "Workspace",
              mode: "workspace-write",
            },
          ],
        },
      ],
    }));
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models",
      () => labView(),
    );

    render(
      <MemoryRouter>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <DirectAgentModelSwitch
            client={runtime.client}
            currentActorId="actor-jenny"
            registration={piAgent}
            tenantId="tenant-northstar"
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "Qwen3 Coder 30B" }),
    ).toBeVisible();
  });
});

function renderSwitch({
  busy = false,
  currentActorId = "actor-jenny",
  registration = localAgent(),
  updateTenantAgent = vi.fn(),
}: {
  busy?: boolean;
  currentActorId?: string;
  registration?: TeamHubTenantAgent;
  updateTenantAgent?: TestRouteHandler;
}) {
  const runtime = createTestTeamHubRuntime();
  runtime.server.on(
    "PATCH",
    "/v0/tenants/{tenantId}/agents/{agentId}",
    updateTenantAgent,
  );
  runtime.server.on("GET", "/v0/tenants/{tenantId}/local-computers", () => ({
    items: [
      {
        computer_id: "computer-1",
        display_name: "Computer",
        status: "online",
        runtimes: [{ type: "codex", status: "ready", models: runtimeModels }],
        workspace_grants: [
          {
            grant_id: "grant-1",
            label: "Workspace",
            mode: "workspace-write",
          },
        ],
      },
    ],
  }));
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <DirectAgentModelSwitch
          busy={busy}
          client={runtime.client}
          currentActorId={currentActorId}
          registration={registration}
          tenantId="tenant-northstar"
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function localAgent(): TeamHubTenantAgent {
  const timestamp = "2026-09-22T08:00:00Z";
  return {
    actor: {
      created_at: timestamp,
      display_name: "Sol",
      handle: "@sol",
      id: "actor-sol",
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
    agent_management_id: "agent-sol",
    agent_type: "general",
    configuration_revision: 4,
    created_at: timestamp,
    created_by: {
      display_name: "Jenny",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-northstar",
    },
    description: "",
    instructions: "",
    runtime: {
      model: "gpt-5.4",
      placement: {
        type: "local",
        computer_id: "computer-1",
        workspace_grant_id: "grant-1",
        runtime_type: "codex",
      },
      reasoning_effort: "medium",
    },
    skill_bindings: [],
    updated_at: timestamp,
    visibility_scope: "sponsor",
  };
}
