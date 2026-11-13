import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { TeamHubEventSync } from "@/features/rooms/event-sync";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { LocalModelsPage } from "./local-models-page";
import type { LocalModelsView } from "./local-models-queries";
import { gb, gpuPool, labView, macView } from "./local-models-test-support";

const tenantId = "tenant-northstar";
const viewPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const actionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/{modelId}/actions";

type InventoryComputer = TeamHubLocalComputerPage["items"][number];

interface Fixture {
  actions: { body: unknown; computerId: string; modelId: string }[];
  runtime: TestTeamHubRuntime;
  views: Record<string, LocalModelsView>;
}

function setup(
  views: LocalModelsView[] = [labView(), macView()],
  inventory?: InventoryComputer[],
): Fixture {
  const runtime = createTestTeamHubRuntime();
  const template = runtime.seed.localComputers[0]!;
  runtime.seed.localComputers =
    inventory ??
    views.map((view) => ({
      ...template,
      computer_id: view.computer.computer_id,
      display_name: view.computer.display_name,
      status: view.computer.status,
    }));
  const fixture: Fixture = {
    actions: [],
    runtime,
    views: Object.fromEntries(
      views.map((view) => [view.computer.computer_id, view]),
    ),
  };
  runtime.server
    .on("GET", viewPath, ({ params }) => {
      const view = fixture.views[params.computerId!];
      return view ?? teamHubErrorResponse(404, "LOCAL_COMPUTER_NOT_FOUND");
    })
    .on("POST", actionPath, ({ body, params }) => {
      fixture.actions.push({
        body,
        computerId: params.computerId!,
        modelId: params.modelId!,
      });
      return Response.json(
        {
          action: (body as { action: string }).action,
          computer_id: params.computerId,
          model_id: params.modelId,
        },
        { status: 202 },
      );
    });
  return fixture;
}

function inventoryComputer(view: LocalModelsView): InventoryComputer {
  const template = createTestTeamHubRuntime().seed.localComputers[0]!;
  return {
    ...template,
    computer_id: view.computer.computer_id,
    display_name: view.computer.display_name,
    status: view.computer.status,
  };
}

function CurrentSearch() {
  return <p>Address search: {useLocation().search}</p>;
}

