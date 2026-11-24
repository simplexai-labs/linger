import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  TeamHubRuntimeProvider,
  type TeamHubRuntime,
} from "@/features/teamhub/teamhub-runtime";

import { ChannelsSettingsPage } from "./channels-settings-page";

function renderPage(api: Record<string, ReturnType<typeof vi.fn>>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const runtime = {
    client: { api },
  } as unknown as TeamHubRuntime;
  return render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <ChannelsSettingsPage />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("ChannelsSettingsPage", () => {
  it("opens the WeChat QR pairing dialog and handles verification code submission", async () => {
    const api = {
      GET: vi.fn(async (path: string) => {
        if (path === "/v0/channels") {
          return {
            data: {
              available: true,
              supported_providers: ["wechat"],
              bindings: [],
            },
          };
        }
        return {
          data: {
            pairing_id: "wxp_1",
            provider: "wechat",
            status: "need_verify_code",
            qr_code_url: "https://liteapp.weixin.qq.com/qr/1",
          },
        };
      }),
      POST: vi.fn(async (path: string) => {
        if (path === "/v0/channels/{provider}/pairings") {
          return {
            data: {
              pairing_id: "wxp_1",
              provider: "wechat",
              status: "need_verify_code",
              qr_code_url: "https://liteapp.weixin.qq.com/qr/1",
            },
          };
        }
        return {
          data: {
            pairing_id: "wxp_1",
            provider: "wechat",
            status: "confirmed",
          },
        };
      }),
      PATCH: vi.fn(),
      DELETE: vi.fn(),
    };

    renderPage(api);

    const connectBtn = await screen.findByRole("button", {
      name: "Connect WeChat",
    });
    await waitFor(() => expect(connectBtn).not.toBeDisabled());
    fireEvent.click(connectBtn);

    expect(
      await screen.findByRole("img", { name: "WeChat pairing QR code" }),
    ).toBeInTheDocument();

    const codeInput = await screen.findByPlaceholderText("Verification code");
    fireEvent.change(codeInput, { target: { value: "4829" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText("WeChat connected.")).toBeInTheDocument();
  });

  it("displays connected WeChat status and supports pausing and disconnecting", async () => {
    const api = {
      GET: vi.fn(async () => ({
        data: {
          available: true,
          supported_providers: ["wechat"],
          bindings: [
            {
              id: "imc_1",
              provider: "wechat",
              enabled: true,
              remote_user_id: "user_1@im.wechat",
              runtime_status: "connected",
              created_at: "2026-11-24T00:00:00Z",
              updated_at: "2026-11-24T00:00:00Z",
            },
          ],
        },
      })),
      POST: vi.fn(),
      PATCH: vi.fn(async () => ({ data: {} })),
      DELETE: vi.fn(async () => ({})),
    };

    renderPage(api);

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByText("Linked account: user_1@im.wechat"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(api.PATCH).toHaveBeenCalledWith("/v0/channels/{provider}", {
        params: { path: { provider: "wechat" } },
        body: { enabled: false },
      }),
    );

    const disconnectBtn = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnectBtn).toHaveAttribute("data-voice-risk", "never");
    fireEvent.click(disconnectBtn);
    await waitFor(() =>
      expect(api.DELETE).toHaveBeenCalledWith("/v0/channels/{provider}", {
        params: { path: { provider: "wechat" } },
      }),
    );
  });

  it("renders the desktop iMessage card on macOS desktop builds", async () => {
    const win = window as unknown as { lingerDesktop?: unknown };
    const previous = win.lingerDesktop;
    win.lingerDesktop = {
      imessage: {
        getStatus: vi.fn(async () => ({
          enabled: true,
          handles: ["me@icloud.com"],
          runtime: "ready",
          fullDisk: "granted",
          messagesAutomation: "granted",
          iMessageSignedIn: "yes",
          ready: true,
          bridge: "running",
        })),
        onStatus: vi.fn(() => () => {}),
        set: vi.fn(),
        act: vi.fn(),
      },
    };
    const api = {
      GET: vi.fn(async () => ({
        data: {
          available: true,
          supported_providers: ["wechat"],
          bindings: [],
        },
      })),
      POST: vi.fn(),
      PATCH: vi.fn(),
      DELETE: vi.fn(),
    };
    try {
      renderPage(api);
      expect(await screen.findByText("Use iMessage")).toBeInTheDocument();
      expect(screen.getByText("me@icloud.com")).toBeInTheDocument();
    } finally {
      win.lingerDesktop = previous;
    }
  });
});
