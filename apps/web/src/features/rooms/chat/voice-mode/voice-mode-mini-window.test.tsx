import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import VoiceModeMiniWindow, {
  clampPosition,
  sessionMessages,
} from "./voice-mode-mini-window";
import type { VoiceModeSession } from "./voice-mode-session";
import { closeVoicePip, openVoicePip, resetVoicePipForTest } from "./voice-pip";

const startedAt = "2026-10-02T03:00:00.000Z";
const message = (
  id: string,
  createdAt: string,
  author: object,
  text: string,
) => ({
  attachments: [],
  author,
  body: text,
  created_at: createdAt,
  id,
  message_kind: "conversation",
  raw_message: text,
  room_id: "room-voice",
  segments: [],
  tenant_id: "tenant-northstar",
});
const me = { display_name: "Jenny", id: "actor-me", kind: "human" };
const codex = { display_name: "Codex", id: "agent-codex", kind: "agent" };

vi.mock("../../room-queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  roomMessagesInfiniteQueryOptions: () => ({
    getNextPageParam: () => undefined,
    initialPageParam: undefined,
    queryFn: async () => ({
      items: [
        message("old", "2026-10-02T02:00:00.000Z", me, "Before voice"),
        message("q1", "2026-10-02T03:01:00.000Z", me, "What is next?"),
        message("a1", "2026-10-02T03:01:05.000Z", codex, "Ship the fix."),
      ],
    }),
    queryKey: ["mini-window-test", "messages"],
  }),
}));
vi.mock("../../runtime-status/use-room-run-statuses", () => ({
  useRoomRunStatusCollection: () => ({
    items: [{ agent: codex, id: "run-1", run_id: "run-1", status: "active" }],
  }),
}));
const voice = vi.hoisted(() => ({
  exit: vi.fn(),
  level: 0,
  retry: vi.fn(),
  session: undefined as VoiceModeSession | undefined,
  setMuted: vi.fn(async () => undefined),
  setSoundOff: vi.fn(),
}));
vi.mock("./voice-mode-session", () => ({
  useOptionalVoiceModeSession: () => voice,
  useVoiceModeLevel: () => voice.level,
}));

beforeEach(() => {
  voice.exit.mockReset();
  voice.level = 0;
  voice.session = {
    closing: false,
    entered: true,
    muted: false,
    prefix: { body: "", documentReferences: [], mentions: [] },
    sourceId: "source-1",
    startedAt,
    state: {
      flushing: false,
      microphoneActive: true,
      sending: false,
      status: "listening",
      text: "and the tests",
    },
    target: {
      accountId: "account-1",
      roomId: "room-voice",
      roomName: "Codex",
      tenantId: "tenant-northstar",
    },
  };
});

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderWindow() {
  const client = new QueryClient();
  const runtime = createTestTeamHubRuntime();
  const tree = () => (
    <QueryClientProvider client={client}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter
          initialEntries={["/t/tenant-northstar/rooms/room-other/chat"]}
        >
          <VoiceModeMiniWindow currentActorId="actor-me" />
          <LocationProbe />
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  // The session stand-in has no subscribers: render again to show a change.
  return Object.assign(view, { refresh: () => view.rerender(tree()) });
}

/** A stand-in for the browser's picture-in-picture window. */
function installFakeVoicePip() {
  const frame = window.document.createElement("iframe");
  window.document.body.append(frame);
  const document = frame.contentDocument!;
  const listeners: (() => void)[] = [];
  const pipWindow = {
    document,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") listeners.push(listener);
    },
    // A closed window is gone; the next request opens a fresh one.
    close: vi.fn(() => listeners.splice(0).forEach((listener) => listener())),
  };
  const requestWindow = vi.fn(async () => pipWindow as unknown as Window);
  Object.defineProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: { requestWindow },
  });
  return { document, frame, pipWindow, requestWindow };
}