function renderPage(fixture: Fixture, search = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={fixture.runtime}>
        <TeamHubEventSync />
        <MemoryRouter
          initialEntries={[`/t/${tenantId}/settings/local-models${search}`]}
        >
          <Suspense fallback={<p>Loading page</p>}>
            <Routes>
              <Route
                element={
                  <>
                    <LocalModelsPage />
                    <CurrentSearch />
                  </>
                }
                path="/t/:tenantId/settings/local-models"
              />
              <Route
                element={<p>Computers page</p>}
                path="/t/:tenantId/settings/computers"
              />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

function cards() {
  return within(screen.getByRole("region", { name: "Models" })).getAllByRole(
    "article",
  );
}

function card(name: string) {
  return cards().find(
    (item) => within(item).queryByRole("button", { name }) !== null,
  )!;
}

/** Each card as "name: status line", in page order. */
function statuses() {
  return cards().map((item) => {
    const toggle = within(item).getAllByRole("button")[0]!;
    const name = toggle.getAttribute("aria-label")!;
    return `${name}: ${toggle.textContent.slice(name.length)}`;
  });
}

async function findModels() {
  return screen.findByRole("region", { name: "Models" });
}

function publishSnapshot(fixture: Fixture, view: LocalModelsView) {
  fixture.views[view.computer.computer_id] = view;
  fixture.runtime.events.emitSignal({
    hint: {
      id: view.computer.computer_id,
      resource: "local-models",
      tenant_id: tenantId,
    },
    type: "resource.invalidated",
  });
}

function withModel(
  view: LocalModelsView,
  modelId: string,
  fields: Partial<LocalModelsView["models"][number]["model"]>,
): LocalModelsView {
  return {
    ...view,
    models: view.models.map((item) =>
      item.model.id === modelId
        ? { ...item, model: { ...item.model, ...fields } }
        : item,
    ),
  };
}

afterEach(() => {
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
});

describe("LocalModelsPage", () => {
  it("lists every model once with its status, as the Computer reported it", async () => {
    renderPage(setup());
    await findModels();

    expect(statuses()).toEqual([
      "Qwen3 Coder 30B: Loaded · GPU 0 · 21.4 GB",
      "Gemma 3 27B: Downloaded",
      "GPT-OSS 20B: Not downloaded · 12.1 GB · Recommended",
      "Gemma 3 4B: Not downloaded · 3.3 GB",
      "Llama 3.3 70B: Not downloaded · 42.5 GB · runs slower",
      "Llama 3.1 405B: Can't download · needs 230 GB",
    ]);
    expect(
      screen.getByText("22.5 GB of 48 GB GPU memory in use"),
    ).toBeVisible();
    expect(screen.queryByText("Sample data")).not.toBeInTheDocument();
    // A model that can't be downloaded has no action, only its toggle.
    expect(within(card("Llama 3.1 405B")).getAllByRole("button")).toHaveLength(
      1,
    );
  });

  it("expands one row at a time to show a model's details", async () => {
    renderPage(setup());
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    const details = screen.getByRole("region", {
      name: "Qwen3 Coder 30B details",
    });
    expect(details).toHaveTextContent("21.4 GB on GPU 0 · RTX 4090");
    expect(details).toHaveTextContent("Research agent, Code reviewer");
    expect(details).toHaveTextContent("http://127.0.0.1:18100/v1");
    expect(details).toHaveTextContent("46 tokens/s");
    expect(details).toHaveTextContent("128K tokens");

    fireEvent.click(screen.getByRole("button", { name: "Llama 3.1 405B" }));
    expect(
      screen.queryByRole("region", { name: "Qwen3 Coder 30B details" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Llama 3.1 405B details" }),
    ).toHaveTextContent(
      "Needs 230 GB of memory; this computer has 102.4 GB for models.",
    );
  });

  it("shows the Computer's pools and hardware in Details", async () => {
    renderPage(setup());
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "lab-118 details" });
    expect(
      within(dialog).getByRole("img", {
        name: "GPU 0 · RTX 4090: 21.4 GB of 24 GB in use",
      }),
    ).toBeVisible();
    // A foundation component holds memory but is not a model row.
    expect(dialog).toHaveTextContent("Qwen3 Embedding");
    expect(dialog).toHaveTextContent("Ubuntu 24.04 · llama.cpp b11370 · CUDA");
    expect(dialog).toHaveTextContent("412 GB");
  });

  it("shows memory other apps use in a pool's bar", async () => {
    const shared = gpuPool(0, 24, [{ gb: 4, id: "small", name: "Small" }]);
    // Another process holds 15 GB of the card next to the model.
    renderPage(
      setup([labView({ pools: [{ ...shared, used_bytes: gb(19) }] })]),
    );
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "lab-118 details" });
    expect(within(dialog).getByTitle("Other apps · 15 GB")).toHaveStyle({
      width: "62.5%",
    });
    expect(within(dialog).getByTitle("Small · 4 GB")).toHaveStyle({
      width: `${(4 / 24) * 100}%`,
    });
  });

  it("downloads on click and follows the snapshots the Computer sends", async () => {
    const fixture = setup();
    renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Download GPT-OSS 20B" }),
    );
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "download" },
          computerId: "computer-lab",
          modelId: "gpt-oss-20b:Q4_K_M",
        },
      ]),
    );

    publishSnapshot(
      fixture,
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        download: { done_bytes: 32, step: "download", total_bytes: 100 },
        state: "downloading",
      }),
    );
    await waitFor(() =>
      expect(statuses()).toContain("GPT-OSS 20B: Downloading · 32%"),
    );
    expect(
      screen.getByRole("progressbar", {
        name: "GPT-OSS 20B download progress",
      }),
    ).toHaveAttribute("aria-valuenow", "32");

    publishSnapshot(
      fixture,
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        download: { done_bytes: 100, step: "verify", total_bytes: 100 },
        state: "downloading",
      }),
    );
    await waitFor(() =>
      expect(statuses()).toContain("GPT-OSS 20B: Downloading · checking file"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel GPT-OSS 20B" }));
    await waitFor(() =>
      expect(fixture.actions.at(-1)?.body).toEqual({ action: "cancel" }),
    );

    publishSnapshot(
      fixture,
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        note: { code: "NO_ROOM_TO_LOAD" },
        state: "idle",
      }),
    );
    await waitFor(() =>
      expect(statuses()).toContain(
        "GPT-OSS 20B: Downloaded · no room to load yet",
      ),
    );
  });

  it("loads at once when the pool has room", async () => {
    const fixture = setup();
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "load" },
          computerId: "computer-lab",
          modelId: "gemma3-27b:Q4_K_M",
        },
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers to unload the model holding the memory before loading another", async () => {
    const fixture = setup();
    renderPage(fixture, "?computer=computer-mac");
    await findModels();

    expect(statuses()).toContain("Llama 3.3 70B: Couldn't load");
    fireEvent.click(screen.getByRole("button", { name: "Llama 3.3 70B" }));
    const details = screen.getByRole("region", {
      name: "Llama 3.3 70B details",
    });
    expect(details).toHaveTextContent(
      "There wasn't enough free memory to load it.",
    );
    // Diagnostic text from the Computer is never shown.
    expect(details).not.toHaveTextContent("need 46 GiB");

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    expect(dialog).toHaveTextContent(
      "Llama 3.3 70B needs 46 GB on Unified memory; 36.9 GB is free.",
    );
    const gptOss = within(dialog).getByRole("checkbox", {
      name: /GPT-OSS 20B/,
    });
    expect(gptOss).toBeChecked();
    expect(dialog).toHaveTextContent(
      "Another Me can't answer until their model is loaded again.",
    );

    fireEvent.click(gptOss);
    expect(within(dialog).getByRole("button", { name: "Load" })).toBeDisabled();
    fireEvent.click(gptOss);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unload and load" }),
    );

    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "load", unload_first: ["gpt-oss-20b:Q4_K_M"] },
          computerId: "computer-mac",
          modelId: "llama3.3-70b:Q4_K_M",
        },
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says so when nothing else in the pool can be unloaded", async () => {
    const mac = macView();
    renderPage(
      setup([
        {
          ...mac,
          models: mac.models.slice(1),
          pools: [
            {
              ...mac.pools[0]!,
              holders: [],
              total_bytes: gb(40),
              used_bytes: 0,
            },
          ],
        },
      ]),
    );
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Make room to load" }),
    ).toHaveTextContent("Nothing else is loaded there.");
  });

  it("asks before unloading a model an Agent uses, and not otherwise", async () => {
    const fixture = setup();
    renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Unload Qwen3 Coder 30B?",
    });
    expect(dialog).toHaveTextContent(
      "Research agent, Code reviewer use this model and can't answer until it is loaded again.",
    );
    expect(fixture.actions).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Unload" }));
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "unload" },
          computerId: "computer-lab",
          modelId: "qwen3-coder-30b:Q4_K_M",
        },
      ]),
    );

    publishSnapshot(fixture, {
      ...labView(),
      models: labView().models.map((item) => ({ ...item, used_by: [] })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Qwen3 Coder 30B details" }),
      ).toHaveTextContent("No Agent yet"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(fixture.actions).toHaveLength(2));
  });

  it("warns which Agents lose their model before removing it", async () => {
    const fixture = setup();
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    fireEvent.click(
      within(
        screen.getByRole("region", { name: "Qwen3 Coder 30B details" }),
      ).getByRole("button", { name: "Remove from computer" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Remove Qwen3 Coder 30B?",
    });
    expect(dialog).toHaveTextContent(
      "Unloads it, deletes its files and frees 18.6 GB of disk on lab-118.",
    );
    expect(dialog).toHaveTextContent(
      "Research agent, Code reviewer use this model and can't answer until you choose another model for them.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "remove" },
          computerId: "computer-lab",
          modelId: "qwen3-coder-30b:Q4_K_M",
        },
      ]),
    );
  });

  it("lists the Agents of a downloaded model and warns before removing it", async () => {
    const view = labView();
    // TeamHub matches Agents by pi_model, which a model keeps while idle.
    view.models[1] = {
      ...view.models[1]!,
      used_by: [{ agent_id: "agent-writer", name: "Writer" }],
    };
    const fixture = setup([view]);
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Gemma 3 27B" }));
    const details = screen.getByRole("region", { name: "Gemma 3 27B details" });
    expect(details).toHaveTextContent("Used byWriter");
    fireEvent.click(
      within(details).getByRole("button", { name: "Remove from computer" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Remove Gemma 3 27B?" });
    expect(dialog).toHaveTextContent("Deletes its files");
    expect(dialog).toHaveTextContent(
      "Writer uses this model and can't answer until you choose another model for it.",
    );
  });

  it("opens a Computer the viewer may read but does not own", async () => {
    // The owned-Computer inventory is empty; the library API allows the read.
    const fixture = setup([labView({ viewer_is_owner: false })], []);
    renderPage(fixture, "?computer=computer-lab");
    await findModels();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Local models",
    );
    expect(
      screen.getByText(
        "Only the person who connected lab-118 can download, load or remove its models.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    ).toBeDisabled();
    expect(screen.getByText(/Address search:/)).toHaveTextContent(
      "?computer=computer-lab",
    );
  });

  it("keeps a shared Computer selected next to the viewer's own", async () => {
    const fixture = setup(
      [labView({ viewer_is_owner: false }), macView()],
      [inventoryComputer(macView())],
    );
    renderPage(fixture, "?computer=computer-lab");
    await findModels();

    // Not the viewer's own Mac: lab-118, read-only.
    expect(card("Qwen3 Coder 30B")).toBeVisible();
    expect(
      screen.getByText(
        "Only the person who connected lab-118 can download, load or remove its models.",
      ),
    ).toBeVisible();
  });

  it.each([
    ["Unload Qwen3 Coder 30B", "Unload Qwen3 Coder 30B?", "Unload"],
    ["Remove from computer", "Remove Qwen3 Coder 30B?", "Remove"],
  ])(
    "disables an open %s confirmation once the Computer goes offline",
    async (opener, title, confirm) => {
      const fixture = setup([labView()]);
      renderPage(fixture);
      await findModels();
      if (opener === "Remove from computer")
        fireEvent.click(
          screen.getByRole("button", { name: "Qwen3 Coder 30B" }),
        );
      fireEvent.click(screen.getByRole("button", { name: opener }));
      const dialog = await screen.findByRole("dialog", { name: title });

      publishSnapshot(
        fixture,
        labView({ computer: { ...labView().computer, status: "offline" } }),
      );
      await waitFor(() =>
        expect(
          within(dialog).getByRole("button", { name: confirm }),
        ).toBeDisabled(),
      );
      fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
      expect(fixture.actions).toEqual([]);
    },
  );

  it("disables an open Unload confirmation once the model is no longer loaded", async () => {
    const fixture = setup([labView()]);
    renderPage(fixture);
    await findModels();
    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Unload Qwen3 Coder 30B?",
    });

    publishSnapshot(
      fixture,
      withModel(labView(), "qwen3-coder-30b:Q4_K_M", {
        endpoint: undefined,
        state: "idle",
      }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Unload" }),
      ).toBeDisabled(),
    );
  });

  it("shows a refusal from the Computer as copy for its code", async () => {
    const fixture = setup();
    fixture.runtime.server.on("POST", actionPath, () =>
      teamHubErrorResponse(409, "LOCAL_MODEL_NO_ROOM", "raw refusal detail"),
    );
    renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gemma 3 27B: There isn't enough free memory to load it. Unload another model first.",
    );
    expect(screen.queryByText(/raw refusal detail/)).not.toBeInTheDocument();
  });

  it("shows what an offline Computer last reported with every action off", async () => {
    renderPage(
      setup([
        labView({
          computer: {
            ...labView().computer,
            last_seen_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
            status: "offline",
          },
        }),
      ]),
    );
    await findModels();

    expect(screen.getByRole("status")).toHaveTextContent(
      "lab-118 is offline (last seen 3 hours ago). This is what it last reported. Reconnect it in Computers to manage its models.",
    );
    expect(
      screen.getByRole("button", { name: "Load Gemma 3 27B" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Download GPT-OSS 20B" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Gemma 3 27B" }));
    expect(
      screen.getByRole("button", { name: "Remove from computer" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("link", { name: "Computers" }));
    expect(await screen.findByText("Computers page")).toBeVisible();
  });

  it("lets only the owner act and tells everyone else why", async () => {
    renderPage(setup([labView({ viewer_is_owner: false })]));
    await findModels();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Only the person who connected lab-118 can download, load or remove its models.",
    );
    expect(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Download GPT-OSS 20B" }),
    ).toBeDisabled();
  });

  it.each([
    [
      "TOOL_NOT_INSTALLED",
      "Local models aren't set up on lab-118",
      "Run Quick Install",
    ],
    [
      "TOOL_FAILED",
      "Couldn't read the local models on lab-118",
      "didn't answer",
    ],
    [
      "NOT_REPORTED",
      "lab-118 hasn't reported local models yet",
      "up-to-date Linger app",
    ],
  ] as const)(
    "explains a Computer without a model library (%s)",
    async (code, title, body) => {
      renderPage(
        setup([
          labView({
            available: false,
            models: [],
            pools: [],
            reason: { code, detail: "raw tool output" },
          }),
        ]),
      );

      const empty = await screen.findByRole("region", { name: title });
      expect(empty).toHaveTextContent(body);
      expect(empty).not.toHaveTextContent("raw tool output");
      expect(
        screen.queryByRole("region", { name: "Models" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Details" }),
      ).not.toBeInTheDocument();
    },
  );

  it("sends a Tenant without Computers to Computers", async () => {
    renderPage(setup([], []));

    const empty = await screen.findByRole("region", {
      name: "No computers yet",
    });
    fireEvent.click(within(empty).getByRole("link", { name: "Computers" }));
    expect(await screen.findByText("Computers page")).toBeVisible();
  });

  it("renders a model that fits nowhere without a placement", async () => {
    renderPage(setup());
    await findModels();

    expect(statuses()).toContain(
      "Llama 3.1 405B: Can't download · needs 230 GB",
    );
    fireEvent.click(screen.getByRole("button", { name: "Llama 3.1 405B" }));
    const memory = within(
      screen.getByRole("region", { name: "Llama 3.1 405B details" }),
    )
      .getByText("Memory")
      .closest("div")!;
    expect(memory).toHaveTextContent(/^Memory230 GB$/);
  });

  it("shows a loaded model's endpoint without a gateway model id", async () => {
    const lab = labView();
    renderPage(
      setup([
        withModel(lab, "qwen3-coder-30b:Q4_K_M", {
          endpoint: { base_url: "http://127.0.0.1:18100/v1" },
        }),
      ]),
    );
    await findModels();

    expect(statuses()[0]).toBe("Qwen3 Coder 30B: Loaded · GPU 0 · 21.4 GB");
    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    expect(
      screen.getByRole("region", { name: "Qwen3 Coder 30B details" }),
    ).toHaveTextContent("http://127.0.0.1:18100/v1");
  });

  it("keeps the chosen Computer in the address", async () => {
    renderPage(setup(), "?computer=computer-mac");
    await findModels();
    expect(statuses()[0]).toBe("GPT-OSS 20B: Loaded · Memory · 14.3 GB");
    expect(screen.getByText("14.3 GB of 51.2 GB memory in use")).toBeVisible();

    fireEvent.click(screen.getByRole("combobox", { name: "Computer" }));
    fireEvent.click(await screen.findByRole("option", { name: "lab-118" }));

    await waitFor(() =>
      expect(
        screen.getByText("Address search: ?computer=computer-lab"),
      ).toBeVisible(),
    );
    await waitFor(() =>
      expect(statuses()[0]).toBe("Qwen3 Coder 30B: Loaded · GPU 0 · 21.4 GB"),
    );
  });

  it("opens the desktop app's own Computer when the address names none", async () => {
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      computer: {
        enroll: () => Promise.reject(new Error("not used")),
        getStatus: () =>
          Promise.resolve({
            activeOperations: 0,
            bridge: "connected",
            computerId: "computer-mac",
            runtime: "ready",
          }),
        onStatus: () => () => undefined,
      },
    };
    renderPage(setup());

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Computer" }),
      ).toHaveTextContent("Mac Studio"),
    );
    await waitFor(() =>
      expect(statuses()[0]).toBe("GPT-OSS 20B: Loaded · Memory · 14.3 GB"),
    );
  });
});
