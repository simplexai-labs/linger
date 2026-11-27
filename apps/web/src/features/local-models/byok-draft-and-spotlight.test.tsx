import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import {
  createMemoryRouter,
  Link,
  RouterProvider,
  useLocation,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { ModelsPage } from "./local-models-page";
import type { LocalModelsView } from "./local-models-queries";
import {
  gb,
  labView,
  localModel,
  modelView,
} from "./local-models-test-support";

const tenantId = "tenant-northstar";
const viewPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const modelSourcePath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

async function renderModelsInDataRouter({
  source,
  view,
}: {
  source?: Record<string, unknown>;
  view: LocalModelsView;
}) {
  const runtime = createTestTeamHubRuntime();
  const template = runtime.seed.localComputers[0]!;
  runtime.seed.localComputers = [
    {
      ...template,
      computer_id: view.computer.computer_id,
      display_name: view.computer.display_name,
      status: view.computer.status,
    },
  ];
  runtime.server
    .on("GET", modelSourcePath, ({ params }) =>
      Response.json({
        computer_id: params.computerId,
        online: true,
        viewer_is_owner: true,
        ...(source ? { status: source } : {}),
      }),
    )
    .on("GET", viewPath, ({ params }) =>
      params.computerId === view.computer.computer_id
        ? view
        : teamHubErrorResponse(404, "LOCAL_COMPUTER_NOT_FOUND"),
    )
    .on("POST", viewPath, ({ params }) =>
      Response.json(
        { action: "refresh", computer_id: params.computerId },
        { status: 202 },
      ),
    );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.ensureQueryData(
    localComputersQueryOptions(runtime.client, tenantId),
  );

  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <Link to={`/t/${tenantId}/settings/security`}>Go to Security</Link>
            <Suspense fallback={<p>Loading</p>}>
              <ModelsPage />
            </Suspense>
            <LocationProbe />
          </>
        ),
        path: "/t/:tenantId/settings/models",
      },
      {
        element: (
          <>
            <p>Security destination</p>
            <LocationProbe />
          </>
        ),
        path: "/t/:tenantId/settings/security",
      },
    ],
    { initialEntries: [`/t/${tenantId}/settings/models`] },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  return { router, runtime };
}

describe("Models BYOK draft retention & FeaturedModelSpotlight controls", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("retains BYOK form draft across tab switches, toggles secret visibility, and warns before leaving", async () => {
    await renderModelsInDataRouter({
      source: {
        byok: { configured: false, key_saved: false },
        mode: "local",
        runtime: "pi",
        runtime_model: "qwen-local",
      },
      view: labView(),
    });

    const tabs = await screen.findByRole("tablist", { name: "Model source" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "BYOK" }));

    const baseUrl = await screen.findByLabelText("Base URL");
    const apiKey = screen.getByLabelText("API key");
    const model = screen.getByRole("combobox", { name: "Model" });

    fireEvent.change(baseUrl, { target: { value: "https://api.acme.test" } });
    fireEvent.change(apiKey, { target: { value: "sk-draft-secret" } });
    fireEvent.change(model, { target: { value: "acme/reasoning-1" } });

    // Eye toggle reveals and re-masks the BYOK API key.
    expect(apiKey).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    expect(apiKey).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Mask API key" }));
    expect(apiKey).toHaveAttribute("type", "password");

    // Switching to Local model and back preserves every entered BYOK field.
    fireEvent.click(within(tabs).getByRole("tab", { name: /Local model/ }));
    expect(await screen.findByRole("region", { name: "Models" })).toBeVisible();

    fireEvent.click(within(tabs).getByRole("tab", { name: "BYOK" }));
    expect(await screen.findByLabelText("Base URL")).toHaveValue(
      "https://api.acme.test",
    );
    expect(screen.getByLabelText("API key")).toHaveValue("sk-draft-secret");
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
      "acme/reasoning-1",
    );

    // Attempting to navigate away warns with a confirmation modal.
    fireEvent.click(screen.getByRole("link", { name: "Go to Security" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/t/${tenantId}/settings/models`,
    );

    fireEvent.click(screen.getByRole("link", { name: "Go to Security" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Discard unsaved changes?" }),
      ).getByRole("button", { name: "Discard" }),
    );
    expect(await screen.findByText("Security destination")).toBeVisible();
  });

  it("hides FeaturedModelSpotlight when catalog is empty or a host blocker is active, and persists dismiss", async () => {
    // 1. Empty catalog hides FeaturedModelSpotlight.
    await renderModelsInDataRouter({
      view: labView({ models: [] }),
    });
    expect(await screen.findByText("No local models available")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Featured model: Inkling 2 Mini" }),
    ).toBeNull();

    // 2. Host blocker (GPU unsupported) hides FeaturedModelSpotlight.
    cleanup();
    await renderModelsInDataRouter({
      view: labView({
        models: [
          modelView(
            localModel({
              availability: {
                downloadable: false,
                reason: { code: "GPU_UNSUPPORTED", gpu_vendor: "amd" },
              },
              fit: "none",
              id: "qwen-unsupported",
              memory_bytes: gb(8),
              name: "Qwen 8B",
              pool: undefined,
            }),
          ),
        ],
      }),
    });
    expect(
      await screen.findByRole("complementary", {
        name: "Local model requirements",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Featured model: Inkling 2 Mini" }),
    ).toBeNull();

    // 3. Dismiss button hides FeaturedModelSpotlight and persists in localStorage.
    cleanup();
    await renderModelsInDataRouter({
      view: labView(),
    });
    const spotlight = await screen.findByRole("region", {
      name: "Featured model: Inkling 2 Mini",
    });
    fireEvent.click(
      within(spotlight).getByRole("button", {
        name: "Dismiss featured model spotlight",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Featured model: Inkling 2 Mini",
        }),
      ).toBeNull(),
    );

    // Remounting keeps the spotlight dismissed.
    cleanup();
    await renderModelsInDataRouter({
      view: labView(),
    });
    await screen.findByRole("region", { name: "Models" });
    expect(
      screen.queryByRole("region", { name: "Featured model: Inkling 2 Mini" }),
    ).toBeNull();
  });
});
