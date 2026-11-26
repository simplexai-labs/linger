import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EventSourceFactory,
  EventSourceLike,
} from "@/features/teamhub/event-stream";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { defineGlobalProperty } from "@/test/global-properties";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { SystemTelemetryPage } from "./system-telemetry-page";
import type {
  SystemTelemetrySnapshot,
  SystemTelemetryStreamStatus,
  SystemTelemetryView,
} from "./telemetry-types";

const GiB = 1024 ** 3;
const tenantId = "tenant-northstar";

class FakeEventSource implements EventSourceLike {
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<
    string,
    Set<(event: MessageEvent) => void>
  >();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, payload?: unknown): void {
    const data =
      payload === undefined
        ? ""
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload);
    const event = { data } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createFakeEventSourceHarness() {
  const sources: FakeEventSource[] = [];
  const factory: EventSourceFactory = (url) => {
    const instance = new FakeEventSource(url);
    sources.push(instance);
    return instance;
  };
  return { factory, sources };
}

function makeRichView(
  computerId: string,
  displayName: string,
  revision = 1,
  snapshotOverrides: Partial<SystemTelemetrySnapshot> = {},
): SystemTelemetryView {
  return {
    computer: {
      computer_id: computerId,
      display_name: displayName,
      status: "online",
    },
    observed_at: "2026-11-26T12:00:00Z",
    revision,
    viewer_is_owner: true,
    snapshot: {
      schema: "localmodels.stack-view/v1",
      schema_version: "1.1",
      generated_at: "2026-11-26T12:00:00Z",
      source: "live",
      host: {
        hostname: "mac-studio.local",
        system: "macOS 15.4 · darwin arm64",
        tier: "M4 Pro 64 GB",
      },
      gateway: {
        kind: "bifrost",
        addr: "127.0.0.1:18480",
        route: "pi",
        in_flight: 3,
        client_lanes: {
          "another-me": 2,
          "code-reviewer": 1,
        },
        p50_ttft_ms: { basis: "live", value: 310 },
      },
      clients: [
        { id: "another-me", name: "Another Me", model: "qwen3.8-27b" },
        { id: "code-reviewer", name: "Code Reviewer", model: "inkling-2-mini" },
      ],
      components: [
        {
          id: "chat-0",
          model: "qwen3.8-27b",
          title: "Qwen3.8 27B",
          quant: "UD-Q4_K_M",
          device: "All-in-Metal",
          state: "loaded",
          slots: 8,
          window: 65536,
          vram_bytes: 17 * GiB,
          perf: {
            decode_tok_s: { basis: "live", value: 18.4 },
            prefill_tok_s: { basis: "live", value: 640 },
            counters: {
              processing: 2,
              requests_deferred: 1,
              kv_cache_usage_ratio: 0.68,
            },
          },
          live_slots: [
            {
              id: 0,
              busy: true,
              phase: "decoding",
              n_ctx: 65536,
              cached: 24000,
              prompt_done: 30000,
              decoded: 620,
              tok_s: 9.2,
              ttft_ms: 295,
            },
            {
              id: 1,
              busy: true,
              phase: "prefill",
              n_ctx: 32768,
              cached: 8000,
              prompt_done: 14000,
              decoded: 0,
              tok_s: 0,
              ttft_ms: 320,
            },
          ],
        },
        {
          id: "hybrid-1",
          model: "inkling-2-mini",
          title: "Inkling 2 Mini",
          quant: "UD-Q4_K_XL",
          device: "All-in-Metal",
          state: "loaded",
          slots: 8,
          window: 131072,
          vram_bytes: 6 * GiB,
          perf: {
            decode_tok_s: { basis: "live", value: 42.1 },
            prefill_tok_s: { basis: "live", value: 920 },
          },
          live_slots: [
            {
              id: 0,
              busy: true,
              phase: "decoding",
              n_ctx: 65536,
              cached: 12000,
              prompt_done: 15000,
              decoded: 310,
              tok_s: 42.1,
              ttft_ms: 140,
            },
          ],
        },
      ],
      gpus: [
        {
          index: 0,
          name: "Apple GPU 20-core",
          total_bytes: 64 * GiB,
          used_bytes: 52 * GiB,
          bandwidth_gb_s: 273,
          holders: ["Safari", "Xcode Simulator"],
          segments: [
            {
              kind: "weights",
              label: "Model Weights",
              bytes: 23 * GiB,
              basis: "live",
            },
            {
              kind: "kv_cache",
              label: "KV Cache",
              bytes: 10 * GiB,
              basis: "live",
            },
            {
              kind: "compute",
              label: "Compute",
              bytes: 4 * GiB,
              basis: "live",
            },
            {
              kind: "external",
              label: "External Apps",
              bytes: 7 * GiB,
              basis: "live",
            },
            {
              kind: "reserve",
              label: "OS Reserve",
              bytes: 8 * GiB,
              basis: "live",
            },
          ],
        },
      ],
      gpu_load: [
        {
          index: 0,
          util_pct: 84,
          mem_ctrl_util_pct: 82,
          temp_c: 74,
          power_w: 68,
          power_limit_w: 85,
          basis: "live",
          source: "IOReport + AppleSMC",
        },
      ],
      ram: {
        total_bytes: 64 * GiB,
        available_bytes: 12 * GiB,
      },
      sensors: {
        collector: "IOReport · AppleSMC · vm_stat",
        cpu: {
          overall_pct: { basis: "live", value: 52 },
          logical_cores: 14,
          per_core: Array.from({ length: 14 }, (_, core) => ({
            core,
            util_pct: 40 + (core % 5) * 10,
          })),
        },
        disk: {
          read_mb_s: { basis: "live", value: 42 },
          write_mb_s: { basis: "live", value: 8 },
        },
        memory_pressure: { level: "elevated", basis: "live" },
        watchdog: { status: "clean", basis: "live" },
      },
      effective_decode_bw_gb_s: { basis: "measured", value: 224 },
      memory_bw_ceiling_gb_s: { basis: "measured", value: 273 },
      bottleneck: "memory_bw_bound",
      p50_ttft_ms: { basis: "live", value: 310 },
      prefix_hit_pct: { basis: "live", value: 84 },
      requests_deferred: { basis: "live", value: 1 },
      kv_cache_usage_ratio: { basis: "live", value: 0.68 },
      in_flight: 3,
      waterfall: [
        {
          request_id: "req-1",
          at: "2026-11-26T12:00:00Z",
          client_id: "another-me",
          model_id: "qwen3.8-27b",
          status: "streaming",
          gateway_ms: 8,
          ttft_ms: 295,
          decode_ms: 1240,
          prompt_tokens: 4200,
          completion_tokens: 310,
          cached_prefix_pct: 86,
          decode_tok_s: 18.4,
          basis: "live",
        },
        {
          request_id: "req-2",
          at: "2026-11-26T11:59:55Z",
          client_id: "code-reviewer",
          model_id: "inkling-2-mini",
          status: "completed",
          gateway_ms: 6,
          ttft_ms: 140,
          decode_ms: 810,
          prompt_tokens: 2100,
          completion_tokens: 260,
          cached_prefix_pct: 79,
          decode_tok_s: 42.1,
          basis: "live",
        },
      ],
      what_if: {
        gpu: 0,
        window: 32768,
        slots: 4,
        kv_bytes_per_token: 65_536,
        compute_bytes_per_token: 4096,
        fixed_bytes: 34 * GiB,
        room_bytes: 30 * GiB,
        weights_bytes: 23 * GiB,
        active_weight_bytes: 17 * 1_000_000_000,
        memory_bw_ceiling_gb_s: 273,
        pool_kind: "unified",
      },
      ...snapshotOverrides,
    },
  };
}

