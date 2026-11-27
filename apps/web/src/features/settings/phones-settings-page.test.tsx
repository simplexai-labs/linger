import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import type { PairedPhone, PhonePairingCode, RelayNode } from "./phone-queries";
import { PhonesSettingsPage } from "./phones-settings-page";

const pixel: PairedPhone = {
  connected: true,
  id: "phone-pixel",
  last_seen_at: "2026-11-22T09:00:00Z",
  name: "Ana's Pixel",
  paired_at: "2026-11-20T09:00:00Z",
  platform: "android",
  push_enabled: false,
  status: "approved",
};

const iphone: PairedPhone = {
  connected: false,
  id: "phone-iphone",
  last_seen_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  name: "Ana's iPhone",
  paired_at: "2026-11-21T09:00:00Z",
  platform: "ios",
  push_enabled: true,
  status: "approved",
};

function pairingCode(overrides: Partial<PhonePairingCode> = {}) {
  return {
    computer_name: "Studio Mac",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    host_id: "ab12",
    lan_urls: ["ws://192.168.1.20:7300"],
    pairing_uri: "linger://pair?d=eyJ2IjoxfQ",
    relay_url: "wss://relay.example.test",
    ...overrides,
  } satisfies PhonePairingCode;
}

const officialNodes: RelayNode[] = [
  {
    id: "relay_official_global",
    url: "wss://relay.heylinger.com",
    label: "Linger Global",
    kind: "official",
    enabled: true,
    connected: true,
  },
  {
    id: "relay_official_mainland",
    url: "ws://120.26.232.218:7787",
    label: "Linger Mainland China",
    kind: "official",
    enabled: true,
    connected: false,
  },
];

function renderPage(
  phones: () => PairedPhone[],
  relays: () => RelayNode[] = () => officialNodes,
) {
  const runtime = createTestTeamHubRuntime();
  runtime.server.on("GET", "/v0/me/phones", () => ({ items: phones() }));
  runtime.server.on("GET", "/v0/mobile/relays", () => ({
    items: relays(),
    links_off: false,
  }));
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <PhonesSettingsPage />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return runtime;
}

