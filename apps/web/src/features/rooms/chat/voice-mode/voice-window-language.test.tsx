import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { resetLanguageForTest, setLanguage } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { writeRoomComposerDraft } from "../../room-drafts";
import { FileVoiceMaterialButton } from "./file-voice-material-button";
import {
  VoiceMaterialsContext,
  type VoiceMaterials,
} from "./voice-materials-context";
import { VoiceMaterialsPreview } from "./voice-materials-preview";
import VoiceModeMiniWindow from "./voice-mode-mini-window";
import type { VoiceModeSession } from "./voice-mode-session";
import { openVoicePip, resetVoicePipForTest } from "./voice-pip";
import { voiceWindowSelector } from "./voice-window-selector";

const zh = zhCN.voiceWindow;
const chat = zhCN.voiceChat;

vi.mock("../../room-queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  roomMessagesInfiniteQueryOptions: () => ({
    getNextPageParam: () => undefined,
    initialPageParam: undefined,
    queryFn: async () => ({ items: [] }),
    queryKey: ["voice-window-language-test", "messages"],
  }),
}));
vi.mock("../../runtime-status/use-room-run-statuses", () => ({
  useRoomRunStatusCollection: () => ({
    items: [
      {
        agent: { display_name: "Codex", id: "agent-codex", kind: "agent" },
        id: "run-1",
        run_id: "run-1",
        status: "active",
      },
    ],
  }),
}));
const voice = vi.hoisted(() => ({
  exit: vi.fn(),
  retry: vi.fn(),
  session: undefined as VoiceModeSession | undefined,
  setMuted: vi.fn(async () => undefined),
  setSoundOff: vi.fn(),
}));
vi.mock("./voice-mode-session", () => ({
  useOptionalVoiceModeSession: () => voice,
  useVoiceModeLevel: () => 0,
}));

const target = {
  accountId: "account-1",
  roomId: "room-voice",
  roomName: "",
  tenantId: "tenant-northstar",
};

beforeEach(() => {
  voice.session = {
    closing: false,
    entered: true,
    muted: false,
    prefix: { body: "", documentReferences: [], mentions: [] },
    sourceId: "source-1",
    startedAt: "2026-10-02T03:00:00.000Z",
    state: {
      flushing: false,
      microphoneActive: true,
      sending: false,
      status: "listening",
      text: "",
    },
    target,
  };
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "documentPictureInPicture");
  resetVoicePipForTest();
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
  localStorage.clear();
  resetLanguageForTest();
});

function renderWindow() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamHubRuntimeProvider runtime={createTestTeamHubRuntime()}>
        <MemoryRouter
          initialEntries={["/t/tenant-northstar/rooms/room-other/chat"]}
        >
          <VoiceModeMiniWindow currentActorId="actor-me" />
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

/** A stand-in for the desktop app's floating window, where Voice Mode floats. */
function installFakeVoicePip() {
  const frame = window.document.createElement("iframe");
  window.document.body.append(frame);
  const document = frame.contentDocument!;
  const pipWindow = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: vi.fn(),
    document,
  };
  const originalOpen = window.open;
  window.open = vi.fn(() => pipWindow as unknown as Window);
  const desktop = window as { lingerDesktop?: unknown };
  desktop.lingerDesktop = {
    voiceWindow: { showMainWindow: vi.fn(async () => {}) },
  };
  const remove = () => {
    window.open = originalOpen;
    delete desktop.lingerDesktop;
  };
  return { document, remove };
}

describe("Voice Mode window in the language on screen", () => {
  it("words the window in Chinese and stays Voice Mode's own window", async () => {
    await setLanguage("zh-CN");
    writeRoomComposerDraft(target, {
      body: "",
      documentContexts: [],
      documentReferences: [],
      mentions: [],
      skillReferences: [],
      voiceMaterials: [
        { id: "m1", messageId: "message-1", quote: "One", title: "Jenny" },
        { id: "m2", messageId: "message-2", quote: "Two", title: "Jenny" },
      ],
    });
    renderWindow();

    const frame = screen.getByRole("region", { name: zh.window });
    // Voice Mode keeps away from its own controls by this marker.
    expect(frame).toHaveAttribute("data-voice-window");
    expect(frame.matches(voiceWindowSelector)).toBe(true);
    expect(within(frame).getByTitle(zh.openConversation)).toHaveTextContent(
      zh.statusListening,
    );
    expect(
      within(frame).getByText(zhCN.voiceMode.statusListening),
    ).toBeInTheDocument();

    expect(screen.getByRole("button", { name: zh.mute })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: zh.showConversation }));
    expect(
      screen.getByRole("button", { name: zh.hideConversation }),
    ).toBeInTheDocument();
    // Ending Voice Mode from its window is never confirmed, as in English.
    const end = screen.getByRole("button", { name: zh.end });
    expect(end).not.toHaveAttribute("data-voice-risk");
    expect(screen.getByRole("button", { name: zh.resize })).toHaveAttribute(
      "title",
      zh.resizeHint,
    );

    const log = screen.getByRole("log", { name: zh.conversation });
    expect(await within(log).findByText(zh.working)).toBeInTheDocument();
    expect(
      screen.getByText(zh.pendingSelections.other.replace("{count}", "2")),
    ).toBeInTheDocument();
  });

  it("names the floating window in Chinese", async () => {
    await setLanguage("zh-CN");
    const fake = installFakeVoicePip();
    renderWindow();
    await act(() => openVoicePip("voice-mode"));
    expect(fake.document.title).toBe(zh.title);
    const floating = within(fake.document.body);
    await floating.findByRole("region", { name: zh.window });
    fake.remove();
  });

  it("words voice selections in Chinese and marks removing one", async () => {
    await setLanguage("zh-CN");
    const materials: VoiceMaterials = {
      acceptsDocuments: true,
      addSelection: () => true,
      error: undefined,
      materials: [
        {
          documentId: "document-1",
          id: "material-1",
          quote: "",
          title: "Plan.md",
        },
      ],
      remove: () => undefined,
      roomId: "room-voice",
      setVoiceModeEntered: () => undefined,
      voiceModeEntered: true,
    };
    render(
      <VoiceMaterialsContext value={materials}>
        <VoiceMaterialsPreview />
        <FileVoiceMaterialButton documentId="document-1" filename="Plan.md" />
        <FileVoiceMaterialButton documentId="document-2" filename="Notes.md" />
      </VoiceMaterialsContext>,
    );

    expect(screen.getByLabelText(chat.selections)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: chat.removeSelection.replace("{title}", "Plan.md"),
      }),
    ).toHaveAttribute("data-voice-risk", "never");
    expect(
      screen.getByRole("button", {
        name: chat.fileAdded.replace("{filename}", "Plan.md"),
      }),
    ).toHaveTextContent(chat.addedToVoice);
    expect(
      screen.getByRole("button", {
        name: chat.addFile.replace("{filename}", "Notes.md"),
      }),
    ).toHaveTextContent(chat.addToVoice);
  });
});