function setupRuntime(
  computers?: {
    computer_id: string;
    display_name: string;
    status: "online" | "offline";
  }[],
): TestTeamHubRuntime {
  const runtime = createTestTeamHubRuntime();
  const template = runtime.seed.localComputers[0]!;
  runtime.seed.localComputers = (
    computers ?? [
      {
        computer_id: "comp-mac",
        display_name: "Mac Studio · M4 Pro",
        status: "online",
      },
      {
        computer_id: "comp-linux",
        display_name: "Linux · RTX 4090",
        status: "online",
      },
    ]
  ).map((item) => ({
    ...template,
    computer_id: item.computer_id,
    display_name: item.display_name,
    status: item.status,
  }));
  return runtime;
}

function renderSystemPage(
  runtime: TestTeamHubRuntime,
  factory: EventSourceFactory,
  initialEntry = `/t/${tenantId}/settings/system?computer=comp-mac`,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route
              element={
                <Suspense fallback={<div>Loading…</div>}>
                  <SystemTelemetryPage eventSourceFactory={factory} />
                </Suspense>
              }
              path="/t/:tenantId/settings/system"
            />
          </Routes>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  window.localStorage.clear();
});

describe("SystemTelemetryPage", () => {
  it("keeps one SSE stream across unrelated UI rerenders, tears down once on computer switch, and pauses on hidden tab", async () => {
    const runtime = setupRuntime();
    const { factory, sources } = createFakeEventSourceHarness();
    renderSystemPage(runtime, factory);

    await waitFor(() => expect(sources).toHaveLength(1));
    expect(sources[0]?.url).toContain(
      `/v0/tenants/${tenantId}/local-computers/comp-mac/system-telemetry/stream`,
    );

    act(() => {
      sources[0]!.emit(
        "telemetry.snapshot",
        makeRichView("comp-mac", "Mac Studio · M4 Pro", 1),
      );
    });

    expect(
      await screen.findByRole("button", { name: /Qwen3\.8 27B/i }),
    ).toBeVisible();

    // Unrelated UI interactions (opening provenance, toggling disclosures, spotlighting)
    // must never recreate the SSE stream.
    fireEvent.click(screen.getByRole("button", { name: /Live · 1 Hz/i }));
    expect(
      screen.getByRole("dialog", { name: "Local Telemetry Provenance" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Close provenance details" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /What-If capacity sandbox/i }),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]?.closed).toBe(false);

    // Tab hidden immediately closes the stream (0 Hz idle); visible resumes cleanly.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(sources[0]?.closed).toBe(true));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[1]?.url).toContain("comp-mac/system-telemetry/stream");

    // Switching Computers closes the previous stream exactly once and opens the new one.
    fireEvent.click(screen.getByRole("combobox", { name: "Computer" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "Linux · RTX 4090" }),
    );
    await waitFor(() => expect(sources).toHaveLength(3));
    expect(sources[1]?.closed).toBe(true);
    expect(sources[2]?.url).toContain("comp-linux/system-telemetry/stream");
  });

  it("preserves the last snapshot dimmed when LOCAL_COMPUTER_OFFLINE arrives on SSE", async () => {
    const runtime = setupRuntime();
    const { factory, sources } = createFakeEventSourceHarness();
    renderSystemPage(runtime, factory);

    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => {
      sources[0]!.emit(
        "telemetry.snapshot",
        makeRichView("comp-mac", "Mac Studio · M4 Pro", 1),
      );
    });
    expect(
      await screen.findByRole("button", { name: /Qwen3\.8 27B/i }),
    ).toBeVisible();

    const offlineStatus: SystemTelemetryStreamStatus = {
      computer_id: "comp-mac",
      status: "offline",
      code: "LOCAL_COMPUTER_OFFLINE",
      message: "Local Computer is offline",
    };
    act(() => {
      sources[0]!.emit("telemetry.status", offlineStatus);
    });

    expect(
      await screen.findByText("Mac Studio · M4 Pro is offline"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Qwen3\.8 27B/i })).toBeVisible();
    expect(
      document.querySelector('[data-telemetry-dimmed="true"]'),
    ).not.toBeNull();
  });

  it("shows a clear upgrade hint when SYSTEM_TELEMETRY_UNSUPPORTED is returned", async () => {
    const runtime = setupRuntime();
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/local-computers/{computerId}/system-telemetry",
      () =>
        teamHubErrorResponse(
          409,
          "SYSTEM_TELEMETRY_UNSUPPORTED",
          "This Local Computer does not support live system telemetry",
        ),
    );
    const { factory, sources } = createFakeEventSourceHarness();
    renderSystemPage(runtime, factory);

    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => {
      sources[0]!.emit("error");
    });

    expect(
      await screen.findByText(
        "Update Local Computer to enable live System telemetry",
      ),
    ).toBeVisible();
    expect(sources[0]?.closed).toBe(true);
  });

  it("renders honest em-dash and basis none tooltip when thermal and power sensors are unavailable", async () => {
    const runtime = setupRuntime();
    const { factory, sources } = createFakeEventSourceHarness();
    renderSystemPage(runtime, factory);

    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => {
      sources[0]!.emit(
        "telemetry.snapshot",
        makeRichView("comp-mac", "Mac Studio · M4 Pro", 1, {
          gpu_load: [
            {
              index: 0,
              util_pct: 61,
              temp_c: null,
              power_w: null,
              power_limit_w: null,
              basis: "live",
            },
          ],
          sensors: {
            cpu: { overall_pct: { basis: "none", value: null } },
            disk: {
              read_mb_s: { basis: "none", value: null },
              write_mb_s: { basis: "none", value: null },
            },
            memory_pressure: { level: "nominal", basis: "live" },
            watchdog: { status: "clean", basis: "live" },
          },
        }),
      );
    });

    await screen.findByText("61");
    const noneNodes = document.querySelectorAll('[data-basis="none"]');
    expect(noneNodes.length).toBeGreaterThanOrEqual(2);
    expect(noneNodes[0]).toHaveAttribute(
      "title",
      "Sensor unavailable on this host (basis: none)",
    );
    expect(screen.queryByText(/0°C/)).not.toBeInTheDocument();
  });

  it("spotlights a Pi Agent route, filters the waterfall, and expands Deep Telemetry & What-If Sandbox", async () => {
    const runtime = setupRuntime();
    const { factory, sources } = createFakeEventSourceHarness();
    renderSystemPage(runtime, factory);

    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => {
      sources[0]!.emit(
        "telemetry.snapshot",
        makeRichView("comp-mac", "Mac Studio · M4 Pro", 1),
      );
      sources[0]!.emit(
        "telemetry.snapshot",
        makeRichView("comp-mac", "Mac Studio · M4 Pro", 2),
      );
    });

    const anotherMeBtn = await screen.findByRole("button", {
      name: /Another Me/i,
    });
    fireEvent.click(anotherMeBtn);

    // Clicking a Pi Agent locks spotlight and auto-opens & filters the waterfall.
    expect(screen.getByText("Spotlight: Another Me")).toBeVisible();
    expect(screen.getByText("Filtered: Another Me")).toBeVisible();
    expect(screen.getByText("295 ms")).toBeVisible();
    expect(screen.queryByText("140 ms")).not.toBeInTheDocument();

    // Clearing spotlight restores all waterfall rows.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear spotlight" })[0]!,
    );
    expect(screen.getByText("140 ms")).toBeVisible();

    // Expand Deep Telemetry & verify Oscilloscope + /slots render cleanly.
    fireEvent.click(
      screen.getByRole("button", {
        name: /Deep telemetry · Oscilloscope & \/slots/i,
      }),
    );
    expect(
      screen.getByRole("img", { name: "Dual-track live oscilloscope" }),
    ).toBeVisible();
    expect(screen.getAllByText("S0").length).toBeGreaterThanOrEqual(1);

    // Expand What-If Sandbox & adjust KV quant.
    fireEvent.click(
      screen.getByRole("button", { name: /What-If capacity sandbox/i }),
    );
    const whatIfHeading = screen.getByText(
      "Forecast Pi slot capacity on Mac Studio · M4 Pro",
    );
    expect(whatIfHeading).toBeVisible();
    const fp16Btn = screen.getByRole("button", { name: "FP16" });
    fireEvent.click(fp16Btn);
    expect(fp16Btn).toHaveAttribute("aria-pressed", "true");
  });

  it("disables continuous SVG packet animations under prefers-reduced-motion: reduce", async () => {
    defineGlobalProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    const runtime = setupRuntime();
    const { factory, sources } = createFakeEventSourceHarness();
    renderSystemPage(runtime, factory);

    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => {
      sources[0]!.emit(
        "telemetry.snapshot",
        makeRichView("comp-mac", "Mac Studio · M4 Pro", 1),
      );
    });

    await screen.findByRole("button", { name: /Qwen3\.8 27B/i });
    expect(document.querySelectorAll("[data-telemetry-packet]").length).toBe(0);
  });

  it("renders a graceful empty standby state when no local models or active Pi streams exist", async () => {
    const runtime = setupRuntime();
    const { factory, sources } = createFakeEventSourceHarness();
    renderSystemPage(runtime, factory);

    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => {
      sources[0]!.emit(
        "telemetry.snapshot",
        makeRichView("comp-mac", "Mac Studio · M4 Pro", 1, {
          clients: [],
          components: [],
          in_flight: 0,
          waterfall: [],
          what_if: undefined,
          gateway: {
            kind: "bifrost",
            addr: "127.0.0.1:18480",
            route: "pi",
            in_flight: 0,
          },
        }),
      );
    });

    expect(await screen.findByText("Pi Agents on standby")).toBeVisible();
    expect(screen.getByText("No local models loaded")).toBeVisible();
    const stage = document.querySelector(
      "[data-telemetry-stage]",
    ) as HTMLElement;
    expect(
      within(stage).getByRole("link", { name: "Manage in Models" }),
    ).toHaveAttribute(
      "href",
      `/t/${tenantId}/settings/models?computer=comp-mac`,
    );
  });
});
