import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineGlobalProperty } from "@/test/global-properties";

import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { AccountSettingsPage } from "./account-settings-page";
import { SettingsLayout } from "./settings-page";

// The dialog imports its sections lazily, so pay that cost before the first
// assertion instead of racing a dynamic import inside a findBy timeout.
beforeAll(async () => {
  await Promise.all([
    import("./account-settings-page"),
    import("@/features/local-computer/computers-page"),
  ]);
});

beforeEach(() => {
  const values = new Map<string, string>();
  defineGlobalProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
});

describe("Settings surfaces", () => {
  it("saves the display name in place without changing the overview", async () => {
    const runtime = await testRuntime();
    const before = await runtime.client.getPersonalProfile("tenant-northstar");
    const saved = {
      ...(await accountProfile(runtime)),
      name: "Jenny Card",
      name_user_managed: true,
    };
    const patch = vi.fn(() => saved);
    runtime.server.on("PATCH", "/v0/tenants/{tenantId}/account-profile", patch);
    renderSettings(runtime);
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit display name" }),
    );
    const nameField = screen.getByRole("textbox", {
      name: "Profile display name",
    });
    fireEvent.change(nameField, { target: { value: "Jenny Card" } });
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/account-profile",
      () => saved,
    );
    // Enter saves in place, as an Agent's name does.
    fireEvent.keyDown(nameField, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Profile display name" }),
      ).not.toBeInTheDocument(),
    );
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { name: "Jenny Card" },
        params: { tenantId: "tenant-northstar" },
      }),
    );
    expect(
      (await screen.findAllByText("Jenny Card", { exact: true }))[0],
    ).toBeVisible();
    expect(await runtime.client.getPersonalProfile("tenant-northstar")).toEqual(
      before,
    );
  });

  it("switches Settings sections through their own addresses", async () => {
    const runtime = await testRuntime();
    renderSettings(runtime, "/t/tenant-northstar/settings/language");

    fireEvent.click(
      within(
        await screen.findByRole("navigation", { name: "Settings sections" }),
      ).getByRole("link", { name: "Account" }),
    );

    expect(
      await screen.findByRole("button", { name: "Change password" }),
    ).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/settings/account",
    );
    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("presents Account as the profile card, the password and the API keys", async () => {
    const runtime = await testRuntime();
    renderSettings(runtime);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const settingsNav = screen.getByRole("complementary", {
      name: "Settings navigation",
    });
    expect(
      within(settingsNav)
        .getAllByRole("link")
        .map((link) => link.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["Account", "Computers", "Models", "Language"]);
    expect(
      screen.getByRole("heading", { level: 1, name: "Account" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Edit display name" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Change cover" })).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Upload profile photo" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Change password" }),
    ).toBeVisible();
    expect(await screen.findByText("Composio")).toBeVisible();
    expect(screen.queryByLabelText("Bio")).toBeNull();
    expect(screen.queryByLabelText("Organization")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Insights" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Log out" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("jenny@northstar.example")).toBeNull();
  });

  it("submits a valid password change from Account settings", async () => {
    const runtime = await testRuntime();
    const change = vi.fn(() => undefined);
    runtime.server.on("POST", "/v0/account/password", change);
    renderSettings(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Change password" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Change password" });
    const submit = within(dialog).getByRole("button", {
      name: "Change password",
    });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Current password"), {
      target: { value: "linger-v0" },
    });
    fireEvent.change(within(dialog).getByLabelText("New password"), {
      target: { value: "linger-v1" },
    });
    fireEvent.change(within(dialog).getByLabelText("Confirm new password"), {
      target: { value: "different-password" },
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Passwords do not match.",
    );
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Confirm new password"), {
      target: { value: "linger-v1" },
    });
    fireEvent.click(submit);

    expect(await screen.findByText("Password changed")).toBeVisible();
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { current_password: "linger-v0", new_password: "linger-v1" },
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Change password" }),
    ).not.toBeInTheDocument();
  });

  it("wraps mobile Settings section links cleanly so Models and Language are not clipped at 390px width", async () => {
    const runtime = await testRuntime();
    renderSettings(runtime);

    const nav = await screen.findByRole("navigation", {
      name: "Settings sections",
    });
    expect(nav).toHaveClass("flex-wrap");
    expect(nav).not.toHaveClass("overflow-x-auto");

    const links = within(nav).getAllByRole("link");
    expect(
      links.map((link) => link.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["Account", "Computers", "Models", "Language"]);
    for (const link of links) {
      expect(link).toHaveClass("shrink-0");
    }
  });
});

describe("Voice API keys", () => {
  it("shows where each voice key comes from and saves one", async () => {
    const runtime = await testRuntime();
    let saved = false;
    runtime.server
      .on("GET", "/v0/tenants/{tenantId}/voice-media-policy", () => ({
        voice_available: true,
        voice_media_supported: saved,
        live_supported: true,
        soniox_key: saved
          ? { source: "stored", can_save: true }
          : { source: "none", can_save: true },
        xai_key: { source: "environment", can_save: false },
      }))
      .on("PUT", "/v0/voice-provider-keys/{provider}", ({ params }) => {
        expect(params.provider).toBe("soniox");
        saved = true;
        return { source: "stored", can_save: true };
      });
    renderSettings(runtime);

    const addSoniox = await screen.findByRole("button", {
      name: "Add Soniox key",
    });
    expect(
      screen.getByText(/Turns Voice Mode into a live conversation/u),
    ).toHaveTextContent("Set with XAI_API_KEY on the server.");
    expect(screen.getByText("Set by your server")).toBeVisible();
    expect(screen.queryByRole("button", { name: /xAI key/u })).toBeNull();

    fireEvent.click(addSoniox);
    const dialog = await screen.findByRole("dialog", { name: "Soniox key" });
    fireEvent.change(within(dialog).getByLabelText("Soniox API key"), {
      target: { value: "soniox-key" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("Soniox key saved")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Soniox key" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Replace Soniox key" }),
    ).toBeVisible();
  });

  it("hides the voice rows where the deployment cannot run voice", async () => {
    const runtime = await testRuntime();
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/voice-media-policy",
      () => ({ voice_available: false, voice_media_supported: false }),
    );
    renderSettings(runtime);

    expect(await screen.findByText("Composio")).toBeVisible();
    await act(async () => undefined);
    expect(screen.queryByText("Soniox")).toBeNull();
    expect(screen.queryByText("xAI")).toBeNull();
  });
});

async function testRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

function renderSettings(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  initialEntry = "/t/tenant-northstar/settings/account",
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider
          router={createMemoryRouter(
            [
              { element: <p>Signed out</p>, path: "/login" },
              {
                children: [
                  { element: <AccountSettingsPage />, path: "account" },
                  { element: <p>Language page</p>, path: "language" },
                ],
                element: (
                  <>
                    <SettingsLayout />
                    <LocationProbe />
                  </>
                ),
                path: "/t/:tenantId/settings",
              },
            ],
            { initialEntries: [initialEntry] },
          )}
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  return { queryClient, unmount: view.unmount };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function accountProfile(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/account-profile", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}
