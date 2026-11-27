// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceMediaPolicy } from "@/features/teamhub/teamhub-types";
import { resetLanguageForTest, setLanguage } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { VoiceKeyDialog } from "./voice-key-dialog";

const words = zhCN.voiceKey;
const missing = { source: "none" as const, can_save: true };
const noKeys: TeamHubVoiceMediaPolicy = {
  voice_available: true,
  voice_media_supported: false,
  live_supported: false,
  soniox_key: missing,
  xai_key: missing,
};

function renderDialog(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  policy: TeamHubVoiceMediaPolicy,
) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceKeyDialog
          onClose={vi.fn()}
          onReady={vi.fn()}
          policy={policy}
          providers={["soniox"]}
          tenantId="tenant-northstar"
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("the voice key dialog in the language on screen", () => {
  afterEach(() => {
    resetLanguageForTest();
  });

  it("keeps the provider's name inside the translated sentences", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("PUT", "/v0/voice-provider-keys/{provider}", () =>
      teamHubErrorResponse(400, "VOICE_KEY_REJECTED", "unrelated server prose"),
    );
    renderDialog(runtime, noKeys);
    expect(
      screen.getByRole("dialog", {
        name: words.title.replace("{provider}", "Soniox"),
      }),
    ).toBeVisible();
    expect(screen.getByText(words.sonioxPurpose)).toBeVisible();
    expect(
      screen.getByRole("link", { name: zhCN.connectors.getAKey }),
    ).toBeVisible();
    fireEvent.change(
      screen.getByLabelText(words.apiKey.replace("{provider}", "Soniox")),
      { target: { value: "bad-key" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: zhCN.connectors.saveKey }),
    );
    expect(
      await screen.findByText(
        words.keyRejected.replace("{provider}", "Soniox"),
      ),
    ).toBeVisible();
  });

  it("leaves the two settings a server operator must type as they are", async () => {
    await setLanguage("zh-CN");
    renderDialog(createTestTeamHubRuntime(), {
      ...noKeys,
      soniox_key: { source: "none", can_save: false },
    });
    for (const name of ["SONIOX_API_KEY", "TEAMHUB_SECRET_ENCRYPTION_KEY"]) {
      expect(screen.getByText(name).tagName).toBe("CODE");
    }
    expect(document.body.textContent).not.toContain("This server");
  });
});