describe("Voice Mode mini window", () => {
  it("shows this session's turns, replies, and live words in order", async () => {
    renderWindow();
    const log = await screen.findByRole("log", {
      name: "Voice Mode conversation",
    });
    expect(await within(log).findByText("What is next?")).toBeInTheDocument();
    expect(within(log).getByText("Ship the fix.")).toBeInTheDocument();
    expect(within(log).getByText("Working…")).toBeInTheDocument();
    expect(within(log).getByText("and the tests")).toBeInTheDocument();
    expect(within(log).queryByText("Before voice")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Voice Mode window" }),
    ).toHaveTextContent("Codex");
  });

  it("shows the live reply and turns its sound off apart from the microphone", async () => {
    voice.session!.live = {
      soundOff: false,
      transcript: [
        { id: "lt_1", speaker: "you", text: "When is the meeting tomorrow" },
        {
          id: "lt_1:reply",
          speaker: "live",
          text: "Tomorrow, after review.",
          pending: true,
        },
      ],
    };
    renderWindow();
    const log = await screen.findByRole("log", {
      name: "Voice Mode conversation",
    });
    expect(
      within(log).getByText("Tomorrow, after review."),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Turn reply sound off from the voice window",
      }),
    );
    expect(voice.setSoundOff).toHaveBeenCalledWith(true);
    expect(voice.setMuted).not.toHaveBeenCalled();
  });

  it("fades in each phrase of a reply as it arrives, and nothing already said", async () => {
    voice.session!.live = {
      soundOff: false,
      transcript: [
        { id: "lt_0:reply", speaker: "live", text: "Said before." },
        {
          id: "lt_1:reply",
          speaker: "live",
          text: "Two meetings,",
          pending: true,
        },
      ],
    };
    const view = renderWindow();
    const log = await screen.findByRole("log", {
      name: "Voice Mode conversation",
    });
    const fading = () =>
      [...log.querySelectorAll("span.voice-live-fade-in")].map(
        (span) => span.textContent,
      );
    expect(log).toHaveTextContent("Two meetings,");
    expect(fading()).toEqual([]);
    voice.session!.live = {
      soundOff: false,
      transcript: [
        { id: "lt_0:reply", speaker: "live", text: "Said before." },
        {
          id: "lt_1:reply",
          speaker: "live",
          text: "Two meetings, then the review.",
          pending: true,
        },
      ],
    };
    view.refresh();
    expect(log).toHaveTextContent("Two meetings, then the review.");
    expect(fading()).toEqual([" then the review."]);
    // The bubble being said faded in as it appeared; the earlier one did not.
    expect(log.querySelectorAll("div.voice-live-fade-in")).toHaveLength(1);
  });

  it("opens at the newest words without gliding through the call", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    // jsdom has no element scrollTo; a stand-in shows whether one glides.
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    try {
      voice.session!.live = {
        soundOff: false,
        transcript: [{ id: "lt_1", speaker: "you", text: "What is next" }],
      };
      renderWindow();
      const log = await screen.findByRole("log", {
        name: "Voice Mode conversation",
      });
      expect(log.scrollTop).toBe(800);
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
      vi.restoreAllMocks();
    }
  });

  it("glides after new lines until the Human scrolls up", async () => {
    const observed: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    voice.session!.live = {
      soundOff: false,
      transcript: [{ id: "lt_1", speaker: "you", text: "What is next" }],
    };
    renderWindow();
    const log = await screen.findByRole("log", {
      name: "Voice Mode conversation",
    });
    let scrollHeight = 400;
    Object.defineProperty(log, "scrollHeight", { get: () => scrollHeight });
    Object.defineProperty(log, "clientHeight", { value: 100 });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      log.scrollTop = options.top ?? 0;
    });
    log.scrollTo = scrollTo as unknown as typeof log.scrollTo;
    const grow = (height: number) => {
      scrollHeight = height;
      observed.forEach((callback) => callback());
    };
    grow(420);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 320, behavior: "smooth" });
    // On its way down the glide passes short of the bottom and keeps following.
    log.scrollTop = 200;
    fireEvent.scroll(log);
    log.scrollTop = 260;
    fireEvent.scroll(log);
    grow(440);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 340, behavior: "smooth" });
    // Scrolling up leaves the newest words where they are.
    log.scrollTop = 100;
    fireEvent.scroll(log);
    scrollTo.mockClear();
    grow(460);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("shows a live call as it was said, with words still being said last", async () => {
    voice.session!.state = {
      ...voice.session!.state,
      text: "Scroll down a bit\nthen",
      heardText: "Scroll down a bit",
      speakingText: "then",
    };
    voice.session!.live = {
      soundOff: true,
      transcript: [
        { id: "lt_1", speaker: "you", text: "Scroll down a bit" },
        { id: "lt_1:reply", speaker: "live", text: "Sure, scrolling for you." },
        {
          id: "m-9",
          speaker: "live",
          text: "The weekly report is in the chat",
        },
      ],
    };
    renderWindow();
    const log = await screen.findByRole("log", {
      name: "Voice Mode conversation",
    });
    const order = [
      "Scroll down a bit",
      "Sure, scrolling for you.",
      "The weekly report is in the chat",
      "then",
    ].map((text) => within(log).getByText(text));
    for (const [index, bubble] of order.slice(1).entries())
      expect(
        order[index]!.compareDocumentPosition(bubble) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    // Said once: neither the saved Messages nor the queued words repeat it.
    expect(within(log).getAllByText("Scroll down a bit")).toHaveLength(1);
    expect(within(log).queryByText("What is next?")).toBeNull();
    expect(within(log).queryByText("Ship the fix.")).toBeNull();
    expect(within(log).queryByText("Working…")).toBeNull();
    expect(within(log).queryByText("Codex")).toBeNull();
    expect(within(log).getAllByText("Reply")).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: "Turn reply sound on from the voice window",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("retries a failed turn from the window", () => {
    voice.session!.state = { ...voice.session!.state, canRetry: true };
    renderWindow();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry voice message from the voice window",
      }),
    );
    expect(voice.retry).toHaveBeenCalledOnce();
  });

  it("shows Another Me beating while listening and turning while speaking", () => {
    voice.level = 0.5;
    renderWindow();
    const avatar = document.querySelector("[data-voice-avatar]")!;
    expect(avatar).toHaveAttribute("data-listening");
    expect(avatar).toHaveAttribute("data-speaking");
    expect(avatar.querySelector("[role='img'], img")).not.toBeNull();
  });

  it("rests the avatar while muted", () => {
    voice.level = 0.5;
    voice.session!.muted = true;
    renderWindow();
    const avatar = document.querySelector("[data-voice-avatar]")!;
    expect(avatar).not.toHaveAttribute("data-listening");
    expect(avatar).not.toHaveAttribute("data-speaking");
  });

  it("expands and shrinks the window", () => {
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    expect(panel).toHaveStyle({ width: "320px" });
    expect(panel).toHaveStyle({
      maxHeight: "calc(min(480px, 70dvh, 100dvh - 68px) + 36px)",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Voice Mode window" }),
    );
    expect(panel).toHaveStyle({ width: "560px" });
    expect(panel).toHaveStyle({
      maxHeight: "calc(min(760px, 86dvh, 100dvh - 68px) + 36px)",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Shrink Voice Mode window" }),
    );
    expect(panel).toHaveStyle({ width: "320px" });
    expect(panel).toHaveStyle({
      maxHeight: "calc(min(480px, 70dvh, 100dvh - 68px) + 36px)",
    });
  });

  it("floats over other windows as the one Voice Mode window", async () => {
    const fake = installFakeVoicePip();
    try {
      renderWindow();
      await act(() => openVoicePip("voice-mode"));
      const floating = within(fake.document.body);
      await floating.findByRole("region", { name: "Voice Mode window" });
      expect(
        screen.queryByRole("region", { name: "Voice Mode window" }),
      ).not.toBeInTheDocument();
      // The desktop sizes, places, and closes that window, so it shows no
      // size or close button and no resize grip of its own, only the way
      // back.
      expect(
        floating.queryByRole("button", { name: "Expand Voice Mode window" }),
      ).not.toBeInTheDocument();
      expect(
        floating.queryByRole("button", { name: "Resize Voice Mode window" }),
      ).not.toBeInTheDocument();
      expect(
        floating.getByRole("button", { name: "Return Voice Mode to Linger" }),
      ).toHaveAttribute("title", "Back to Linger; Voice Mode continues");
      expect(
        floating.queryByRole("button", { name: "End Voice Mode" }),
      ).not.toBeInTheDocument();

      // The desktop's close button ends Voice Mode instead of leaving a
      // second window behind in the page, also when the page was already in
      // front and takes the focus back.
      const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      act(() => fake.pipWindow.close());
      // While it tells a close from back to tab, nothing flashes up in the
      // page.
      expect(
        screen.queryByRole("region", { name: "Voice Mode window" }),
      ).not.toBeInTheDocument();
      await waitFor(() => expect(voice.exit).toHaveBeenCalledOnce());
      expect(
        screen.queryByRole("region", { name: "Voice Mode window" }),
      ).not.toBeInTheDocument();
      focused.mockRestore();
    } finally {
      fake.frame.remove();
      Reflect.deleteProperty(window, "documentPictureInPicture");
      resetVoicePipForTest();
    }
  });

  it("floats the call again from the window inside the page", async () => {
    const fake = installFakeVoicePip();
    try {
      renderWindow();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Float Voice Mode window" }),
        );
        await fake.requestWindow.mock.results[0]?.value;
      });
      await within(fake.document.body).findByRole("region", {
        name: "Voice Mode window",
      });
      expect(fake.requestWindow).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("region", { name: "Voice Mode window" }),
      ).not.toBeInTheDocument();
      expect(voice.exit).not.toHaveBeenCalled();
      // The page takes the window back before the test removes its frame.
      act(() => closeVoicePip("voice-mode"));
    } finally {
      fake.frame.remove();
      Reflect.deleteProperty(window, "documentPictureInPicture");
      resetVoicePipForTest();
    }
  });

  it("keeps the call when the desktop's back to tab button returns to the page", async () => {
    const fake = installFakeVoicePip();
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      renderWindow();
      await act(() => openVoicePip("voice-mode"));
      // Back to tab brings this page from the background to the front.
      act(() => {
        fake.pipWindow.close();
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // The call goes on in the window inside the page, on its conversation.
      await waitFor(() =>
        expect(screen.getByTestId("location")).toHaveTextContent(
          "/t/tenant-northstar/rooms/room-voice/chat",
        ),
      );
      expect(voice.exit).not.toHaveBeenCalled();
      expect(
        screen.getByRole("region", { name: "Voice Mode window" }),
      ).toBeInTheDocument();
    } finally {
      focused.mockRestore();
      fake.frame.remove();
      Reflect.deleteProperty(window, "documentPictureInPicture");
      resetVoicePipForTest();
    }
  });

  it("returns from the browser's floating window by its return button", async () => {
    const fake = installFakeVoicePip();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    try {
      renderWindow();
      await act(() => openVoicePip("voice-mode"));
      const floating = within(fake.document.body);
      await act(async () => {
        fireEvent.click(
          await floating.findByRole("button", {
            name: "Return Voice Mode to Linger",
          }),
        );
      });
      // The tab comes to the front and the call goes on in the window inside
      // the page, on the conversation it started in.
      expect(focus).toHaveBeenCalledOnce();
      expect(fake.pipWindow.close).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(screen.getByTestId("location")).toHaveTextContent(
          "/t/tenant-northstar/rooms/room-voice/chat",
        ),
      );
      expect(
        screen.getByRole("region", { name: "Voice Mode window" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Return Voice Mode to Linger" }),
      ).not.toBeInTheDocument();
      expect(voice.exit).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
      fake.frame.remove();
      Reflect.deleteProperty(window, "documentPictureInPicture");
      resetVoicePipForTest();
    }
  });

  it("returns from the desktop app's window by its own button, and ends when that window closes", async () => {
    const fake = installFakeVoicePip();
    const open = vi.fn(() => fake.pipWindow as unknown as Window);
    const showMain = vi.fn(async () => {});
    const originalOpen = window.open;
    window.open = open;
    const desktop = window as { lingerDesktop?: unknown };
    desktop.lingerDesktop = {
      voiceWindow: { showMainWindow: showMain },
    };
    try {
      renderWindow();
      await act(() => openVoicePip("voice-mode"));
      const floating = within(fake.document.body);
      await act(async () => {
        fireEvent.click(
          await floating.findByRole("button", {
            name: "Return Voice Mode to Linger",
          }),
        );
      });
      expect(showMain).toHaveBeenCalledOnce();
      // The call goes on in the window inside the page, on its conversation,
      // with no return button there.
      await waitFor(() =>
        expect(screen.getByTestId("location")).toHaveTextContent(
          "/t/tenant-northstar/rooms/room-voice/chat",
        ),
      );
      expect(
        screen.getByRole("region", { name: "Voice Mode window" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Return Voice Mode to Linger" }),
      ).not.toBeInTheDocument();
      expect(voice.exit).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Float Voice Mode window" }),
        );
      });
      expect(open).toHaveBeenCalledTimes(2);
      expect(fake.requestWindow).not.toHaveBeenCalled();
      await floating.findByRole("region", { name: "Voice Mode window" });
      // The window's close button ends Voice Mode even as the main window
      // comes to the front.
      act(() => {
        fake.pipWindow.close();
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(voice.exit).toHaveBeenCalledOnce());
      expect(showMain).toHaveBeenCalledOnce();
    } finally {
      window.open = originalOpen;
      delete desktop.lingerDesktop;
      fake.frame.remove();
      Reflect.deleteProperty(window, "documentPictureInPicture");
      resetVoicePipForTest();
    }
  });

  it("resizes by its edges and corners, inside the page and above a minimum", () => {
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    const onScreen = vi
      .spyOn(panel, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(600, 100, 320, 300));
    const grip = screen.getByRole("button", {
      name: "Resize Voice Mode window",
    });
    fireEvent.pointerDown(grip, { button: 0, clientX: 920, clientY: 400 });
    fireEvent.pointerMove(grip, { clientX: 960, clientY: 500 });
    expect(panel).toHaveStyle({ height: "400px", width: "360px" });
    expect(panel).toHaveAttribute("data-size", "custom");
    // The corner stops 16px short of the page's edge, as a drag does.
    fireEvent.pointerMove(grip, { clientX: 5000, clientY: 5000 });
    expect(panel).toHaveStyle({
      height: `${window.innerHeight - 16 - 100}px`,
      width: `${window.innerWidth - 16 - 600}px`,
    });
    fireEvent.pointerMove(grip, { clientX: 0, clientY: 0 });
    expect(panel).toHaveStyle({ height: "200px", width: "260px" });
    fireEvent.pointerUp(grip);
    // A move after the drag ended changes nothing.
    fireEvent.pointerMove(grip, { clientX: 960, clientY: 500 });
    expect(panel).toHaveStyle({ height: "200px", width: "260px" });

    // The left edge moves that side and keeps the right one where it was.
    const left = panel.querySelector('[data-resize-edge="w"]')!;
    fireEvent.pointerDown(left, { button: 0, clientX: 600, clientY: 200 });
    fireEvent.pointerMove(left, { clientX: 500, clientY: 900 });
    fireEvent.pointerUp(left);
    expect(panel).toHaveStyle({ height: "300px", left: "500px" });
    expect(panel).toHaveStyle({ width: "420px" });

    // Arrow keys on the grip resize too.
    onScreen.mockReturnValue(new DOMRect(500, 100, 420, 300));
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(panel).toHaveStyle({ height: "300px", width: "428px" });
    fireEvent.keyDown(grip, { key: "ArrowUp", shiftKey: true });
    expect(panel).toHaveStyle({ height: "268px", width: "420px" });
  });

  it("goes back to a preset size from a dragged one", () => {
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      new DOMRect(200, 100, 320, 300),
    );
    const grip = screen.getByRole("button", {
      name: "Resize Voice Mode window",
    });
    fireEvent.pointerDown(grip, { button: 0, clientX: 520, clientY: 400 });
    fireEvent.pointerMove(grip, { clientX: 800, clientY: 400 });
    fireEvent.pointerUp(grip);
    expect(panel).toHaveStyle({ width: "600px" });
    // Wider than the expanded preset, so the button offers the compact one.
    fireEvent.click(
      screen.getByRole("button", { name: "Shrink Voice Mode window" }),
    );
    expect(panel).toHaveStyle({ width: "320px" });
    expect(panel).toHaveStyle({
      maxHeight: "calc(min(480px, 70dvh, 100dvh - 68px) + 36px)",
    });
    expect(panel.style.height).toBe("");
    expect(panel).toHaveAttribute("data-size", "compact");
  });

  it("cannot be dragged out of the viewport, and moves back in when it grows or the viewport shrinks", () => {
    const observed: (() => void)[] = [];
    const resize = () => observed.forEach((callback) => callback());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    let height = 300;
    Object.defineProperty(panel, "offsetHeight", { get: () => height });
    const title = screen.getByText("Voice Mode", {
      selector: ".voice-window-title",
    });
    fireEvent.pointerDown(title, { button: 0, clientX: 800, clientY: 90 });
    fireEvent.pointerMove(window, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(window);
    expect(panel).toHaveStyle({
      left: `${window.innerWidth - 320 - 16}px`,
      top: `${window.innerHeight - 300 - 16}px`,
    });
    fireEvent.pointerDown(title, { button: 0, clientX: 800, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(window);
    expect(panel).toHaveStyle({ left: "16px", top: "16px" });

    // At the bottom of the page, a longer conversation makes it taller.
    fireEvent.pointerDown(title, { button: 0, clientX: 100, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 5000 });
    fireEvent.pointerUp(window);
    expect(panel).toHaveStyle({ top: `${window.innerHeight - 300 - 16}px` });
    height = 480;
    act(() => resize());
    expect(panel).toHaveStyle({ top: `${window.innerHeight - 480 - 16}px` });

    // A shorter viewport moves it up until all of it shows again.
    vi.stubGlobal("innerHeight", 600);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(panel).toHaveStyle({ top: `${600 - 480 - 16}px` });
  });

  it("drags from anywhere on the header, including the title", () => {
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    const title = screen.getByTitle("Open this conversation");
    const before = Number.parseFloat(panel.style.top);
    fireEvent.pointerDown(title, { button: 0, clientX: 600, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 300 });
    expect(Number.parseFloat(panel.style.top)).toBe(before + 200);
    // Releasing a drag on the title must not also open the Room.
    fireEvent.click(title);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/rooms/room-other/chat",
    );
    fireEvent.click(title);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/rooms/room-voice/chat",
    );
  });

  it("opens compact every time, even after it was expanded", () => {
    const first = renderWindow();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Voice Mode window" }),
    );
    first.unmount();
    renderWindow();
    expect(
      screen.getByRole("region", { name: "Voice Mode window" }),
    ).toHaveStyle({ width: "320px" });
  });

  it("names its controls apart from the Room composer's", () => {
    voice.session!.state = { ...voice.session!.state, canRetry: true };
    renderWindow();
    expect(
      screen.getByRole("button", { name: "Mute Voice Mode" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mute microphone" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Retry voice message$/ }),
    ).toBeNull();
    // Voice Mode takes no screenshots.
    expect(screen.queryByRole("button", { name: /screenshot/i })).toBeNull();
  });

  it("ends Voice Mode from its close button", () => {
    renderWindow();
    fireEvent.click(screen.getByRole("button", { name: "End Voice Mode" }));
    expect(voice.exit).toHaveBeenCalledOnce();
  });

  it("leaves at once when Voice Mode ends, while the session drains", () => {
    voice.session!.closing = true;
    renderWindow();
    expect(
      screen.queryByRole("region", { name: "Voice Mode window" }),
    ).toBeNull();
  });

  it("filters to conversation Messages since the session started", () => {
    const items = [
      message("b", "2026-10-02T03:02:00.000Z", codex, "second"),
      message("a", "2026-10-02T03:01:00.000Z", me, "first"),
      {
        ...message("s", "2026-10-02T03:03:00.000Z", codex, "status"),
        message_kind: "agent_status",
      },
      message("o", "2026-10-02T02:59:59.000Z", me, "earlier"),
    ] as unknown as Parameters<typeof sessionMessages>[0];
    expect(sessionMessages(items, startedAt).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("keeps the whole window 16px inside the viewport", () => {
    const size = { height: 400, width: 320 };
    expect(clampPosition({ left: -500, top: -500 }, size)).toEqual({
      left: 16,
      top: 16,
    });
    expect(clampPosition({ left: 99_999, top: 99_999 }, size)).toEqual({
      left: window.innerWidth - 320 - 16,
      top: window.innerHeight - 400 - 16,
    });
    // Taller than the viewport: the header stays at the top of the page.
    expect(
      clampPosition({ left: 200, top: 300 }, { ...size, height: 5000 }),
    ).toEqual({ left: 200, top: 16 });
  });
});