/** Opens the pairing dialog once the paired list it compares against loads. */
async function openPairing() {
  const button = await screen.findByRole("button", { name: "Pair a phone" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.getByRole("dialog", { name: "Pair a phone" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Settings › Phones", () => {
  it("lists paired phones with their connection and push state", async () => {
    renderPage(() => [pixel, iphone]);
    const list = await screen.findByRole("list", { name: "Paired phones" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Ana's Pixel");
    expect(rows[0]).toHaveTextContent("Android");
    expect(rows[0]).toHaveTextContent("Connected now");
    expect(rows[0]).toHaveTextContent("Push off");
    expect(rows[1]).toHaveTextContent("iPhone");
    expect(rows[1]).toHaveTextContent("Last seen 3 hours ago");
    expect(rows[1]).toHaveTextContent("Push on");
  });

  it("says when no phone is paired", async () => {
    renderPage(() => []);
    expect(await screen.findByText("No phones yet.")).toBeVisible();
  });

  it("shows the pairing code as a QR code and notes a missing relay", async () => {
    const runtime = renderPage(() => []);
    runtime.server.on("POST", "/v0/me/phone-pairings", () =>
      pairingCode({ relay_url: undefined }),
    );
    const dialog = await openPairing();
    const qr = await within(dialog).findByRole("img", { name: "Pairing code" });
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d/u);
    expect(dialog).toHaveTextContent("Pairs with Studio Mac");
    expect(dialog).toHaveTextContent(/Expires in \d\d:\d\d/u);
    expect(dialog).toHaveTextContent("The code works once and for 10 minutes.");
    expect(dialog).toHaveTextContent("only on the same Wi‑Fi");
  });

  it("explains a server without a secret seed", async () => {
    const runtime = renderPage(() => []);
    runtime.server.on("POST", "/v0/me/phone-pairings", () =>
      teamHubErrorResponse(503, "MOBILE_UNAVAILABLE", "Mobile is unavailable."),
    );
    const dialog = await openPairing();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Phones need a private secret seed on this server.",
    );
    expect(within(dialog).queryByRole("img")).toBeNull();
  });

  it("refuses to show a code no phone could reach", async () => {
    const runtime = renderPage(() => []);
    runtime.server.on("POST", "/v0/me/phone-pairings", () =>
      pairingCode({ lan_urls: [], relay_url: undefined }),
    );
    const dialog = await openPairing();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This computer cannot accept phones right now.",
    );
    expect(within(dialog).queryByRole("img")).toBeNull();
  });

  it("asks for a new code once the code expires", async () => {
    const runtime = renderPage(() => []);
    const create = vi
      .fn()
      .mockReturnValueOnce(
        pairingCode({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
      )
      .mockReturnValueOnce(pairingCode());
    runtime.server.on("POST", "/v0/me/phone-pairings", create);
    const dialog = await openPairing();
    expect(
      await within(dialog).findByText("This code has expired."),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "New code" }));
    expect(
      await within(dialog).findByRole("img", { name: "Pairing code" }),
    ).toBeVisible();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("asks to compare the code of a new phone and approves it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let phones: PairedPhone[] = [pixel];
    const runtime = renderPage(() => phones);
    runtime.server.on("POST", "/v0/me/phone-pairings", () => pairingCode());
    const approve = vi.fn(() => {
      phones = [{ ...iphone, status: "approved" }, pixel];
      return undefined;
    });
    runtime.server.on("POST", "/v0/me/phones/{phoneId}/approve", approve);
    const dialog = await openPairing();
    await within(dialog).findByRole("img", { name: "Pairing code" });
    phones = [
      { ...iphone, status: "pending", confirmation_code: "042137" },
      pixel,
    ];
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    const confirm = await screen.findByRole("dialog", {
      name: "Is this your phone?",
    });
    expect(
      within(confirm).getByLabelText("Confirmation code"),
    ).toHaveTextContent("042137");
    expect(confirm).toHaveTextContent("Ana's iPhone");
    fireEvent.click(within(confirm).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalledOnce());
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Is this your phone?" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ana's iPhone is paired.",
    );
  });

  it("lists a pending phone with its code and an Approve button", async () => {
    renderPage(() => [
      { ...iphone, status: "pending", confirmation_code: "042137" },
    ]);
    const list = await screen.findByRole("list", { name: "Paired phones" });
    expect(list).toHaveTextContent("Waiting for approval");
    expect(list).toHaveTextContent("042137");
    expect(within(list).getByRole("button", { name: "Approve" })).toBeVisible();
  });

  it("removes a phone only after confirmation", async () => {
    let phones = [pixel, iphone];
    const runtime = renderPage(() => phones);
    const remove = vi.fn(({ params }: { params: Record<string, string> }) => {
      phones = phones.filter((phone) => phone.id !== params.phoneId);
      return undefined;
    });
    runtime.server.on("DELETE", "/v0/me/phones/{phoneId}", remove);
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Ana's Pixel" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Remove Ana's Pixel?" });
    expect(dialog).toHaveTextContent(
      "It disconnects at once and must be paired again.",
    );
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Remove Ana's Pixel?" }),
      ).toBeNull(),
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0]?.[0].params.phoneId).toBe("phone-pixel");
    const list = screen.getByRole("list", { name: "Paired phones" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list).not.toHaveTextContent("Ana's Pixel");
  });

  it("lists the Relay nodes, turns one off and adds a custom one", async () => {
    let nodes = [...officialNodes];
    const runtime = renderPage(
      () => [iphone],
      () => nodes,
    );
    const update = vi.fn(
      ({ params, body }: { params: Record<string, string>; body: unknown }) => {
        const { enabled } = body as { enabled: boolean };
        nodes = nodes.map((node) =>
          node.id === params.relayId ? { ...node, enabled } : node,
        );
        return nodes.find((node) => node.id === params.relayId);
      },
    );
    const create = vi.fn(({ body }: { body: unknown }) => {
      const node: RelayNode = {
        id: "relay_custom",
        url: (body as { url: string }).url,
        label: "203.0.113.7:7787",
        kind: "custom",
        enabled: true,
        connected: false,
      };
      nodes = [...nodes, node];
      return node;
    });
    runtime.server.on("PATCH", "/v0/mobile/relays/{relayId}", update);
    runtime.server.on("POST", "/v0/mobile/relays", create);
    const list = await screen.findByRole("list", { name: "Relay nodes" });
    expect(list).toHaveTextContent("Linger Global");
    expect(list).toHaveTextContent("Linked");
    fireEvent.click(
      within(list).getByRole("switch", { name: "Use Linger Mainland China" }),
    );
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[0].body).toEqual({ enabled: false });
    fireEvent.change(screen.getByLabelText("Add a node"), {
      target: { value: "ws://203.0.113.7:7787" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0].body).toEqual({
      url: "ws://203.0.113.7:7787",
    });
    expect(
      await within(list).findByText("203.0.113.7:7787"),
    ).toBeInTheDocument();
  });
});
