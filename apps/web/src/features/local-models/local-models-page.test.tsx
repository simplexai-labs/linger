import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act as reactAct,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubEventSync } from "@/features/rooms/event-sync";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import {
  acceptTenantAgentUpdates,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";

import { ModelsPage } from "./local-models-page";
import type { LocalModelsView } from "./local-models-queries";
import {
  gb,
  gpuPool,
  labView,
  localModel,
  macView,
  memoryPool,
  modelView,
} from "./local-models-test-support";

const tenantId = "tenant-northstar";
const viewPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const actionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/{modelId}/actions";
const modelSourcePath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source";

type InventoryComputer = TeamHubLocalComputerPage["items"][number];

interface Fixture {
  actions: { body: unknown; computerId: string; modelId: string }[];
  refreshes: string[];
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
    refreshes: [],
    runtime,
    views: Object.fromEntries(
      views.map((view) => [view.computer.computer_id, view]),
    ),
  };
  runtime.server
    // A Computer that cannot switch sources reports none: the library alone.
    .on("GET", modelSourcePath, ({ params }) =>
      Response.json({
        computer_id: params.computerId,
        online: true,
        viewer_is_owner: true,
      }),
    )
    .on("GET", viewPath, ({ params }) => {
      const view = fixture.views[params.computerId!];
      return view ?? teamHubErrorResponse(404, "LOCAL_COMPUTER_NOT_FOUND");
    })
    .on("POST", viewPath, ({ params }) => {
      fixture.refreshes.push(params.computerId!);
      return Response.json(
        { action: "refresh", computer_id: params.computerId },
        { status: 202 },
      );
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

// The page suspends until the Computer inventory loads, and React holds a
// revealed Suspense boundary for 300 ms; loading the inventory first renders
// the page at once.
async function renderPage(fixture: Fixture, search = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await queryClient.ensureQueryData(
    localComputersQueryOptions(fixture.runtime.client, tenantId),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={fixture.runtime}>
        <TeamHubEventSync />
        <MemoryRouter
          initialEntries={[`/t/${tenantId}/settings/models${search}`]}
        >
          <Suspense fallback={<p>Loading page</p>}>
            <Routes>
              <Route
                element={
                  <>
                    <ModelsPage />
                    <CurrentSearch />
                  </>
                }
                path="/t/:tenantId/settings/models"
              />
              <Route
                element={<p>Computers page</p>}
                path="/t/:tenantId/settings/computers"
              />
              <Route
                element={<p>Another Me room</p>}
                path="/t/:tenantId/rooms/:roomId/chat"
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

/** One card's status line, without its model name. */
function statusOf(name: string) {
  return statuses()
    .find((line) => line.startsWith(`${name}: `))!
    .slice(name.length + 2);
}

/**
 * Holds every action request until the returned function answers it with
 * respond(), as a Computer that takes a while to decide.
 */
function holdActions(fixture: Fixture, respond: () => Response) {
  const held: (() => void)[] = [];
  fixture.runtime.server.on(
    "POST",
    actionPath,
    () => new Promise((resolve) => held.push(() => resolve(respond()))),
  );
  return () => {
    for (const release of held.splice(0)) release();
  };
}

function accepted(action: string) {
  return Response.json(
    { action, computer_id: "computer-lab", model_id: "held" },
    { status: 202 },
  );
}

function enableReadyPi(fixture: Fixture) {
  for (const computer of fixture.runtime.seed.localComputers) {
    computer.runtimes = [
      ...computer.runtimes.filter((runtime) => runtime.type !== "pi"),
      {
        models: [],
        status: "ready",
        type: "pi",
        version: "1.3.0",
      },
    ];
  }
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
    await renderPage(setup());
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

  it("marks the model the Computer recommends, whatever its fit", async () => {
    // localmodels recommends what its stack would install: on a small Mac a
    // ladder model, on a small card a fallback that runs from system memory.
    const absent = (
      id: string,
      name: string,
      fit: "system" | "unified",
      recommended: boolean,
    ) =>
      modelView(
        localModel({
          download_bytes: gb(2.6),
          family: "other",
          fit,
          id,
          name,
          pool: fit === "system" ? "system" : "unified",
          recommended,
        }),
      );
    const fixture = setup([
      macView({
        models: [
          absent("qwen3.8-27b-iq3s:UD-IQ3_S", "Qwen3.8 27B", "unified", false),
          absent("spark-x2.6-4b:Q4_K_M", "Spark-X2.6 4B", "unified", true),
        ],
      }),
      labView({
        computer: { ...labView().computer, computer_id: "computer-win" },
        models: [absent("qwen3.5-9b:Q4_K_M", "Qwen3.5 9B", "system", true)],
      }),
    ]);
    await renderPage(fixture, "?computer=computer-mac");
    await findModels();
    expect(statuses()).toEqual([
      "Spark-X2.6 4B: Not downloaded · 2.6 GB · Recommended",
      "Qwen3.8 27B: Not downloaded · 2.6 GB",
    ]);

    cleanup();
    await renderPage(fixture, "?computer=computer-win");
    await waitFor(() =>
      expect(statuses()).toEqual([
        "Qwen3.5 9B: Not downloaded · 2.6 GB · Recommended",
      ]),
    );
  });

  it("expands one row at a time to show a model's details", async () => {
    await renderPage(setup());
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
    await renderPage(setup());
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
    await renderPage(
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
    await renderPage(fixture);
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

  it.each(["DOWNLOAD_FAILED", "NETWORK_UNAVAILABLE"] as const)(
    "resumes a download that stopped with %s instead of loading it",
    async (code) => {
      const fixture = setup([
        withModel(macView(), "llama3.3-70b:Q4_K_M", {
          error: { code, detail: "retries exhausted" },
        }),
      ]);
      await renderPage(fixture);
      await findModels();

      expect(statusOf("Llama 3.3 70B")).toBe(
        code === "NETWORK_UNAVAILABLE"
          ? "Download stopped · network unavailable"
          : "Download stopped",
      );
      expect(
        screen.queryByRole("button", { name: "Retry Llama 3.3 70B" }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Resume download Llama 3.3 70B" }),
      );
      await waitFor(() =>
        expect(fixture.actions).toEqual([
          {
            body: { action: "download" },
            computerId: "computer-mac",
            modelId: "llama3.3-70b:Q4_K_M",
          },
        ]),
      );
    },
  );

  it("shows a resumed download as under way from the click", async () => {
    const fixture = setup([
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        error: { code: "DOWNLOAD_FAILED" },
      }),
    ]);
    const answer = holdActions(fixture, () => accepted("download"));
    await renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Resume download Llama 3.3 70B" }),
    );
    await waitFor(() =>
      expect(statusOf("Llama 3.3 70B")).toMatch(/^Downloading/),
    );
    answer();
  });

  it("lets an accepted download be cancelled before its first progress", async () => {
    const fixture = setup();
    await renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Download GPT-OSS 20B" }),
    );
    const cancel = await screen.findByRole("button", {
      name: "Cancel GPT-OSS 20B",
    });
    await waitFor(() => expect(cancel).toBeEnabled());
    expect(statusOf("GPT-OSS 20B")).toBe("Downloading");

    const answer = holdActions(fixture, () => accepted("cancel"));
    fireEvent.click(cancel);
    await waitFor(() => expect(statusOf("GPT-OSS 20B")).toBe("Cancelling"));
    expect(
      screen.queryByRole("button", { name: "Download GPT-OSS 20B" }),
    ).toBeNull();
    answer();
  });

  it("shows a download as cancelling from the click until the Computer stops it", async () => {
    const fixture = setup([
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        download: { done_bytes: 32, step: "download", total_bytes: 100 },
        state: "downloading",
      }),
    ]);
    const answer = holdActions(fixture, () => accepted("cancel"));
    await renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Cancel GPT-OSS 20B" }));
    await waitFor(() => expect(statusOf("GPT-OSS 20B")).toBe("Cancelling"));
    expect(
      card("GPT-OSS 20B").querySelector(".town-shimmer-text"),
    ).not.toBeNull();

    // Progress keeps arriving while the tool stops the download.
    publishSnapshot(
      fixture,
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        download: { done_bytes: 40, step: "download", total_bytes: 100 },
        state: "downloading",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("progressbar", {
          name: "GPT-OSS 20B download progress",
        }),
      ).toHaveAttribute("aria-valuenow", "40"),
    );
    expect(statusOf("GPT-OSS 20B")).toBe("Cancelling");

    publishSnapshot(fixture, labView());
    answer();
    await waitFor(() =>
      expect(statusOf("GPT-OSS 20B")).toMatch(/^Not downloaded/),
    );
  });

  it("discards a stopped download instead of removing it", async () => {
    const fixture = setup([
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        error: { code: "DOWNLOAD_FAILED" },
      }),
    ]);
    await renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Llama 3.3 70B" }));
    const details = screen.getByRole("region", {
      name: "Llama 3.3 70B details",
    });
    expect(details).toHaveTextContent("Last download");
    expect(
      within(details).queryByRole("button", { name: "Remove from computer" }),
    ).toBeNull();
    fireEvent.click(
      within(details).getByRole("button", { name: "Discard download" }),
    );
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "cancel" },
          computerId: "computer-mac",
          modelId: "llama3.3-70b:Q4_K_M",
        },
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    [
      "/home/ana/.local/share/localmodels/tools/gateway-home",
      "It loaded, but Agents couldn't be given access to it: the folder /home/ana/.local/share/localmodels/tools/gateway-home belongs to another account. Quit Linger, rename that folder, then open Linger and load the model again.",
    ],
    [
      undefined,
      "It loaded, but Agents couldn't be given access to it: a Linger folder on the computer belongs to another account.",
    ],
  ])(
    "explains a gateway folder another account owns (path %s)",
    async (path, copy) => {
      await renderPage(
        setup([
          withModel(macView(), "llama3.3-70b:Q4_K_M", {
            error: {
              cause: "GATEWAY_HOME_NOT_PRIVATE",
              code: "GATEWAY_REGISTRATION_FAILED",
              detail: "raw gateway detail",
              ...(path ? { path } : {}),
            },
          }),
        ]),
      );
      await findModels();

      fireEvent.click(screen.getByRole("button", { name: "Llama 3.3 70B" }));
      const details = screen.getByRole("region", {
        name: "Llama 3.3 70B details",
      });
      expect(details).toHaveTextContent(copy);
      expect(details).not.toHaveTextContent("raw gateway detail");
    },
  );

  it("retries a model that failed to load with a load and still offers Remove", async () => {
    const fixture = setup([
      withModel(macView(), "llama3.3-70b:Q4_K_M", {
        error: { code: "ENGINE_START_FAILED" },
        memory_bytes: gb(10),
      }),
    ]);
    await renderPage(fixture);
    await findModels();

    expect(statusOf("Llama 3.3 70B")).toBe(
      "Couldn't load · engine didn't start",
    );
    fireEvent.click(screen.getByRole("button", { name: "Llama 3.3 70B" }));
    const details = screen.getByRole("region", {
      name: "Llama 3.3 70B details",
    });
    expect(details).toHaveTextContent("Last load");
    expect(
      within(details).getByRole("button", { name: "Remove from computer" }),
    ).toBeEnabled();
    expect(
      within(details).queryByRole("button", { name: "Discard download" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "load" },
          computerId: "computer-mac",
          modelId: "llama3.3-70b:Q4_K_M",
        },
      ]),
    );
  });

  it("loads at once when the pool has room", async () => {
    const fixture = setup();
    await renderPage(fixture);
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
    await renderPage(fixture, "?computer=computer-mac");
    await findModels();

    expect(statuses()).toContain(
      "Llama 3.3 70B: Couldn't load · not enough free memory",
    );
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
    await renderPage(
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
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    expect(dialog).toHaveTextContent(
      "Llama 3.3 70B needs more than all 40 GB of Unified memory, so it can't load there.",
    );
    expect(within(dialog).getByRole("button", { name: "Load" })).toBeDisabled();
  });

  it("names the apps holding the memory instead of calling the model too big", async () => {
    const lab = labView();
    const qwen = localModel({
      id: "qwen3-14b:Q4_K_M",
      memory_bytes: gb(8.9),
      name: "Qwen3 14B",
      pool: "gpu:0",
      state: "idle",
    });
    // A 16 GB card where Linger's embedding holds 1 GB and other apps 8 GB:
    // the model fits the empty card but not what is free now.
    const pool = gpuPool(0, 16, [
      { component: true, gb: 1, id: "embedding", name: "Qwen3 Embedding" },
    ]);
    await renderPage(
      setup([
        {
          ...lab,
          models: [modelView(qwen)],
          pools: [{ ...pool, used_bytes: gb(9) }],
        },
      ]),
    );
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Qwen3 14B" }));
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    expect(dialog).toHaveTextContent(
      "Qwen3 14B needs 8.9 GB on GPU 0 · RTX 4090; 7 GB is free.",
    );
    expect(dialog).not.toHaveTextContent("empty");
    const inUse = within(dialog).getByRole("list", {
      name: "Also using this memory",
    });
    expect(
      within(inUse)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Other apps8 GB", "Qwen3 Embedding1 GB"]);
    expect(dialog).toHaveTextContent(
      "Other apps are using 8 GB. Close other apps that use GPU 0, then click Recheck memory.",
    );
    expect(within(dialog).getByRole("button", { name: "Load" })).toBeDisabled();
  });

  it("lists other apps when unloading every model still isn't enough", async () => {
    const lab = labView();
    const pool = gpuPool(0, 24, [
      { gb: 10, id: "qwen3-coder-30b:Q4_K_M", name: "Qwen3 Coder 30B" },
    ]);
    await renderPage(
      setup([
        withModel(
          withModel(
            { ...lab, pools: [{ ...pool, used_bytes: gb(22) }, lab.pools[1]!] },
            "qwen3-coder-30b:Q4_K_M",
            { memory_bytes: gb(10) },
          ),
          "gemma3-27b:Q4_K_M",
          { pool: "gpu:0", memory_bytes: gb(13) },
        ),
      ]),
    );
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    expect(
      within(dialog).getByRole("checkbox", { name: /Qwen3 Coder 30B/ }),
    ).not.toBeChecked();
    expect(
      within(
        within(dialog).getByRole("list", { name: "Also using this memory" }),
      ).getByRole("listitem"),
    ).toHaveTextContent("Other apps12 GB");
    expect(dialog).toHaveTextContent(
      "Other apps are using 12 GB. Close other apps that use GPU 0, then click Recheck memory.",
    );
  });

  it("asks before unloading a model an Agent uses, and not otherwise", async () => {
    const fixture = setup();
    await renderPage(fixture);
    await findModels();

    expect(
      within(card("Qwen3 Coder 30B")).getByText("2 Agents"),
    ).toHaveAttribute("title", "Used by Research agent, Code reviewer");

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
      observed_at: "2026-11-13T10:00:05.000Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Qwen3 Coder 30B details" }),
      ).toHaveTextContent("No Agent yet"),
    );
    expect(
      within(card("Qwen3 Coder 30B")).queryByText(/^\d+ Agents?$/),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(fixture.actions).toHaveLength(2));
  });

  it("warns which Agents lose their model before removing it", async () => {
    const fixture = setup();
    await renderPage(fixture);
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
    await renderPage(fixture);
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
    await renderPage(fixture, "?computer=computer-lab");
    await findModels();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Models",
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
    await renderPage(fixture, "?computer=computer-lab");
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
      await renderPage(fixture);
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
    await renderPage(fixture);
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

  it("shows a load as under way from the click until a snapshot reflects it", async () => {
    const fixture = setup();
    const answer = holdActions(fixture, () => accepted("load"));
    let reads = 0;
    fixture.runtime.server.on("GET", viewPath, ({ params }) => {
      reads += 1;
      return fixture.views[params.computerId!];
    });
    await renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    await waitFor(() => expect(statusOf("Gemma 3 27B")).toMatch(/^Loading/));
    const row = card("Gemma 3 27B");
    expect(
      within(row).queryByRole("button", { name: "Load Gemma 3 27B" }),
    ).toBeNull();
    expect(row.querySelector(".town-shimmer-text")).not.toBeNull();

    // Accepted, and the fresh read still carries the snapshot from before.
    const readsBefore = reads;
    answer();
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore));
    expect(statusOf("Gemma 3 27B")).toMatch(/^Loading/);

    publishSnapshot(
      fixture,
      withModel(labView(), "gemma3-27b:Q4_K_M", { state: "loaded" }),
    );
    await waitFor(() => expect(statusOf("Gemma 3 27B")).toMatch(/^Loaded/));
  });

  it("spins and disables the row's button while an unload is sent", async () => {
    const fixture = setup();
    const answer = holdActions(fixture, () => accepted("unload"));
    await renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Unload Qwen3 Coder 30B" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Unload Qwen3 Coder 30B?" }),
      ).getByRole("button", { name: "Unload" }),
    );
    const unload = await screen.findByRole("button", {
      name: "Unload Qwen3 Coder 30B",
    });
    await waitFor(() => expect(unload).toHaveAttribute("aria-busy", "true"));
    expect(unload).toBeDisabled();
    expect(statusOf("Qwen3 Coder 30B")).toBe("Unloading");

    answer();
    publishSnapshot(
      fixture,
      withModel(labView(), "qwen3-coder-30b:Q4_K_M", { state: "idle" }),
    );
    await waitFor(() =>
      expect(statusOf("Qwen3 Coder 30B")).toMatch(/^Downloaded/),
    );
    expect(
      screen.getByRole("button", { name: "Load Qwen3 Coder 30B" }),
    ).toBeEnabled();
  });

  it("puts the row back and explains when the Computer refuses", async () => {
    const fixture = setup();
    const answer = holdActions(fixture, () =>
      teamHubErrorResponse(409, "LOCAL_MODEL_NO_ROOM", "raw refusal detail"),
    );
    await renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    await waitFor(() => expect(statusOf("Gemma 3 27B")).toMatch(/^Loading/));

    answer();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gemma 3 27B: There isn't enough free memory to load it. Close memory-heavy apps or unload another model, then recheck memory.",
    );
    expect(statusOf("Gemma 3 27B")).toMatch(/^Downloaded/);
    expect(
      screen.getByRole("button", { name: "Load Gemma 3 27B" }),
    ).toBeEnabled();
  });

  it("shows a refusal from the Computer as copy for its code", async () => {
    const fixture = setup();
    fixture.runtime.server.on("POST", actionPath, () =>
      teamHubErrorResponse(409, "LOCAL_MODEL_NO_ROOM", "raw refusal detail"),
    );
    await renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gemma 3 27B: There isn't enough free memory to load it. Close memory-heavy apps or unload another model, then recheck memory.",
    );
    expect(screen.queryByText(/raw refusal detail/)).not.toBeInTheDocument();
  });

  it("shows what an offline Computer last reported with every action off", async () => {
    await renderPage(
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
    await renderPage(setup([labView({ viewer_is_owner: false })]));
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
      await renderPage(
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
      expect(
        screen.queryByRole("button", { name: "Recheck memory" }),
      ).not.toBeInTheDocument();
    },
  );

  it("sends a Tenant without Computers to Computers", async () => {
    await renderPage(setup([], []));

    const empty = await screen.findByRole("region", {
      name: "No computers yet",
    });
    fireEvent.click(within(empty).getByRole("link", { name: "Computers" }));
    expect(await screen.findByText("Computers page")).toBeVisible();
  });

  it("renders a model that fits nowhere without a placement", async () => {
    await renderPage(setup());
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
    await renderPage(
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
    await renderPage(setup(), "?computer=computer-mac");
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
    await renderPage(setup());

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Computer" }),
      ).toHaveTextContent("Mac Studio"),
    );
    await waitFor(() =>
      expect(statuses()[0]).toBe("GPT-OSS 20B: Loaded · Memory · 14.3 GB"),
    );
  });

  it("shows rich model card icons, capability badges, and expanded metadata", async () => {
    const richLab = withModel(labView(), "qwen3-coder-30b:Q4_K_M", {
      active_parameters: "3B",
      architecture: "moe",
      capabilities: ["coding", "tool_use", "reasoning"],
      family: "qwen",
      license: "Apache-2.0",
      parameters: "30B",
      prompt_tokens_per_second: 612.5,
      publisher: "Alibaba Cloud",
      source_url: "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",
    });
    const visionLab = withModel(richLab, "gemma3-4b:Q4_K_M", {
      family: "gemma",
      vision: true,
    });
    await renderPage(setup([visionLab]));
    await findModels();

    const coderCard = card("Qwen3 Coder 30B");
    expect(coderCard).toHaveAttribute("data-status", "loaded");
    const qwenTile = coderCard.querySelector('[data-family="qwen"]');
    expect(qwenTile).toBeInTheDocument();
    expect(qwenTile).toHaveClass("bg-lavender-500/15", "text-lavender-700");
    expect(within(coderCard).getByText("2 Agents")).toBeVisible();
    expect(within(coderCard).getByText("3B active")).toBeVisible();
    expect(within(coderCard).getByText("Tool use")).toBeVisible();
    expect(within(coderCard).getByText("Reasoning")).toBeVisible();
    expect(within(coderCard).getByText("+1")).toHaveAttribute(
      "title",
      "Coding",
    );

    const gemmaCard = card("Gemma 3 4B");
    expect(gemmaCard).toHaveAttribute("data-status", "available");
    const gemmaTile = gemmaCard.querySelector('[data-family="gemma"]');
    expect(gemmaTile).toBeInTheDocument();
    expect(gemmaTile).toHaveClass("bg-bluebell-500/15", "text-bluebell-700");
    expect(within(gemmaCard).getByText("Vision")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    const details = screen.getByRole("region", {
      name: "Qwen3 Coder 30B details",
    });
    expect(details).toHaveTextContent("PublisherAlibaba Cloud");
    expect(details).toHaveTextContent("Parameters30B · 3B active (MoE)");
    expect(details).toHaveTextContent("Coding");
    expect(details).toHaveTextContent("46 tokens/s · 613 prompt tokens/s");
    expect(details).toHaveTextContent("LicenseApache-2.0");
    const link = within(details).getByRole("link", {
      name: "huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("distinguishes card states and keeps a single-node responsive header without competing utilities", async () => {
    const view = withModel(
      withModel(labView(), "gpt-oss-20b:Q4_K_M", {
        capabilities: ["tool_use"],
        parameters: "20B",
      }),
      "gemma3-27b:Q4_K_M",
      {
        error: { code: "ENGINE_START_FAILED" },
        state: "failed",
      },
    );
    await renderPage(setup([view]));
    await findModels();

    const loadedCard = card("Qwen3 Coder 30B");
    expect(loadedCard).toHaveAttribute("data-status", "loaded");
    expect(loadedCard).not.toHaveAttribute("data-recommended");

    const recommendedCard = card("GPT-OSS 20B");
    expect(recommendedCard).toHaveAttribute("data-status", "available");
    expect(recommendedCard).toHaveAttribute("data-recommended", "true");
    expect(
      within(recommendedCard).getByRole("button", {
        name: "Download GPT-OSS 20B",
      }),
    ).toHaveClass("bg-primary");
    const badgeGroup = within(recommendedCard)
      .getByText("Tool use")
      .closest("div")!;
    expect(badgeGroup).toHaveClass("flex");
    expect(badgeGroup).not.toHaveClass("hidden");
    expect(recommendedCard.firstElementChild).toHaveClass("grid");
    expect(recommendedCard.firstElementChild).not.toHaveClass("flex", "hidden");

    const failedCard = card("Gemma 3 27B");
    expect(failedCard).toHaveAttribute("data-status", "failed");

    const unavailableCard = card("Llama 3.1 405B");
    expect(unavailableCard).toHaveAttribute("data-status", "unavailable");
  });

  it("shows live download rate and ETA when bytes_per_second is reported", async () => {
    const mb = 1024 * 1024;
    await renderPage(
      setup([
        withModel(labView(), "gpt-oss-20b:Q4_K_M", {
          download: {
            bytes_per_second: 50 * mb,
            done_bytes: 5_000 * mb,
            step: "download",
            total_bytes: 20_000 * mb,
          },
          state: "downloading",
        }),
      ]),
    );
    await findModels();

    expect(statuses()).toContain(
      "GPT-OSS 20B: Downloading · 25% · 50 MB/s · 5m left",
    );
  });

  it("shows Bifrost gateway readiness above Endpoint on an expanded loaded model", async () => {
    const view = labView();
    const computer = {
      ...inventoryComputer(view),
      runtimes: [
        ...inventoryComputer(view).runtimes,
        {
          models: [
            {
              id: "localmodels-library/qwen3-coder-30b",
              label: "Qwen3 Coder 30B",
            },
          ],
          status: "ready" as const,
          type: "pi" as const,
          version: "1.3.0",
        },
      ],
    };
    await renderPage(setup([view], [computer]));
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    const details = screen.getByRole("region", {
      name: "Qwen3 Coder 30B details",
    });
    expect(details).toHaveTextContent("GatewayReady · Bifrost (Pi)");
    expect(details).toHaveTextContent("Endpointhttp://127.0.0.1:18100/v1");
  });

  it("reflects Pi runtime setup, catalog registration, and failure states in the Gateway row", async () => {
    const fixture = setup([labView()]);
    await renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    const details = screen.getByRole("region", {
      name: "Qwen3 Coder 30B details",
    });
    expect(details).toHaveTextContent("GatewayBifrost · Pi not installed");
    expect(
      screen.queryByRole("button", { name: /Use Qwen3 Coder 30B with/u }),
    ).toBeNull();

    const computer = fixture.runtime.seed.localComputers[0]!;
    computer.runtimes = [
      ...computer.runtimes,
      {
        models: [],
        status: "not_installed",
        type: "pi",
      },
    ];
    fixture.runtime.events.emitSignal({
      hint: {
        id: "computer-lab",
        resource: "computers",
        tenant_id: tenantId,
      },
      type: "resource.invalidated",
    });
    await waitFor(() =>
      expect(details).toHaveTextContent("GatewayBifrost · Setting up Pi…"),
    );
    expect(
      screen.queryByRole("button", { name: /Use Qwen3 Coder 30B with/u }),
    ).toBeNull();

    computer.runtimes = computer.runtimes.map((runtime) =>
      runtime.type === "pi"
        ? { ...runtime, status: "ready", version: "1.3.0" }
        : runtime,
    );
    fixture.runtime.events.emitSignal({
      hint: {
        id: "computer-lab",
        resource: "computers",
        tenant_id: tenantId,
      },
      type: "resource.invalidated",
    });
    await waitFor(() =>
      expect(details).toHaveTextContent(
        "GatewayBifrost · Registering with Pi…",
      ),
    );
    expect(
      await screen.findByRole("button", {
        name: "Use Qwen3 Coder 30B with Jenny's Delegate",
      }),
    ).toBeVisible();

    computer.runtimes = computer.runtimes.map((runtime) =>
      runtime.type === "pi" ? { ...runtime, status: "error" } : runtime,
    );
    fixture.runtime.events.emitSignal({
      hint: {
        id: "computer-lab",
        resource: "computers",
        tenant_id: tenantId,
      },
      type: "resource.invalidated",
    });
    await waitFor(() =>
      expect(details).toHaveTextContent("GatewayBifrost · Pi unavailable"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Use Qwen3 Coder 30B with/u }),
      ).toBeNull(),
    );
  });

  it("switches Another Me to a loaded model in one click and opens its chat", async () => {
    const fixture = setup();
    enableReadyPi(fixture);
    acceptTenantAgentUpdates(fixture.runtime);
    await renderPage(fixture);
    await findModels();

    const useButton = await screen.findByRole("button", {
      name: "Use Qwen3 Coder 30B with Jenny's Delegate",
    });
    fireEvent.click(useButton);

    await waitFor(() =>
      expect(
        fixture.runtime.server.requestsTo(
          "PATCH",
          "/v0/tenants/{tenantId}/agents/{agentId}",
        ),
      ).toHaveLength(1),
    );
    const openChat = await screen.findByRole("link", { name: "Open chat" });
    expect(openChat).toHaveAttribute(
      "href",
      "/t/tenant-northstar/rooms/room-another-me/chat",
    );
    expect(
      within(card("Qwen3 Coder 30B")).getByText("3 Agents"),
    ).toHaveAttribute(
      "title",
      "Used by Research agent, Code reviewer, Jenny's Delegate",
    );

    fireEvent.click(openChat);
    expect(await screen.findByText("Another Me room")).toBeVisible();
  });

  it("lets the Sponsor switch other Agents from Used by while disabling busy ones", async () => {
    const fixture = setup();
    enableReadyPi(fixture);
    acceptTenantAgentUpdates(fixture.runtime);
    fixture.runtime.seed.tenantAgents = fixture.runtime.seed.tenantAgents.map(
      (agent) =>
        agent.actor.id === "actor-codex"
          ? {
              ...agent,
              availability: {
                active_task_count: 1,
                label: "Working",
                status: "online",
              },
            }
          : agent,
    );
    await renderPage(fixture);
    await findModels();

    await screen.findByRole("button", {
      name: "Use Qwen3 Coder 30B with Jenny's Delegate",
    });
    fireEvent.click(screen.getByRole("button", { name: "Qwen3 Coder 30B" }));
    const details = screen.getByRole("region", {
      name: "Qwen3 Coder 30B details",
    });
    const switcher = within(details).getByRole("combobox", {
      name: "Switch an Agent to Qwen3 Coder 30B",
    });
    fireEvent.click(switcher);
    const busyCodex = await screen.findByRole("option", {
      name: "Codex · Working",
    });
    expect(busyCodex).toBeDisabled();

    // Finish Codex's active turn, then switch Codex from Used by.
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    fixture.runtime.seed.tenantAgents = fixture.runtime.seed.tenantAgents.map(
      (agent) =>
        agent.actor.id === "actor-codex"
          ? {
              ...agent,
              availability: {
                active_task_count: 0,
                label: "Online",
                status: "online",
              },
            }
          : agent,
    );
    fixture.runtime.events.emitSignal({
      hint: { id: "actor-codex", resource: "agents", tenant_id: tenantId },
      type: "resource.invalidated",
    });

    fireEvent.click(
      within(details).getByRole("combobox", {
        name: "Switch an Agent to Qwen3 Coder 30B",
      }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));

    await waitFor(() =>
      expect(
        fixture.runtime.server.requestsTo(
          "PATCH",
          "/v0/tenants/{tenantId}/agents/{agentId}",
        ),
      ).toHaveLength(1),
    );
    expect(details).toHaveTextContent("Codex");
  });

  it("hands affected Agents over automatically once a Make room replacement model loads", async () => {
    const mac = withModel(macView(), "llama3.3-70b:Q4_K_M", {
      pi_model: "localmodels-library/llama3.3-70b",
    });
    const fixture = setup([mac]);
    enableReadyPi(fixture);
    acceptTenantAgentUpdates(fixture.runtime);
    fixture.runtime.seed.tenantAgents = fixture.runtime.seed.tenantAgents.map(
      (agent) =>
        agent.actor.id === "actor-delegate"
          ? {
              ...agent,
              runtime: {
                model: "localmodels-library/gpt-oss-20b",
                placement: {
                  computer_id: "computer-mac",
                  runtime_type: "pi",
                  type: "local",
                  workspace_grant_id: "grant-linger-workspace",
                },
              },
            }
          : agent,
    );
    await renderPage(fixture, "?computer=computer-mac");
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    const handoff = within(dialog).getByRole("checkbox", {
      name: "Switch Jenny's Delegate to Llama 3.3 70B once loaded",
    });
    expect(handoff).toBeChecked();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unload and load" }),
    );
    await waitFor(() => expect(fixture.actions).toHaveLength(1));
    expect(
      fixture.runtime.server.requestsTo(
        "PATCH",
        "/v0/tenants/{tenantId}/agents/{agentId}",
      ),
    ).toHaveLength(0);

    publishSnapshot(
      fixture,
      withModel(mac, "llama3.3-70b:Q4_K_M", {
        endpoint: { base_url: "http://127.0.0.1:18100/v1" },
        state: "loaded",
      }),
    );

    await waitFor(() =>
      expect(
        fixture.runtime.server.requestsTo(
          "PATCH",
          "/v0/tenants/{tenantId}/agents/{agentId}",
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(
        within(card("Llama 3.3 70B")).getByText("1 Agent"),
      ).toHaveAttribute("title", "Used by Jenny's Delegate"),
    );
  });

  it("explains when an Agent becomes busy before a Make room replacement model finishes loading", async () => {
    const baseMac = withModel(macView(), "llama3.3-70b:Q4_K_M", {
      pi_model: "localmodels-library/llama3.3-70b",
    });
    const mac = {
      ...baseMac,
      models: [
        ...baseMac.models,
        modelView(
          localModel({
            endpoint: { base_url: "http://127.0.0.1:18100/v1" },
            fit: "unified",
            id: "qwen3-coder-30b:Q4_K_M",
            memory_bytes: gb(4),
            name: "Qwen3 Coder 30B",
            pi_model: "localmodels-library/qwen3-coder-30b",
            pool: "unified",
            state: "loaded",
          }),
        ),
      ],
    };
    const fixture = setup([mac]);
    enableReadyPi(fixture);
    acceptTenantAgentUpdates(fixture.runtime);
    fixture.runtime.seed.tenantAgents = fixture.runtime.seed.tenantAgents.map(
      (agent) =>
        agent.actor.id === "actor-delegate"
          ? {
              ...agent,
              runtime: {
                model: "localmodels-library/gpt-oss-20b",
                placement: {
                  computer_id: "computer-mac",
                  runtime_type: "pi",
                  type: "local",
                  workspace_grant_id: "grant-linger-workspace",
                },
              },
            }
          : agent,
    );
    await renderPage(fixture, "?computer=computer-mac");
    await findModels();

    const useQwen = await screen.findByRole("button", {
      name: "Use Qwen3 Coder 30B with Jenny's Delegate",
    });
    expect(useQwen).toBeEnabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unload and load" }),
    );
    await waitFor(() => expect(fixture.actions).toHaveLength(1));

    // Jenny's Delegate starts a turn before the replacement model finishes loading.
    fixture.runtime.seed.tenantAgents = fixture.runtime.seed.tenantAgents.map(
      (agent) =>
        agent.actor.id === "actor-delegate"
          ? {
              ...agent,
              availability: {
                active_task_count: 1,
                label: "Working",
                status: "online",
              },
            }
          : agent,
    );
    fixture.runtime.events.emitSignal({
      hint: { id: "actor-delegate", resource: "agents", tenant_id: tenantId },
      type: "resource.invalidated",
    });
    await waitFor(() => expect(useQwen).toBeDisabled());

    publishSnapshot(
      fixture,
      withModel(mac, "llama3.3-70b:Q4_K_M", {
        endpoint: { base_url: "http://127.0.0.1:18100/v1" },
        state: "loaded",
      }),
    );

    expect(
      await screen.findByText(
        "Couldn't switch Jenny's Delegate to Llama 3.3 70B while working. Switch once the current turn finishes.",
      ),
    ).toBeVisible();
    expect(
      fixture.runtime.server.requestsTo(
        "PATCH",
        "/v0/tenants/{tenantId}/agents/{agentId}",
      ),
    ).toHaveLength(0);
  });

  it("hides the Make room handoff checkbox when Pi is not ready for Agent switching", async () => {
    const mac = withModel(macView(), "llama3.3-70b:Q4_K_M", {
      pi_model: "localmodels-library/llama3.3-70b",
    });
    const fixture = setup([mac]);
    fixture.runtime.seed.tenantAgents = fixture.runtime.seed.tenantAgents.map(
      (agent) =>
        agent.actor.id === "actor-delegate"
          ? {
              ...agent,
              runtime: {
                model: "localmodels-library/gpt-oss-20b",
                placement: {
                  computer_id: "computer-mac",
                  runtime_type: "pi",
                  type: "local",
                  workspace_grant_id: "grant-linger-workspace",
                },
              },
            }
          : agent,
    );
    await renderPage(fixture, "?computer=computer-mac");
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    expect(
      within(dialog).queryByRole("checkbox", {
        name: /Switch Jenny's Delegate/u,
      }),
    ).toBeNull();
  });
});

