import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import VoiceModeMiniWindow, {
  clampPosition,
  sessionMessages,
} from "./voice-mode-mini-window";
import type { VoiceModeSession } from "./voice-mode-session";
import { openVoicePip, resetVoicePipForTest } from "./voice-pip";
import { voiceWindowAction } from "./voice-ui-bridge";

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

/** Renders the window with its conversation open, unless only the island. */
function renderWindow({ conversation = true } = {}) {
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
  if (conversation)
    fireEvent.click(
      screen.getByRole("button", { name: "Show Voice Mode conversation" }),
    );
  // The session stand-in has no subscribers: render again to show a change.
  return Object.assign(view, { refresh: () => view.rerender(tree()) });
}

/**
 * A stand-in for the desktop app's floating window: only the desktop app
 * floats Voice Mode. `remove` puts the page back as it was.
 */
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
    removeEventListener: () => undefined,
    // A closed window is gone; the next request opens a fresh one.
    close: vi.fn(() => listeners.splice(0).forEach((listener) => listener())),
  };
  const open = vi.fn(() => pipWindow as unknown as Window);
  const originalOpen = window.open;
  window.open = open;
  const desktop = window as { lingerDesktop?: unknown };
  desktop.lingerDesktop = {
    voiceWindow: { showMainWindow: vi.fn(async () => {}) },
  };
  const remove = () => {
    window.open = originalOpen;
    delete desktop.lingerDesktop;
    frame.remove();
    resetVoicePipForTest();
  };
  return { document, open, pipWindow, remove };
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
  });

  it("shows the live reply and turns its sound off apart from the microphone", async () => {
    voice.session!.live = {
      soundOff: false,
      waking: false,
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
      waking: false,
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
      waking: false,
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
        waking: false,
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
      waking: false,
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
      waking: false,
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

  it("shows Another Me swelling with the voice while listening", () => {
    voice.level = 0.5;
    renderWindow();
    const avatar = document.querySelector("[data-voice-avatar]")!;
    expect(avatar).toHaveAttribute("data-listening");
    expect(avatar).toHaveAttribute("data-speaking");
    expect(avatar).not.toHaveAttribute("data-waking");
    expect(avatar.querySelector("[role='img'], img")).not.toBeNull();
  });

  it("wakes up until the live model itself is connected", () => {
    voice.level = 0.5;
    voice.session!.state = {
      ...voice.session!.state,
      microphoneActive: false,
      status: "connecting",
    };
    const view = renderWindow({ conversation: false });
    const island = screen.getByTitle("Open this conversation");
    expect(island).toHaveTextContent("Waking up");
    const avatar = document.querySelector("[data-voice-avatar]")!;
    expect(avatar).toHaveAttribute("data-waking");
    expect(avatar).not.toHaveAttribute("data-listening");
    // Every control is already there; only the state says it wakes up.
    for (const name of [
      "Mute Voice Mode",
      "Show Voice Mode conversation",
      "End Voice Mode",
    ])
      expect(
        screen.getByRole("button", { name }).closest("[inert]"),
      ).toBeNull();

    // The microphone is heard, but the live model is still connecting.
    voice.session!.state = {
      ...voice.session!.state,
      microphoneActive: true,
      status: "listening",
    };
    voice.session!.live = { soundOff: false, transcript: [], waking: true };
    view.refresh();
    expect(island).toHaveTextContent("Waking up");
    expect(avatar).toHaveAttribute("data-waking");

    voice.session!.live = { soundOff: false, transcript: [], waking: false };
    view.refresh();
    expect(island).toHaveTextContent("Listening");
    expect(avatar).not.toHaveAttribute("data-waking");
    expect(avatar).toHaveAttribute("data-listening");
  });

  it("rests the avatar while muted", () => {
    voice.level = 0.5;
    voice.session!.muted = true;
    renderWindow();
    const avatar = document.querySelector("[data-voice-avatar]")!;
    expect(avatar).not.toHaveAttribute("data-listening");
    expect(avatar).not.toHaveAttribute("data-speaking");
  });

  it("opens as the island alone and shows the conversation under it on request", () => {
    renderWindow({ conversation: false });
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    expect(panel).toHaveAttribute("data-size", "island");
    // One width open or shut, so nothing on the island jumps sideways.
    expect(panel).toHaveStyle({ width: "360px" });
    expect(screen.queryByRole("log")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Resize Voice Mode window" }),
    ).toBeNull();
    const show = screen.getByRole("button", {
      name: "Show Voice Mode conversation",
    });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(panel).toHaveAttribute("data-size", "conversation");
    expect(panel).toHaveStyle({ width: "360px" });
    expect(
      screen.getByRole("log", { name: "Voice Mode conversation" }),
    ).toHaveStyle({ maxHeight: "calc(min(480px, 70dvh, 100dvh - 80px))" });
    fireEvent.click(
      screen.getByRole("button", { name: "Hide Voice Mode conversation" }),
    );
    expect(panel).toHaveAttribute("data-size", "island");
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("floats over other windows as the one Voice Mode window", async () => {
    const fake = installFakeVoicePip();
    try {
      renderWindow({ conversation: false });
      await act(() => openVoicePip("voice-mode"));
      expect(fake.open).toHaveBeenCalledOnce();
      const floating = within(fake.document.body);
      await floating.findByRole("region", { name: "Voice Mode window" });
      expect(
        screen.queryByRole("region", { name: "Voice Mode window" }),
      ).not.toBeInTheDocument();
      // The floated window is the island alone, like the window in the page;
      // its arrow grows the window to show the conversation, inside the click.
      expect(floating.queryByRole("log")).toBeNull();
      const resizeTo = vi.fn();
      Object.assign(fake.pipWindow, {
        innerHeight: 96,
        innerWidth: 360,
        outerHeight: 124,
        outerWidth: 360,
        resizeTo,
        screen: { availHeight: 900, availWidth: 1400 },
      });
      fireEvent.click(
        floating.getByRole("button", { name: "Show Voice Mode conversation" }),
      );
      expect(
        floating.getByRole("log", { name: "Voice Mode conversation" }),
      ).toBeInTheDocument();
      expect(resizeTo).toHaveBeenLastCalledWith(360, 480 + 28);
      fireEvent.click(
        floating.getByRole("button", { name: "Hide Voice Mode conversation" }),
      );
      expect(resizeTo).toHaveBeenLastCalledWith(360 + 0, 48 + 28);
      expect(floating.queryByRole("log")).toBeNull();
      expect(
        floating.queryByRole("button", { name: "Resize Voice Mode window" }),
      ).not.toBeInTheDocument();
      // The call is the whole window: no bar above the conversation.
      expect(
        floating.queryByRole("button", { name: /Return Voice Mode/ }),
      ).not.toBeInTheDocument();
      expect(
        floating.getByRole("button", { name: "End Voice Mode" }),
      ).toBeInTheDocument();

      // The window's close button ends Voice Mode, even as the main window
      // comes to the front, instead of leaving a second window behind in the
      // page.
      act(() => {
        fake.pipWindow.close();
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(voice.exit).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("region", { name: "Voice Mode window" }),
      ).not.toBeInTheDocument();
    } finally {
      fake.remove();
    }
  });

  it("moves a floated window's height frame by frame, shutting over the conversation", async () => {
    const fake = installFakeVoicePip();
    try {
      renderWindow({ conversation: false });
      await act(() => openVoicePip("voice-mode"));
      const floating = within(fake.document.body);
      await floating.findByRole("region", { name: "Voice Mode window" });
      const frames: FrameRequestCallback[] = [];
      const heights: number[] = [];
      const size = { innerHeight: 96, outerHeight: 124 };
      // Live sizes: the window reports what it was last resized to.
      Object.defineProperties(fake.pipWindow, {
        innerHeight: { get: () => size.innerHeight },
        outerHeight: { get: () => size.outerHeight },
      });
      Object.assign(fake.pipWindow, {
        cancelAnimationFrame: () => undefined,
        innerWidth: 360,
        outerWidth: 360,
        performance: { now: () => 0 },
        requestAnimationFrame: (callback: FrameRequestCallback) =>
          frames.push(callback),
        resizeTo: (_width: number, height: number) => {
          heights.push(height);
          size.outerHeight = height;
          size.innerHeight = height - 28;
        },
        screen: { availHeight: 900, availWidth: 1400 },
      });
      const run = (now: number) => act(() => frames.shift()?.(now));
      fireEvent.click(
        floating.getByRole("button", { name: "Show Voice Mode conversation" }),
      );
      expect(floating.getByRole("log")).toBeInTheDocument();
      run(140);
      run(280);
      // Eased toward the open height (fast first), landing on it.
      expect(heights[0]).toBeGreaterThan(124 + (508 - 124) / 2);
      expect(heights.at(-1)).toBe(508);
      fireEvent.click(
        floating.getByRole("button", { name: "Hide Voice Mode conversation" }),
      );
      run(140);
      // The conversation stays while the window shuts over it.
      expect(floating.getByRole("log")).toBeInTheDocument();
      run(280);
      expect(heights.at(-1)).toBe(76);
      expect(floating.queryByRole("log")).toBeNull();
      // Saying "expand" folds it open just as the arrow does.
      act(() => {
        voiceWindowAction("expand");
      });
      run(280);
      expect(heights.at(-1)).toBe(508);
      expect(floating.getByRole("log")).toBeInTheDocument();
      act(() => fake.pipWindow.close());
    } finally {
      fake.remove();
    }
  });

  it("stays in the page in a browser, whose floating window it cannot style", async () => {
    const requestWindow = vi.fn();
    Object.defineProperty(window, "documentPictureInPicture", {
      configurable: true,
      value: { requestWindow },
    });
    try {
      renderWindow({ conversation: false });
      await act(() => openVoicePip("voice-mode"));
      expect(requestWindow).not.toHaveBeenCalled();
      expect(
        screen.getByRole("region", { name: "Voice Mode window" }),
      ).toHaveAttribute("data-size", "island");
    } finally {
      Reflect.deleteProperty(window, "documentPictureInPicture");
      resetVoicePipForTest();
    }
  });

  it("resizes by its edges and corners, inside the page and above a minimum", () => {
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    const onScreen = vi
      .spyOn(panel, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(600, 100, 360, 300));
    const grip = screen.getByRole("button", {
      name: "Resize Voice Mode window",
    });
    fireEvent.pointerDown(grip, { button: 0, clientX: 960, clientY: 400 });
    fireEvent.pointerMove(grip, { clientX: 1000, clientY: 500 });
    expect(panel).toHaveStyle({ height: "400px", width: "400px" });
    expect(panel).toHaveAttribute("data-size", "custom");
    // The corner stops 16px short of the page's edge, as a drag does.
    fireEvent.pointerMove(grip, { clientX: 5000, clientY: 5000 });
    expect(panel).toHaveStyle({
      height: `${window.innerHeight - 16 - 100}px`,
      width: `${window.innerWidth - 16 - 600}px`,
    });
    fireEvent.pointerMove(grip, { clientX: 0, clientY: 0 });
    expect(panel).toHaveStyle({ height: "200px", width: "360px" });
    fireEvent.pointerUp(grip);
    // A move after the drag ended changes nothing.
    fireEvent.pointerMove(grip, { clientX: 960, clientY: 500 });
    expect(panel).toHaveStyle({ height: "200px", width: "360px" });

    // The left edge moves that side and keeps the right one where it was.
    const left = panel.querySelector('[data-resize-edge="w"]')!;
    fireEvent.pointerDown(left, { button: 0, clientX: 600, clientY: 200 });
    fireEvent.pointerMove(left, { clientX: 500, clientY: 900 });
    fireEvent.pointerUp(left);
    expect(panel).toHaveStyle({ height: "300px", left: "500px" });
    expect(panel).toHaveStyle({ width: "460px" });

    // Arrow keys on the grip resize too.
    onScreen.mockReturnValue(new DOMRect(500, 100, 460, 300));
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(panel).toHaveStyle({ height: "300px", width: "468px" });
    fireEvent.keyDown(grip, { key: "ArrowUp", shiftKey: true });
    expect(panel).toHaveStyle({ height: "268px", width: "460px" });
  });

  it("keeps a dragged size as the conversation closes and opens again", () => {
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      new DOMRect(200, 100, 320, 300),
    );
    const grip = screen.getByRole("button", {
      name: "Resize Voice Mode window",
    });
    fireEvent.pointerDown(grip, { button: 0, clientX: 520, clientY: 400 });
    fireEvent.pointerMove(grip, { clientX: 800, clientY: 500 });
    fireEvent.pointerUp(grip);
    expect(panel).toHaveStyle({ height: "400px", width: "600px" });
    fireEvent.click(
      screen.getByRole("button", { name: "Hide Voice Mode conversation" }),
    );
    // Closed, the island keeps the width the Human gave the window.
    expect(panel).toHaveStyle({ width: "600px" });
    expect(panel.style.height).toBe("");
    fireEvent.click(
      screen.getByRole("button", { name: "Show Voice Mode conversation" }),
    );
    // Open again, it comes back at the Human's size, not the preset.
    expect(panel).toHaveStyle({ height: "400px", width: "600px" });
    expect(panel).toHaveAttribute("data-size", "custom");
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
    // The island is the window's bar.
    const title = panel.querySelector("header")!;
    fireEvent.pointerDown(title, { button: 0, clientX: 800, clientY: 90 });
    fireEvent.pointerMove(window, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(window);
    expect(panel).toHaveStyle({
      left: `${window.innerWidth - 360 - 16}px`,
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

  it("opens as the island every time, even after the conversation was open", () => {
    const first = renderWindow();
    first.unmount();
    renderWindow({ conversation: false });
    expect(
      screen.getByRole("region", { name: "Voice Mode window" }),
    ).toHaveAttribute("data-size", "island");
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
    renderWindow({ conversation: false });
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