describe("Model source", () => {
  const switchPath =
    "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source";
  const testPath =
    "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source/test";
  const modelsPath =
    "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source/models";
  const byokStatus = {
    byok: {
      base_url: "https://api.example.com",
      configured: true,
      endpoint: "/chat/completions",
      key_saved: true,
      model_id: "vendor/model",
      path: "/v1",
      protocol: "openai-chat",
    },
    mode: "byok",
    runtime: "codex",
    runtime_model: "localmodels-byok",
  };
  const unconfigured = {
    byok: { configured: false, key_saved: false },
    mode: "subscription",
    runtime: "claude",
    runtime_model: "",
  };

  function withSource(fixture: Fixture, status: object) {
    const switches: unknown[] = [];
    const tests: unknown[] = [];
    const listings: unknown[] = [];
    fixture.runtime.server
      .on("POST", modelsPath, ({ body }) => {
        listings.push(body);
        return Response.json({
          models: [
            { context_window: 131_072, id: "vendor/model", name: "Vendor" },
            { id: "vendor/other" },
          ],
          url: "https://api.example.com/v1/models",
        });
      })
      .on("GET", switchPath, ({ params }) =>
        Response.json({
          computer_id: params.computerId,
          online: true,
          status,
          viewer_is_owner: true,
        }),
      )
      .on("POST", testPath, ({ body }) => {
        tests.push(body);
        const { byok } = body as {
          byok: { base_url: string; endpoint: string; path: string };
        };
        return Response.json({
          context_window: 131_072,
          model_id: "vendor/model",
          ok: true,
          protocol: "openai-chat",
          url: byok.base_url + byok.path + byok.endpoint,
        });
      });
    return { listings, switches, tests };
  }

  it("opens on the source in use and explains BYOK on hover", async () => {
    const fixture = setup([labView()]);
    withSource(fixture, byokStatus);
    await renderPage(fixture);

    const tabs = await screen.findByRole("tablist", { name: "Model source" });
    expect(
      within(tabs).getByRole("tab", { name: /BYOK/u, selected: true }),
    ).toBeInTheDocument();
    expect(
      within(tabs).getByRole("img", { name: "In use" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Bring your own key");
    expect(
      screen.getByText("Agents on lab-118 use BYOK · vendor/model"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Stored privately/u)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API format")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toHaveValue(
      "https://api.example.com",
    );
    expect(screen.getByRole("combobox", { name: "Path" })).toHaveValue("/v1");
    expect(screen.getByRole("combobox", { name: "Endpoint" })).toHaveValue(
      "/chat/completions",
    );
    expect(
      screen.getByText(/^Sends OpenAI Chat Completions requests to/u),
    ).toHaveTextContent("https://api.example.com/v1/chat/completions");
    expect(
      screen.queryByRole("button", { name: "Test connection" }),
    ).not.toBeInTheDocument();
  });

  it("asks before ending running tasks and switches only once confirmed", async () => {
    const fixture = setup([labView()]);
    const { switches } = withSource(fixture, byokStatus);
    fixture.runtime.server.on("POST", switchPath, ({ body }) => {
      switches.push(body);
      if (!(body as { force_terminate?: boolean }).force_terminate)
        return Response.json(
          {
            error: {
              code: "AGENT_HAS_ACTIVE_RUNS",
              details: [
                {
                  code: "AGENT_HAS_ACTIVE_RUNS",
                  field: "agent",
                  reason: "Research agent",
                },
              ],
              message: "busy",
              request_id: "test-busy",
            },
          },
          { status: 409 },
        );
      return Response.json({
        computer_id: "computer-lab",
        online: true,
        status: { ...byokStatus, mode: "local", runtime: "pi" },
        terminated_run_count: 1,
        updated_agent_count: 2,
        viewer_is_owner: true,
      });
    });
    await renderPage(fixture);

    fireEvent.click(await screen.findByRole("tab", { name: "Local model" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Local model" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "End running tasks?",
    });
    expect(dialog).toHaveTextContent("Research agent is working on tasks");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Terminate tasks & Switch" }),
    );

    expect(
      await screen.findByText(
        "Agents now use Local model. 2 Agents were moved. 1 task was ended.",
      ),
    ).toBeInTheDocument();
    expect(switches).toHaveLength(2);
    expect(switches[0]).toMatchObject({ mode: "local" });
    expect(switches[1]).toEqual({
      ...(switches[0] as object),
      force_terminate: true,
    });
  });

  it("shows what the Computer serves after a switch fails", async () => {
    const fixture = setup([labView()]);
    withSource(fixture, byokStatus);
    let reads = 0;
    fixture.runtime.server
      .on("GET", switchPath, ({ params }) => {
        reads += 1;
        return Response.json({
          computer_id: params.computerId,
          online: true,
          status:
            reads === 1
              ? byokStatus
              : { ...byokStatus, mode: "local", runtime: "pi" },
          viewer_is_owner: true,
        });
      })
      .on("POST", switchPath, () =>
        Response.json(
          {
            error: {
              code: "MODEL_SOURCE_UNCONFIRMED",
              message: "late",
              request_id: "test-late",
            },
          },
          { status: 504 },
        ),
      );
    await renderPage(fixture);

    fireEvent.click(await screen.findByRole("tab", { name: "Local model" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Local model" }),
    );

    expect(
      await screen.findByText("Agents on lab-118 use Local model"),
    ).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it("tests and saves an endpoint, keeping the saved key when left blank", async () => {
    const fixture = setup([labView()]);
    const { switches, tests } = withSource(fixture, {
      ...byokStatus,
      mode: "local",
      runtime: "pi",
    });
    fixture.runtime.server.on("POST", switchPath, ({ body }) => {
      switches.push(body);
      const { byok } = body as { byok: { model_id: string } };
      return Response.json({
        computer_id: "computer-lab",
        online: true,
        status: {
          ...byokStatus,
          byok: { ...byokStatus.byok, model_id: byok.model_id },
        },
        viewer_is_owner: true,
      });
    });
    await renderPage(fixture);

    fireEvent.click(await screen.findByRole("tab", { name: /BYOK/u }));
    expect(await screen.findByLabelText("Model")).toHaveValue("vendor/model");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const connected = (await screen.findByText("Connected")).closest(
      '[role="status"]',
    );
    expect(connected).toHaveTextContent(
      "vendor/model · 128K context · OpenAI Chat Completions",
    );
    expect(connected).toHaveTextContent(
      "https://api.example.com/v1/chat/completions",
    );

    fireEvent.click(screen.getByRole("button", { name: "List models" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "vendor/other" }),
    );
    expect(screen.getByLabelText("Model")).toHaveValue("vendor/other");
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-new" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save & Switch to BYOK" }),
    );

    await waitFor(() => expect(switches).toHaveLength(1));
    fireEvent.click(await screen.findByRole("tab", { name: "Local model" }));
    fireEvent.click(screen.getByRole("tab", { name: /BYOK/u }));
    expect(await screen.findByLabelText("Model")).toHaveValue("vendor/other");
    const address = {
      base_url: "https://api.example.com",
      endpoint: "/chat/completions",
      path: "/v1",
      protocol: "openai-chat",
    };
    expect(tests).toEqual([
      {
        byok: { ...address, model_id: "vendor/model", reuse_saved_key: true },
      },
    ]);
    expect(switches).toEqual([
      {
        byok: { ...address, api_key: "sk-new", model_id: "vendor/other" },
        mode: "byok",
        runtime: "claude",
      },
    ]);
  });

  it("sends requests to the base URL, path and endpoint as entered", async () => {
    const fixture = setup([labView()]);
    const { listings, tests } = withSource(fixture, unconfigured);
    await renderPage(fixture);

    fireEvent.click(await screen.findByRole("tab", { name: /BYOK/u }));
    const path = screen.getByRole("combobox", { name: "Path" });
    const endpoint = screen.getByRole("combobox", { name: "Endpoint" });
    expect(path).toHaveValue("/v1");
    expect(path).toHaveClass("text-muted-foreground");
    expect(endpoint).toHaveValue("/messages");

    const baseUrl = screen.getByLabelText("Base URL");
    fireEvent.change(baseUrl, {
      target: { value: " https://open.bigmodel.cn/ " },
    });
    fireEvent.blur(baseUrl);
    expect(baseUrl).toHaveValue("https://open.bigmodel.cn");
    expect(
      screen.getByText(/^Sends Anthropic Messages requests to/u),
    ).toHaveTextContent("https://open.bigmodel.cn/v1/messages");

    fireEvent.click(
      screen.getByRole("button", { name: "Show Path suggestions" }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /^\/api\/paas\/v4 /u }),
    );
    expect(path).toHaveValue("/api/paas/v4");
    expect(path).toHaveClass("text-foreground");

    // An endpoint left at its default follows the Runtime.
    fireEvent.click(screen.getByRole("combobox", { name: "AI runtime" }));
    fireEvent.click(await screen.findByRole("option", { name: "Pi" }));
    expect(endpoint).toHaveValue("/chat/completions");
    expect(
      screen.getByText(/^Sends OpenAI Chat Completions requests to/u),
    ).toHaveTextContent(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );

    // Without an endpoint the address names no format, so Pi's own applies.
    fireEvent.click(
      screen.getByRole("button", { name: "Show Endpoint suggestions" }),
    );
    fireEvent.click(
      await screen.findByRole("option", {
        name: "- No endpoint. The base URL is the full address.",
      }),
    );
    expect(endpoint).toHaveValue("");
    expect(
      screen.getByText(
        /^Sends OpenAI Chat Completions \(the Pi format\) requests to/u,
      ),
    ).toHaveTextContent("https://open.bigmodel.cn/api/paas/v4");

    fireEvent.click(screen.getByRole("button", { name: "List models" }));
    await waitFor(() => expect(listings).toHaveLength(1));
    expect(listings[0]).toEqual({
      base_url: "https://open.bigmodel.cn",
      endpoint: "",
      path: "/api/paas/v4",
      protocol: "openai-chat",
    });

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: " glm-5 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(tests).toHaveLength(1));
    expect(tests[0]).toEqual({
      byok: {
        base_url: "https://open.bigmodel.cn",
        endpoint: "",
        model_id: "glm-5",
        path: "/api/paas/v4",
        protocol: "openai-chat",
      },
    });

    // A path carries only segments, never a query.
    fireEvent.change(path, { target: { value: "/v4?beta=1" } });
    expect(
      screen.getByText(/Path and endpoint take segments like \/v1/u),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "List models" })).toBeDisabled();
  });

  it("lists the models only on request, with the key as typed", async () => {
    const fixture = setup([labView()]);
    const { listings } = withSource(fixture, byokStatus);
    await renderPage(fixture);

    expect(
      await screen.findByText("List the endpoint's models, or type an ID."),
    ).toBeInTheDocument();
    expect(listings).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "List models" }));
    expect(
      await screen.findByText(
        "2 models listed from https://api.example.com/v1/models.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", {
        name: "vendor/model Vendor · 128K context",
      }),
    ).toBeInTheDocument();
    expect(listings).toEqual([
      {
        base_url: "https://api.example.com",
        endpoint: "/chat/completions",
        path: "/v1",
        protocol: "openai-chat",
        reuse_saved_key: true,
      },
    ]);

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-typed" },
    });
    expect(screen.queryByText(/models listed from/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "List models" }));
    await waitFor(() => expect(listings).toHaveLength(2));
    expect(listings[1]).toMatchObject({ api_key: "sk-typed" });
    expect(listings[1]).not.toHaveProperty("reuse_saved_key");
  });

  it("falls back to typing the model ID when the endpoint lists none", async () => {
    const fixture = setup([labView()]);
    withSource(fixture, byokStatus);
    fixture.runtime.server.on("POST", modelsPath, () =>
      teamHubErrorResponse(
        409,
        "BYOK_NOT_FOUND",
        "https://api.example.com/v1/models returned HTTP 404: the address or the model was not found.",
      ),
    );
    await renderPage(fixture);

    fireEvent.click(await screen.findByRole("button", { name: "List models" }));
    expect(
      await screen.findByText(
        "https://api.example.com/v1/models returned HTTP 404: the address or the model was not found.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("vendor/model");
  });

  it("keeps a failed test in view until dismissed and lets a success fade", async () => {
    const fixture = setup([labView()]);
    const { tests } = withSource(fixture, byokStatus);
    fixture.runtime.server.on("POST", testPath, ({ body }) => {
      tests.push(body);
      return tests.length === 1
        ? teamHubErrorResponse(
            409,
            "BYOK_NOT_FOUND",
            "https://api.example.com/v1/chat/completions returned HTTP 404: the address or the model was not found.",
          )
        : teamHubErrorResponse(
            409,
            "BYOK_AUTH_FAILED",
            "https://api.example.com/v1/chat/completions rejected the API key (HTTP 401).",
          );
    });
    await renderPage(fixture);
    // Only the toast's own timers run fake, between requests to the server.
    function afterFakeTime(act: () => void, ...steps: number[]) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        act();
        for (const step of steps)
          reactAct(() => {
            vi.advanceTimersByTime(step);
          });
      } finally {
        vi.useRealTimers();
      }
    }

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    const failed = await screen.findByRole("alert");
    expect(failed).toHaveTextContent("Couldn't connect");
    expect(failed).toHaveTextContent(
      "https://api.example.com/v1/chat/completions returned HTTP 404: the address or the model was not found.",
    );
    afterFakeTime(() => undefined, 10_000);
    expect(failed).toBeInTheDocument();
    afterFakeTime(
      () =>
        fireEvent.click(
          within(failed).getByRole("button", { name: "Dismiss" }),
        ),
      200,
    );
    expect(screen.queryByText("Couldn't connect")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "https://api.example.com/v1/chat/completions rejected the API key (HTTP 401).",
    );
    afterFakeTime(() => fireEvent.pointerDown(document.body), 200);
    expect(screen.queryByText("Couldn't connect")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Editing the address withdraws the result it no longer describes.
    fireEvent.change(screen.getByRole("combobox", { name: "Path" }), {
      target: { value: "/v2" },
    });
    expect(screen.queryByText("Couldn't connect")).not.toBeInTheDocument();

    fixture.runtime.server.on("POST", testPath, () =>
      Response.json({
        context_window: 2048,
        model_id: "vendor/model",
        ok: true,
        protocol: "openai-chat",
        url: "https://api.example.com/v2/chat/completions",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const connected = (await screen.findByText("Connected")).closest(
      '[role="status"]',
    )!;
    expect(connected).toHaveTextContent("vendor/model · 2K context");
    // Resting the pointer on a success keeps it; leaving lets it fade.
    fireEvent.mouseEnter(connected);
    afterFakeTime(() => undefined, 10_000);
    expect(connected).toBeInTheDocument();
    afterFakeTime(() => fireEvent.mouseLeave(connected), 1_500, 200);
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("switches back to a model already on the computer", async () => {
    const fixture = setup([labView()]);
    const { switches } = withSource(fixture, byokStatus);
    fixture.runtime.server.on("POST", switchPath, ({ body }) => {
      switches.push(body);
      return Response.json({
        computer_id: "computer-lab",
        online: true,
        status: { ...byokStatus, mode: "local", runtime: "pi" },
        viewer_is_owner: true,
      });
    });
    await renderPage(fixture);

    fireEvent.click(await screen.findByRole("tab", { name: "Local model" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Local model" }),
    );

    await waitFor(() => expect(switches).toHaveLength(1));
    expect(switches[0]).toMatchObject({ mode: "local" });
    expect(
      (switches[0] as { local_model_id?: string }).local_model_id,
    ).toBeTruthy();
  });

  it("guides users to free external memory, rechecks, and clears guidance when room returns", async () => {
    const blockedPool = {
      ...gpuPool(0, 24),
      used_bytes: gb(16),
    };
    const busyView = labView({
      models: [
        modelView(
          localModel({
            availability: {
              downloadable: false,
              reason: {
                code: "MEMORY_INSUFFICIENT",
                have_bytes: gb(8),
                need_bytes: gb(16),
              },
            },
            fit: "none",
            id: "qwen3.8-27b:IQ3_S",
            memory_bytes: gb(16),
            name: "Qwen3.8 27B",
            pool: undefined,
          }),
        ),
        modelView(
          localModel({
            id: "spark-4b:Q4_K_M",
            memory_bytes: gb(4),
            name: "Spark 4B",
            pool: "gpu:0",
          }),
        ),
      ],
      pools: [blockedPool],
    });
    const fixture = setup([busyView]);
    withSource(fixture, {
      ...byokStatus,
      mode: "subscription",
      runtime: "claude",
      runtime_model: "claude-sonnet",
    });
    await renderPage(fixture);

    const tabs = await screen.findByRole("tablist", { name: "Model source" });
    expect(
      within(tabs).getByRole("tab", { name: "Local model", selected: true }),
    ).toBeInTheDocument();
    expect(
      within(tabs).queryByRole("tab", { name: "Subscription" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Agents on lab-118 use Subscription · Claude Code"),
    ).toBeInTheDocument();

    const guidance = await screen.findByRole("complementary", {
      name: "Memory guidance",
    });
    expect(guidance).toHaveTextContent(
      "Free GPU memory to install a larger model",
    );
    fireEvent.click(
      within(guidance).getByRole("button", { name: "Recheck memory" }),
    );
    await waitFor(() => expect(fixture.refreshes).toEqual(["computer-lab"]));

    // After closing external GPU apps, the snapshot clears the warning and unlocks the 27B model.
    publishSnapshot(
      fixture,
      labView({
        models: [
          modelView(
            localModel({
              id: "qwen3.8-27b:IQ3_S",
              memory_bytes: gb(16),
              name: "Qwen3.8 27B",
              pool: "gpu:0",
              recommended: true,
            }),
          ),
        ],
        observed_at: "2026-11-13T10:05:00.000Z",
        pools: [gpuPool(0, 24)],
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Memory guidance" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Download Qwen3.8 27B" }),
    ).toBeEnabled();
  });

  it("rechecks memory from Make room to load on unified Macs and surfaces refresh failures", async () => {
    const busyMac = macView({
      models: [
        modelView(
          localModel({
            download_bytes: gb(42.5),
            error: { code: "LOAD_NO_ROOM", detail: "need 46 GiB" },
            fit: "unified",
            id: "llama3.3-70b:Q4_K_M",
            memory_bytes: gb(46),
            name: "Llama 3.3 70B",
            pool: "unified",
            state: "failed",
          }),
        ),
      ],
      pools: [
        {
          holders: [],
          id: "unified",
          kind: "unified",
          total_bytes: gb(51.2),
          used_bytes: gb(20),
        },
      ],
    });
    const fixture = setup([busyMac]);
    await renderPage(fixture);
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    expect(dialog).toHaveTextContent("Other apps are using 20 GB.");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Recheck memory" }),
    );
    await waitFor(() => expect(fixture.refreshes).toEqual(["computer-mac"]));

    publishSnapshot(fixture, {
      ...busyMac,
      observed_at: "2026-11-13T10:06:00.000Z",
      pools: [
        {
          holders: [],
          id: "unified",
          kind: "unified",
          total_bytes: gb(51.2),
          used_bytes: 0,
        },
      ],
    });

    await waitFor(() =>
      expect(dialog).toHaveTextContent(
        "Enough memory is free now (51.2 GB available).",
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Load" }));
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "load" },
          computerId: "computer-mac",
          modelId: "llama3.3-70b:Q4_K_M",
        },
      ]),
    );

    // Failed rechecks show a retryable action error without crashing the library.
    fixture.runtime.server.on("POST", viewPath, () =>
      teamHubErrorResponse(503, "LOCAL_COMPUTER_OFFLINE"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Recheck memory" }));
    expect(
      await screen.findByText(
        "The computer is offline. Reconnect it in Computers, then try again.",
      ),
    ).toBeInTheDocument();
  });

  it("clears preselected agent unloads after Recheck memory shows enough room", async () => {
    const busyMac = macView({
      models: [
        macView().models[0]!,
        modelView(
          localModel({
            download_bytes: gb(20),
            fit: "unified",
            id: "gemma3-27b:Q4_K_M",
            memory_bytes: gb(30),
            name: "Gemma 3 27B",
            pool: "unified",
            state: "idle",
          }),
        ),
      ],
      pools: [
        {
          holders: [
            {
              bytes: gb(14.3),
              id: "gpt-oss-20b:Q4_K_M",
              kind: "model",
              name: "GPT-OSS 20B",
            },
          ],
          id: "unified",
          kind: "unified",
          total_bytes: gb(51.2),
          used_bytes: gb(34.3),
        },
      ],
    });
    const fixture = setup([busyMac]);
    await renderPage(fixture);
    await findModels();

    fireEvent.click(screen.getByRole("button", { name: "Load Gemma 3 27B" }));
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    expect(
      within(dialog).getByRole("checkbox", { name: /GPT-OSS 20B/ }),
    ).toBeChecked();
    expect(dialog).toHaveTextContent(
      "Another Me can't answer until their model is loaded again.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Unload and load" }),
    ).toBeEnabled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Recheck memory" }),
    );
    await waitFor(() => expect(fixture.refreshes).toEqual(["computer-mac"]));

    // Closing the external app frees 20 GB so 36.9 GB is free without unloading GPT-OSS 20B.
    publishSnapshot(fixture, {
      ...busyMac,
      observed_at: "2026-11-13T10:07:00.000Z",
      pools: [
        {
          holders: [
            {
              bytes: gb(14.3),
              id: "gpt-oss-20b:Q4_K_M",
              kind: "model",
              name: "GPT-OSS 20B",
            },
          ],
          id: "unified",
          kind: "unified",
          total_bytes: gb(51.2),
          used_bytes: gb(14.3),
        },
      ],
    });

    await waitFor(() =>
      expect(dialog).toHaveTextContent(
        "Enough memory is free now (36.9 GB available).",
      ),
    );
    expect(dialog).not.toHaveTextContent("Another Me can't answer");
    fireEvent.click(within(dialog).getByRole("button", { name: "Load" }));
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "load" },
          computerId: "computer-mac",
          modelId: "gemma3-27b:Q4_K_M",
        },
      ]),
    );
  });

  it("lets the owner choose a loaded larger model in SwitchToLocalNotice and Use for Agents", async () => {
    const small = localModel({
      id: "spark-4b:Q4_K_M",
      memory_bytes: gb(4),
      name: "Spark 4B",
      pi_model: "localmodels-library/spark-4b",
      pool: "gpu:0",
      state: "loaded",
    });
    const large = localModel({
      id: "qwen3.8-27b:IQ3_S",
      memory_bytes: gb(16),
      name: "Qwen3.8 27B",
      pi_model: "localmodels-library/qwen3.8-27b",
      pool: "gpu:0",
      state: "loaded",
    });
    const view = labView({
      models: [modelView(small), modelView(large)],
    });
    const fixture = setup([view]);
    const { switches } = withSource(fixture, {
      ...byokStatus,
      mode: "byok",
      runtime: "pi",
      runtime_model: "localmodels-byok",
    });
    fixture.runtime.server.on("POST", switchPath, ({ body }) => {
      switches.push(body);
      return Response.json({
        computer_id: "computer-lab",
        online: true,
        status: {
          ...byokStatus,
          mode: "local",
          runtime: "pi",
          runtime_model: "localmodels-library/spark-4b",
        },
        viewer_is_owner: true,
      });
    });
    await renderPage(fixture);

    fireEvent.click(await screen.findByRole("tab", { name: "Local model" }));
    const modelSelect = await screen.findByRole("combobox", {
      name: "Local model",
    });
    fireEvent.click(modelSelect);
    fireEvent.click(await screen.findByRole("option", { name: /Spark 4B/u }));
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Local model" }),
    );
    await waitFor(() => expect(switches).toHaveLength(1));
    expect(switches[0]).toEqual({
      local_model_id: "spark-4b:Q4_K_M",
      mode: "local",
    });

    // Once on Local model mode running Spark 4B, loaded Qwen3.8 27B offers Use for Agents.
    const useLarge = await screen.findByRole("button", {
      name: "Use Qwen3.8 27B for Agents",
    });
    expect(
      screen.queryByRole("button", { name: "Use Spark 4B for Agents" }),
    ).toBeNull();
    fireEvent.click(useLarge);
    await waitFor(() => expect(switches).toHaveLength(2));
    expect(switches[1]).toEqual({
      local_model_id: "qwen3.8-27b:IQ3_S",
      mode: "local",
    });
  });

  it("hides Recheck memory and Use for Agents when read-only or offline while keeping one status notice", async () => {
    const busyView = labView({
      models: [
        modelView(
          localModel({
            availability: {
              downloadable: false,
              reason: {
                code: "MEMORY_INSUFFICIENT",
                have_bytes: gb(8),
                need_bytes: gb(16),
              },
            },
            fit: "none",
            id: "qwen3.8-27b:IQ3_S",
            memory_bytes: gb(16),
            name: "Qwen3.8 27B",
            pool: undefined,
          }),
        ),
        modelView(
          localModel({
            id: "loaded:Q4",
            memory_bytes: gb(4),
            name: "Loaded Model",
            pi_model: "localmodels-library/loaded",
            pool: "gpu:0",
            state: "loaded",
          }),
        ),
      ],
      pools: [{ ...gpuPool(0, 24), used_bytes: gb(16) }],
      viewer_is_owner: false,
    });
    const readOnlyFixture = setup([busyView]);
    await renderPage(readOnlyFixture);
    await findModels();

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Recheck memory" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Use .* for Agents/u }),
    ).not.toBeInTheDocument();

    cleanup();
    const offlineView = labView({
      ...busyView,
      computer: { ...busyView.computer, status: "offline" },
      viewer_is_owner: true,
    });
    await renderPage(setup([offlineView]));
    await findModels();

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Recheck memory" }),
    ).not.toBeInTheDocument();
  });

  it("shows unified memory breakdown on hover/click and in Details, with Recheck memory inside Details", async () => {
    const initialMac = macView({
      computer: {
        ...macView().computer,
        host: {
          ...macView().computer.host!,
          memory_pressure: "normal",
          metal_working_set_bytes: gb(17.8),
          ram_available_bytes: gb(9.1),
          ram_total_bytes: gb(24),
        },
      },
      pools: [
        {
          ...memoryPool("unified", 21.5),
          reserve_bytes: gb(2.5),
          used_bytes: gb(14.9),
        },
      ],
    });
    const fixture = setup([initialMac]);
    await renderPage(fixture);
    await findModels();

    const headerTrigger = screen.getByRole("button", { name: /6\.6 GB free/ });
    fireEvent.mouseEnter(headerTrigger);
    const popover = screen.getByRole("region", {
      name: "Unified memory breakdown",
    });
    expect(popover).toHaveTextContent("Physical memory24 GB");
    expect(popover).toHaveTextContent("Reclaimable & free9.1 GB");
    expect(popover).toHaveTextContent("Reserved for macOS & Linger2.5 GB");
    expect(popover).toHaveTextContent("Available for models6.6 GB");
    expect(popover).toHaveTextContent("Per-model Metal GPU cap17.8 GB");

    fireEvent.mouseLeave(headerTrigger);
    expect(
      screen.queryByRole("region", { name: "Unified memory breakdown" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const detailsDialog = screen.getByRole("dialog", {
      name: "Mac Studio details",
    });
    expect(detailsDialog).toHaveTextContent(
      "Reclaimable9.1 GB reclaimable & free",
    );
    expect(detailsDialog).toHaveTextContent(
      "System reserve2.5 GB kept for macOS & Linger",
    );
    expect(detailsDialog).toHaveTextContent("Metal GPU limit17.8 GB per model");

    fireEvent.mouseEnter(
      within(detailsDialog).getByRole("button", { name: "6.6 GB free" }),
    );
    expect(
      within(detailsDialog).getByRole("region", {
        name: "Unified memory breakdown",
      }),
    ).toBeVisible();

    fireEvent.click(
      within(detailsDialog).getByRole("button", { name: "Recheck memory" }),
    );
    await waitFor(() => expect(fixture.refreshes).toEqual(["computer-mac"]));
  });

  it("soft-checks live memory before downloading and supports Download only or Recheck to Download and load", async () => {
    const lowRoomModel = modelView(
      localModel({
        download_bytes: gb(11.2),
        fit: "unified",
        fits_now: false,
        id: "qwen3.8-27b-iq3s:UD-IQ3_S",
        load_free_bytes: gb(6.6),
        load_need_bytes: gb(18.4),
        memory_bytes: gb(20.8),
        name: "Qwen3.8 27B (UD-IQ3_S)",
        pool: "unified",
        state: "absent",
      }),
    );
    const secondLowRoom = modelView(
      localModel({
        download_bytes: gb(10.5),
        fit: "unified",
        fits_now: false,
        id: "gemma3-27b:Q4_K_M",
        load_free_bytes: gb(6.6),
        load_need_bytes: gb(17.5),
        memory_bytes: gb(19.2),
        name: "Gemma 3 27B",
        pool: "unified",
        state: "absent",
      }),
    );
    const mac = macView({
      models: [lowRoomModel, secondLowRoom],
      pools: [
        {
          ...memoryPool("unified", 21.5),
          reserve_bytes: gb(2.5),
          used_bytes: gb(14.9),
        },
      ],
    });
    const fixture = setup([mac]);
    await renderPage(fixture);
    await findModels();

    expect(statusOf("Qwen3.8 27B (UD-IQ3_S)")).toContain(
      "needs 18.4 GB free to load",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Qwen3.8 27B (UD-IQ3_S)" }),
    );
    expect(
      screen.getByRole("region", { name: "Qwen3.8 27B (UD-IQ3_S) details" }),
    ).toHaveTextContent("it needs 18.4 GB free and only 6.6 GB is free");

    fireEvent.click(
      screen.getByRole("button", { name: "Download Qwen3.8 27B (UD-IQ3_S)" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Not enough free memory to load now",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Download only" }),
    );
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "download", no_autoload: true },
          computerId: "computer-mac",
          modelId: "qwen3.8-27b-iq3s:UD-IQ3_S",
        },
      ]),
    );

    // Open on a second model and use Recheck memory; once room opens up, Download and load becomes active.
    fireEvent.click(
      screen.getByRole("button", { name: "Download Gemma 3 27B" }),
    );
    const recheckDialog = screen.getByRole("dialog", {
      name: "Not enough free memory to load now",
    });
    fireEvent.click(
      within(recheckDialog).getByRole("button", { name: "Recheck memory" }),
    );
    await waitFor(() => expect(fixture.refreshes).toEqual(["computer-mac"]));

    publishSnapshot(
      fixture,
      macView({
        models: [
          modelView({ ...lowRoomModel.model, state: "idle" }),
          modelView({
            ...secondLowRoom.model,
            fits_now: true,
            load_free_bytes: undefined,
            load_need_bytes: undefined,
          }),
        ],
        observed_at: "2026-11-13T10:08:00.000Z",
        pools: [
          {
            ...memoryPool("unified", 21.5),
            reserve_bytes: gb(2.5),
            used_bytes: gb(1),
          },
        ],
      }),
    );

    const readyDialog = await screen.findByRole("dialog", {
      name: "Ready to download and load",
    });
    fireEvent.click(
      within(readyDialog).getByRole("button", { name: "Download and load" }),
    );
    await waitFor(() =>
      expect(fixture.actions).toEqual([
        {
          body: { action: "download", no_autoload: true },
          computerId: "computer-mac",
          modelId: "qwen3.8-27b-iq3s:UD-IQ3_S",
        },
        {
          body: { action: "download" },
          computerId: "computer-mac",
          modelId: "gemma3-27b:Q4_K_M",
        },
      ]),
    );
  });

  it("shows a readable error while keeping the library when reading model source fails", async () => {
    const fixture = setup();
    fixture.runtime.server.on("GET", modelSourcePath, () =>
      teamHubErrorResponse(502, "MODEL_SOURCE_FAILED"),
    );

    await renderPage(fixture);
    await findModels();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Couldn't read how Agents on this computer get their model. Try again.",
    );
    const retry = within(alert).getByRole("button", { name: "Retry" });
    fixture.runtime.server.on("GET", modelSourcePath, ({ params }) =>
      Response.json({
        computer_id: params.computerId,
        online: true,
        status: {
          ...byokStatus,
          mode: "local",
          runtime: "pi",
          runtime_model: "localmodels-library/qwen3-coder-30b",
        },
        viewer_is_owner: true,
      }),
    );
    fireEvent.click(retry);
    expect(
      await screen.findByText("Agents on lab-118 use Local model"),
    ).toBeInTheDocument();
  });

  it("refetches model source when a Computer comes back online and disables BYOK when offline", async () => {
    const offlineLab = labView({
      computer: { ...labView().computer, status: "offline" },
    });
    const fixture = setup([offlineLab]);
    let online = false;
    fixture.runtime.server.on("GET", switchPath, ({ params }) =>
      Response.json({
        computer_id: params.computerId,
        online,
        ...(online ? { status: byokStatus } : {}),
        viewer_is_owner: true,
      }),
    );
    await renderPage(fixture);
    await findModels();

    expect(
      screen.queryByRole("tablist", { name: "Model source" }),
    ).not.toBeInTheDocument();

    online = true;
    publishSnapshot(fixture, labView());

    expect(
      await screen.findByRole("tab", { name: /BYOK/u, selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toBeEnabled();

    // Going offline while viewing BYOK shows the offline notice and disables edits.
    publishSnapshot(fixture, offlineLab);
    expect(await screen.findByText(/Reconnect it in/u)).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("resets stale BYOK test feedback, protects saved keys across origins, clears models on a new address, and takes typed model IDs", async () => {
    const fixture = setup([labView()]);
    const { listings, switches, tests } = withSource(fixture, byokStatus);
    fixture.runtime.server.on("POST", switchPath, ({ body }) => {
      switches.push(body);
      return Response.json({
        computer_id: "computer-lab",
        online: true,
        status: byokStatus,
        viewer_is_owner: true,
      });
    });
    await renderPage(fixture);

    const tabs = await screen.findByRole("tablist", { name: "Model source" });
    expect(tabs).toHaveClass("self-start");
    fireEvent.click(await screen.findByRole("button", { name: "List models" }));
    expect(
      await screen.findByText(
        "2 models listed from https://api.example.com/v1/models.",
      ),
    ).toBeInTheDocument();

    // Any model ID can be typed even when the endpoint listed models.
    const model = screen.getByLabelText("Model");
    fireEvent.change(model, { target: { value: "custom/alias" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();

    // Another origin withdraws the result, the listed models and the saved key.
    const baseUrl = screen.getByLabelText("Base URL");
    fireEvent.change(baseUrl, {
      target: { value: "https://other.example.net" },
    });
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(
      screen.getByText("List the endpoint's models, or type an ID."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/A key is saved on this computer/u),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(tests).toHaveLength(2));
    expect(tests[1]).toEqual({
      byok: {
        base_url: "https://other.example.net",
        endpoint: "/chat/completions",
        model_id: "custom/alias",
        path: "/v1",
        protocol: "openai-chat",
      },
    });

    // Saving while already on BYOK clears the typed API key input cleanly.
    fireEvent.change(baseUrl, { target: { value: "https://api.example.com" } });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-rotate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(switches).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByLabelText("API key")).toHaveValue(""),
    );
    expect(listings).toHaveLength(1);
  });

  it("refreshes Tenant Agents after Use for Agents and lets SwitchToLocalNotice prefer a newly loaded model", async () => {
    const idleSmall = localModel({
      id: "spark-4b:Q4_K_M",
      memory_bytes: gb(4),
      name: "Spark 4B",
      pi_model: "localmodels-library/spark-4b",
      pool: "gpu:0",
      state: "idle",
    });
    const loadedLarge = localModel({
      id: "qwen3.8-27b:IQ3_S",
      memory_bytes: gb(16),
      name: "Qwen3.8 27B",
      pi_model: "localmodels-library/qwen3.8-27b",
      pool: "gpu:0",
      state: "loaded",
    });
    const fixture = setup([labView({ models: [modelView(idleSmall)] })]);
    enableReadyPi(fixture);
    const { switches } = withSource(fixture, {
      ...byokStatus,
      mode: "byok",
      runtime: "pi",
      runtime_model: "localmodels-byok",
    });
    let agentReads = 0;
    fixture.runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", () => {
      agentReads += 1;
      return {
        items: fixture.runtime.seed.tenantAgents,
        page: { has_more: false },
      };
    });
    fixture.runtime.server.on("POST", switchPath, ({ body }) => {
      switches.push(body);
      return Response.json({
        computer_id: "computer-lab",
        online: true,
        status: {
          ...byokStatus,
          mode: "local",
          runtime: "pi",
          runtime_model: "localmodels-library/qwen3.8-27b",
        },
        viewer_is_owner: true,
      });
    });
    await renderPage(fixture);

    fireEvent.click(await screen.findByRole("tab", { name: "Local model" }));
    await findModels();

    // A newly loaded model becomes the default target without sticking on the earlier idle one.
    publishSnapshot(
      fixture,
      labView({
        models: [modelView(idleSmall), modelView(loadedLarge)],
        observed_at: "2026-11-13T10:08:00.000Z",
      }),
    );
    const readsBeforeSwitch = agentReads;
    await screen.findByRole("combobox", { name: "Local model" });
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Local model" }),
    );
    await waitFor(() => expect(switches).toHaveLength(1));
    expect(switches[0]).toEqual({
      local_model_id: "qwen3.8-27b:IQ3_S",
      mode: "local",
    });
    await waitFor(() => expect(agentReads).toBeGreaterThan(readsBeforeSwitch));
  });

  it("offers Remove for damaged files, warns for unloaded models with Agents, and recovers from missing Computers or TOOL_FAILED", async () => {
    const damaged = localModel({
      error: { code: "CHECKSUM_MISMATCH" },
      id: "broken:Q4",
      memory_bytes: gb(6),
      name: "Broken 6B",
      pool: "gpu:0",
      state: "failed",
    });
    const idleUsed = localModel({
      id: "idle-used:Q4",
      memory_bytes: gb(8),
      name: "Idle Used 8B",
      pi_model: "localmodels-library/idle-used",
      pool: "gpu:1",
      state: "idle",
    });
    const offlineFirst = labView({
      computer: {
        ...labView().computer,
        computer_id: "computer-offline",
        display_name: "Old Laptop",
        status: "offline",
      },
    });
    const onlineSecond = labView({
      computer: {
        ...labView().computer,
        computer_id: "computer-online",
        display_name: "Workstation",
        status: "online",
      },
      models: [modelView(damaged), modelView(idleUsed, ["Research agent"])],
      pools: [gpuPool(0, 24), { ...gpuPool(1, 24), used_bytes: gb(5) }],
    });
    const fixture = setup(
      [offlineFirst, onlineSecond],
      [inventoryComputer(offlineFirst), inventoryComputer(onlineSecond)],
    );
    await renderPage(fixture);
    await findModels();

    // Prefers the online Computer over an earlier offline one when no ?computer= is given.
    expect(
      screen.getByRole("combobox", { name: "Computer" }),
    ).toHaveTextContent("Workstation");

    expect(statusOf("Broken 6B")).toBe("Couldn't load · files damaged");
    expect(
      screen.getByRole("button", { name: "Remove Broken 6B" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Retry Broken 6B" }),
    ).toBeNull();

    expect(statusOf("Idle Used 8B")).toBe("Downloaded · load to answer");
    fireEvent.click(screen.getByRole("button", { name: "Idle Used 8B" }));
    expect(
      screen.getByRole("region", { name: "Idle Used 8B details" }),
    ).toHaveTextContent(
      "Research agent uses this model. Load it so it can answer.",
    );

    // Details modal includes Other apps in the legend when external apps hold memory.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const detailsDialog = screen.getByRole("dialog", {
      name: "Workstation details",
    });
    expect(detailsDialog).toHaveTextContent("Other apps");
    fireEvent.click(
      within(detailsDialog).getByRole("button", { name: "Close" }),
    );

    // A missing ?computer= shows clear copy and a button back to the owner's online Computer.
    cleanup();
    await renderPage(fixture, "?computer=computer-removed");
    expect(
      await screen.findByText(
        "This computer wasn't found. It may have been removed.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Workstation" }));
    await findModels();
    expect(card("Broken 6B")).toBeVisible();

    // TOOL_FAILED offers Try again refresh when the Computer is online.
    publishSnapshot(fixture, {
      ...onlineSecond,
      available: false,
      models: [],
      observed_at: "2026-11-13T10:12:00.000Z",
      pools: [],
      reason: { code: "TOOL_FAILED" },
    });
    const retryTool = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retryTool);
    await waitFor(() => expect(fixture.refreshes).toEqual(["computer-online"]));
  });

  it("clears optimistic action state when a snapshot lands before 202 and drops externally unloaded models from Make room", async () => {
    const baseMac = macView();
    const fixture = setup([baseMac]);
    let releaseAction!: () => void;
    fixture.runtime.server.on(
      "POST",
      actionPath,
      ({ body, params }) =>
        new Promise((resolve) => {
          fixture.actions.push({
            body,
            computerId: params.computerId!,
            modelId: params.modelId!,
          });
          releaseAction = () =>
            resolve(accepted((body as { action: string }).action));
        }),
    );
    await renderPage(fixture);
    await findModels();

    // Open Make room for Llama 3.3 70B (needs 46 GB, GPT-OSS 20B preselected).
    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    const checkbox = within(dialog).getByRole("checkbox", {
      name: /GPT-OSS 20B/u,
    });
    // Unchecking shows the shortfall hint cleanly.
    fireEvent.click(checkbox);
    expect(dialog).toHaveTextContent(
      "Select at least 9.1 GB more to unload before loading Llama 3.3 70B.",
    );
    fireEvent.click(checkbox);

    // Another model is unloaded externally, leaving another loaded model on the pool.
    const extraLoaded = localModel({
      fit: "unified",
      id: "extra:Q4",
      memory_bytes: gb(12),
      name: "Extra 12B",
      pool: "unified",
      state: "loaded",
    });
    publishSnapshot(fixture, {
      ...baseMac,
      models: [modelView(extraLoaded), baseMac.models[1]!],
      observed_at: "2026-11-13T10:09:00.000Z",
      pools: [
        {
          holders: [
            { bytes: gb(12), id: "extra:Q4", kind: "model", name: "Extra 12B" },
          ],
          id: "unified",
          kind: "unified",
          total_bytes: gb(51.2),
          used_bytes: gb(12),
        },
      ],
    });
    const extraCheck = await within(dialog).findByRole("checkbox", {
      name: /Extra 12B/u,
    });
    fireEvent.click(extraCheck);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unload and load" }),
    );
    await waitFor(() => expect(fixture.actions).toHaveLength(1));
    // GPT-OSS 20B (no longer loaded) was filtered out of unload_first.
    expect(fixture.actions[0]).toEqual({
      body: { action: "load", unload_first: ["extra:Q4"] },
      computerId: "computer-mac",
      modelId: "llama3.3-70b:Q4_K_M",
    });

    // A newer snapshot arrives with the same failed status BEFORE the 202 resolves.
    publishSnapshot(fixture, {
      ...baseMac,
      models: [modelView(extraLoaded), baseMac.models[1]!],
      observed_at: "2026-11-13T10:10:00.000Z",
    });
    releaseAction();

    // Row does not stay stuck on "Loading" because observedAt was captured at click time.
    await waitFor(() =>
      expect(statusOf("Llama 3.3 70B")).toBe(
        "Couldn't load · not enough free memory",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    ).toBeEnabled();
  });

  it("preserves busy Agent warnings during mixed Make room handoff and shows queued handoff status", async () => {
    const mac = withModel(macView(), "llama3.3-70b:Q4_K_M", {
      pi_model: "localmodels-library/llama3.3-70b",
    });
    const fixture = setup([mac]);
    enableReadyPi(fixture);
    acceptTenantAgentUpdates(fixture.runtime);
    fixture.runtime.seed.tenantAgents = fixture.runtime.seed.tenantAgents.map(
      (agent) =>
        agent.actor.id === "actor-delegate" || agent.actor.id === "actor-codex"
          ? {
              ...agent,
              runtime: {
                model: "localmodels-library/gpt-oss-20b",
                placement: {
                  computer_id: "computer-mac",
                  runtime_type: "pi",
                  type: "local",
                  workspace_grant_id: "grant-linger-workspace",
                },
              },
            }
          : agent,
    );
    await renderPage(fixture, "?computer=computer-mac");
    await findModels();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry Llama 3.3 70B" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Make room to load" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unload and load" }),
    );
    expect(
      await screen.findByText(
        "Will switch Jenny's Delegate, Codex to Llama 3.3 70B once it finishes loading.",
      ),
    ).toBeVisible();

    // Codex starts working while Jenny's Delegate stays idle.
    fixture.runtime.seed.tenantAgents = fixture.runtime.seed.tenantAgents.map(
      (agent) =>
        agent.actor.id === "actor-codex"
          ? {
              ...agent,
              availability: {
                active_task_count: 1,
                label: "Working",
                status: "online",
              },
            }
          : agent,
    );
    fixture.runtime.events.emitSignal({
      hint: { id: "actor-codex", resource: "agents", tenant_id: tenantId },
      type: "resource.invalidated",
    });
    await waitFor(() =>
      expect(
        fixture.runtime.server.requestsTo(
          "GET",
          "/v0/tenants/{tenantId}/agent-availability",
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );

    publishSnapshot(
      fixture,
      withModel(mac, "llama3.3-70b:Q4_K_M", {
        endpoint: { base_url: "http://127.0.0.1:18100/v1" },
        state: "loaded",
      }),
    );

    // Idle Agent switches AND busy Agent warning survives instead of being wiped.
    await waitFor(() =>
      expect(
        fixture.runtime.server.requestsTo(
          "PATCH",
          "/v0/tenants/{tenantId}/agents/{agentId}",
        ),
      ).toHaveLength(1),
    );
    expect(
      await screen.findByText(
        "Couldn't switch Codex to Llama 3.3 70B while working. Switch once the current turn finishes.",
      ),
    ).toBeVisible();
  });
});
